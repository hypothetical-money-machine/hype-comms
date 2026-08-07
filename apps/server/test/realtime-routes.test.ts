import { once } from "node:events";

import { systemConnectedEventSchema, type SyncResponse } from "@hmm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import type {
  RealtimePrincipal,
  RealtimePrincipalRevalidation,
} from "../src/modules/realtime/auth.js";
import type { RealtimeEventHub } from "../src/modules/realtime/hub.js";
import { REALTIME_SESSION_REVOKED_CLOSE_CODE } from "../src/modules/realtime/routes.js";
import type { WorkspaceRepository } from "../src/modules/workspace/repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const deviceSessionId = "10000000-0000-4000-8000-000000000003";
const ticket = "a".repeat(32);

class FakeWorkspaceRepository {
  readonly consumedTickets: string[] = [];
  readonly syncedCursors: string[] = [];
  readonly revalidations: RealtimePrincipal[] = [];
  consumedPrincipal: RealtimePrincipal = {
    workspaceId,
    userId,
    deviceSessionId,
    agentTokenId: null,
    reactionEvents: true,
  };
  revalidation: RealtimePrincipalRevalidation = { status: "valid" };
  revalidationError: Error | null = null;

  async consumeRealtimeTicket(token: string): Promise<RealtimePrincipal | null> {
    this.consumedTickets.push(token);
    return this.consumedPrincipal;
  }

  async syncPrincipal(principal: RealtimePrincipal, after: string): Promise<SyncResponse> {
    this.syncedCursors.push(after);
    return { events: [], nextCursor: after, highWaterCursor: after, hasMore: false };
  }

  async revalidateRealtimePrincipal(
    principal: RealtimePrincipal,
  ): Promise<RealtimePrincipalRevalidation> {
    this.revalidations.push(principal);
    if (this.revalidationError !== null) throw this.revalidationError;
    return this.revalidation;
  }

  asRepository(): WorkspaceRepository {
    return this as unknown as WorkspaceRepository;
  }
}

class FakeRealtimeEventHub {
  readonly subscribed: string[] = [];
  unsubscribeCalls = 0;

  subscribe(workspaceIdentifier: string): () => void {
    this.subscribed.push(workspaceIdentifier);
    return () => {
      this.unsubscribeCalls += 1;
    };
  }

  async close(): Promise<void> {}

  asHub(): RealtimeEventHub {
    return this as unknown as RealtimeEventHub;
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function connectedApp(
  repository: FakeWorkspaceRepository,
  hub: FakeRealtimeEventHub,
): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; socket: WebSocket }> {
  const app = await buildApp({
    allowedOrigins: ["app://bundle"],
    workspace: { repository: repository.asRepository(), realtimeHub: hub.asHub() },
  });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  // Only the heartbeat interval is faked so the WebSocket keeps using real I/O.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const socket = new WebSocket(
    `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9`,
    { origin: "app://bundle" },
  );
  sockets.push(socket);
  const [data] = await once(socket, "message");
  systemConnectedEventSchema.parse(JSON.parse(data.toString()));
  return { app, socket };
}

describe("realtime session revalidation", () => {
  it("closes an initially invalid principal before replaying any events", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.revalidation = { status: "invalid", reason: "membership_inactive" };
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      workspace: {
        repository: repository.asRepository(),
        realtimeHub: new FakeRealtimeEventHub().asHub(),
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9`,
      { origin: "app://bundle" },
    );
    sockets.push(socket);
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));

    const [code, reason] = await once(socket, "close");

    expect(code).toBe(REALTIME_SESSION_REVOKED_CLOSE_CODE);
    expect(reason.toString()).toBe("Session revoked");
    expect(messages).toEqual([]);
    expect(repository.syncedCursors).toEqual([]);
    expect(repository.revalidations).toEqual([
      { userId, workspaceId, deviceSessionId, agentTokenId: null, reactionEvents: true },
    ]);
  });

  it("continues the initial replay when revalidation has a transient error", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.revalidationError = new Error("database unavailable");

    const { socket } = await connectedApp(repository, new FakeRealtimeEventHub());

    expect(repository.revalidations).toEqual([
      { userId, workspaceId, deviceSessionId, agentTokenId: null, reactionEvents: true },
    ]);
    expect(repository.syncedCursors).toEqual(["9"]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a live socket with 4401 once its device session is revoked", async () => {
    const repository = new FakeWorkspaceRepository();
    const { socket } = await connectedApp(repository, new FakeRealtimeEventHub());

    repository.revalidation = { status: "invalid", reason: "session_revoked" };
    const closed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(30_000);
    const [code, reason] = await closed;

    expect(code).toBe(4401);
    expect(reason.toString()).toBe("Session revoked");
    // The principal must carry the device session the ticket was bound to, or nothing is checkable.
    expect(repository.revalidations).toEqual([
      { userId, workspaceId, deviceSessionId, agentTokenId: null, reactionEvents: true },
      { userId, workspaceId, deviceSessionId, agentTokenId: null, reactionEvents: true },
    ]);
  });

  it("closes a live socket whose workspace membership is no longer active", async () => {
    const repository = new FakeWorkspaceRepository();
    const { socket } = await connectedApp(repository, new FakeRealtimeEventHub());

    repository.revalidation = { status: "invalid", reason: "membership_inactive" };
    const closed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(30_000);
    const [code] = await closed;

    expect(code).toBe(4401);
  });

  it("revalidates the bound agent token and closes the socket once it is revoked", async () => {
    const repository = new FakeWorkspaceRepository();
    const agentTokenId = "10000000-0000-4000-8000-000000000004";
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId,
    };
    const { socket } = await connectedApp(repository, new FakeRealtimeEventHub());

    repository.revalidation = { status: "invalid", reason: "agent_token_revoked" };
    const closed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(30_000);
    const [code] = await closed;

    expect(code).toBe(4401);
    expect(repository.revalidations).toEqual([
      { workspaceId, userId, deviceSessionId: null, agentTokenId },
      { workspaceId, userId, deviceSessionId: null, agentTokenId },
    ]);
  });

  it("keeps a socket whose session is still valid open on the heartbeat", async () => {
    const repository = new FakeWorkspaceRepository();
    const { socket } = await connectedApp(repository, new FakeRealtimeEventHub());

    await vi.advanceTimersByTimeAsync(30_000);

    expect(repository.revalidations).toHaveLength(2);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("does not sign a device out when revalidation itself fails", async () => {
    const repository = new FakeWorkspaceRepository();
    const { socket } = await connectedApp(repository, new FakeRealtimeEventHub());
    repository.revalidationError = new Error("database unavailable");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(repository.revalidations).toHaveLength(2);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("realtime socket teardown", () => {
  it("unsubscribes once even when the socket both closes and errors", async () => {
    const hub = new FakeRealtimeEventHub();
    const repository = new FakeWorkspaceRepository();
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      workspace: { repository: repository.asRepository(), realtimeHub: hub.asHub() },
    });
    apps.push(app);
    const serverSockets: WebSocket[] = [];
    app.websocketServer.on("connection", (serverSocket: WebSocket) => {
      serverSockets.push(serverSocket);
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9`,
      { origin: "app://bundle" },
    );
    sockets.push(socket);
    await once(socket, "message");

    const serverSocket = serverSockets[0];
    if (serverSocket === undefined) throw new Error("The server socket was not captured");
    serverSocket.emit("close", 1006, Buffer.alloc(0));
    serverSocket.emit("error", new Error("read ECONNRESET"));

    expect(hub.subscribed).toEqual([workspaceId]);
    expect(hub.unsubscribeCalls).toBe(1);
  });
});
