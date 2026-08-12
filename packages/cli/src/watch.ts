import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  productRealtimeEventSchema,
  realtimeTicketResponseSchema,
  sequenceSchema,
  workspaceBootstrapResponseSchema,
  type ProductRealtimeEvent,
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
  UsageError,
  networkError,
} from "./errors.js";
import { writeEvent, writeResult } from "./output.js";
import type { CommandContext } from "./types.js";

const WATCH_CAPABILITIES = [REACTION_EVENTS_CAPABILITY, READ_STATE_EVENTS_CAPABILITY].join(",");

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

function websocketUrl(origin: string, ticket: string, after: string): string {
  const url = new URL("/v1/realtime", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("after", after);
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

async function streamOneConnection(input: {
  readonly origin: string;
  readonly ticket: string;
  readonly after: string;
  readonly timeoutMs: number;
  readonly workspaceId: string;
  readonly write: (event: ProductRealtimeEvent) => void;
  readonly stopped: () => boolean;
  readonly registerSocket: (socket: WebSocket | undefined) => void;
}): Promise<ConnectionResult> {
  return new Promise<ConnectionResult>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(input.origin, input.ticket, input.after), {
      handshakeTimeout: input.timeoutMs,
      maxPayload: 4 * 1_024 * 1_024,
      perMessageDeflate: false,
    });
    input.registerSocket(socket);
    let cursor = input.after;
    let delivered = false;
    let resyncRequired = false;
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      input.registerSocket(undefined);
      if (error !== undefined) reject(error);
      else resolve({ cursor, delivered });
    };
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        socket.terminate();
        settle(
          new CliError({
            exitCode: EXIT_CONTRACT,
            code: "INVALID_SERVER_CONTRACT",
            message: "The realtime server sent a binary message",
            retryable: false,
          }),
        );
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data.toString("utf8")) as unknown;
      } catch (error) {
        socket.terminate();
        settle(
          new CliError({
            exitCode: EXIT_CONTRACT,
            code: "INVALID_SERVER_CONTRACT",
            message: "The realtime server sent malformed JSON",
            retryable: false,
            cause: error,
          }),
        );
        return;
      }
      const parsed = productRealtimeEventSchema.safeParse(value);
      if (!parsed.success) {
        socket.terminate();
        settle(
          new CliError({
            exitCode: EXIT_CONTRACT,
            code: "INVALID_SERVER_CONTRACT",
            message: "The realtime server sent an invalid event",
            retryable: false,
          }),
        );
        return;
      }
      delivered = true;
      cursor = parsed.data.workspaceSequence;
      input.write(parsed.data);
      if (parsed.data.type === "system.resync_required") {
        resyncRequired = true;
        socket.close(1000);
      }
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      settle(unexpectedStatusError(response.statusCode ?? 500));
    });
    socket.once("error", (error) => {
      if (input.stopped()) settle();
      else settle(networkError(error));
    });
    socket.once("close", (code) => {
      if (input.stopped()) {
        settle();
      } else if (resyncRequired || code === 4009) {
        if (!resyncRequired) {
          const event = productRealtimeEventSchema.parse({
            version: 1,
            id: randomUUID(),
            type: "system.resync_required",
            occurredAt: new Date().toISOString(),
            workspaceId: input.workspaceId,
            conversationId: null,
            workspaceSequence: cursor,
            conversationSequence: null,
            entityVersion: 1,
            delivery: "at_least_once",
            payload: { reason: "cursor_expired" },
          });
          input.write(event);
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
  let cursor = afterOption ?? bootstrap.syncCursor;
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
        const ticket = await client.request({
          method: "POST",
          path: "/v1/realtime/tickets",
          responseSchema: realtimeTicketResponseSchema,
          headers: { "x-hmm-chat-capabilities": WATCH_CAPABILITIES },
        });
        const result = await streamOneConnection({
          origin: profile.apiOrigin,
          ticket: ticket.ticket,
          after: cursor,
          timeoutMs: context.options.timeoutMs,
          workspaceId: bootstrap.workspace.id,
          write(event) {
            cursor = event.workspaceSequence;
            writeEvent(context.runtime.io, event);
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
        const base = Math.min(10_000, 250 * 2 ** Math.min(failures, 6));
        const jitter = Math.floor(base * 0.25 * context.runtime.random());
        await delay(Math.max(base + jitter, requestedRetryDelay));
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    currentSocket?.terminate();
  }
  // A stopped watch is a successful command. This is intentionally silent in JSON mode.
  if (!context.options.json) writeResult(context.runtime.io, { cursor }, false);
}
