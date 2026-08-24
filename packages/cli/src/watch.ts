import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  ATTACHMENTS_CAPABILITY,
  MESSAGE_RETRACT_EVENTS_CAPABILITY,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  productRealtimeEventSchema,
  realtimeTicketResponseSchema,
  sequenceSchema,
  workspaceBootstrapResponseSchema,
  type AGENT_WAKE_REALTIME_PREAMBLE,
  type ProductRealtimeEvent,
  type SystemConnectedEvent,
} from "@hype-comms/contracts";
import WebSocket, { type RawData } from "ws";

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
  networkError,
} from "./errors.js";
import { writeEvent, writeResult } from "./output.js";
import type { CommandContext } from "./types.js";

/** Builds the body-free repair signal the client emits when it cannot continue from its cursor. */
function syntheticResyncEvent(
  workspaceId: string,
  cursor: string,
  reason: "client_replay_overflow" | "cursor_expired",
): ProductRealtimeEvent {
  return productRealtimeEventSchema.parse({
    version: 1,
    id: randomUUID(),
    type: "system.resync_required",
    occurredAt: new Date().toISOString(),
    workspaceId,
    conversationId: null,
    workspaceSequence: cursor,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { reason },
  });
}

// Negotiated on the ticket request, which is where a websocket connection
// settles its capabilities; the socket upgrade itself carries no headers.
// participated-thread-notifications-v1 subscribes to nothing new: a watcher
// already receives every message.created event for the conversations it
// belongs to. It only asks the server to annotate the thread replies that land
// in threads this principal has already written in, which is the difference
// between a bot that can answer a follow-up and one that has to keep its own
// ledger of where it has spoken.
const WATCH_CAPABILITIES = [
  ATTACHMENTS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  MESSAGE_RETRACT_EVENTS_CAPABILITY,
].join(",");
const PRODUCT_REALTIME_MAX_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
export const PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT = 1_024;
export const PRODUCT_REALTIME_PENDING_REPLAY_BYTE_LIMIT = 4 * 1_024 * 1_024;

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

interface ConnectionResult {
  readonly cursor: string;
  readonly delivered: boolean;
}

export function laterCursor(current: string, candidate: string): string {
  return BigInt(candidate) > BigInt(current) ? candidate : current;
}

export interface ProductRealtimeWatchOptions {
  readonly client: ApiClient;
  readonly origin: string;
  readonly after: string;
  readonly timeoutMs: number;
  readonly workspaceId: string;
  readonly random: () => number;
  readonly capabilities?: string;
  /** Requests the Wake-only, requested-cursor handshake before authorized replay begins. */
  readonly preamble?: typeof AGENT_WAKE_REALTIME_PREAMBLE;
  /** Validates the user-bound handshake before any buffered replay is exposed to the projection. */
  readonly validateConnected?: (event: SystemConnectedEvent) => void;
  readonly onEvent: (event: ProductRealtimeEvent) => void | Promise<void>;
}

