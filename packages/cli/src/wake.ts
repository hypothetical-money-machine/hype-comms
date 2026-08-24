import {
  AGENT_WAKE_REALTIME_PREAMBLE,
  agentWakeBootstrapResponseSchema,
  agentWakeStreamRecordSchema,
  classifyAgentWake,
  createAgentWakeSignal,
  sequenceSchema,
  type AgentWakeBootstrapResponse,
  type AgentWakeStreamRecord,
  type ConversationKind,
  type ProductRealtimeEvent,
} from "@hype-comms/contracts";
import { deriveAgentWakeId } from "@hype-comms/contracts/wake-node";

import { parseCommandArguments, requirePositionals, stringOption } from "./argv.js";
import { ApiClient } from "./client.js";
import { resolveProfile } from "./config.js";
import { CliError, EXIT_TRANSIENT, UsageError, contractError } from "./errors.js";
import { writeEvent } from "./output.js";
import type { CommandContext } from "./types.js";
import { laterCursor, watchProductRealtime } from "./watch.js";

class WakeOutputBackpressureError extends CliError {
  constructor() {
    super({
      exitCode: EXIT_TRANSIENT,
      code: "OUTPUT_BACKPRESSURE",
      message: "Wake output closed before its accepted write drained",
      // A retry inside this child cannot restore its closed parent pipe. The owning broker may
      // restart from the last durable cursor without acknowledging this record.
      retryable: false,
    });
    this.name = "WakeOutputBackpressureError";
  }
}

function waitForOutputDrain(context: CommandContext): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const output = context.runtime.io.stdout;
    const cleanup = (): void => {
      output.off("drain", drained);
      output.off("error", failed);
      output.off("close", failed);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(new WakeOutputBackpressureError());
    };
    output.once("drain", drained);
    output.once("error", failed);
    output.once("close", failed);
    if (output.destroyed || output.writableEnded) failed();
    else if (!output.writableNeedDrain) drained();
  });
}

async function emitRecord(context: CommandContext, record: AgentWakeStreamRecord): Promise<void> {
  // Keep stdout pinned to the strict, body-free protocol even when a projection bug supplies an
  // accidental extra field. A false return means Node accepted the bounded write but needs the
  // producer to pause until `drain`; the realtime transport applies that backpressure upstream.
  if (!writeEvent(context.runtime.io, agentWakeStreamRecordSchema.parse(record))) {
    await waitForOutputDrain(context);
  }
}

function appendConversationKind(
  kinds: Map<string, ConversationKind>,
  conversationId: string,
  kind: ConversationKind,
): void {
  const existing = kinds.get(conversationId);
  if (existing !== undefined && existing !== kind) {
    throw contractError("A conversation changed kind while preparing the wake projection");
  }
  kinds.set(conversationId, kind);
}

function loadConversationKinds(
  bootstrap: AgentWakeBootstrapResponse,
): Map<string, ConversationKind> {
  const kinds = new Map<string, ConversationKind>();
  for (const conversation of bootstrap.conversations) {
    appendConversationKind(kinds, conversation.conversationId, conversation.kind);
  }
  return kinds;
}

function applyConversationProjection(
  event: ProductRealtimeEvent,
  kinds: Map<string, ConversationKind>,
): void {
  if (
    event.type === "channel.created" ||
    event.type === "channel.archived" ||
    event.type === "direct_conversation.created"
  ) {
    appendConversationKind(kinds, event.payload.conversation.id, event.payload.conversation.kind);
  } else if (event.type === "channel.membership_changed") {
    // Membership can grant this agent access to an existing private channel that was absent from
    // bootstrap. The event type itself is authoritative conversation-kind metadata.
    appendConversationKind(kinds, event.conversationId, "channel");
  }
}

export async function wakeCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  if (subcommand !== "watch") {
    throw new UsageError("Usage: hype-comms-cli wake watch --json [--after CURSOR]");
  }
  const parsed = parseCommandArguments(args, { after: { kind: "string" } });
  requirePositionals(parsed, 0);
  if (!context.options.json) {
    throw new UsageError("wake watch requires --json because its output is an NDJSON wake stream");
  }

  const afterOption = stringOption(parsed, "after");
  if (afterOption !== undefined && !sequenceSchema.safeParse(afterOption).success) {
    throw new UsageError("--after must be an unsigned decimal cursor", "INVALID_CURSOR");
  }
  const profile = await resolveProfile(context.runtime, context.options);
  if (profile.credential?.kind !== "agent") {
    throw new UsageError(
      "wake watch requires a profile authenticated with an agent token",
      "AGENT_CREDENTIAL_REQUIRED",
    );
  }
  const client = new ApiClient({
    profile,
    fetch: context.runtime.fetch,
    timeoutMs: context.options.timeoutMs,
  });
  const bootstrap = await client.request({
    path: "/v1/agent-wake/bootstrap",
    responseSchema: agentWakeBootstrapResponseSchema,
  });

  const agentUserId = bootstrap.agentUserId;
  const workspaceId = bootstrap.workspaceId;
  const startCursor = afterOption ?? bootstrap.highWaterCursor;
  const conversationKinds = loadConversationKinds(bootstrap);
  let checkpointCursor = startCursor;

  await watchProductRealtime({
    client,
    origin: profile.apiOrigin,
    after: startCursor,
    timeoutMs: context.options.timeoutMs,
    workspaceId,
    random: context.runtime.random,
    preamble: AGENT_WAKE_REALTIME_PREAMBLE,
    validateConnected(event) {
      if (event.payload.userId !== agentUserId) {
        throw contractError("Realtime connected with the wrong agent identity");
      }
    },
    async onEvent(event) {
      const nextCheckpointCursor = laterCursor(checkpointCursor, event.workspaceSequence);
      if (event.type === "system.connected") {
        await emitRecord(context, {
          version: 1,
          type: "agent.wake.checkpoint",
          workspaceId,
          agentUserId,
          cursor: nextCheckpointCursor,
        });
        checkpointCursor = nextCheckpointCursor;
        return;
      }
      if (event.type === "system.resync_required") {
        await emitRecord(context, {
          version: 1,
          type: "agent.wake.repair_required",
          workspaceId,
          agentUserId,
          cursor: nextCheckpointCursor,
          reason: event.payload.reason,
        });
        checkpointCursor = nextCheckpointCursor;
        return;
      }

      applyConversationProjection(event, conversationKinds);
      if (
        event.type === "message.created" &&
        BigInt(event.workspaceSequence) > BigInt(startCursor)
      ) {
        const conversationKind = conversationKinds.get(event.conversationId);
        if (conversationKind === undefined) {
          throw contractError("A realtime message referenced an unknown conversation");
        }
        const candidate = classifyAgentWake(event, conversationKind, agentUserId);
        if (candidate !== null) {
          await emitRecord(context, createAgentWakeSignal(candidate, deriveAgentWakeId(candidate)));
        }
      }
      await emitRecord(context, {
        version: 1,
        type: "agent.wake.checkpoint",
        workspaceId,
        agentUserId,
        cursor: nextCheckpointCursor,
      });
      checkpointCursor = nextCheckpointCursor;
    },
  });
}
