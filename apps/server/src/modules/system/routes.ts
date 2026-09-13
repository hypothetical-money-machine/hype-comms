import { timingSafeEqual } from "node:crypto";

import type { HealthResponse, ReadinessResponse } from "@hype-comms/contracts";
import { parseBearerAuthorization } from "../../http/bearer-authorization.js";
import { routeModule } from "../../http/route-registrar.js";
import { publicPolicy } from "../../http/authentication-policies.js";

import type { Lifecycle } from "../../lifecycle.js";
import type { MetricsRegistry } from "../../metrics.js";
import { ApiError } from "../../errors.js";

interface SystemRoutesOptions {
  lifecycle: Lifecycle;
  metrics?: {
    readonly registry: MetricsRegistry;
    readonly token: string;
  };
}

function hasMetricsAccess(header: string | string[] | undefined, token: string): boolean {
  const { token: suppliedToken } = parseBearerAuthorization(header);
  if (suppliedToken === null) return false;
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const systemRoutes = routeModule<SystemRoutesOptions>((routes, { lifecycle, metrics }) => {
  routes.register({
    method: "GET",
    url: "/livez",
    policy: publicPolicy,
    scopes: [],
    request: {},
    handler: async (): Promise<HealthResponse> => ({ status: "ok" }),
  });

  routes.register({
    method: "GET",
    url: "/readyz",
    policy: publicPolicy,
    scopes: [],
    request: {},
    handler: async ({ reply }): Promise<ReadinessResponse> => {
      const checks = await lifecycle.inspect();
      const ready = Object.values(checks).every((result) => result === "ok");
      if (!ready) void reply.code(503);
      return { status: ready ? "ready" : "not_ready", checks };
    },
  });

  if (metrics !== undefined) {
    routes.register({
      method: "GET",
      url: "/metrics",
      scopes: [],
      request: {},
      policy: {
        name: "metrics-bearer-token",
        authenticate: async (request, _scopes, reply) => {
          if (!hasMetricsAccess(request.headers.authorization, metrics.token)) {
            void reply.header("www-authenticate", "Bearer");
            throw new ApiError(401, "UNAUTHORIZED", "Metrics authentication is required");
          }
        },
      },
      handler: async ({ reply }) => {
        void reply.header("cache-control", "no-store");
        void reply.type("text/plain; version=0.0.4; charset=utf-8");
        return metrics.registry.render();
      },
    });
  }
});
