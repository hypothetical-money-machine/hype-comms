import { WorkspaceRealtimeClient, workspaceEndpoints as endpoints } from "@hype-comms/api-client";
import {
  WORKSPACE_PROTOCOL_UPGRADE_MESSAGE,
  compareSyncPositions,
  productRealtimeEventSchema,
  syncPositionQuerySchema,
  type ProductRealtimeEvent,
  type SyncPosition,
} from "@hype-comms/contracts";
import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { parseCommandArguments, requirePositionals, stringOption } from "./argv.js";
import { ApiClient } from "./client.js";
import { resolveProfile } from "./config.js";
import {
  CliError,
  EXIT_API,
  EXIT_AUTH,
  EXIT_CONTRACT,
  EXIT_TRANSIENT,
  MAX_RETRY_AFTER_MS,
  UsageError,
} from "./errors.js";
import { EventWriter, writeResult } from "./output.js";
import type { CommandContext } from "./types.js";

/** Builds the body-free repair signal the client emits when it cannot continue from its cursor. */
function syntheticResyncEvent(
  workspaceId: string,
  cursor: SyncPosition,
  reason: "client_replay_overflow" | "cursor_expired",
): ProductRealtimeEvent {
  return productRealtimeEventSchema.parse({
    version: 1,
    id: randomUUID(),
    type: "system.resync_required",
    occurredAt: new Date().toISOString(),
    workspaceId,
    conversationId: null,
    position: cursor,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { reason },
  });
}
class ResyncRequiredError extends CliError {
  constructor() {
    super({
      exitCode: EXIT_API,
      code: "RESYNC_REQUIRED",
      message: "A fresh workspace bootstrap is required",
      retryable: false,
    });
  }
}

export function laterCursor(current: SyncPosition, candidate: SyncPosition): SyncPosition {
  return compareSyncPositions(candidate, current) > 0 ? candidate : current;
}

export interface ProductRealtimeWatchOptions {
  readonly client: ApiClient;
  readonly origin: string;
  readonly after: SyncPosition;
  readonly timeoutMs: number;
  readonly workspaceId: string;
  readonly userId: string;
  readonly signal?: AbortSignal;
  readonly random: () => number;
  readonly onEvent: (event: ProductRealtimeEvent) => void | Promise<void>;
}

function unexpectedStatusError(status: number): CliError {
  if (status === 401 || status === 403) {
    return new CliError({
      exitCode: EXIT_AUTH,
      code: "UNAUTHORIZED",
      message: "Realtime authentication was rejected",
      httpStatus: status,
      retryable: false,
    });
  }
  if (status === 429 || status >= 500) {
    return new CliError({
      exitCode: EXIT_TRANSIENT,
      code: status === 429 ? "RATE_LIMITED" : "SERVER_ERROR",
      message: "The realtime server is temporarily unavailable",
      httpStatus: status,
      retryable: true,
    });
  }
  return new CliError({
    exitCode: EXIT_API,
    code: "REALTIME_REJECTED",
    message: "The realtime connection was rejected",
    httpStatus: status,
    retryable: false,
  });
}

export function watchRetryDelayMs(
  failures: number,
  requestedRetryDelay: number,
  random: () => number,
): number {
  const base = Math.min(10000, 250 * 2 ** Math.min(failures, 6));
  const jitter = Math.floor(base * 0.25 * random());
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(base + jitter, requestedRetryDelay));
}

/**
 * Consume the validated product realtime stream until the process is stopped or the cursor needs
 * repair. Command-specific projections belong in `onEvent`; ticketing, reconnects, cursor resume,
 * and websocket validation stay centralized here so machine consumers cannot drift from `watch`.
 */
