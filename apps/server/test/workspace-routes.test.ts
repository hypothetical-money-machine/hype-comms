import { testPosition } from "./support/sync-position.js";
import { createHash } from "node:crypto";

import {
  ATTACHMENT_CONTENT_SHA256_HEADER,
  type AgentCurrentPrincipal,
  type AgentScope,
  type BotScope,
  type CurrentUser,
} from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthenticatedBotIdentity, BotService } from "../src/modules/bots/service.js";
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
const conversationId = "10000000-0000-4000-8000-000000000007";
const replyId = "10000000-0000-4000-8000-000000000008";
const agentUserId = "10000000-0000-4000-8000-000000000009";
const agentTokenId = "10000000-0000-4000-8000-000000000010";
const sessionToken = "a".repeat(43);
const botToken = `hype_comms_bot_${"b".repeat(43)}`;

const currentUser: CurrentUser = {
  user: {
    id: userId,
    kind: "human",
    username: "owner",
    displayName: "Owner",
    avatarUrl: null,
    title: "Chief Mischief Officer",
    createdAt: now,
    updatedAt: now,
  },
  email: "owner@example.com",
  workspaceId,
  role: "owner",
};

class FakeIdentityService {
  readonly defaultAgentAgencyEnabled: boolean | undefined;
  readonly authenticateContext: ReturnType<typeof vi.fn>;
  readonly authenticateAgentContext: ReturnType<typeof vi.fn>;

  constructor(
    role: "owner" | "member" = "owner",
    defaultAgentAgencyEnabled?: boolean,
    scopes: readonly AgentScope[] = ["workspace:read"],
  ) {
    this.defaultAgentAgencyEnabled = defaultAgentAgencyEnabled;
    this.authenticateContext = vi.fn(async () => ({
      currentUser: { ...currentUser, role },
      sessionId,
      principalKind: "human" as const,
    }));
    const currentAgent: AgentCurrentPrincipal = {
      type: "agent",
      user: {
        id: agentUserId,
        kind: "agent",
        username: "test-agent",
        displayName: "Test Agent",
        avatarUrl: null,
        title: null,
        createdAt: now,
        updatedAt: now,
      },
      workspaceId,
      role: "member",
      scopes: [...scopes],
    };
    this.authenticateAgentContext = vi.fn(async () => ({
      currentUser: currentAgent,
      authorizationScopes: [...scopes],
      agentTokenId,
      principalKind: "agent" as const,
    }));
  }

  asService(): IdentityService {
    return this as unknown as IdentityService;
  }
}

class FakeBotService {
  readonly authenticate;

  constructor(scopes: readonly BotScope[]) {
    const identity: AuthenticatedBotIdentity = {
      principalKind: "bot",
      currentUser: {
        user: {
          id: reactionId,
          kind: "bot",
          username: "task-bot",
          displayName: "Task Bot",
          avatarUrl: null,
          title: null,
          createdAt: now,
          updatedAt: now,
        },
        workspaceId,
        role: "member",
      },
      sessionId: null,
      credentialId: messageId,
      scopes,
    };
    this.authenticate = vi.fn(async () => identity);
  }

  asService(): BotService {
    return this as unknown as BotService;
  }
}

