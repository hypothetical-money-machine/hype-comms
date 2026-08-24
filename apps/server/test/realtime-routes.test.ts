import { once } from "node:events";

import {
  systemConnectedEventSchema,
  type ConversationSummary,
  type NotificationState,
  type SyncResponse,
  type User,
} from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  NotificationController,
  type NotificationSettingsPort,
} from "../../desktop/src/main/notification-controller.js";
import type { NotificationPresenter } from "../../desktop/src/main/notification-presenter.js";
import { WorkspaceRealtime } from "../../desktop/src/main/workspace-realtime.js";
import { buildApp } from "../src/app.js";
import { ApiError } from "../src/errors.js";
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
const replayEventId = "10000000-0000-4000-8000-000000000004";
const authorId = "10000000-0000-4000-8000-000000000005";
const conversationId = "10000000-0000-4000-8000-000000000006";
const messageId = "10000000-0000-4000-8000-000000000007";
const ticket = "a".repeat(32);
const now = "2026-08-23T12:00:00.000Z";

const replayEvent: SyncResponse["events"][number] = {
  version: 1,
  id: replayEventId,
  type: "member.updated",
  occurredAt: now,
  workspaceId,
  conversationId: null,
  workspaceSequence: "10",
  conversationSequence: null,
  entityVersion: 1,
  delivery: "at_least_once",
  payload: {
    member: {
      id: userId,
      kind: "agent",
      username: "delivery-agent",
      displayName: "Delivery Agent",
      avatarUrl: null,
      title: null,
      createdAt: now,
      updatedAt: now,
    },
  },
};
const secondReplayEvent: SyncResponse["events"][number] = {
  ...replayEvent,
  id: "10000000-0000-4000-8000-000000000006",
  workspaceSequence: "11",
};

