import {
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
      message: "Wake output reached its bounded stream capacity",
      // The owning broker restarts the process from its durable cursor. Retrying inside this
      // process while stdout remains blocked would only create another buffered record.
      retryable: false,
    });
    this.name = "WakeOutputBackpressureError";
  }
}

function emitRecord(context: CommandContext, record: AgentWakeStreamRecord): void {
  // Keep stdout pinned to the strict, body-free protocol even when a projection bug supplies an
  // accidental extra field. Stop consuming realtime as soon as Node signals pipe backpressure;
  // natural process shutdown drains at most the stream high-water mark, and the durable parent
  // restarts from its last acknowledged cursor.
  if (!writeEvent(context.runtime.io, agentWakeStreamRecordSchema.parse(record))) {
    throw new WakeOutputBackpressureError();
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
    validateConnected(event) {
      if (event.payload.userId !== agentUserId) {
        throw contractError("Realtime connected with the wrong agent identity");
      }
    },
    onEvent(event) {
      checkpointCursor = laterCursor(checkpointCursor, event.workspaceSequence);
      if (event.type === "system.connected") {
        emitRecord(context, {
          version: 1,
          type: "agent.wake.checkpoint",
          workspaceId,
          agentUserId,
          cursor: checkpointCursor,
        });
        return;
      }
      if (event.type === "system.resync_required") {
        emitRecord(context, {
          version: 1,
          type: "agent.wake.repair_required",
          workspaceId,
          agentUserId,
          cursor: checkpointCursor,
          reason: event.payload.reason,
        });
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
          emitRecord(context, createAgentWakeSignal(candidate, deriveAgentWakeId(candidate)));
        }
      }
      emitRecord(context, {
        version: 1,
        type: "agent.wake.checkpoint",
        workspaceId,
        agentUserId,
        cursor: checkpointCursor,
      });
    },
  });
}
