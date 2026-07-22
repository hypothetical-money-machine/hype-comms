import type { HealthResponse, ReadinessResponse } from "@hmm-chat/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { Lifecycle } from "../../lifecycle.js";

interface SystemRoutesOptions {
  lifecycle: Lifecycle;
}

export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (app, { lifecycle }) => {
  app.get("/livez", async (): Promise<HealthResponse> => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply): Promise<ReadinessResponse> => {
    const checks = await lifecycle.inspect();
    const ready = Object.values(checks).every((result) => result === "ok");
    if (!ready) void reply.code(503);
    return { status: ready ? "ready" : "not_ready", checks };
  });
};
