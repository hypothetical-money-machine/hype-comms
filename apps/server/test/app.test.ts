import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { apiErrorEnvelopeSchema, systemConnectedEventSchema } from "@hmm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import { ChatStore } from "../src/modules/chat/store.js";
import { SignInThrottle } from "../src/modules/chat/throttle.js";

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

  it("answers malformed bodies with 400 rather than an internal error", async () => {
    const app = await buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/session",
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

describe("chat channel", () => {
  it("requires the access code, derives authors from the session, and persists history", async () => {
    const store = new ChatStore(":memory:");
    const app = await buildApp({
      allowedOrigins: ["https://chat.hypemm.com"],
      chat: { accessCode: "weekend-secret", store },
    });
    apps.push(app);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/chat/session",
      payload: { name: "Morgan", accessCode: "wrong-secret" },
    });
    const signedIn = await app.inject({
      method: "POST",
      url: "/v1/chat/session",
      payload: { name: "Morgan", accessCode: "weekend-secret" },
    });
    const cookie = signedIn.cookies.find(({ name }) => name === "hmm_chat_session");
    const created = await app.inject({
      method: "POST",
      url: "/v1/chat/welcome/messages",
      cookies: { hmm_chat_session: cookie?.value ?? "" },
      payload: {
        clientMessageId: "10000000-0000-4000-8000-000000000020",
        body: "Chat hello",
      },
    });
    const history = await app.inject({
      method: "GET",
      url: "/v1/chat/welcome/messages",
      cookies: { hmm_chat_session: cookie?.value ?? "" },
    });

    expect(denied.statusCode).toBe(401);
    expect(signedIn.statusCode).toBe(204);
    expect(cookie).toBeDefined();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ authorName: "Morgan", body: "Chat hello" });
    expect(history.json()).toMatchObject({ messages: [{ authorName: "Morgan" }] });
  });

  it("broadcasts messages to authenticated same-origin websocket clients", async () => {
    const store = new ChatStore(":memory:");
    const app = await buildApp({
      allowedOrigins: ["https://chat.hypemm.com"],
      chat: { accessCode: "weekend-secret", store },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const signedIn = await app.inject({
      method: "POST",
      url: "/v1/chat/session",
      payload: { name: "Alex", accessCode: "weekend-secret" },
    });
    const cookie = signedIn.cookies.find(({ name }) => name === "hmm_chat_session");
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/chat/welcome/realtime`,
      {
        headers: { cookie: `hmm_chat_session=${cookie?.value ?? ""}` },
        origin: "https://chat.hypemm.com",
      },
    );
    await once(socket, "open");

    const messagePromise = once(socket, "message");
    await app.inject({
      method: "POST",
      url: "/v1/chat/welcome/messages",
      cookies: { hmm_chat_session: cookie?.value ?? "" },
      payload: {
        clientMessageId: "10000000-0000-4000-8000-000000000021",
        body: "Realtime chat",
      },
    });
    const [data] = await messagePromise;
    socket.close();

    expect(JSON.parse(data.toString())).toMatchObject({
      type: "chat.welcome_message_created",
      message: { authorName: "Alex", body: "Realtime chat" },
    });
  });
});

describe("chat session security", () => {
  async function signIn(app: Awaited<ReturnType<typeof buildApp>>, name: string, code: string) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/session",
      payload: { name, accessCode: code },
    });
    return {
      response,
      cookie: response.cookies.find(({ name: cookieName }) => cookieName === "hmm_chat_session"),
    };
  }

  it("rejects a cookie signed by a different server secret", async () => {
    const app = await buildApp({
      chat: { accessCode: "weekend-secret-code", store: new ChatStore(":memory:") },
    });
    const other = await buildApp({
      chat: { accessCode: "weekend-secret-code", store: new ChatStore(":memory:") },
    });
    apps.push(app, other);

    const { cookie } = await signIn(other, "Morgan", "weekend-secret-code");
    const replayed = await app.inject({
      method: "GET",
      url: "/v1/chat/session",
      cookies: { hmm_chat_session: cookie?.value ?? "" },
    });

    expect(cookie).toBeDefined();
    expect(replayed.statusCode).toBe(401);
  });

  it("invalidates existing sessions when the access code is rotated", async () => {
    const store = new ChatStore(":memory:");
    const before = await buildApp({ chat: { accessCode: "original-access-code", store } });
    apps.push(before);
    const { cookie } = await signIn(before, "Morgan", "original-access-code");

    const after = await buildApp({ chat: { accessCode: "rotated-access-code", store } });
    apps.push(after);
    const replayed = await after.inject({
      method: "GET",
      url: "/v1/chat/session",
      cookies: { hmm_chat_session: cookie?.value ?? "" },
    });

    expect(cookie).toBeDefined();
    expect(replayed.statusCode).toBe(401);
  });

  it("reuses the persisted signing key so restarts do not sign users out", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-chat-store-"));
    const filename = path.join(directory, "chat.sqlite");

    const first = await buildApp({
      chat: { accessCode: "weekend-secret-code", store: new ChatStore(filename) },
    });
    apps.push(first);
    const { cookie } = await signIn(first, "Morgan", "weekend-secret-code");
    await first.close();

    const second = await buildApp({
      chat: { accessCode: "weekend-secret-code", store: new ChatStore(filename) },
    });
    apps.push(second);
    const restored = await second.inject({
      method: "GET",
      url: "/v1/chat/session",
      cookies: { hmm_chat_session: cookie?.value ?? "" },
    });
    await rm(directory, { recursive: true, force: true });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ name: "Morgan" });
  });

  it("omits Secure when the deployment is not served over HTTPS", async () => {
    const secure = await buildApp({
      chat: {
        accessCode: "weekend-secret-code",
        store: new ChatStore(":memory:"),
        cookieSecure: true,
      },
    });
    const insecure = await buildApp({
      chat: {
        accessCode: "weekend-secret-code",
        store: new ChatStore(":memory:"),
        cookieSecure: false,
      },
    });
    apps.push(secure, insecure);

    const overHttps = await signIn(secure, "Morgan", "weekend-secret-code");
    const overHttp = await signIn(insecure, "Morgan", "weekend-secret-code");

    expect(String(overHttps.response.headers["set-cookie"])).toContain("Secure");
    expect(String(overHttp.response.headers["set-cookie"])).not.toContain("Secure");
    expect(String(overHttp.response.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("throttles repeated failed sign-in attempts", async () => {
    const app = await buildApp({
      chat: {
        accessCode: "weekend-secret-code",
        store: new ChatStore(":memory:"),
        throttle: new SignInThrottle({ maxFailures: 2, windowMs: 60_000 }),
      },
    });
    apps.push(app);

    const first = await signIn(app, "Morgan", "wrong-access-code");
    const second = await signIn(app, "Morgan", "wrong-access-code");
    const blocked = await signIn(app, "Morgan", "wrong-access-code");
    const correctButBlocked = await signIn(app, "Morgan", "weekend-secret-code");

    expect(first.response.statusCode).toBe(401);
    expect(second.response.statusCode).toBe(401);
    expect(blocked.response.statusCode).toBe(429);
    expect(apiErrorEnvelopeSchema.parse(blocked.response.json()).error.code).toBe("RATE_LIMITED");
    expect(blocked.response.headers["retry-after"]).toBeDefined();
    expect(correctButBlocked.response.statusCode).toBe(429);
  });
});