class FakeWorkspaceRepository {
  readonly requireGroupDirectMessagesForConversations = vi.fn(async () => undefined);
  readonly requireGroupDirectMessagesForMessages = vi.fn(async () => undefined);
  readonly requireGroupDirectMessagesForAttachments = vi.fn(async () => undefined);
  readonly bootstrap = vi.fn(async () => ({
    currentUser,
    workspace: {
      id: workspaceId,
      name: "Hype Comms",
      slug: "hype-comms",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    },
    members: [currentUser.user],
    conversations: [
      {
        conversation: {
          id: conversationId,
          workspaceId,
          kind: "channel",
          name: "Company News",
          slug: "company-news",
          topic: null,
          access: "workspace",
          channelMode: "announcement",
          isArchived: false,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        },
        participantIds: [userId],
        membershipRole: null,
        lastMessage: null,
        unreadCount: 0,
        mentionCount: 0,
        readCursor: null,
      },
    ],
    conversationsNextCursor: null,
    conversationsHasMore: false,
    syncCursor: testPosition("0"),
    featureFlags: {
      channels: true,
      directMessages: true,
      mentions: true,
      announcementChannels: true,
      humansOnlyChannels: true,
    },
  }));
  readonly listConversations = vi.fn(async () => {
    const bootstrap = await this.bootstrap();
    return { conversations: bootstrap.conversations, nextCursor: null, hasMore: false };
  });
  readonly listMembers = vi.fn(async () => ({ members: [currentUser.user] }));
  readonly listChannelMembers = vi.fn(async () => ({
    conversationId,
    access: "workspace" as const,
    members: [{ user: currentUser.user, role: "owner" as const, joinedAt: now }],
    canManage: true,
  }));
  readonly createChannel = vi.fn(async () => ({
    conversation: (await this.bootstrap()).conversations[0],
    syncCursor: testPosition("1"),
  }));
  readonly archiveChannel = vi.fn(async () => ({
    conversation: (await this.bootstrap()).conversations[0],
    syncCursor: testPosition("2"),
  }));
  readonly createDirectConversation = vi.fn(async () => ({
    conversation: (await this.bootstrap()).conversations[0],
    syncCursor: testPosition("3"),
  }));
  readonly history = vi.fn(async () => ({
    reactions: [],
    snapshotPosition: testPosition("0"),
    messages: [
      {
        id: messageId,
        conversationId,
        conversationSequence: "1",
        version: 1,
        clientMessageId: messageId,
        authorId: userId,
        threadRootId: null,
        body: "Root",
        bodyFormat: "hype_comms_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    threadSummaries: [
      {
        threadRootId: messageId,
        replyCount: 1,
        latestReply: {
          id: replyId,
          conversationId,
          conversationSequence: "2",
          version: 1,
          clientMessageId: replyId,
          authorId: userId,
          threadRootId: messageId,
          body: "Reply",
          bodyFormat: "hype_comms_markdown_v1",
          editedAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    threadsSupported: true,
    nextCursor: null,
  }));
  readonly contextHistory = vi.fn(async () => ({
    contextPack: {
      version: 1 as const,
      conversation: {
        id: conversationId,
        kind: "channel" as const,
        slug: "company-news",
        selector: "#company-news",
      },
      anchorMessageId: messageId,
      messages: [
        {
          id: messageId,
          conversationSequence: "1",
          createdAt: now,
          body: "Root",
          author: {
            id: userId,
            kind: "human" as const,
            username: "owner",
            displayName: "Owner",
          },
          mentionedYou: false,
          threadRootId: null,
        },
      ],
      threadRoot: null,
      replyTarget: {
        kind: "thread" as const,
        conversationId,
        rootMessageId: messageId,
      },
      readThroughMessageId: messageId,
      truncatedBefore: false,
      nextCursor: null,
    },
  }));
  readonly thread = vi.fn(async () => ({
    reactions: [],
    snapshotPosition: testPosition("0"),
    root: {
      id: messageId,
      conversationId,
      conversationSequence: "1",
      version: 1,
      clientMessageId: messageId,
      authorId: userId,
      threadRootId: null,
      body: "Root",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    replies: [],
    nextCursor: null,
  }));
  readonly messageById = vi.fn(async () => ({
    message: {
      id: messageId,
      conversationId,
      conversationSequence: "1",
      version: 1,
      clientMessageId: messageId,
      authorId: userId,
      threadRootId: null,
      body: "Root",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  }));
  readonly retractMessage = vi.fn(async () => ({
    message: {
      id: messageId,
      conversationId,
      conversationSequence: "1",
      version: 2,
      clientMessageId: messageId,
      authorId: userId,
      threadRootId: null,
      body: "Root",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    syncCursor: testPosition("3"),
  }));
  readonly sendMessage = vi.fn(async (_identity: unknown, targetConversationId: string) => ({
    message: {
      id: replyId,
      conversationId: targetConversationId,
      conversationSequence: "2",
      version: 1,
      clientMessageId: replyId,
      authorId: userId,
      threadRootId: messageId,
      body: "Reply",
      bodyFormat: "hype_comms_markdown_v1",
      editedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    syncCursor: testPosition("2"),
  }));
  readonly sync = vi.fn(async () => ({
    events: [
      {
        version: 1,
        id: replyId,
        type: "member.updated" as const,
        occurredAt: now,
        workspaceId,
        conversationId: null,
        position: testPosition("1"),
        conversationSequence: null,
        entityVersion: 1,
        delivery: "at_least_once" as const,
        payload: { member: currentUser.user },
      },
    ],
    nextCursor: testPosition("0"),
    highWaterCursor: testPosition("0"),
    hasMore: false,
  }));
  readonly issueRealtimeTicket = vi.fn(async () => ({
    ticket: "b".repeat(32),
    position: testPosition("0"),
    expiresAt: now,
  }));
  readonly listMessageReactions = vi.fn(async () => ({ reactions: [] }));
  readonly addReaction = vi.fn(
    async (_identity: unknown, targetMessageId: string, emoji: string) => ({
      reaction: { id: reactionId, messageId: targetMessageId, userId, emoji, createdAt: now },
      syncCursor: testPosition("7"),
    }),
  );
  readonly removeReaction = vi.fn(async () => ({ removed: true, syncCursor: testPosition("8") }));
  readonly listConversationTasks = vi.fn(async () => ({
    snapshotPosition: testPosition("0"),
    tasks: [],
    nextCursor: null,
    hasMore: false,
  }));
  readonly listChannelTasks = vi.fn(async () => ({
    snapshotPosition: testPosition("0"),
    tasks: [],
    nextCursor: null,
    hasMore: false,
  }));
  readonly listMyTasks = vi.fn(async () => ({
    snapshotPosition: testPosition("0"),
    tasks: [],
    nextCursor: null,
    hasMore: false,
  }));
  readonly getTask = vi.fn(async () => ({ task: { id: taskId } }));
  readonly getChannelTaskByNumber = vi.fn(async () => ({ task: { id: taskId } }));
  readonly createTask = vi.fn(async () => ({
    task: { id: taskId },
    syncCursor: testPosition("9"),
  }));
  readonly createChannelTask = vi.fn(async () => ({
    task: { id: taskId },
    syncCursor: testPosition("9"),
  }));
  readonly updateTask = vi.fn(async () => ({
    task: { id: taskId },
    syncCursor: testPosition("10"),
  }));
  readonly moveTask = vi.fn(async () => ({ task: { id: taskId }, syncCursor: testPosition("11") }));
  readonly communicationPaths = vi.fn(async () => ({
    generatedAt: now,
    members: [currentUser.user],
    paths: [],
  }));
  readonly readFileContent = vi.fn(async () => {
    const bytes = Buffer.from("payload", "utf8");
    return {
      attachment: {
        id: messageId,
        messageId: replyId,
        uploadedBy: userId,
        fileName: "evidence.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        status: "ready" as const,
        downloadUrl: null,
        createdAt: now,
      },
      bytes,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });

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

async function reactionApp(repository: FakeWorkspaceRepository, botService?: BotService) {
  const app = await buildApp({
    identity: {
      service: new FakeIdentityService().asService(),
      ...(botService === undefined ? {} : { botService }),
    },
    workspace: {
      repository: repository.asRepository(),
      realtimeHub: new FakeRealtimeEventHub().asHub(),
    },
  });
  apps.push(app);
  return app;
}

async function appWithRole(
  repository: FakeWorkspaceRepository,
  role: "owner" | "member",
): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const app = await buildApp({
    identity: { service: new FakeIdentityService(role).asService() },
    workspace: {
      repository: repository.asRepository(),
      realtimeHub: new FakeRealtimeEventHub().asHub(),
    },
  });
  apps.push(app);
  return app;
}

describe("canonical workspace routes", () => {
  it("does not expose the retired Wake bootstrap", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const response = await app.inject({
      method: "GET",
      url: "/v2/agent-wake/bootstrap",
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(repository.bootstrap).not.toHaveBeenCalled();
  });

  it("serves authoritative length and SHA-256 headers with attachment bytes", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const response = await app.inject({
      method: "GET",
      url: `/v2/files/${messageId}/content`,
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("payload");
    expect(response.headers["content-length"]).toBe("7");
    expect(response.headers[ATTACHMENT_CONTENT_SHA256_HEADER]).toBe(
      createHash("sha256").update("payload").digest("hex"),
    );
    expect(repository.readFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
    );
  });

  it("returns canonical announcement fields regardless of obsolete headers", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const legacy = await app.inject({
      method: "GET",
      url: "/v2/bootstrap",
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });
    const capable = await app.inject({
      method: "GET",
      url: "/v2/bootstrap",
      headers: {
        cookie: `hype_comms_session=${sessionToken}`,
        "x-hype-comms-capabilities": "announcement-channels-v1,threads-v1",
      },
    });

    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().featureFlags.announcementChannels).toBe(true);
    expect(legacy.json().conversations[0].conversation.channelMode).toBe("announcement");
    expect(capable.statusCode).toBe(200);
    expect(capable.json().featureFlags.announcementChannels).toBe(true);
    expect(capable.json().conversations[0].conversation.channelMode).toBe("announcement");
  });

  it("includes authorized group conversations without negotiation", async () => {
    const repository = new FakeWorkspaceRepository();
    const bootstrap = await repository.bootstrap();
    const base = bootstrap.conversations[0]!;
    repository.bootstrap.mockResolvedValue({
      ...bootstrap,
      conversations: [
        {
          ...base,
          conversation: {
            ...base.conversation,
            kind: "group_direct_message",
            name: null,
            slug: null,
            topic: null,
            access: null,
            channelMode: null,
          },
          participantIds: [userId, messageId, reactionId],
          membershipRole: "owner",
        },
      ],
    });
    const app = await reactionApp(repository);
    const legacyHeaders = { cookie: `hype_comms_session=${sessionToken}` };
    const capableHeaders = {
      ...legacyHeaders,
      "x-hype-comms-capabilities": "group-direct-messages-v1",
    };

    for (const url of ["/v2/bootstrap", "/v2/conversations?limit=50"]) {
      const legacy = await app.inject({ method: "GET", url, headers: legacyHeaders });
      const capable = await app.inject({ method: "GET", url, headers: capableHeaders });

      expect(legacy.statusCode).toBe(200);
      expect(capable.statusCode).toBe(200);
      expect(legacy.json()).toEqual(capable.json());
      expect(capable.json().conversations[0]).toMatchObject({
        conversation: { kind: "group_direct_message" },
        participantIds: [userId, messageId, reactionId],
      });
    }
  });

  it("includes titles on every user response", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const legacyHeaders = { cookie: `hype_comms_session=${sessionToken}` };
    const capableHeaders = {
      ...legacyHeaders,
      "x-hype-comms-capabilities": "member-profiles-v1",
    };
    const requests = [
      { url: "/v2/bootstrap", user: (body: Record<string, unknown>) => body.members?.[0] },
      { url: "/v2/members", user: (body: Record<string, unknown>) => body.members?.[0] },
      {
        url: "/v2/channels/10000000-0000-4000-8000-000000000007/members",
        user: (body: Record<string, unknown>) => (body.members as { user: unknown }[])?.[0]?.user,
      },
      {
        url: "/v2/admin/communication-paths",
        user: (body: Record<string, unknown>) => body.members?.[0],
      },
    ] as const;

    for (const request of requests) {
      const legacy = await app.inject({ method: "GET", url: request.url, headers: legacyHeaders });
      const capable = await app.inject({
        method: "GET",
        url: request.url,
        headers: capableHeaders,
      });
      expect(legacy.statusCode).toBe(200);
      expect(capable.statusCode).toBe(200);
      expect(request.user(legacy.json())).toMatchObject({ title: "Chief Mischief Officer" });
      expect(request.user(capable.json())).toMatchObject({ title: "Chief Mischief Officer" });
    }

    const legacySync = await app.inject({
      method: "GET",
      url: `/v2/sync?after=${encodeURIComponent(JSON.stringify(testPosition("0")))}&limit=100`,
      headers: legacyHeaders,
    });
    const capableSync = await app.inject({
      method: "GET",
      url: `/v2/sync?after=${encodeURIComponent(JSON.stringify(testPosition("0")))}&limit=100`,
      headers: capableHeaders,
    });
    expect(legacySync.json().events[0].payload.member).toMatchObject({
      title: "Chief Mischief Officer",
    });
    expect(capableSync.json().events[0].payload.member).toMatchObject({
      title: "Chief Mischief Officer",
    });
  });

  it("includes channel mode on every conversation response", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const legacyHeaders = { cookie: `hype_comms_session=${sessionToken}` };
    const capableHeaders = {
      ...legacyHeaders,
      "x-hype-comms-capabilities": "announcement-channels-v1,threads-v1",
    };
    const requests = [
      { method: "GET", url: "/v2/conversations?limit=50" },
      {
        method: "POST",
        url: "/v2/channels",
        payload: {
          name: "Company News",
          slug: "company-news",
          topic: null,
          access: "workspace",
          channelMode: "announcement",
        },
      },
      {
        method: "PATCH",
        url: `/v2/channels/${conversationId}`,
        payload: { isArchived: true },
      },
      {
        method: "POST",
        url: "/v2/direct-conversations",
        payload: { memberId: userId },
      },
    ] as const;

    for (const request of requests) {
      const legacy = await app.inject({ ...request, headers: legacyHeaders });
      const capable = await app.inject({ ...request, headers: capableHeaders });
      expect(legacy.statusCode).toBeLessThan(300);
      expect(capable.statusCode).toBeLessThan(300);
      const legacySummary =
        request.method === "GET" ? legacy.json().conversations[0] : legacy.json().conversation;
      const capableSummary =
        request.method === "GET" ? capable.json().conversations[0] : capable.json().conversation;
      expect(legacySummary.conversation.channelMode).toBe("announcement");
      expect(capableSummary.conversation.channelMode).toBe("announcement");
    }
  });

  it("retains humans-only access on reads and creation without negotiation", async () => {
    const repository = new FakeWorkspaceRepository();
    const bootstrap = await repository.bootstrap();
    const humansOnlySummary = {
      ...bootstrap.conversations[0]!,
      conversation: {
        ...bootstrap.conversations[0]!.conversation,
        name: "People",
        slug: "people",
        access: "humans" as const,
      },
    };
    repository.bootstrap.mockResolvedValue({
      ...bootstrap,
      conversations: [humansOnlySummary],
      featureFlags: { ...bootstrap.featureFlags, humansOnlyChannels: true },
    });
    repository.listChannelMembers.mockResolvedValue({
      conversationId,
      access: "humans",
      members: [{ user: currentUser.user, role: "member", joinedAt: now }],
      canManage: false,
    });
    const app = await reactionApp(repository);
    const legacyHeaders = { cookie: `hype_comms_session=${sessionToken}` };
    const capableHeaders = {
      ...legacyHeaders,
      "x-hype-comms-capabilities": "humans-only-channels-v1",
    };

    for (const request of [
      { method: "GET", url: "/v2/bootstrap" },
      { method: "GET", url: "/v2/conversations?limit=50" },
      { method: "PATCH", url: `/v2/channels/${conversationId}`, payload: { isArchived: true } },
    ] as const) {
      const legacy = await app.inject({ ...request, headers: legacyHeaders });
      const capable = await app.inject({ ...request, headers: capableHeaders });
      expect(legacy.statusCode).toBeLessThan(300);
      expect(capable.statusCode).toBeLessThan(300);
      const legacySummary =
        request.method === "GET" ? legacy.json().conversations[0] : legacy.json().conversation;
      const capableSummary =
        request.method === "GET" ? capable.json().conversations[0] : capable.json().conversation;
      expect(legacySummary.conversation.access).toBe("humans");
      expect(capableSummary.conversation.access).toBe("humans");
    }

    const legacyBootstrap = await app.inject({
      method: "GET",
      url: "/v2/bootstrap",
      headers: legacyHeaders,
    });
    const capableBootstrap = await app.inject({
      method: "GET",
      url: "/v2/bootstrap",
      headers: capableHeaders,
    });
    expect(legacyBootstrap.json().featureFlags.humansOnlyChannels).toBe(true);
    expect(capableBootstrap.json().featureFlags.humansOnlyChannels).toBe(true);

    const legacyMembers = await app.inject({
      method: "GET",
      url: `/v2/channels/${conversationId}/members`,
      headers: legacyHeaders,
    });
    const capableMembers = await app.inject({
      method: "GET",
      url: `/v2/channels/${conversationId}/members`,
      headers: capableHeaders,
    });
    expect(legacyMembers.json()).toMatchObject({ access: "humans", canManage: false });
    expect(capableMembers.json()).toMatchObject({ access: "humans", canManage: false });

    const input = { name: "People", slug: "people", topic: null, access: "humans" };
    const legacyCreate = await app.inject({
      method: "POST",
      url: "/v2/channels",
      headers: legacyHeaders,
      payload: input,
    });
    const capableCreate = await app.inject({
      method: "POST",
      url: "/v2/channels",
      headers: capableHeaders,
      payload: input,
    });
    expect(legacyCreate.statusCode).toBe(201);
    expect(capableCreate.statusCode).toBe(201);
    expect(capableCreate.json().conversation.conversation.access).toBe("humans");
    expect(repository.createChannel).toHaveBeenCalledTimes(2);
  });

  it("issues sync and realtime results without capability arguments", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = {
      cookie: `hype_comms_session=${sessionToken}`,
      "x-hype-comms-capabilities":
        `reaction-events-v1, read-state-events-v1, task-events-v1, ` +
        `${"participated-thread-notifications-v1"}, ${"message-retract-v1"}, ` +
        `${"ephemeral-activity-v1"}, ${"group-direct-messages-v1"}, ` +
        `${"humans-only-channels-v1"}, ${"system-channels-v1"}`,
    };

    const sync = await app.inject({
      method: "GET",
      url: `/v2/sync?after=${encodeURIComponent(JSON.stringify(testPosition("0")))}&limit=100`,
      headers,
    });
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/v2/realtime/tickets",
      headers,
    });

    expect(sync.statusCode).toBe(200);
    expect(ticketResponse.statusCode).toBe(200);
    expect(repository.sync).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      testPosition("0"),
      100,
    );
    expect(repository.issueRealtimeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
    );
  });

  it("ignores obsolete capability headers", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = { cookie: `hype_comms_session=${sessionToken}` };

    const legacy = await app.inject({
      method: "GET",
      url: `/v2/sync?after=${encodeURIComponent(JSON.stringify(testPosition("0")))}&limit=100`,
      headers,
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v2/realtime/tickets",
      headers: { ...headers, "x-hype-comms-capabilities": "reaction events" },
    });

    expect(legacy.statusCode).toBe(200);
    expect(repository.sync).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      testPosition("0"),
      100,
    );
    expect(malformed.statusCode).toBe(200);
    expect(repository.issueRealtimeTicket).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
    );
  });

  it("validates and forwards an authorized batch hydration query", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const response = await app.inject({
      method: "POST",
      url: "/v2/reactions/query",
      headers: {
        cookie: `hype_comms_session=${sessionToken}`,
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
    const path = `/v2/messages/${messageId}/reactions/${encodeURIComponent("👩🏽‍💻")}`;
    const headers = { cookie: `hype_comms_session=${sessionToken}` };

    const added = await app.inject({ method: "PUT", url: path, headers });
    const removed = await app.inject({ method: "DELETE", url: path, headers });

    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ reaction: { messageId, emoji: "👩🏽‍💻" } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true, syncCursor: testPosition("8") });
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
    const headers = { cookie: `hype_comms_session=${sessionToken}` };

    for (const emoji of ["shipit", "👍 🎉"]) {
      const response = await app.inject({
        method: "PUT",
        url: `/v2/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
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
      url: "/v2/reactions/query",
      headers: {
        cookie: `hype_comms_session=${sessionToken}`,
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
    const headers = { cookie: `hype_comms_session=${sessionToken}` };

    const listed = await app.inject({
      method: "GET",
      url: `/v2/conversations/${messageId}/tasks?after=cursor&limit=25`,
      headers,
    });
    const mine = await app.inject({ method: "GET", url: "/v2/tasks/mine", headers });
    const missingKey = await app.inject({
      method: "POST",
      url: `/v2/conversations/${messageId}/tasks`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { title: "Build the board" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/v2/conversations/${messageId}/tasks`,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": taskId,
      },
      payload: { title: "  Build the board  ", priority: "high" },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v2/tasks/${taskId}`,
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
      url: `/v2/tasks/${taskId}/move`,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": reactionId,
      },
      payload: { expectedVersion: 2, status: "in_progress", beforeTaskId: null },
    });
    const oversizedVersion = await app.inject({
      method: "PATCH",
      url: `/v2/tasks/${taskId}`,
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "oversized-version",
      },
      payload: {
        expectedVersion: Number.MAX_SAFE_INTEGER + 1,
        title: "Should be rejected",
        description: null,
        priority: "none",
        assigneeId: null,
        dueOn: null,
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(mine.statusCode).toBe(200);
    expect(missingKey.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(moved.statusCode).toBe(200);
    expect(oversizedVersion.statusCode).toBe(400);
    expect(repository.listConversationTasks).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
      "cursor",
      25,
      {},
    );
    expect(repository.listMyTasks).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      undefined,
      100,
      {},
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

  it("accepts scoped bot credentials only on task routes", async () => {
    const repository = new FakeWorkspaceRepository();
    const botService = new FakeBotService(["tasks:read"]);
    const app = await reactionApp(repository, botService.asService());
    const authorization = { authorization: `Bearer ${botToken}` };

    const listed = await app.inject({
      method: "GET",
      url: `/v2/conversations/${messageId}/tasks`,
      headers: authorization,
    });
    const writeWithoutScope = await app.inject({
      method: "POST",
      url: `/v2/conversations/${messageId}/tasks`,
      headers: {
        ...authorization,
        "content-type": "application/json",
        "idempotency-key": taskId,
      },
      payload: { title: "Bot-created task" },
    });
    const nonTaskRoute = await app.inject({
      method: "GET",
      url: "/v2/members",
      headers: authorization,
    });

    expect(listed.statusCode).toBe(200);
    expect(writeWithoutScope.statusCode).toBe(403);
    expect(nonTaskRoute.statusCode).toBe(401);
    expect(botService.authenticate).toHaveBeenCalledWith(botToken);
    expect(repository.listConversationTasks).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: "bot", credentialId: messageId }),
      messageId,
      undefined,
      100,
      {},
    );
    expect(repository.createTask).not.toHaveBeenCalled();
  });

  it("does not fall back to a human cookie when a bot credential is malformed", async () => {
    const repository = new FakeWorkspaceRepository();
    const botService = new FakeBotService(["tasks:read"]);
    const app = await reactionApp(repository, botService.asService());

    const response = await app.inject({
      method: "GET",
      url: `/v2/conversations/${messageId}/tasks`,
      headers: {
        cookie: `hype_comms_session=${sessionToken}`,
        authorization: "Bearer malformed",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(botService.authenticate).not.toHaveBeenCalled();
    expect(repository.listConversationTasks).not.toHaveBeenCalled();
  });

  it("lets a write-scoped bot mutate tasks without granting list access", async () => {
    const repository = new FakeWorkspaceRepository();
    const botService = new FakeBotService(["tasks:write"]);
    const app = await reactionApp(repository, botService.asService());
    const headers = {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json",
      "idempotency-key": taskId,
    };

    const created = await app.inject({
      method: "POST",
      url: `/v2/conversations/${messageId}/tasks`,
      headers,
      payload: { title: "Bot-created task" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v2/conversations/${messageId}/tasks`,
      headers: { authorization: headers.authorization },
    });

    expect(created.statusCode).toBe(201);
    expect(listed.statusCode).toBe(403);
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: "bot" }),
      messageId,
      expect.objectContaining({ title: "Bot-created task" }),
      taskId,
    );
    expect(repository.listConversationTasks).not.toHaveBeenCalled();
  });

  it("supports filtered channel-slug lists and stable single-task references", async () => {
    const repository = new FakeWorkspaceRepository();
    const botService = new FakeBotService(["tasks:read", "tasks:write"]);
    const app = await reactionApp(repository, botService.asService());
    const headers = { authorization: `Bearer ${botToken}` };
    const filteredUrl = new URL("http://localhost/v2/channels/general/tasks");
    filteredUrl.searchParams.set("status", "in_progress");
    filteredUrl.searchParams.set("priority", "urgent");
    filteredUrl.searchParams.set("assignee", "me");
    filteredUrl.searchParams.set("dueAfter", "2026-08-01");
    filteredUrl.searchParams.set("dueBefore", "2026-08-31");
    filteredUrl.searchParams.set("updatedAfter", now);
    filteredUrl.searchParams.set("updatedBy", "me");

    const filtered = await app.inject({
      method: "GET",
      url: `${filteredUrl.pathname}${filteredUrl.search}`,
      headers,
    });
    const byNumber = await app.inject({
      method: "GET",
      url: "/v2/channels/general/tasks/12",
      headers,
    });
    const byId = await app.inject({ method: "GET", url: `/v2/tasks/${taskId}`, headers });
    const created = await app.inject({
      method: "POST",
      url: "/v2/channels/general/tasks",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": taskId,
      },
      payload: { title: "Create by human-readable channel" },
    });
    const invalidRange = await app.inject({
      method: "GET",
      url: "/v2/channels/general/tasks?dueAfter=2026-09-01&dueBefore=2026-08-01",
      headers,
    });
    const invalidNumber = await app.inject({
      method: "GET",
      url: "/v2/channels/general/tasks/0",
      headers,
    });
    const oversizedNumber = await app.inject({
      method: "GET",
      url: "/v2/channels/general/tasks/9223372036854775808",
      headers,
    });

    expect(filtered.statusCode).toBe(200);
    expect(byNumber.statusCode).toBe(200);
    expect(byId.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(invalidRange.statusCode).toBe(400);
    expect(invalidNumber.statusCode).toBe(400);
    expect(oversizedNumber.statusCode).toBe(400);
    expect(repository.listChannelTasks).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: "bot" }),
      "general",
      undefined,
      100,
      {
        status: "in_progress",
        priority: "urgent",
        assignee: "me",
        dueAfter: "2026-08-01",
        dueBefore: "2026-08-31",
        updatedAfter: now,
        updatedBy: "me",
      },
    );
    expect(repository.getChannelTaskByNumber).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: "bot" }),
      "general",
      "12",
    );
    expect(repository.getTask).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: "bot" }),
      taskId,
    );
    expect(repository.createChannelTask).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: "bot" }),
      "general",
      expect.objectContaining({ title: "Create by human-readable channel" }),
      taskId,
    );
    expect(repository.listChannelTasks).toHaveBeenCalledTimes(1);
    expect(repository.getChannelTaskByNumber).toHaveBeenCalledTimes(1);
  });
});

