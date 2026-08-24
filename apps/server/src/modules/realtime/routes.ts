import { randomUUID } from "node:crypto";

import {
  clientEphemeralActivityFrameSchema,
  realtimeTicketSchema,
  sequenceSchema,
  type ClientEphemeralActivityFrame,
  type EphemeralActivityFrame,
  type SyncResponse,
  type SystemConnectedEvent,
} from "@hype-comms/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import type { MetricsRegistry } from "../../metrics.js";
import type {
  ConsumeRealtimeTicket,
  RealtimePrincipal,
  RevalidateRealtimePrincipal,
} from "./auth.js";
import type { EphemeralActivityHub } from "./activity-hub.js";

/** Close code telling the client to re-authenticate rather than reconnect with a stale session. */
export const REALTIME_SESSION_REVOKED_CLOSE_CODE = 4401;
const HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_MAX_PAYLOAD_BYTES = 1_024;
const ACTIVITY_BACKPRESSURE_BYTES = 64 * 1_024;

declare module "fastify" {
  interface FastifyRequest {
    realtimePrincipal: RealtimePrincipal | null;
    realtimeCursor: string | null;
  }
}

interface RealtimeRoutesOptions {
  allowedOrigins: ReadonlySet<string>;
  consumeTicket: ConsumeRealtimeTicket;
  loadEvents?: (principal: RealtimePrincipal, after: string) => Promise<SyncResponse>;
  subscribe?: (workspaceId: string, listener: () => void) => () => void;
  /** Re-checks the bound session/token and membership of an already-connected socket. */
  revalidate?: RevalidateRealtimePrincipal;
  activityHub?: EphemeralActivityHub;
  metrics?: MetricsRegistry;
}

