import { type CurrentUser } from "@hmm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { IdentityService } from "../src/modules/identity/service.js";
import type { RealtimeEventHub } from "../src/modules/realtime/hub.js";
import type { WorkspaceRepository } from "../src/modules/workspace/repository.js";

const now = "2026-07-27T18:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000003";
const messageId = "10000000-0000-4000-8000-000000000004";
const reactionId = "10000000-0000-4000-8000-000000000005";
const taskId = "10000000-0000-4000-8000-000000000006";
const sessionToken = "a".repeat(43);

const currentUser: CurrentUser = {
  user: {
    id: userId,
    username: "owner",
    displayName: "Owner",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  },
  email: "owner@example.com",
  workspaceId,
  role: "owner",
};

class FakeIdentityService {
  readonly authenticateContext = vi.fn(async () => ({ currentUser, sessionId }));

  asService(): IdentityService {
    return this as unknown as IdentityService;
  }
}

class FakeWorkspaceRepository {
  readonly createChannel = vi.fn(async () => ({}));
  readonly sync = vi.fn(async () => ({
    events: [],
    nextCursor: "0",
    highWaterCursor: "0",
    hasMore: false,
  }));
  readonly issueRealtimeTicket = vi.fn(async () => ({ ticket: "b".repeat(32), expiresAt: now }));
  readonly listMessageReactions = vi.fn(async () => ({ reactions: [] }));
  readonly addReaction = vi.fn(
    async (_identity: unknown, targetMessageId: string, emoji: string) => ({
      reaction: { id: reactionId, messageId: targetMessageId, userId, emoji, createdAt: now },
      syncCursor: "7",
    }),
  );
  readonly removeReaction = vi.fn(async () => ({ removed: true, syncCursor: "8" }));
  readonly listConversationTasks = vi.fn(async () => ({
    tasks: [],
    nextCursor: null,
    hasMore: false,
  }));
  readonly listMyTasks = vi.fn(async () => ({ tasks: [], nextCursor: null, hasMore: false }));
  readonly createTask = vi.fn(async () => ({ task: { id: taskId }, syncCursor: "9" }));
  readonly updateTask = vi.fn(async () => ({ task: { id: taskId }, syncCursor: "10" }));
  readonly moveTask = vi.fn(async () => ({ task: { id: taskId }, syncCursor: "11" }));

  asRepository(): WorkspaceRepository {
    return this as unknown as WorkspaceRepository;
  }
}

class FakeRealtimeEventHub {
  subscribe(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {}

  asHub(): RealtimeEventHub {
    return this as unknown as RealtimeEventHub;
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function reactionApp(repository: FakeWorkspaceRepository) {
  const app = await buildApp({
    identity: { service: new FakeIdentityService().asService() },
    workspace: {
      repository: repository.asRepository(),
      realtimeHub: new FakeRealtimeEventHub().asHub(),
    },
  });
  apps.push(app);
  return app;
}

describe("event capability routes", () => {
  it("negotiates event payloads independently for sync and realtime", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = {
      cookie: `hmm_session=${sessionToken}`,
      "x-hmm-chat-capabilities": "reaction-events-v1, read-state-events-v1, task-events-v1",
    };

    const sync = await app.inject({ method: "GET", url: "/v1/sync?after=0&limit=100", headers });
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/v1/realtime/tickets",
      headers,
    });

    expect(sync.statusCode).toBe(200);
    expect(ticketResponse.statusCode).toBe(200);
    expect(repository.sync).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      "0",
      100,
      true,
      true,
      true,
    );
    expect(repository.issueRealtimeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      true,
      true,
      true,
    );
  });

