import { WORKSPACE_PROTOCOL_HEADER, apiErrorEnvelopeSchema } from "@hype-comms/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("workspace protocol registration", () => {
  it.each(["/v1/bootstrap", "/v1/realtime", "/v1/auth/me", "/v3/bootstrap", "/v1", "/v20/sync"])(
    "refuses %s with an envelope existing clients can parse, before reading a credential",
    async (url) => {
      const consumeRealtimeTicket = vi.fn();
      const app = await buildApp({ consumeRealtimeTicket });
      apps.push(app);
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(426);
      expect(response.headers[WORKSPACE_PROTOCOL_HEADER]).toBe("2");
      expect(apiErrorEnvelopeSchema.parse(response.json())).toEqual({
        error: {
          code: "CONFLICT",
          message:
            "Update Hype Comms to continue. The client and server versions are incompatible.",
          requestId: expect.any(String),
          details: [{ field: "protocol", issue: "Workspace protocol 2 is required" }],
        },
      });
      expect(consumeRealtimeTicket).not.toHaveBeenCalled();
    },
  );

  it("marks a supported API error so clients can distinguish a missing resource from an old server", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v2/not-a-resource" });

    expect(response.statusCode).toBe(404);
    expect(response.headers[WORKSPACE_PROTOCOL_HEADER]).toBe("2");
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("NOT_FOUND");
  });
});
