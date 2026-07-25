import { randomUUID } from "node:crypto";

import {
  realtimeTicketSchema,
  sequenceSchema,
  type SyncResponse,
  type SystemConnectedEvent,
} from "@hmm-chat/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import type { ConsumeRealtimeTicket, RealtimePrincipal } from "./auth.js";

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
}

export const realtimeRoutes: FastifyPluginAsync<RealtimeRoutesOptions> = async (
  app,
  { allowedOrigins, consumeTicket, loadEvents, subscribe },
) => {
  app.decorateRequest("realtimePrincipal", null);
  app.decorateRequest("realtimeCursor", null);

  app.get(
    "/realtime",
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin === undefined || !allowedOrigins.has(origin)) {
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

        request.realtimePrincipal = await consumeTicket({
          ticket: result.data,
          origin,
          request,
        });
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

      let cursor = initialCursor;
      let closed = false;
      let flushing = false;
      let flushAgain = false;
      let connectedSent = false;
      let pongReceived = true;

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
            connectionId: randomUUID(),
            userId: principal.userId,
          },
        };
        socket.send(JSON.stringify(event));
      };

      const flush = async (): Promise<void> => {
        if (closed) return;
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
      const heartbeat = setInterval(() => {
        if (!pongReceived) {
          socket.terminate();
          return;
        }
        pongReceived = false;
        socket.ping();
      }, 30_000);

      socket.on("pong", () => {
        pongReceived = true;
      });
      socket.once("close", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
      });
      socket.once("error", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
      });
      void flush();
    },
  );
};
