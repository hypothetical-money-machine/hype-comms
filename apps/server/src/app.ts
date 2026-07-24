import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";

import { ApiError, registerErrorHandling } from "./errors.js";
import { Lifecycle } from "./lifecycle.js";
import { chatRoutes } from "./modules/chat/routes.js";
import type { ChatStore } from "./modules/chat/store.js";
import { identityLandingRoutes, identityRoutes } from "./modules/identity/routes.js";
import type { IdentityService } from "./modules/identity/service.js";
import { denyRealtimeTickets, type ConsumeRealtimeTicket } from "./modules/realtime/auth.js";
import { realtimeRoutes } from "./modules/realtime/routes.js";
import { systemRoutes } from "./modules/system/routes.js";
import type { SignInThrottle } from "./throttle.js";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly lifecycle?: Lifecycle;
  readonly allowedOrigins?: readonly string[];
  readonly consumeRealtimeTicket?: ConsumeRealtimeTicket;
  readonly cookieSecure?: boolean;
  readonly chat?: {
    readonly accessCode: string;
    readonly store: ChatStore;
    readonly throttle?: SignInThrottle;
  };
  readonly identity?: {
    readonly service: IdentityService;
  };
  readonly webRoot?: string;
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
  if (options.webRoot !== undefined) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      setHeaders(reply) {
        void reply.header(
          "content-security-policy",
          "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; " +
            "style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; " +
            "frame-ancestors 'none'; form-action 'self'",
        );
        void reply.header("referrer-policy", "no-referrer");
        void reply.header("x-content-type-options", "nosniff");
        void reply.header("x-frame-options", "DENY");
      },
    });
  }
  await app.register(systemRoutes, { lifecycle });
  await app.register(
    async (v1) => {
      await v1.register(realtimeRoutes, {
        allowedOrigins,
        consumeTicket: options.consumeRealtimeTicket ?? denyRealtimeTickets,
      });
      if (options.chat !== undefined) {
        await v1.register(chatRoutes, {
          allowedOrigins,
          accessCode: options.chat.accessCode,
          store: options.chat.store,
          cookieSecure: options.cookieSecure ?? true,
          ...(options.identity === undefined ? {} : { identityService: options.identity.service }),
          ...(options.chat.throttle === undefined ? {} : { throttle: options.chat.throttle }),
        });
      }
      if (options.identity !== undefined) {
        await v1.register(identityRoutes, {
          service: options.identity.service,
          cookieSecure: options.cookieSecure ?? true,
        });
      }
    },
    { prefix: "/v1" },
  );

  if (options.identity !== undefined) {
    await app.register(identityLandingRoutes);
  }

  if (options.chat !== undefined) {
    app.addHook("onClose", async () => options.chat?.store.close());
  }

  lifecycle.markReady();
  return app;
}
