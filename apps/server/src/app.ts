import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";

import { ApiError, registerErrorHandling } from "./errors.js";
import { Lifecycle } from "./lifecycle.js";
import type { MetricsRegistry } from "./metrics.js";
import type { BotService } from "./modules/bots/service.js";
import { authKitRoutes } from "./modules/identity/authkit-routes.js";
import type { AuthKitService } from "./modules/identity/authkit-service.js";
import type { AgentEnrollmentModule } from "./modules/identity/agent-enrollment.js";
import { workOSWebhookRoutes } from "./modules/identity/authkit-webhook-routes.js";
import type { WorkOSWebhookProcessor } from "./modules/identity/authkit-webhook.js";
import { identityLandingRoutes, identityRoutes } from "./modules/identity/routes.js";
import type { IdentityService } from "./modules/identity/service.js";
import { denyRealtimeTickets, type ConsumeRealtimeTicket } from "./modules/realtime/auth.js";
import type { RealtimeEventHub } from "./modules/realtime/hub.js";
import { realtimeRoutes } from "./modules/realtime/routes.js";
import { systemRoutes } from "./modules/system/routes.js";
import { channelWebhookRoutes } from "./modules/webhooks/routes.js";
import type { WorkspaceRepository } from "./modules/workspace/repository.js";
import { workspaceRoutes } from "./modules/workspace/routes.js";
import type { FixedWindowAttemptThrottle } from "./throttle.js";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly lifecycle?: Lifecycle;
  readonly allowedOrigins?: readonly string[];
  readonly consumeRealtimeTicket?: ConsumeRealtimeTicket;
  readonly cookieSecure?: boolean;
  /** Socket peers allowed to supply forwarded client metadata, expressed only as IPs/CIDRs. */
  readonly trustedProxies?: readonly string[];
  readonly metrics?: {
    readonly registry: MetricsRegistry;
    readonly token: string;
  };
  readonly identity?: {
    readonly service: IdentityService;
    readonly agentEnrollment?: AgentEnrollmentModule;
    readonly botService?: BotService;
    readonly webhookThrottle?: FixedWindowAttemptThrottle;
    /** False when links are issued by an administrator, which disables self-service requests. */
    readonly selfServiceMagicLink?: boolean;
    /** False while the previous server remains a supported production rollback target. */
    readonly agentProvisioningEnabled?: boolean;
    /** Fail-closed gate for new AuthKit authorization, callback, and exchange traffic. */
    readonly authKitAdmissionEnabled?: boolean;
    readonly authKitService?: AuthKitService;
    readonly workosWebhookProcessor?: WorkOSWebhookProcessor;
  };
  readonly workspace?: {
    readonly repository: WorkspaceRepository;
    readonly realtimeHub: RealtimeEventHub;
  };
  readonly webRoot?: string;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const lifecycle = options.lifecycle ?? new Lifecycle();
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  const trustProxy = options.trustedProxies?.length ? [...options.trustedProxies] : undefined;
  const app = Fastify({
    logger: options.logger ?? false,
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });

  registerErrorHandling(app);
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });
  if (options.metrics !== undefined) {
    app.addHook("onResponse", async (request, reply) => {
      options.metrics?.registry.observeHttpRequest({
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      });
    });
  }

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
  await app.register(systemRoutes, {
    lifecycle,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  const consumeWorkspaceTicket: ConsumeRealtimeTicket | undefined =
    options.workspace === undefined
      ? undefined
      : async ({ ticket }) => {
          const principal = await options.workspace?.repository.consumeRealtimeTicket(ticket);
          if (principal === null || principal === undefined) {
            throw new ApiError(401, "UNAUTHORIZED", "Realtime ticket is invalid or expired");
          }
          return principal;
        };
  await app.register(
    async (v1) => {
      await v1.register(realtimeRoutes, {
        allowedOrigins,
        consumeTicket:
          options.consumeRealtimeTicket ?? consumeWorkspaceTicket ?? denyRealtimeTickets,
        ...(options.workspace === undefined
          ? {}
          : {
              loadEvents: (principal, after) =>
                options.workspace!.repository.syncPrincipal(principal, after, 100),
              subscribe: (workspaceId, listener) =>
                options.workspace!.realtimeHub.subscribe(workspaceId, listener),
              revalidate: (principal) =>
                options.workspace!.repository.revalidateRealtimePrincipal(principal),
              ...(options.metrics === undefined ? {} : { metrics: options.metrics.registry }),
            }),
      });
      if (options.identity !== undefined) {
        await v1.register(identityRoutes, {
          service: options.identity.service,
          ...(options.identity.agentEnrollment === undefined
            ? {}
            : { agentEnrollment: options.identity.agentEnrollment }),
          ...(options.identity.authKitService === undefined
            ? {}
            : { authKitService: options.identity.authKitService }),
          cookieSecure: options.cookieSecure ?? true,
          selfServiceMagicLink: options.identity.selfServiceMagicLink ?? true,
          agentProvisioningEnabled: options.identity.agentProvisioningEnabled ?? true,
        });
        await v1.register(authKitRoutes, {
          identityService: options.identity.service,
          cookieSecure: options.cookieSecure ?? true,
          magicLinkAvailable: options.identity.selfServiceMagicLink ?? true,
          authKitAdmissionEnabled: options.identity.authKitAdmissionEnabled ?? false,
          ...(options.identity.authKitService === undefined
            ? {}
            : { authKitService: options.identity.authKitService }),
        });
        if (options.identity.workosWebhookProcessor !== undefined) {
          await v1.register(workOSWebhookRoutes, {
            processor: options.identity.workosWebhookProcessor,
          });
        }
      }
      if (options.identity !== undefined && options.workspace !== undefined) {
        await v1.register(workspaceRoutes, {
          identityService: options.identity.service,
          ...(options.identity.botService === undefined
            ? {}
            : { botService: options.identity.botService }),
          repository: options.workspace.repository,
        });
        if (options.identity.botService !== undefined) {
          await v1.register(channelWebhookRoutes, {
            identityService: options.identity.service,
            botService: options.identity.botService,
            repository: options.workspace.repository,
            ...(options.identity.webhookThrottle === undefined
              ? {}
              : { throttle: options.identity.webhookThrottle }),
          });
        }
      }
    },
    { prefix: "/v1" },
  );

  if (options.identity !== undefined) {
    await app.register(identityLandingRoutes);
  }

  if (options.workspace !== undefined) {
    app.addHook("onClose", async () => options.workspace?.realtimeHub.close());
  }

  lifecycle.markReady();
  return app;
}
