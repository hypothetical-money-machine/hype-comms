import { timingSafeEqual } from "node:crypto";

import type { HealthResponse, ReadinessResponse } from "@hmm-chat/contracts";
import type { FastifyPluginAsync } from "fastify";

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
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (
  app,
  { lifecycle, metrics },
) => {
  app.get("/livez", async (): Promise<HealthResponse> => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply): Promise<ReadinessResponse> => {
    const checks = await lifecycle.inspect();
    const ready = Object.values(checks).every((result) => result === "ok");
    if (!ready) void reply.code(503);
    return { status: ready ? "ready" : "not_ready", checks };
  });

  if (metrics !== undefined) {
    app.get("/metrics", async (request, reply) => {
      if (!hasMetricsAccess(request.headers.authorization, metrics.token)) {
        void reply.header("www-authenticate", "Bearer");
        throw new ApiError(401, "UNAUTHORIZED", "Metrics authentication is required");
      }
      void reply.header("cache-control", "no-store");
      void reply.type("text/plain; version=0.0.4; charset=utf-8");
      return metrics.registry.render();
    });
  }
};