describe("message thread routes", () => {
  it("loads one exact authorized message without exposing a search primitive", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);

    const response = await app.inject({
      method: "GET",
      url: `/v2/messages/${messageId}`,
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      message: expect.objectContaining({ id: messageId, conversationId }),
    });
    expect(repository.messageById).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
    );
  });

  it("rejects a malformed exact-message target before repository access", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);

    const response = await app.inject({
      method: "GET",
      url: "/v2/messages/not-a-uuid",
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.messageById).not.toHaveBeenCalled();
  });

  it("forwards an authorized retract and rejects a malformed target", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = { cookie: `hype_comms_session=${sessionToken}` };

    const retracted = await app.inject({
      method: "DELETE",
      url: `/v2/messages/${messageId}`,
      headers,
    });
    const malformed = await app.inject({
      method: "DELETE",
      url: "/v2/messages/not-a-uuid",
      headers,
    });

    expect(retracted.statusCode).toBe(200);
    expect(retracted.json()).toMatchObject({
      message: { id: messageId, body: "Root", deletedAt: now },
      syncCursor: testPosition("3"),
    });
    expect(repository.retractMessage).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
    );
    expect(malformed.statusCode).toBe(400);
    expect(repository.retractMessage).toHaveBeenCalledTimes(1);
  });

  it("always includes thread summaries in history", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = { cookie: `hype_comms_session=${sessionToken}` };

    const legacy = await app.inject({
      method: "GET",
      url: `/v2/conversations/${conversationId}/messages`,
      headers,
    });
    const capable = await app.inject({
      method: "GET",
      url: `/v2/conversations/${conversationId}/messages`,
      headers: { ...headers, "x-hype-comms-capabilities": "threads-v1" },
    });

    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({
      reactions: [],
      snapshotPosition: testPosition("0"),
      messages: expect.any(Array),
      threadSummaries: [expect.objectContaining({ threadRootId: messageId, replyCount: 1 })],
      threadsSupported: true,
      nextCursor: null,
    });
    expect(capable.statusCode).toBe(200);
    expect(capable.json()).toMatchObject({
      reactions: [],
      snapshotPosition: testPosition("0"),
      messages: expect.any(Array),
      threadSummaries: [{ threadRootId: messageId, replyCount: 1 }],
      threadsSupported: true,
      nextCursor: null,
    });
    expect(repository.history).toHaveBeenCalledTimes(2);
    expect(repository.history).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ currentUser }),
      conversationId,
      undefined,
      50,
    );
    expect(repository.history).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ currentUser }),
      conversationId,
      undefined,
      50,
    );
  });

  it("serves bounded context history without capability negotiation", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const sessionHeaders = { cookie: `hype_comms_session=${sessionToken}` };

    const missingCapability = await app.inject({
      method: "GET",
      url:
        `/v2/conversations/${conversationId}/messages?contextPack=true` +
        `&throughMessageId=${messageId}&limit=4`,
      headers: sessionHeaders,
    });
    expect(missingCapability.statusCode).toBe(200);
    expect(repository.history).not.toHaveBeenCalled();
    expect(repository.contextHistory).toHaveBeenCalledOnce();

    const capable = await app.inject({
      method: "GET",
      url:
        `/v2/conversations/${conversationId}/messages?contextPack=true` +
        `&throughMessageId=${messageId}&limit=4`,
      headers: {
        ...sessionHeaders,
        "x-hype-comms-capabilities": "agent-context-pack-v1",
      },
    });
    expect(capable.statusCode).toBe(200);
    expect(capable.json()).toEqual(await repository.contextHistory.mock.results[0]?.value);
    expect(repository.contextHistory).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      conversationId,
      undefined,
      messageId,
      4,
    );
    expect(repository.history).not.toHaveBeenCalled();
  });

  it("validates bounded context-history paging before repository access", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = {
      cookie: `hype_comms_session=${sessionToken}`,
      "x-hype-comms-capabilities": "agent-context-pack-v1",
    };

    for (const query of [
      `contextPack=true&throughMessageId=${messageId}&before=cursor`,
      "contextPack=true&limit=21",
      "contextPack=true&limit=0",
      "contextPack=false",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v2/conversations/${conversationId}/messages?${query}`,
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "BAD_REQUEST" },
      });
    }
    expect(repository.contextHistory).not.toHaveBeenCalled();
    expect(repository.history).not.toHaveBeenCalled();

    const page = await app.inject({
      method: "GET",
      url: `/v2/conversations/${conversationId}/messages?contextPack=true&before=cursor`,
      headers,
    });
    expect(page.statusCode).toBe(200);
    expect(repository.contextHistory).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      conversationId,
      "cursor",
      undefined,
      8,
    );
  });

  it("loads a bounded thread page and forwards a reply root on send", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const headers = {
      cookie: `hype_comms_session=${sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": replyId,
      "x-hype-comms-capabilities": `${"threads-v1"},${"announcement-channels-v1"}`,
    };

    const thread = await app.inject({
      method: "GET",
      url: `/v2/messages/${messageId}/thread?before=cursor&limit=25`,
      headers,
    });
    const reply = await app.inject({
      method: "POST",
      url: `/v2/conversations/${conversationId}/messages`,
      headers,
      payload: {
        threadRootId: messageId,
        body: "Reply",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: replyId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });

    expect(thread.statusCode).toBe(200);
    expect(repository.thread).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      messageId,
      "cursor",
      25,
    );
    expect(reply.statusCode).toBe(201);
    expect(repository.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      conversationId,
      expect.objectContaining({ clientMessageId: replyId, threadRootId: messageId }),
      "req-2",
    );
  });

  it("rejects malformed thread pagination before calling the repository", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);
    const response = await app.inject({
      method: "GET",
      url: `/v2/messages/${messageId}/thread?limit=101`,
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.thread).not.toHaveBeenCalled();
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
      cookie: `hype_comms_session=${sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": messageId,
    };

    const accepted = await app.inject({ method: "POST", url: "/v2/channels", headers, payload });
    const legacy = await app.inject({
      method: "POST",
      url: "/v2/channels",
      headers: { cookie: headers.cookie, "content-type": headers["content-type"] },
      payload: { ...payload, slug: "legacy-channel" },
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v2/channels",
      headers: { ...headers, "idempotency-key": "bad key" },
      payload,
    });

    expect(accepted.statusCode).toBe(201);
    expect(legacy.statusCode).toBe(201);
    expect(repository.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
      payload,
      messageId,
      "req-1",
      true,
    );
    expect(malformed.statusCode).toBe(400);
    expect(repository.createChannel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ currentUser }),
      { ...payload, slug: "legacy-channel" },
      undefined,
      "req-2",
      true,
    );
    expect(repository.createChannel).toHaveBeenCalledTimes(2);
  });
});

describe("default agent agency rollout gate", () => {
  it("authenticates public-channel discovery before revealing the rollout state", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await buildApp({
      identity: { service: new FakeIdentityService("owner", false).asService() },
      workspace: {
        repository: repository.asRepository(),
        realtimeHub: new FakeRealtimeEventHub().asHub(),
      },
    });
    apps.push(app);

    const anonymous = await app.inject({ method: "GET", url: "/v2/channels" });
    const invalidCredential = await app.inject({
      method: "GET",
      url: "/v2/channels",
      headers: { authorization: "Bearer invalid" },
    });
    const authenticated = await app.inject({
      method: "GET",
      url: "/v2/channels",
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalidCredential.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(503);
  });

  it("authenticates public-channel self-join before revealing the rollout state", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await buildApp({
      identity: { service: new FakeIdentityService("owner", false).asService() },
      workspace: {
        repository: repository.asRepository(),
        realtimeHub: new FakeRealtimeEventHub().asHub(),
      },
    });
    apps.push(app);
    const url = `/v2/channels/${conversationId}/membership`;

    const anonymous = await app.inject({ method: "PUT", url });
    const invalidCredential = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: "Bearer invalid" },
    });
    const authenticated = await app.inject({
      method: "PUT",
      url,
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalidCredential.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(503);
  });

  it("authenticates group-conversation creation before revealing the rollout state", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await buildApp({
      identity: { service: new FakeIdentityService("owner", false).asService() },
      workspace: {
        repository: repository.asRepository(),
        realtimeHub: new FakeRealtimeEventHub().asHub(),
      },
    });
    apps.push(app);
    const request = {
      method: "POST" as const,
      url: "/v2/group-direct-conversations",
      payload: { memberIds: [messageId, replyId] },
    };

    const anonymous = await app.inject(request);
    const invalidCredential = await app.inject({
      ...request,
      headers: { authorization: "Bearer invalid" },
    });
    const authenticated = await app.inject({
      ...request,
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(invalidCredential.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(503);
  });
});

describe("admin communication paths route", () => {
  it("returns aggregated member-to-member paths for workspace owners", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);

    const response = await app.inject({
      method: "GET",
      url: "/v2/admin/communication-paths",
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.communicationPaths).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser }),
    );
    expect(response.json()).toEqual({
      generatedAt: now,
      members: [
        {
          id: userId,
          kind: "human",
          username: "owner",
          displayName: "Owner",
          title: "Chief Mischief Officer",
          avatarUrl: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      paths: [],
    });
  });

  it("rejects non-owner members with 403 without querying the repository", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await appWithRole(repository, "member");

    const response = await app.inject({
      method: "GET",
      url: "/v2/admin/communication-paths",
      headers: { cookie: `hype_comms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(repository.communicationPaths).not.toHaveBeenCalled();
  });

  it("requires an authenticated session", async () => {
    const repository = new FakeWorkspaceRepository();
    const app = await reactionApp(repository);

    const response = await app.inject({ method: "GET", url: "/v2/admin/communication-paths" });

    expect(response.statusCode).toBe(401);
    expect(repository.communicationPaths).not.toHaveBeenCalled();
  });
});
