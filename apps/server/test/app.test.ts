import { once } from "node:events";

import {
  apiErrorEnvelopeSchema,
  developmentWelcomeHistorySchema,
  developmentWelcomeMessageEventSchema,
  developmentWelcomeMessageSchema,
  systemConnectedEventSchema,
} from "@hmm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";

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

  it("returns the stable error envelope for unknown routes", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/missing" });

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
      url: `/v1/realtime?ticket=${"a".repeat(32)}`,
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
      workspaceSequence: "9",
    });
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      consumeRealtimeTicket: consumeTicket,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${"a".repeat(32)}`,
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

describe("development welcome channel", () => {
  it("stores messages in memory and returns history", async () => {
    const app = await buildApp({ enableDevelopmentChat: true });
    apps.push(app);
    const clientMessageId = "10000000-0000-4000-8000-000000000010";

    const created = await app.inject({
      method: "POST",
      url: "/v1/development/welcome/messages",
      payload: { clientMessageId, authorName: "Morgan", body: "Hello!" },
    });
    const history = await app.inject({
      method: "GET",
      url: "/v1/development/welcome/messages",
    });

    expect(created.statusCode).toBe(201);
    expect(developmentWelcomeMessageSchema.parse(created.json())).toMatchObject({
      clientMessageId,
      authorName: "Morgan",
      body: "Hello!",
    });
    expect(developmentWelcomeHistorySchema.parse(history.json()).messages).toHaveLength(1);
  });

  it("broadcasts created messages to connected desktop clients", async () => {
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      enableDevelopmentChat: true,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/development/welcome/realtime`,
      { origin: "app://bundle" },
    );
    await once(socket, "open");

    const messagePromise = once(socket, "message");
    const created = await app.inject({
      method: "POST",
      url: "/v1/development/welcome/messages",
      payload: {
        clientMessageId: "10000000-0000-4000-8000-000000000011",
        authorName: "Alex",
        body: "Realtime hello",
      },
    });
    const [data] = await messagePromise;
    socket.close();

    expect(created.statusCode).toBe(201);
    expect(developmentWelcomeMessageEventSchema.parse(JSON.parse(data.toString()))).toMatchObject({
      message: { authorName: "Alex", body: "Realtime hello" },
    });
  });

  it("rejects invalid identities and keeps development routes opt-in", async () => {
    const enabledApp = await buildApp({ enableDevelopmentChat: true });
    const disabledApp = await buildApp();
    apps.push(enabledApp, disabledApp);

    const invalid = await enabledApp.inject({
      method: "POST",
      url: "/v1/development/welcome/messages",
      payload: {
        clientMessageId: "10000000-0000-4000-8000-000000000012",
        authorName: "Morgan\nAdmin",
        body: "Nope",
      },
    });
    const absent = await disabledApp.inject({
      method: "GET",
      url: "/v1/development/welcome/messages",
    });

    expect(invalid.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(invalid.json()).error.code).toBe("BAD_REQUEST");
    expect(absent.statusCode).toBe(404);
  });
});
