import { randomUUID } from "node:crypto";

import { realtimeTicketSchema, type SystemConnectedEvent } from "@hmm-chat/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import type { ConsumeRealtimeTicket, RealtimePrincipal } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    realtimePrincipal: RealtimePrincipal | null;
  }
}

interface RealtimeRoutesOptions {
  allowedOrigins: ReadonlySet<string>;
  consumeTicket: ConsumeRealtimeTicket;
}

export const realtimeRoutes: FastifyPluginAsync<RealtimeRoutesOptions> = async (
  app,
  { allowedOrigins, consumeTicket },
) => {
  app.decorateRequest("realtimePrincipal", null);

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

        request.realtimePrincipal = await consumeTicket({
          ticket: result.data,
          origin,
          request,
        });
      },
    },
    (socket, request) => {
      const principal = request.realtimePrincipal;
      if (principal === null) {
        socket.close(1011, "Authentication context unavailable");
        return;
      }

      const event: SystemConnectedEvent = {
        version: 1,
        id: randomUUID(),
        type: "system.connected",
        occurredAt: new Date().toISOString(),
        workspaceId: principal.workspaceId,
        conversationId: null,
        workspaceSequence: principal.workspaceSequence,
        conversationSequence: null,
        entityVersion: 1,
        delivery: "at_least_once",
        payload: {
          connectionId: randomUUID(),
          userId: principal.userId,
        },
      };

      socket.send(JSON.stringify(event));
    },
  );
};
