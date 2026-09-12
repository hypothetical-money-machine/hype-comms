import { randomUUID } from "node:crypto";

import {
  clientEphemeralActivityFrameSchema,
  realtimeConnectionQuerySchema,
  type ClientEphemeralActivityFrame,
  type EphemeralActivityFrame,
  type SyncResponse,
  type SystemConnectedEvent,
} from "@hype-comms/contracts";
import { routeModule, validateRequest } from "../../http/route-registrar.js";

import { DomainError } from "../../domain-errors.js";
import { ApiError } from "../../errors.js";
import type { MetricsRegistry } from "../../metrics.js";
import type { EphemeralActivityHub } from "./activity-hub.js";
import type {
  ConsumeRealtimeTicket,
  RealtimePrincipal,
  RevalidateRealtimePrincipal,
} from "./auth.js";

/** Close code telling the client to re-authenticate rather than reconnect with a stale session. */
export const REALTIME_SESSION_REVOKED_CLOSE_CODE = 4401;
const HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_MAX_PAYLOAD_BYTES = 1_024;
const ACTIVITY_BACKPRESSURE_BYTES = 64 * 1_024;

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

export const realtimeRoutes = routeModule<RealtimeRoutesOptions>(
  (
    routes,
    { allowedOrigins, consumeTicket, loadEvents, subscribe, revalidate, activityHub, metrics },
  ) => {
    routes.websocket({
      url: "/realtime",
      scopes: [],
      beforeAuthentication: ({ request }) => {
        const origin = request.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) {
          throw new ApiError(403, "FORBIDDEN", "Origin is not allowed");
        }
      },
      request: {
        query: validateRequest(realtimeConnectionQuerySchema, (_value, error) => {
          if (error.issues.some((issue) => issue.path[0] === "ticket")) {
            return new ApiError(401, "UNAUTHORIZED", "A valid realtime ticket is required");
          }
          if (error.issues.some((issue) => issue.path[0] === "after")) {
            return new ApiError(400, "BAD_REQUEST", "A valid realtime cursor is required");
          }
          return new ApiError(400, "BAD_REQUEST", "Unsupported realtime connection option");
        }),
      },
      policy: {
        name: "single-use-realtime-ticket",
        // CLI sockets have no Origin. Browser tickets are protected by CORS at issuance and
        // the Origin allowlist above; all tickets remain single-use and expire in 30 seconds.
        authenticate: ({ query }, request) =>
          consumeTicket({ ticket: query.ticket, origin: request.headers.origin, request }),
      },
      handler: (socket, { identity: principal, input: { query }, request }) => {
        const initialCursor = query.after;
        metrics?.realtimeConnected();

        let cursor = initialCursor;
        let closed = false;
        let flushing = false;
        let flushAgain = false;
        let connectedSent = false;
        let pongReceived = true;
        let initialRevalidationComplete = false;
        let agentAuthorizationReadyForPage = false;
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
          void handleActivity(frame)
            .catch((error: unknown) => {
              // A failed authorization read drops one lossy hint; it must not become an unhandled
              // rejection that terminates the process.
              request.log.warn({ err: error }, "Dropped an ephemeral activity frame");
            })
            .finally(() => {
              activityProcessing = false;
              drainActivity();
            });
        };

        const sendConnected = (): boolean => {
          if (connectedSent) return !closed && socket.readyState === 1;
          if (closed || socket.readyState !== 1) return false;
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
          if (activityHub !== undefined) {
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
          return true;
        };

        const revalidatePrincipal = async (): Promise<boolean> => {
          if (closed || socket.readyState !== 1) return false;
          if (revalidate === undefined) {
            if (principal.agentTokenId === null) return true;
            request.log.error(
              { userId: principal.userId },
              "Closing an agent realtime socket because revalidation is unavailable",
            );
            socket.close(1011, "Authorization unavailable");
            return false;
          }
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
            request.log.error({ err: error }, "Realtime session revalidation failed");
            if (principal.agentTokenId === null) {
              // Preserve the existing human-session availability tradeoff. Agent
              // sockets fail closed because a stale credential must never receive events.
              return true;
            }
            if (!closed && socket.readyState === 1) {
              socket.close(1011, "Authorization unavailable");
            }
            return false;
          }
        };

        // Heartbeats and deliveries share one queue, so their credential checks never overlap. A
        // notified flush waits behind an active heartbeat check, and a coalesced follow-up flush
        // performs its own later check.
        let revalidationTail: Promise<void> = Promise.resolve();
        const serializedRevalidatePrincipal = (): Promise<boolean> => {
          const current = revalidationTail.then(revalidatePrincipal);
          revalidationTail = current.then(
            () => undefined,
            () => undefined,
          );
          return current;
        };

        const loadAgentPage = async (): Promise<SyncResponse | null> => {
          if (loadEvents === undefined) return null;
          if (agentAuthorizationReadyForPage) {
            agentAuthorizationReadyForPage = false;
            return loadEvents(principal, cursor);
          }

          // Loading and authorization are independent database reads. Overlap them to avoid adding
          // their latencies while still withholding every byte until this page's check resolves valid.
          const authorization = serializedRevalidatePrincipal();
          const loaded = loadEvents(principal, cursor).then(
            (response) => ({ status: "loaded" as const, response }),
            (error: unknown) => ({ status: "failed" as const, error }),
          );
          if (!(await authorization)) return null;
          const outcome = await loaded;
          if (outcome.status === "failed") throw outcome.error;
          return outcome.response;
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
                if (principal.agentTokenId === null) {
                  response = await loadEvents(principal, cursor);
                } else {
                  // The initial connection check authorizes page one. Every later page and notified
                  // flush performs its own check, concurrent with loading but complete before send.
                  const authorizedResponse = await loadAgentPage();
                  if (authorizedResponse === null) return;
                  response = authorizedResponse;
                }
                for (const event of response.events) {
                  if (socket.readyState !== 1) return;
                  socket.send(JSON.stringify(event));
                }
                cursor = response.nextCursor;
              } while (response.hasMore && !closed);

              // Clients hold replay until the user-bound handshake, then apply it while
              // notifications are disarmed. Every agent page remains withheld until authorized.
              sendConnected();
            } while (flushAgain && !closed);
          } catch (error) {
            if (error instanceof DomainError && error.kind === "sync_position_expired") {
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

        const heartbeat = setInterval(() => {
          if (!pongReceived) {
            socket.terminate();
            return;
          }
          void serializedRevalidatePrincipal();
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
        void serializedRevalidatePrincipal().then((mayReplay) => {
          if (!mayReplay || closed || socket.readyState !== 1) return;
          initialRevalidationComplete = true;
          agentAuthorizationReadyForPage = principal.agentTokenId !== null;
          void flush();
        });
      },
    });
  },
);