function websocketUrl(
  origin: string,
  ticket: string,
  after: string,
  preamble: typeof AGENT_WAKE_REALTIME_PREAMBLE | undefined,
): string {
  const url = new URL("/v1/realtime", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("after", after);
  if (preamble !== undefined) url.searchParams.set("preamble", preamble);
  return url.toString();
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
  const base = Math.min(10_000, 250 * 2 ** Math.min(failures, 6));
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
): Promise<{ readonly cursor: string }> {
  let cursor = input.after;
  let stopped = false;
  let currentSocket: WebSocket | undefined;
  const stop = (): void => {
    stopped = true;
    currentSocket?.close(1000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let failures = 0;
  let requestedRetryDelay: number;
  try {
    while (!stopped) {
      try {
        const ticket = await input.client.request({
          method: "POST",
          path: "/v1/realtime/tickets",
          responseSchema: realtimeTicketResponseSchema,
          ...(input.capabilities === undefined
            ? {}
            : { headers: { "x-hype-comms-capabilities": input.capabilities } }),
        });
        const result = await streamOneConnection({
          origin: input.origin,
          ticket: ticket.ticket,
          after: cursor,
          timeoutMs: input.timeoutMs,
          workspaceId: input.workspaceId,
          preamble: input.preamble,
          validateConnected: input.validateConnected,
          async write(event) {
            await input.onEvent(event);
            cursor = laterCursor(cursor, event.workspaceSequence);
          },
          stopped: () => stopped,
          registerSocket(socket) {
            currentSocket = socket;
          },
        });
        cursor = result.cursor;
        failures = result.delivered ? 0 : failures + 1;
        requestedRetryDelay = 0;
      } catch (error) {
        if (error instanceof ResyncRequiredError) throw error;
        if (!(error instanceof CliError) || !error.retryable) throw error;
        requestedRetryDelay = error.retryAfterMs ?? 0;
        failures += 1;
      }
      if (!stopped) {
        await delay(watchRetryDelayMs(failures, requestedRetryDelay, input.random));
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    currentSocket?.terminate();
  }
  return { cursor };
}

async function streamOneConnection(input: {
  readonly origin: string;
  readonly ticket: string;
  readonly after: string;
  readonly timeoutMs: number;
  readonly workspaceId: string;
  readonly preamble: typeof AGENT_WAKE_REALTIME_PREAMBLE | undefined;
  readonly validateConnected: ((event: SystemConnectedEvent) => void) | undefined;
  readonly write: (event: ProductRealtimeEvent) => void | Promise<void>;
  readonly stopped: () => boolean;
  readonly registerSocket: (socket: WebSocket | undefined) => void;
}): Promise<ConnectionResult> {
  return new Promise<ConnectionResult>((resolve, reject) => {
    const socket = new WebSocket(
      websocketUrl(input.origin, input.ticket, input.after, input.preamble),
      {
        handshakeTimeout: input.timeoutMs,
        maxPayload: PRODUCT_REALTIME_MAX_PAYLOAD_BYTES,
        perMessageDeflate: false,
      },
    );
    input.registerSocket(socket);
    let cursor = input.after;
    let delivered = false;
    let connected = false;
    let resyncRequired = false;
    let settled = false;
    const pendingReplay: ProductRealtimeEvent[] = [];
    let pendingReplayBytes = 0;
    let queuedMessages = 0;
    let messageTail: Promise<void> = Promise.resolve();
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      pendingReplay.length = 0;
      pendingReplayBytes = 0;
      input.registerSocket(undefined);
      if (error !== undefined) reject(error);
      else resolve({ cursor, delivered });
    };
    const rejectContract = (message: string, cause?: unknown): void => {
      socket.terminate();
      settle(
        new CliError({
          exitCode: EXIT_CONTRACT,
          code: "INVALID_SERVER_CONTRACT",
          message,
          retryable: false,
          cause,
        }),
      );
    };
    const deliver = async (event: ProductRealtimeEvent): Promise<boolean> => {
      try {
        await input.write(event);
        delivered = true;
        cursor = laterCursor(cursor, event.workspaceSequence);
        return true;
      } catch (error) {
        socket.terminate();
        settle(error);
        return false;
      }
    };
    const handleMessage = async (data: RawData, isBinary: boolean): Promise<void> => {
      if (settled) return;
      if (isBinary) {
        rejectContract("The realtime server sent a binary message");
        return;
      }
      const serialized = data.toString("utf8");
      const frameBytes = Buffer.byteLength(serialized);
      let value: unknown;
      try {
        value = JSON.parse(serialized) as unknown;
      } catch (error) {
        rejectContract("The realtime server sent malformed JSON", error);
        return;
      }
      const parsed = productRealtimeEventSchema.safeParse(value);
      if (!parsed.success) {
        rejectContract("The realtime server sent an invalid event");
        return;
      }
      const event = parsed.data;
      if (event.workspaceId !== input.workspaceId) {
        rejectContract("Realtime sent an event for the wrong workspace");
        return;
      }

      if (event.type === "system.connected") {
        if (connected) {
          rejectContract("Realtime sent more than one connection event");
          return;
        }
        connected = true;
        // Legacy servers and non-preamble connections send authorized initial replay before the
        // user-bound handshake. Keep those frames private and bounded until identity validation.
        // Release replay before its high-water handshake so a durable consumer cannot checkpoint
        // past an event it has not received yet.
        try {
          input.validateConnected?.(event);
        } catch (error) {
          socket.terminate();
          settle(error);
          return;
        }
        for (const replayEvent of pendingReplay) {
          if (!(await deliver(replayEvent))) return;
        }
        pendingReplay.length = 0;
        pendingReplayBytes = 0;
        if (!(await deliver(event))) return;
        return;
      }

      if (!connected) {
        if (event.type === "system.resync_required") {
          // Cursor recovery is body-free and may replace the handshake. Never release a partial
          // replay when the server could not establish its authoritative boundary.
          pendingReplay.length = 0;
          pendingReplayBytes = 0;
          if (!(await deliver(event))) return;
          resyncRequired = true;
          socket.close(1000);
          return;
        }
        if (
          pendingReplay.length >= PRODUCT_REALTIME_PENDING_REPLAY_EVENT_LIMIT ||
          pendingReplayBytes + frameBytes > PRODUCT_REALTIME_PENDING_REPLAY_BYTE_LIMIT
        ) {
          // This is a local capacity limit rather than malformed server data. Discard the
          // unvalidated replay and surface the same body-free repair signal used by the desktop
          // realtime client so durable consumers can reset deliberately from their last cursor.
          pendingReplay.length = 0;
          pendingReplayBytes = 0;
          const event = syntheticResyncEvent(input.workspaceId, cursor, "client_replay_overflow");
          if (!(await deliver(event))) return;
          socket.terminate();
          settle(new ResyncRequiredError());
          return;
        }
        pendingReplay.push(event);
        pendingReplayBytes += frameBytes;
        return;
      }

      if (!(await deliver(event))) return;
      if (event.type === "system.resync_required") {
        resyncRequired = true;
        socket.close(1000);
      }
    };
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (settled) return;
      queuedMessages += 1;
      socket.pause();
      const handling = messageTail.then(() => handleMessage(data, isBinary));
      messageTail = handling.then(
        () => undefined,
        (error: unknown) => {
          socket.terminate();
          settle(error);
        },
      );
      void messageTail.then(() => {
        queuedMessages -= 1;
        if (queuedMessages === 0 && !settled) socket.resume();
      });
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      settle(unexpectedStatusError(response.statusCode ?? 500));
    });
    socket.once("error", (error) => {
      void messageTail.then(() => {
        if (settled) return;
        if (input.stopped()) settle();
        else settle(networkError(error));
      });
    });
    socket.once("close", (code) => {
      void messageTail.then(async () => {
        if (settled) return;
        if (input.stopped()) {
          settle();
          return;
        }
        if (resyncRequired || code === 4009) {
          if (!resyncRequired) {
            const event = syntheticResyncEvent(input.workspaceId, cursor, "cursor_expired");
            try {
              await input.write(event);
            } catch (error) {
              settle(error);
              return;
            }
          }
          settle(new ResyncRequiredError());
        } else if (code === 4401 || code === 4403) {
          settle(
            new CliError({
              exitCode: EXIT_AUTH,
              code: "REALTIME_AUTH_REVOKED",
              message: "Realtime access was revoked",
              retryable: false,
            }),
          );
        } else {
          settle();
        }
      });
    });
  });
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
  if (afterOption !== undefined && !sequenceSchema.safeParse(afterOption).success) {
    throw new UsageError("--after must be an unsigned decimal cursor", "INVALID_CURSOR");
  }
  const bootstrap = await client.request({
    path: "/v1/bootstrap",
    responseSchema: workspaceBootstrapResponseSchema,
  });
  const { cursor } = await watchProductRealtime({
    client,
    origin: profile.apiOrigin,
    after: afterOption ?? bootstrap.syncCursor,
    timeoutMs: context.options.timeoutMs,
    workspaceId: bootstrap.workspace.id,
    random: context.runtime.random,
    capabilities: WATCH_CAPABILITIES,
    onEvent(event) {
      writeEvent(context.runtime.io, event);
    },
  });
  // A stopped watch is a successful command. This is intentionally silent in JSON mode.
  if (!context.options.json) writeResult(context.runtime.io, { cursor }, false);
}