export async function watchProductRealtime(
  input: ProductRealtimeWatchOptions,
): Promise<{ readonly cursor: SyncPosition }> {
  let cursor = input.after;
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;
  let finished = false;
  let requestedRetryDelay = 0;
  let incompatibleReason: string | undefined;
  let resolve: (value: { readonly cursor: SyncPosition }) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const result = new Promise<{ readonly cursor: SyncPosition }>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  const finish = (error?: unknown): void => {
    if (finished) return;
    finished = true;
    stopped = true;
    realtime.resetSession();
    void tail.then(() => (error === undefined ? resolve({ cursor }) : reject(error)), reject);
  };
  const enqueue = (event: ProductRealtimeEvent): void => {
    const delivery = tail.then(async () => {
      await input.onEvent(event);
      // Only successful output delivery acknowledges the position used for reconnect.
      if (event.type !== "system.resync_required") {
        cursor = laterCursor(cursor, event.position);
        realtime.acknowledge({ scope, cursor });
      }
      if (event.type === "system.resync_required") finish(new ResyncRequiredError());
    });
    tail = delivery.catch((error) => {
      finish(error);
      throw error;
    });
    // finish owns the rejected result; attach immediately while output may still be pending.
    void tail.catch(() => undefined);
  };
  const realtime = new WorkspaceRealtimeClient({
    apiOrigin: input.origin,
    clientOrigin: input.origin,
    transport: { ticket: (signal) => input.client.request({ ...endpoints.ticket(), signal }) },
    createSocket: (url, options) =>
      new WebSocket(url, {
        ...options,
        handshakeTimeout: input.timeoutMs,
        perMessageDeflate: false,
      }),
    reconnectDelay: (failures) => {
      const result = watchRetryDelayMs(failures, requestedRetryDelay, input.random);
      requestedRetryDelay = 0;
      return result;
    },
    onEvent({ event }) {
      if (stopped) return false;
      enqueue(event);
      return true;
    },
    onDrop(reason) {
      incompatibleReason = reason;
    },
    onState(state) {
      if (state === "incompatible")
        finish(
          new CliError({
            exitCode: EXIT_CONTRACT,
            code:
              incompatibleReason === "protocol-mismatch"
                ? "UPGRADE_REQUIRED"
                : "INVALID_SERVER_CONTRACT",
            message:
              incompatibleReason === "protocol-mismatch"
                ? WORKSPACE_PROTOCOL_UPGRADE_MESSAGE
                : "The realtime server sent an incompatible event",
            retryable: false,
          }),
        );
    },
    onFailure(failure) {
      if (failure.kind === "ticket") {
        if (failure.error instanceof CliError && failure.error.retryable) {
          requestedRetryDelay = failure.error.retryAfterMs ?? 0;
          return false;
        }
        finish(failure.error);
        return true;
      }
      if (failure.kind === "handshake") {
        const error = unexpectedStatusError(failure.status);
        if (error.retryable) return false;
        finish(error);
        return true;
      }
      if (failure.kind === "invalid_frame") {
        finish(
          new CliError({
            exitCode: EXIT_CONTRACT,
            code: "INVALID_SERVER_CONTRACT",
            message: "The realtime server sent an invalid event",
            retryable: false,
          }),
        );
        return true;
      }
      if (failure.code === 4009) {
        enqueue(syntheticResyncEvent(input.workspaceId, cursor, "cursor_expired"));
        return true;
      }
      if (failure.code === 4401 || failure.code === 4403) {
        finish(
          new CliError({
            exitCode: EXIT_AUTH,
            code: "REALTIME_AUTH_REVOKED",
            message: "Realtime access was revoked",
            retryable: false,
          }),
        );
        return true;
      }
      return false;
    },
  });
  const scope = realtime.prepare({
    after: input.after,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  const stop = (): void => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  input.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (input.signal?.aborted === true) stop();
    else realtime.activate(scope);
    return await result;
  } finally {
    input.signal?.removeEventListener("abort", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    realtime.resetSession();
  }
}

export async function watchCommand(
  context: CommandContext,
  args: readonly string[],
): Promise<void> {
  const parsed = parseCommandArguments(args, {
    after: { kind: "string" },
  });
  requirePositionals(parsed, 0);
  if (!context.options.json) {
    throw new UsageError("watch requires --json because its output is an NDJSON event stream");
  }
  const profile = await resolveProfile(context.runtime, context.options);
  const client = new ApiClient({
    profile,
    fetch: context.runtime.fetch,
    timeoutMs: context.options.timeoutMs,
  });
  const afterOption = stringOption(parsed, "after");
  if (afterOption !== undefined && !syncPositionQuerySchema.safeParse(afterOption).success) {
    throw new UsageError(
      "--after must be a JSON position with epoch and sequence",
      "INVALID_CURSOR",
    );
  }
  const bootstrap = await client.request({ ...endpoints.bootstrap() });
  const writer = new EventWriter(context.runtime.io.stdout);
  try {
    const { cursor } = await watchProductRealtime({
      client,
      origin: profile.apiOrigin,
      after:
        afterOption === undefined
          ? bootstrap.syncCursor
          : syncPositionQuerySchema.parse(afterOption),
      timeoutMs: context.options.timeoutMs,
      workspaceId: bootstrap.workspace.id,
      userId: bootstrap.currentUser.user.id,
      random: context.runtime.random,
      onEvent: (event) => writer.write(event),
    });
    // A stopped watch is a successful command. This is intentionally silent in JSON mode.
    if (!context.options.json) writeResult(context.runtime.io, { cursor }, false);
  } finally {
    writer.dispose();
  }
}
