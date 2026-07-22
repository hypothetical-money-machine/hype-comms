import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";

import { ApiError, registerErrorHandling } from "./errors.js";
import { Lifecycle } from "./lifecycle.js";
import { denyRealtimeTickets, type ConsumeRealtimeTicket } from "./modules/realtime/auth.js";
import { realtimeRoutes } from "./modules/realtime/routes.js";
import { systemRoutes } from "./modules/system/routes.js";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly lifecycle?: Lifecycle;
  readonly allowedOrigins?: readonly string[];
  readonly consumeRealtimeTicket?: ConsumeRealtimeTicket;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const lifecycle = options.lifecycle ?? new Lifecycle();
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  const app = Fastify({
    logger: options.logger ?? false,
  });

  registerErrorHandling(app);
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (origin === undefined) {
        callback(null, false);
        return;
      }
      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new ApiError(403, "FORBIDDEN", "Origin is not allowed"), false);
    },
  });
  await app.register(websocket);
  await app.register(systemRoutes, { lifecycle });
  await app.register(
    async (v1) => {
      await v1.register(realtimeRoutes, {
        allowedOrigins,
        consumeTicket: options.consumeRealtimeTicket ?? denyRealtimeTickets,
      });
    },
    { prefix: "/v1" },
  );

  lifecycle.markReady();
  return app;
}
