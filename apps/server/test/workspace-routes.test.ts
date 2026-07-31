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
      "x-hmm-chat-capabilities": "reaction-events-v1, read-state-events-v1",
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
    );
    expect(repository.issueRealtimeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
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