export const realtimeRoutes: FastifyPluginAsync<RealtimeRoutesOptions> = async (
  app,
  { allowedOrigins, consumeTicket, loadEvents, subscribe, revalidate, activityHub, metrics },
) => {
  app.decorateRequest("realtimePrincipal", null);
  app.decorateRequest("realtimeCursor", null);

  app.get(
    "/realtime",
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) {
          throw new ApiError(403, "FORBIDDEN", "Origin is not allowed");
        }

        const result = realtimeTicketSchema.safeParse(
          (request.query as { ticket?: unknown }).ticket,
        );
        if (!result.success) {
          throw new ApiError(401, "UNAUTHORIZED", "A valid realtime ticket is required");
        }
        const cursor = sequenceSchema.safeParse((request.query as { after?: unknown }).after);
        if (!cursor.success) {
          throw new ApiError(400, "BAD_REQUEST", "A valid realtime cursor is required");
        }

        // An absent Origin is accepted for human and agent tickets alike. Requiring it here would
        // break every non-browser client that holds a human session -- `hype-comms-cli watch` opens
        // its socket through `ws`, which sends no Origin -- and it buys little: a hostile page
        // cannot obtain a human ticket to replay, because `POST /v1/realtime/tickets` sits behind
        // the CORS policy in app.ts, which rejects an unrecognized origin outright rather than
        // merely withholding response headers. Tickets are additionally single-use and expire in
        // 30s. Browsers cannot forge Origin, so the allowlist check above still constrains them.
        const principal = await consumeTicket({
          ticket: result.data,
          origin,
          request,
        });
        request.realtimePrincipal = principal;
        request.realtimeCursor = cursor.data;
      },
    },
    (socket, request) => {
      const principal = request.realtimePrincipal;
      const initialCursor = request.realtimeCursor;
      if (principal === null || initialCursor === null) {
        socket.close(1011, "Authentication context unavailable");
        return;
      }
      metrics?.realtimeConnected();

      let cursor = initialCursor;
      let closed = false;
      let flushing = false;
      let flushAgain = false;
      let connectedSent = false;
      let pongReceived = true;
      let initialRevalidationComplete = false;
      const activityConnectionId = randomUUID();
      let activityRegistered = false;
      let desiredPresence: "online" | "away" = "online";
      let activityProcessing = false;
      let pendingActivity: ClientEphemeralActivityFrame | null = null;

      const sendActivity = (frame: EphemeralActivityFrame): boolean => {
        if (
          closed ||
          socket.readyState !== 1 ||
          socket.bufferedAmount > ACTIVITY_BACKPRESSURE_BYTES
        ) {
          return false;
        }
        try {
          socket.send(JSON.stringify(frame));
          return true;
        } catch {
          return false;
        }
      };

      const handleActivity = async (frame: ClientEphemeralActivityFrame): Promise<void> => {
        if (frame.type === "activity.presence.set") {
          desiredPresence = frame.state;
          if (activityRegistered) activityHub?.setPresence(activityConnectionId, frame.state);
          return;
        }
        if (!activityRegistered) return;
        await activityHub?.setTyping(activityConnectionId, frame.conversationId, frame.typing);
      };

      const drainActivity = (): void => {
        if (activityProcessing || pendingActivity === null || closed) return;
        const frame = pendingActivity;
        pendingActivity = null;
        activityProcessing = true;
        void handleActivity(frame).finally(() => {
          activityProcessing = false;
          drainActivity();
        });
      };

      const sendConnected = (): void => {
        if (connectedSent || socket.readyState !== 1) return;
        connectedSent = true;
        const event: SystemConnectedEvent = {
          version: 1,
          id: randomUUID(),
          type: "system.connected",
          occurredAt: new Date().toISOString(),
          workspaceId: principal.workspaceId,
          conversationId: null,
          workspaceSequence: cursor,
          conversationSequence: null,
          entityVersion: 1,
          delivery: "at_least_once",
          payload: {
            connectionId: activityConnectionId,
            userId: principal.userId,
          },
        };
        socket.send(JSON.stringify(event));
        if (activityHub !== undefined && principal.ephemeralActivity) {
          activityHub.register(
            {
              id: activityConnectionId,
              principal,
              send: sendActivity,
            },
            desiredPresence,
          );
          activityRegistered = true;
        }
      };

      const flush = async (): Promise<void> => {
        if (closed || !initialRevalidationComplete) return;
        if (flushing) {
          flushAgain = true;
          return;
        }
        flushing = true;
        try {
          do {
            flushAgain = false;
            if (loadEvents === undefined) {
              sendConnected();
              return;
            }
            let response: SyncResponse;
            do {
              response = await loadEvents(principal, cursor);
              for (const event of response.events) {
                if (socket.readyState !== 1) return;
                socket.send(JSON.stringify(event));
              }
              cursor = response.nextCursor;
            } while (response.hasMore && !closed);
            sendConnected();
          } while (flushAgain && !closed);
        } catch (error) {
          if (error instanceof ApiError && error.code === "CURSOR_EXPIRED") {
            if (socket.readyState === 1) {
              socket.send(
                JSON.stringify({
                  version: 1,
                  id: randomUUID(),
                  type: "system.resync_required",
                  occurredAt: new Date().toISOString(),
                  workspaceId: principal.workspaceId,
                  conversationId: null,
                  workspaceSequence: cursor,
                  conversationSequence: null,
                  entityVersion: 1,
                  delivery: "at_least_once",
                  payload: { reason: "cursor_expired" },
                }),
              );
              socket.close(4009, "Resync required");
            }
            return;
          }
          request.log.error({ err: error }, "Realtime event replay failed");
          socket.close(1011, "Realtime delivery failed");
        } finally {
          flushing = false;
        }
      };

      const unsubscribe = subscribe?.(principal.workspaceId, () => {
        void flush();
      });
      const revalidatePrincipal = async (): Promise<boolean> => {
        if (revalidate === undefined) return true;
        try {
          const result = await revalidate(principal);
          if (result.status === "valid") return true;
          if (closed || socket.readyState !== 1) return false;
          request.log.warn(
            { reason: result.reason, userId: principal.userId },
            "Closing a realtime socket whose session is no longer authorized",
          );
          socket.close(REALTIME_SESSION_REVOKED_CLOSE_CODE, "Session revoked");
          return false;
        } catch (error) {
          // A transient database failure must not sign a healthy device out.
          request.log.error({ err: error }, "Realtime session revalidation failed");
          return true;
        }
      };

      const heartbeat = setInterval(() => {
        if (!pongReceived) {
          socket.terminate();
          return;
        }
        void revalidatePrincipal();
        pongReceived = false;
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      let tornDown = false;
      const teardown = (): void => {
        if (tornDown) return;
        tornDown = true;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        if (activityRegistered) activityHub?.disconnect(activityConnectionId);
        activityRegistered = false;
        metrics?.realtimeDisconnected();
      };

      socket.on("message", (data) => {
        if (!principal.ephemeralActivity) return;
        const serialized = data.toString();
        if (Buffer.byteLength(serialized) > ACTIVITY_MAX_PAYLOAD_BYTES) {
          socket.close(1002, "Invalid activity frame");
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(serialized);
        } catch {
          socket.close(1002, "Invalid activity frame");
          return;
        }
        const parsed = clientEphemeralActivityFrameSchema.safeParse(input);
        if (!parsed.success) {
          socket.close(1002, "Invalid activity frame");
          return;
        }
        // Keep at most the latest unprocessed activity frame. Typing refreshes are hints, and a
        // dropped stop is bounded by both server and client TTLs, so queue growth is never useful.
        pendingActivity = parsed.data;
        drainActivity();
      });
      socket.on("pong", () => {
        pongReceived = true;
      });
      socket.once("close", teardown);
      socket.once("error", teardown);
      void revalidatePrincipal().then((mayReplay) => {
        if (!mayReplay || closed || socket.readyState !== 1) return;
        initialRevalidationComplete = true;
        void flush();
      });
    },
  );
};
