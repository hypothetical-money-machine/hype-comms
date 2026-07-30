import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { apiErrorEnvelopeSchema, systemConnectedEventSchema } from "@hmm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import { Lifecycle } from "../src/lifecycle.js";
import { MetricsRegistry } from "../src/metrics.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("operational routes", () => {
  it("reports liveness and readiness", async () => {
    const app = await buildApp();
    apps.push(app);

    const [health, ready] = await Promise.all([
      app.inject({ method: "GET", url: "/livez" }),
      app.inject({ method: "GET", url: "/readyz" }),
    ]);

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", checks: { server: "ok" } });
  });

  it("reports database readiness without changing the readiness response shape", async () => {
    const lifecycle = new Lifecycle();
    lifecycle.addCheck("database", () => false);
    const app = await buildApp({ lifecycle });
    apps.push(app);
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: "not_ready",
      checks: { server: "ok", database: "failed" },
    });
  });

  it("exposes bounded Prometheus metrics only with the configured bearer token", async () => {
    const token = "metrics-token-that-is-at-least-32-characters";
    const databasePool = { totalCount: 5, idleCount: 3, waitingCount: 1 };
    const metrics = new MetricsRegistry(databasePool);
    const app = await buildApp({ metrics: { registry: metrics, token } });
    apps.push(app);
    await app.inject({ method: "GET", url: "/livez" });

    const [missing, incorrect, authorized] = await Promise.all([
      app.inject({ method: "GET", url: "/metrics" }),
      app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${"x".repeat(token.length)}` },
      }),
      app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${token}` },
      }),
    ]);

    expect(missing.statusCode).toBe(401);
    expect(incorrect.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");
    expect(authorized.body).toContain(
      'hmm_chat_http_requests_total{method="GET",route="/livez",status_code="200"} 1',
    );
    expect(authorized.body).toContain('hmm_chat_postgres_pool_connections{state="waiting"} 1');
  });

  it("answers malformed bodies with 400 rather than an internal error", async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/magic-links",
      headers: { "content-type": "application/json" },
      payload: "not json",
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("BAD_REQUEST");
  });

  it("returns the stable error envelope for unknown routes", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/missing" });

    expect(response.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("NOT_FOUND");
  });

  it("does not register identity routes without a configured identity service", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/auth/me" });

    expect(response.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("NOT_FOUND");
  });

  it("allows only exact configured HTTP origins", async () => {
    const app = await buildApp({ allowedOrigins: ["app://bundle"] });
    apps.push(app);

    const allowed = await app.inject({
      method: "GET",
      url: "/livez",
      headers: { origin: "app://bundle" },
    });
    const rejected = await app.inject({
      method: "GET",
      url: "/livez",
      headers: { origin: "https://evil.example" },
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe("app://bundle");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(rejected.statusCode).toBe(403);
  });
});

describe("static web client", () => {
  it("serves the browser client without exposing server files", async () => {
    const webRoot = await mkdtemp(path.join(os.tmpdir(), "hmm-chat-web-"));
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>HMM Chat</title>");
    const app = await buildApp({ webRoot });
    apps.push(app);

    const root = await app.inject({ method: "GET", url: "/" });
    const traversal = await app.inject({ method: "GET", url: "/../package.json" });
    await rm(webRoot, { recursive: true, force: true });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("HMM Chat");
    expect(root.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(traversal.statusCode).toBe(404);
  });
});

describe("realtime route", () => {
  it("checks Origin before consuming a ticket", async () => {
    const consumeTicket = vi.fn();
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      consumeRealtimeTicket: consumeTicket,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/realtime?ticket=${"a".repeat(32)}&after=0`,
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        origin: "https://evil.example",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(consumeTicket).not.toHaveBeenCalled();
  });

  it("consumes a one-time ticket and emits the versioned handshake", async () => {
    const consumeTicket = vi.fn().mockResolvedValue({
      userId: "10000000-0000-4000-8000-000000000001",
      workspaceId: "10000000-0000-4000-8000-000000000002",
    });
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      consumeRealtimeTicket: consumeTicket,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${"a".repeat(32)}&after=9`,
      { origin: "app://bundle" },
    );

    const [data] = await once(socket, "message");
    const event = systemConnectedEventSchema.parse(JSON.parse(data.toString()));
    socket.close();

    expect(event.workspaceSequence).toBe("9");
    expect(event.delivery).toBe("at_least_once");
    expect(consumeTicket).toHaveBeenCalledOnce();
  });
});