  it("keeps legacy clients opted out and rejects malformed capability headers", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = { cookie: `hmm_session=${sessionToken}` };

    const legacy = await app.inject({
      method: "GET",
      url: "/v1/sync?after=0&limit=100",
      headers,
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/realtime/tickets",
      headers: { ...headers, "x-hmm-chat-capabilities": "reaction events" },
    });

    expect(legacy.statusCode).toBe(200);
    expect(repository.sync).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      "0",
      100,
      false,
      false,
      false,
    );
    expect(malformed.statusCode).toBe(400);
    expect(repository.issueRealtimeTicket).not.toHaveBeenCalled();
  });

  it("validates and forwards an authorized batch hydration query", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reactions/query",
      headers: {
        cookie: `hmm_session=${sessionToken}`,
        "content-type": "application/json",
      },
      payload: { messageIds: [messageId] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reactions: [] });
    expect(repository.listMessageReactions).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      [messageId],
    );
  });

  it("decodes and forwards one Unicode emoji for idempotent add and remove", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const path = `/v1/messages/${messageId}/reactions/${encodeURIComponent("👩🏽‍💻")}`;
    const headers = { cookie: `hmm_session=${sessionToken}` };

    const added = await app.inject({ method: "PUT", url: path, headers });
    const removed = await app.inject({ method: "DELETE", url: path, headers });

    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ reaction: { messageId, emoji: "👩🏽‍💻" } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true, syncCursor: "8" });
    expect(repository.addReaction).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
      "👩🏽‍💻",
    );
    expect(repository.removeReaction).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
      "👩🏽‍💻",
    );
  });

  it("rejects text and multiple emoji before calling the repository", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = { cookie: `hmm_session=${sessionToken}` };

    for (const emoji of ["shipit", "👍 🎉"]) {
      const response = await app.inject({
        method: "PUT",
        url: `/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    }
    expect(repository.addReaction).not.toHaveBeenCalled();
  });

  it("rejects duplicate message IDs in a hydration query", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const response = await app.inject({
      method: "POST",
      url: "/v1/reactions/query",
      headers: {
        cookie: `hmm_session=${sessionToken}`,
        "content-type": "application/json",
      },
      payload: { messageIds: [messageId, messageId] },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.listMessageReactions).not.toHaveBeenCalled();
  });
});

describe("task routes", () => {
  it("validates paging and requires idempotency for every task mutation", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = { cookie: `hmm_session=${sessionToken}` };

    const listed = await app.inject({
      method: "GET",
      url: `/v1/conversations/${messageId}/tasks?after=cursor&limit=25`,
      headers,
    });
    const mine = await app.inject({ method: "GET", url: "/v1/tasks/mine", headers });
    const missingKey = await app.inject({
      method: "POST",
      url: `/v1/conversations/${messageId}/tasks`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { title: "Build the board" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/v1/conversations/${messageId}/tasks`,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": taskId,
      },
      payload: { title: "  Build the board  ", priority: "high" },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/tasks/${taskId}`,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": messageId,
      },
      payload: {
        expectedVersion: 1,
        title: "Build and verify the board",
        description: null,
        priority: "urgent",
        assigneeId: null,
        dueOn: null,
      },
    });
    const moved = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/move`,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": reactionId,
      },
      payload: { expectedVersion: 2, status: "in_progress", beforeTaskId: null },
    });

    expect(listed.statusCode).toBe(200);
    expect(mine.statusCode).toBe(200);
    expect(missingKey.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(moved.statusCode).toBe(200);
    expect(repository.listConversationTasks).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
      "cursor",
      25,
    );
    expect(repository.listMyTasks).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      undefined,
      100,
    );
    expect(repository.createTask).toHaveBeenCalledTimes(1);
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
      {
        title: "Build the board",
        description: null,
        priority: "high",
        assigneeId: null,
        dueOn: null,
        sourceMessageId: null,
      },
      taskId,
    );
    expect(repository.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      taskId,
      expect.objectContaining({ expectedVersion: 1, priority: "urgent" }),
      messageId,
    );
    expect(repository.moveTask).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      taskId,
      { expectedVersion: 2, status: "in_progress", beforeTaskId: null },
      reactionId,
    );
  });
});

describe("channel mutation routes", () => {
  it("forwards a valid optional idempotency key and rejects a malformed one", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const payload = {
      name: "Alpha Team",
      slug: "alpha-team",
      topic: null,
      access: "workspace",
    };
    const headers = {
      cookie: `hmm_session=${sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": messageId,
    };

    const accepted = await app.inject({ method: "POST", url: "/v1/channels", headers, payload });
    const legacy = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers: { cookie: headers.cookie, "content-type": headers["content-type"] },
      payload: { ...payload, slug: "legacy-channel" },
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers: { ...headers, "idempotency-key": "bad key" },
      payload,
    });

    expect(accepted.statusCode).toBe(201);
    expect(legacy.statusCode).toBe(201);
    expect(repository.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      payload,
      messageId,
    );
    expect(malformed.statusCode).toBe(400);
    expect(repository.createChannel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ currentUser }),
      { ...payload, slug: "legacy-channel" },
      undefined,
    );
    expect(repository.createChannel).toHaveBeenCalledTimes(2);
  });
});