const replayMessageEvent: SyncResponse["events"][number] = {
  version: 1,
  id: replayEventId,
  type: "message.created",
  occurredAt: now,
  workspaceId,
  conversationId,
  workspaceSequence: "10",
  conversationSequence: "1",
  entityVersion: 1,
  delivery: "at_least_once",
  payload: {
    message: {
      id: messageId,
      conversationId,
      conversationSequence: "1",
      version: 1,
      clientMessageId: "10000000-0000-4000-8000-000000000008",
      authorId,
      threadRootId: null,
      body: "initial replay must remain quiet",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    mentionedUserIds: [],
  },
};

const currentUser: User = {
  id: userId,
  kind: "human",
  username: "current-user",
  displayName: "Current User",
  avatarUrl: null,
  createdAt: now,
  updatedAt: now,
};

const replayAuthor: User = {
  id: authorId,
  kind: "human",
  username: "replay-author",
  displayName: "Replay Author",
  avatarUrl: null,
  createdAt: now,
  updatedAt: now,
};

const directConversation: ConversationSummary = {
  conversation: {
    id: conversationId,
    workspaceId,
    kind: "direct_message",
    name: null,
    slug: null,
    topic: null,
    access: null,
    channelMode: null,
    isArchived: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  },
  participantIds: [userId, authorId],
  membershipRole: null,
  lastMessage: null,
  unreadCount: 1,
  mentionCount: 0,
  readCursor: null,
};

class NotificationSettingsStub implements NotificationSettingsPort {
  state: NotificationState = {
    version: 1,
    devicePreference: "enabled",
    contentPreviewPreference: "disabled",
    nativeSupport: "supported",
    osPermission: "granted",
  };

  readonly markPresenterFailure = vi.fn((): NotificationState => this.state);

  subscribe(): () => void {
    return () => undefined;
  }
}

class NotificationPresenterSpy implements NotificationPresenter {
  readonly kind = "native" as const;
  readonly present = vi.fn<NotificationPresenter["present"]>(() => ({ close: () => undefined }));
}

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
  beforeRevalidation: ((call: number) => void | Promise<void>) | null = null;
  syncResponse: SyncResponse | null = null;
  syncResponses: SyncResponse[] = [];
  syncError: Error | null = null;
  afterSync: ((call: number) => void | Promise<void>) | null = null;

  async consumeRealtimeTicket(token: string): Promise<RealtimePrincipal | null> {
    this.consumedTickets.push(token);
    return this.consumedPrincipal;
  }

  async syncPrincipal(principal: RealtimePrincipal, after: string): Promise<SyncResponse> {
    this.syncedCursors.push(after);
    if (this.syncError !== null) throw this.syncError;
    const response =
      this.syncResponses.shift() ??
      this.syncResponse ??
      ({ events: [], nextCursor: after, highWaterCursor: after, hasMore: false } as const);
    await this.afterSync?.(this.syncedCursors.length);
    return response;
  }

  async revalidateRealtimePrincipal(
    principal: RealtimePrincipal,
  ): Promise<RealtimePrincipalRevalidation> {
    this.revalidations.push(principal);
    await this.beforeRevalidation?.(this.revalidations.length);
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
  listener: (() => void) | null = null;

  subscribe(workspaceIdentifier: string, listener: () => void): () => void {
    this.subscribed.push(workspaceIdentifier);
    this.listener = listener;
    return () => {
      this.unsubscribeCalls += 1;
      this.listener = null;
    };
  }

  notify(): void {
    this.listener?.();
  }

  async close(): Promise<void> {}

  asHub(): RealtimeEventHub {
    return this as unknown as RealtimeEventHub;
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const sockets: WebSocket[] = [];
const realtimeClients: WorkspaceRealtime[] = [];
const notificationControllers: NotificationController[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const realtime of realtimeClients.splice(0)) realtime.stop();
  for (const controller of notificationControllers.splice(0)) controller.shutdown();
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
  it("keeps an initial message replay quiet across the server and desktop boundary", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.syncResponse = {
      events: [replayMessageEvent],
      nextCursor: "10",
      highWaterCursor: "10",
      hasMore: false,
    };
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      workspace: {
        repository: repository.asRepository(),
        realtimeHub: new FakeRealtimeEventHub().asHub(),
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const presenter = new NotificationPresenterSpy();
    const controller = new NotificationController({
      presenter,
      settings: new NotificationSettingsStub(),
      headless: false,
      getWindowState: () => ({ focused: false, shown: true, minimized: false }),
    });
    notificationControllers.push(controller);
    controller.startSession({
      sessionGeneration: 1,
      userId,
      workspaceId,
      bootstrapCursor: "9",
    });
    controller.replaceMembers([currentUser, replayAuthor]);
    controller.replaceConversations([directConversation]);

    const observeForNotifications = (
      event: Parameters<NotificationController["handleEvent"]>[0],
    ): void => {
      controller.handleEvent(event, {
        sessionGeneration: 1,
        ...(event.type === "system.connected" ? { connectionId: event.payload.connectionId } : {}),
      });
    };
    const realtime = new WorkspaceRealtime({
      apiOrigin: address,
      rendererOrigin: "app://bundle",
      transport: {
        ticket: async () => ({ ticket, expiresAt: "2026-08-23T12:01:00.000Z" }),
      },
      onEvent: (frame) => {
        observeForNotifications(frame.event);
        return true;
      },
      onState: (state) => controller.setRealtimeState(state),
    });
    realtimeClients.push(realtime);
    realtime.start("9", { userId, workspaceId });

    await vi.waitFor(() => {
      expect(controller.diagnostics.connectionArmed).toBe(true);
      expect(controller.diagnostics.watermark).toBe("10");
    });
    expect(presenter.present).not.toHaveBeenCalled();
  });

  it("sends an opted-in agent its requested-cursor preamble before replay", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000010",
    };
    repository.syncResponse = {
      events: [replayEvent],
      nextCursor: "10",
      highWaterCursor: "10",
      hasMore: false,
    };
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
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9&preamble=agent-wake-v1`,
      { origin: "app://bundle" },
    );
    sockets.push(socket);

    const frames = await new Promise<unknown[]>((resolve) => {
      const received: unknown[] = [];
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
        if (received.length === 2) resolve(received);
      });
    });

    expect(frames).toMatchObject([
      { type: "system.connected", workspaceSequence: "9" },
      { type: "member.updated", workspaceSequence: "10" },
    ]);
    expect(repository.revalidations).toHaveLength(1);
  });

  it("preserves replay-before-connected ordering for an agent without the wake preamble", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000011",
    };
    repository.syncResponse = {
      events: [replayEvent],
      nextCursor: "10",
      highWaterCursor: "10",
      hasMore: false,
    };
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

    const frames = await new Promise<unknown[]>((resolve) => {
      const received: unknown[] = [];
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
        if (received.length === 2) resolve(received);
      });
    });

    expect(frames).toMatchObject([
      { type: "member.updated", workspaceSequence: "10" },
      { type: "system.connected", workspaceSequence: "10" },
    ]);
    expect(repository.revalidations).toHaveLength(1);
  });

  it("ignores the agent-wake preamble opt-in for a human principal", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.syncResponse = {
      events: [replayEvent],
      nextCursor: "10",
      highWaterCursor: "10",
      hasMore: false,
    };
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
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9&preamble=agent-wake-v1`,
      { origin: "app://bundle" },
    );
    sockets.push(socket);

    const frames = await new Promise<unknown[]>((resolve) => {
      const received: unknown[] = [];
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
        if (received.length === 2) resolve(received);
      });
    });

    expect(frames).toMatchObject([
      { type: "member.updated", workspaceSequence: "10" },
      { type: "system.connected", workspaceSequence: "10" },
    ]);
  });

  it("rejects an unknown realtime preamble before consuming the ticket", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      workspace: {
        repository: repository.asRepository(),
        realtimeHub: new FakeRealtimeEventHub().asHub(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/realtime?ticket=${ticket}&after=9&preamble=unknown`,
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        origin: "app://bundle",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(repository.consumedTickets).toEqual([]);
  });

  it("loads the next agent replay page concurrently but sends it only after authorization", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000012",
    };
    repository.syncResponses.push(
      {
        events: [replayEvent],
        nextCursor: "10",
        highWaterCursor: "11",
        hasMore: true,
      },
      {
        events: [secondReplayEvent],
        nextCursor: "11",
        highWaterCursor: "11",
        hasMore: false,
      },
    );
    const authorizationStarted = Promise.withResolvers<void>();
    const releaseAuthorization = Promise.withResolvers<void>();
    repository.beforeRevalidation = async (call) => {
      if (call !== 2) return;
      authorizationStarted.resolve();
      await releaseAuthorization.promise;
    };
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
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9&preamble=agent-wake-v1`,
      { origin: "app://bundle" },
    );
    sockets.push(socket);
    const frames: unknown[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));

    await authorizationStarted.promise;
    try {
      await vi.waitFor(() => expect(repository.syncedCursors).toEqual(["9", "10"]));
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames).toMatchObject([
        { type: "system.connected", workspaceSequence: "9" },
        { type: "member.updated", workspaceSequence: "10" },
      ]);
    } finally {
      releaseAuthorization.resolve();
    }
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toMatchObject({ type: "member.updated", workspaceSequence: "11" });
  });

  it("sends only the body-free recovery control when the replay cursor has expired", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000011",
    };
    repository.syncError = new ApiError(409, "CURSOR_EXPIRED", "Cursor expired");
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
    const frames: unknown[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));

    const [code] = await once(socket, "close");

    expect(code).toBe(4009);
    expect(frames).toMatchObject([
      {
        type: "system.resync_required",
        workspaceSequence: "9",
        payload: { reason: "cursor_expired" },
      },
    ]);
  });

  it("closes an initially invalid principal before replaying any events", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000013",
    };
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
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=9&preamble=agent-wake-v1`,
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
      {
        userId,
        workspaceId,
        deviceSessionId: null,
        agentTokenId: "10000000-0000-4000-8000-000000000013",
      },
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

  it("rejects a revoked agent before a publish-triggered flush can deliver", async () => {
    const repository = new FakeWorkspaceRepository();
    const hub = new FakeRealtimeEventHub();
    const agentTokenId = "10000000-0000-4000-8000-000000000005";
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId,
    };
    const { socket } = await connectedApp(repository, hub);
    repository.syncResponse = {
      events: [replayEvent],
      nextCursor: "10",
      highWaterCursor: "10",
      hasMore: false,
    };
    repository.revalidation = { status: "invalid", reason: "agent_token_revoked" };

    const outcome = new Promise<
      | { readonly type: "close"; readonly code: number; readonly reason: string }
      | { readonly type: "message"; readonly frame: unknown }
    >((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ type: "close", code, reason: reason.toString() });
      });
      socket.once("message", (data) => {
        resolve({ type: "message", frame: JSON.parse(data.toString()) });
      });
    });
    hub.notify();

    await expect(outcome).resolves.toEqual({
      type: "close",
      code: REALTIME_SESSION_REVOKED_CLOSE_CODE,
      reason: "Session revoked",
    });
  });

  it("revalidates a coalesced publish after an earlier checked page finishes", async () => {
    const repository = new FakeWorkspaceRepository();
    const hub = new FakeRealtimeEventHub();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000009",
    };
    const { socket } = await connectedApp(repository, hub);
    await vi.waitFor(() => expect(repository.syncedCursors).toEqual(["9"]));
    repository.syncResponses.push(
      { events: [], nextCursor: "9", highWaterCursor: "9", hasMore: false },
      {
        events: [replayEvent],
        nextCursor: "10",
        highWaterCursor: "10",
        hasMore: false,
      },
    );
    const pageStarted = Promise.withResolvers<void>();
    const releasePage = Promise.withResolvers<void>();
    repository.afterSync = async (call) => {
      if (call !== 2) return;
      pageStarted.resolve();
      await releasePage.promise;
    };
    const outcome = new Promise<
      | { readonly type: "close"; readonly code: number; readonly reason: string }
      | { readonly type: "message"; readonly frame: unknown }
    >((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ type: "close", code, reason: reason.toString() });
      });
      socket.once("message", (data) => {
        resolve({ type: "message", frame: JSON.parse(data.toString()) });
      });
    });

    hub.notify();
    await pageStarted.promise;
    repository.revalidation = { status: "invalid", reason: "agent_token_revoked" };
    hub.notify();
    releasePage.resolve();

    await expect(outcome).resolves.toEqual({
      type: "close",
      code: REALTIME_SESSION_REVOKED_CLOSE_CODE,
      reason: "Session revoked",
    });
  });

  it("fails closed when agent authorization cannot be checked before a notified flush", async () => {
    const repository = new FakeWorkspaceRepository();
    const hub = new FakeRealtimeEventHub();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000007",
    };
    const { socket } = await connectedApp(repository, hub);
    repository.syncResponse = {
      events: [replayEvent],
      nextCursor: "10",
      highWaterCursor: "10",
      hasMore: false,
    };
    repository.revalidationError = new Error("database unavailable");

    const outcome = new Promise<
      | { readonly type: "close"; readonly code: number; readonly reason: string }
      | { readonly type: "message"; readonly frame: unknown }
    >((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ type: "close", code, reason: reason.toString() });
      });
      socket.once("message", (data) => {
        resolve({ type: "message", frame: JSON.parse(data.toString()) });
      });
    });
    hub.notify();

    await expect(outcome).resolves.toEqual({
      type: "close",
      code: 1011,
      reason: "Authorization unavailable",
    });
  });

  it("revalidates an agent again before delivering the next replay page", async () => {
    const repository = new FakeWorkspaceRepository();
    repository.consumedPrincipal = {
      workspaceId,
      userId,
      deviceSessionId: null,
      agentTokenId: "10000000-0000-4000-8000-000000000008",
    };
    repository.syncResponses.push(
      {
        events: [replayEvent],
        nextCursor: "10",
        highWaterCursor: "11",
        hasMore: true,
      },
      {
        events: [secondReplayEvent],
        nextCursor: "11",
        highWaterCursor: "11",
        hasMore: false,
      },
    );
    repository.afterSync = (call) => {
      if (call === 1) {
        repository.revalidation = { status: "invalid", reason: "agent_token_revoked" };
      }
    };
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
    const frames: unknown[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));

    const [code] = await once(socket, "close");

    expect(code).toBe(REALTIME_SESSION_REVOKED_CLOSE_CODE);
    expect(frames).toMatchObject([{ type: "member.updated", workspaceSequence: "10" }]);
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
