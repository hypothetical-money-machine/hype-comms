import { describe, expect, it } from "vitest";

import {
  ANNOUNCEMENT_CHANNELS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  TASK_EVENTS_CAPABILITY,
  THREADS_CAPABILITY,
  type SendMessageOperation,
  type Task,
} from "@hmm-chat/contracts";

import { ChatSession, type SessionCookieStore, type SessionFetch } from "./chat-session";
import { WorkspaceTransport } from "./workspace-transport";

const API_ORIGIN = "https://chat.example";
const NOW = "2026-07-24T12:00:00.000Z";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const CLIENT_MESSAGE_ID = "10000000-0000-4000-8000-000000000010";
const MEMBER_ID = "10000000-0000-4000-8000-000000000011";
const REACTION_ID = "10000000-0000-4000-8000-000000000012";
const THREAD_REPLY_ID = "10000000-0000-4000-8000-000000000013";
const THREAD_REPLY_CLIENT_ID = "10000000-0000-4000-8000-000000000014";
const CLIENT_CAPABILITIES = [
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  TASK_EVENTS_CAPABILITY,
  THREADS_CAPABILITY,
  ANNOUNCEMENT_CHANNELS_CAPABILITY,
].join(",");

const CURRENT_USER = {
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "human",
    username: "morgan",
    displayName: "Morgan",
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  email: "morgan@example.com",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  role: "member",
} as const;

const SYNC_RESPONSE = {
  events: [],
  nextCursor: "42",
  highWaterCursor: "42",
  hasMore: false,
} as const;

const BOOTSTRAP_RESPONSE = {
  currentUser: CURRENT_USER,
  workspace: {
    id: "10000000-0000-4000-8000-000000000002",
    name: "HMM",
    slug: "hmm",
    createdBy: "10000000-0000-4000-8000-000000000001",
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [],
  conversations: [
    {
      conversation: {
        id: CONVERSATION_ID,
        workspaceId: "10000000-0000-4000-8000-000000000002",
        kind: "channel",
        name: "General",
        slug: "general",
        topic: null,
        access: "workspace",
        channelMode: "chat",
        isArchived: false,
        createdBy: "10000000-0000-4000-8000-000000000001",
        createdAt: NOW,
        updatedAt: NOW,
      },
      participantIds: [],
      membershipRole: null,
      lastMessage: null,
      unreadCount: 0,
      mentionCount: 0,
      readCursor: null,
    },
  ],
  conversationsNextCursor: null,
  conversationsHasMore: false,
  syncCursor: "42",
  featureFlags: {
    channels: true,
    directMessages: true,
    mentions: true,
    announcementChannels: false,
  },
} as const;

const SEND_OPERATION: SendMessageOperation = {
  conversationId: CONVERSATION_ID,
  idempotencyKey: CLIENT_MESSAGE_ID,
  message: {
    threadRootId: null,
    body: "hello",
    bodyFormat: "hmm_markdown_v1",
    clientMessageId: CLIENT_MESSAGE_ID,
    mentionedUserIds: [],
    attachmentIds: [],
  },
};

const CHANNEL_MEMBERS_RESPONSE = {
  conversationId: CONVERSATION_ID,
  access: "members",
  members: [{ user: CURRENT_USER.user, role: "owner", joinedAt: NOW }],
  canManage: true,
} as const;

const SEARCH_RESPONSE = {
  results: [
    {
      message: {
        id: CLIENT_MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "7",
        version: 1,
        clientMessageId: CLIENT_MESSAGE_ID,
        authorId: CURRENT_USER.user.id,
        threadRootId: null,
        body: "Quarterly avalanche review",
        bodyFormat: "hmm_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  ],
  nextCursor: "next-page",
} as const;

const THREAD_ROOT = SEARCH_RESPONSE.results[0].message;
const THREAD_REPLY = {
  ...THREAD_ROOT,
  id: THREAD_REPLY_ID,
  conversationSequence: "8",
  clientMessageId: THREAD_REPLY_CLIENT_ID,
  threadRootId: THREAD_ROOT.id,
  body: "Thread reply",
} as const;

const REACTION = {
  id: REACTION_ID,
  messageId: CLIENT_MESSAGE_ID,
  userId: CURRENT_USER.user.id,
  emoji: "👩🏽‍💻",
  createdAt: NOW,
} as const;

const TASK: Task = {
  id: "10000000-0000-4000-8000-000000000013",
  workspaceId: CURRENT_USER.workspaceId,
  conversationId: CONVERSATION_ID,
  number: "1",
  version: 1,
  title: "Build Kanban",
  description: null,
  status: "todo",
  priority: "high",
  assigneeId: CURRENT_USER.user.id,
  dueOn: null,
  sourceMessageId: null,
  rank: "1024",
  createdBy: CURRENT_USER.user.id,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

class MemoryCookies implements SessionCookieStore {
  readonly values = new Map<string, string>();
  readonly removals: string[] = [];

  async get(filter: { readonly url: string; readonly name: string }) {
    const value = this.values.get(filter.name);
    return value === undefined ? [] : [{ name: filter.name, value }];
  }

  async remove(_url: string, name: string): Promise<void> {
    this.removals.push(name);
    this.values.delete(name);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function createTransport(request: SessionFetch): {
  readonly transport: WorkspaceTransport;
  readonly session: ChatSession;
} {
  const session = new ChatSession({
    apiOrigin: API_ORIGIN,
    cookies: new MemoryCookies(),
    request,
  });
  return { transport: new WorkspaceTransport(API_ORIGIN, session), session };
}

/** Builds a transport whose every product request answers with one prepared response. */
function transportAnswering(response: () => Response | Promise<Response>): WorkspaceTransport {
  return createTransport(async () => response()).transport;
}

describe("WorkspaceTransport bootstrap compatibility", () => {
  it("treats a pre-pagination bootstrap response as one complete conversation page", async () => {
    // A pre-pagination server omitted both conversation-page fields entirely.
    const legacyFeatureFlags: {
      -readonly [
        Key in keyof typeof BOOTSTRAP_RESPONSE.featureFlags
      ]?: (typeof BOOTSTRAP_RESPONSE.featureFlags)[Key];
    } = {
      ...BOOTSTRAP_RESPONSE.featureFlags,
    };
    delete legacyFeatureFlags.announcementChannels;
    const legacyConversation: {
      -readonly [
        Key in keyof (typeof BOOTSTRAP_RESPONSE.conversations)[number]["conversation"]
      ]?: (typeof BOOTSTRAP_RESPONSE.conversations)[number]["conversation"][Key];
    } = { ...BOOTSTRAP_RESPONSE.conversations[0].conversation };
    delete legacyConversation.channelMode;
    const legacyBootstrap: Record<string, unknown> = {
      ...BOOTSTRAP_RESPONSE,
      featureFlags: legacyFeatureFlags,
      conversations: [{ ...BOOTSTRAP_RESPONSE.conversations[0], conversation: legacyConversation }],
    };
    delete legacyBootstrap.conversationsNextCursor;
    delete legacyBootstrap.conversationsHasMore;
    const transport = transportAnswering(() => jsonResponse(legacyBootstrap));

    await expect(transport.bootstrap()).resolves.toEqual(BOOTSTRAP_RESPONSE);
  });
});

describe("WorkspaceTransport threads", () => {
  it("advertises thread support when requesting conversation history", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        messages: [THREAD_ROOT],
        threadSummaries: [
          { threadRootId: THREAD_ROOT.id, replyCount: 1, latestReply: THREAD_REPLY },
        ],
        threadsSupported: true,
        nextCursor: null,
      });
    });

    await transport.history({ conversationId: CONVERSATION_ID, before: "cursor-2", limit: 25 });

    expect(requests).toEqual([
      {
        url: `https://chat.example/v1/conversations/${CONVERSATION_ID}/messages?before=cursor-2&limit=25`,
        init: expect.objectContaining({
          method: "GET",
          headers: { "x-hmm-chat-capabilities": CLIENT_CAPABILITIES },
        }),
      },
    ]);
  });

  it("detects the immediately previous server from an absent thread-support signal", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({ messages: [THREAD_ROOT, THREAD_REPLY], nextCursor: null }),
    );

    await expect(
      transport.history({ conversationId: CONVERSATION_ID, limit: 25 }),
    ).resolves.toMatchObject({
      messages: [THREAD_ROOT, THREAD_REPLY],
      threadSummaries: [],
      threadsSupported: false,
    });
  });

  it("fetches and strictly parses a paginated thread", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const response = { root: THREAD_ROOT, replies: [THREAD_REPLY], nextCursor: "cursor-1" };
    const { transport } = createTransport(async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(response);
    });

    await expect(
      transport.thread({ messageId: THREAD_ROOT.id, before: "cursor-2", limit: 25 }),
    ).resolves.toEqual(response);
    expect(requests).toEqual([
      {
        url: `https://chat.example/v1/messages/${THREAD_ROOT.id}/thread?before=cursor-2&limit=25`,
        init: expect.objectContaining({ method: "GET" }),
      },
    ]);
  });

  it("rejects a thread response whose reply points at another root", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({
        root: THREAD_ROOT,
        replies: [{ ...THREAD_REPLY, threadRootId: CONVERSATION_ID }],
        nextCursor: null,
      }),
    );

    await expect(transport.thread({ messageId: THREAD_ROOT.id, limit: 50 })).rejects.toThrow(
      "Reply must belong to the requested thread",
    );
  });
});

describe("WorkspaceTransport sync classification", () => {
  it("accepts a well-formed sync page", async () => {
    const transport = transportAnswering(() => jsonResponse(SYNC_RESPONSE));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "accepted",
      response: SYNC_RESPONSE,
    });
  });

  it("sends the requested cursor, limit, and supported event capabilities", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(SYNC_RESPONSE);
    });

    await transport.sync("41", 25);

    expect(requests).toEqual([
      {
        url: "https://chat.example/v1/sync?after=41&limit=25",
        init: expect.objectContaining({
          method: "GET",
          headers: { "x-hmm-chat-capabilities": CLIENT_CAPABILITIES },
        }),
      },
    ]);
  });

  it("advertises supported event capabilities when issuing a realtime ticket", async () => {
    const requests: RequestInit[] = [];
    const { transport } = createTransport(async (_url, init) => {
      requests.push(init);
      return jsonResponse({ ticket: "a".repeat(32), expiresAt: NOW });
    });

    await transport.ticket();

    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        headers: { "x-hmm-chat-capabilities": CLIENT_CAPABILITIES },
      }),
    ]);
  });

  it("reports a revoked membership (403) as permanent instead of retryable", async () => {
    const transport = transportAnswering(() => statusResponse(403));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "permanent",
      reason: "forbidden",
    });
  });

  it("reports a rejected sync request (400) as permanent validation instead of retryable", async () => {
    const transport = transportAnswering(() => statusResponse(400));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "permanent",
      reason: "validation",
    });
  });

  it("reports a missing sync route (404) as permanent instead of retryable", async () => {
    const transport = transportAnswering(() => statusResponse(404));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "permanent",
      reason: "not_found",
    });
  });

  it("reports an unparseable success body as permanent, never as retryable", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({ events: [], nextCursor: "not-a-sequence", hasMore: false }),
    );

    await expect(transport.sync("41")).resolves.toEqual({
      status: "permanent",
      reason: "invalid_response",
    });
  });

  it("reports a success response that is not JSON as permanent, never as retryable", async () => {
    const transport = transportAnswering(() => new Response("not json", { status: 200 }));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "permanent",
      reason: "invalid_response",
    });
  });

  it("keeps an expired cursor (410) a reset request", async () => {
    const transport = transportAnswering(() => statusResponse(410));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "reset_required",
      reason: "cursor_expired",
    });
  });

  it("carries Retry-After when the server rate limits sync", async () => {
    const transport = transportAnswering(() => statusResponse(429, { "retry-after": "30" }));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "retryable",
      reason: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("carries Retry-After when the server fails with a 5xx", async () => {
    const transport = transportAnswering(() => statusResponse(503, { "retry-after": "2" }));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "retryable",
      reason: "server",
      retryAfterMs: 2_000,
    });
  });

  it("reports a 5xx without Retry-After as retryable with no delay hint", async () => {
    const transport = transportAnswering(() => statusResponse(500));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "retryable",
      reason: "server",
      retryAfterMs: null,
    });
  });

  it("classifies a connection failure as a retryable network failure", async () => {
    const { transport } = createTransport(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(transport.sync("41")).resolves.toEqual({
      status: "retryable",
      reason: "network",
      retryAfterMs: null,
    });
  });

  it("classifies a request timeout as a retryable network failure", async () => {
    const { transport } = createTransport(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await expect(transport.sync("41")).resolves.toEqual({
      status: "retryable",
      reason: "network",
      retryAfterMs: null,
    });
  });

  it("signs the device out on 401 and reports authentication_required", async () => {
    const { transport, session } = createTransport(async (url) =>
      url.endsWith("/v1/auth/me") ? jsonResponse(CURRENT_USER) : statusResponse(401),
    );

    await session.restore();
    expect(session.state.status).toBe("signed-in");

    await expect(transport.sync("41")).resolves.toEqual({ status: "authentication_required" });
    expect(session.state).toEqual({ status: "signed-out" });
  });
});

describe("WorkspaceTransport send classification", () => {
  it("forwards a non-null thread root in the idempotent send body", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ message: THREAD_REPLY, syncCursor: "43" });
    });
    const operation: SendMessageOperation = {
      ...SEND_OPERATION,
      idempotencyKey: THREAD_REPLY_CLIENT_ID,
      message: {
        ...SEND_OPERATION.message,
        clientMessageId: THREAD_REPLY_CLIENT_ID,
        threadRootId: THREAD_ROOT.id,
        body: THREAD_REPLY.body,
      },
    };

    await expect(transport.send(operation)).resolves.toMatchObject({ status: "accepted" });
    expect(requests).toEqual([
      {
        url: `https://chat.example/v1/conversations/${CONVERSATION_ID}/messages`,
        init: expect.objectContaining({
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": THREAD_REPLY_CLIENT_ID,
          },
          body: JSON.stringify(operation.message),
        }),
      },
    ]);
  });

  it("treats 408 Request Timeout as retryable instead of permanently blocking the outbox", async () => {
    const transport = transportAnswering(() => statusResponse(408));

    await expect(transport.send(SEND_OPERATION)).resolves.toEqual({
      status: "retryable",
      reason: "server",
      retryAfterMs: null,
    });
  });

  it("treats 425 Too Early as retryable instead of permanently blocking the outbox", async () => {
    const transport = transportAnswering(() => statusResponse(425, { "retry-after": "1" }));

    await expect(transport.send(SEND_OPERATION)).resolves.toEqual({
      status: "retryable",
      reason: "server",
      retryAfterMs: 1_000,
    });
  });

  it("classifies a request timeout as a network retry, not an invalid response", async () => {
    const { transport } = createTransport(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await expect(transport.send(SEND_OPERATION)).resolves.toEqual({
      status: "retryable",
      reason: "network",
      retryAfterMs: null,
    });
  });

  it("keeps a rejected payload (413) permanent", async () => {
    const transport = transportAnswering(() => statusResponse(413));

    await expect(transport.send(SEND_OPERATION)).resolves.toEqual({
      status: "permanent",
      reason: "validation",
    });
  });

  it("keeps a duplicate send (409) permanent", async () => {
    const transport = transportAnswering(() => statusResponse(409));

    await expect(transport.send(SEND_OPERATION)).resolves.toEqual({
      status: "permanent",
      reason: "conflict",
    });
  });
});

describe("WorkspaceTransport conversations", () => {
  it("requests one conversation page with the cursor and limit on the querystring", async () => {
    const requests: string[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse({ conversations: [], nextCursor: null, hasMore: false });
    });

    await expect(transport.conversations({ after: "cursor-2", limit: 10 })).resolves.toEqual({
      conversations: [],
      nextCursor: null,
      hasMore: false,
    });
    await transport.conversations();

    expect(requests).toEqual([
      "GET https://chat.example/v1/conversations?after=cursor-2&limit=10",
      "GET https://chat.example/v1/conversations?limit=50",
    ]);
  });

  it("retries an ambiguous channel create with the same idempotency key", async () => {
    const requests: { readonly key: string | null; readonly body: string | null }[] = [];
    const { transport } = createTransport(async (_url, init) => {
      requests.push({
        key: new Headers(init.headers).get("idempotency-key"),
        body: typeof init.body === "string" ? init.body : null,
      });
      if (requests.length === 1) throw new TypeError("connection reset after commit");
      return jsonResponse({ conversation: BOOTSTRAP_RESPONSE.conversations[0], syncCursor: "43" });
    });

    await expect(
      transport.createChannel({
        name: "Alpha Team",
        slug: "alpha-team",
        topic: null,
        access: "workspace",
        idempotencyKey: CLIENT_MESSAGE_ID,
      }),
    ).resolves.toMatchObject({ syncCursor: "43" });
    expect(requests).toEqual([
      {
        key: CLIENT_MESSAGE_ID,
        body: JSON.stringify({
          name: "Alpha Team",
          slug: "alpha-team",
          topic: null,
          access: "workspace",
        }),
      },
      {
        key: CLIENT_MESSAGE_ID,
        body: JSON.stringify({
          name: "Alpha Team",
          slug: "alpha-team",
          topic: null,
          access: "workspace",
        }),
      },
    ]);
  });

  it("advertises announcement support and sends the mode only for announcement creates", async () => {
    const requests: Array<{ readonly capability: string | null; readonly body: string | null }> =
      [];
    const { transport } = createTransport(async (_url, init) => {
      requests.push({
        capability: new Headers(init.headers).get("x-hmm-chat-capabilities"),
        body: typeof init.body === "string" ? init.body : null,
      });
      return jsonResponse({ conversation: BOOTSTRAP_RESPONSE.conversations[0], syncCursor: "43" });
    });

    await transport.createChannel({
      name: "Company News",
      slug: "company-news",
      topic: null,
      access: "workspace",
      channelMode: "announcement",
      idempotencyKey: CLIENT_MESSAGE_ID,
    });

    expect(requests).toEqual([
      {
        capability: CLIENT_CAPABILITIES,
        body: JSON.stringify({
          name: "Company News",
          slug: "company-news",
          topic: null,
          access: "workspace",
          channelMode: "announcement",
        }),
      },
    ]);
  });
});

describe("WorkspaceTransport tasks", () => {
  it("uses scoped list and idempotent mutation routes with canonical bodies", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") {
        return jsonResponse({ tasks: [TASK], nextCursor: null, hasMore: false });
      }
      return jsonResponse({ task: TASK, syncCursor: "43" });
    });

    await expect(
      transport.tasks(CONVERSATION_ID, {
        after: "cursor",
        limit: 25,
        status: "in_progress",
        priority: "urgent",
        assignee: "me",
        dueAfter: "2026-08-01",
        dueBefore: "2026-08-31",
        updatedAfter: NOW,
        updatedBy: "me",
      }),
    ).resolves.toEqual({ tasks: [TASK], nextCursor: null, hasMore: false });
    await transport.myTasks({ limit: 10 });
    await transport.createTask({
      conversationId: CONVERSATION_ID,
      idempotencyKey: CLIENT_MESSAGE_ID,
      title: TASK.title,
      description: null,
      priority: TASK.priority,
      assigneeId: TASK.assigneeId,
      dueOn: null,
      sourceMessageId: null,
    });
    await transport.updateTask({
      taskId: TASK.id,
      idempotencyKey: CLIENT_MESSAGE_ID,
      expectedVersion: 1,
      title: TASK.title,
      description: null,
      priority: TASK.priority,
      assigneeId: TASK.assigneeId,
      dueOn: null,
    });
    await transport.moveTask({
      taskId: TASK.id,
      idempotencyKey: CLIENT_MESSAGE_ID,
      expectedVersion: 1,
      status: "in_progress",
      beforeTaskId: null,
    });

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [
        "GET",
        "https://chat.example/v1/conversations/10000000-0000-4000-8000-000000000003/tasks?after=cursor&limit=25&status=in_progress&priority=urgent&assignee=me&dueAfter=2026-08-01&dueBefore=2026-08-31&updatedAfter=2026-07-24T12%3A00%3A00.000Z&updatedBy=me",
      ],
      ["GET", "https://chat.example/v1/tasks/mine?limit=10"],
      ["POST", "https://chat.example/v1/conversations/10000000-0000-4000-8000-000000000003/tasks"],
      ["PATCH", `https://chat.example/v1/tasks/${TASK.id}`],
      ["POST", `https://chat.example/v1/tasks/${TASK.id}/move`],
    ]);
    for (const request of requests.slice(2)) {
      expect(request.init.headers).toMatchObject({ "idempotency-key": CLIENT_MESSAGE_ID });
      expect(JSON.parse(String(request.init.body))).not.toHaveProperty("idempotencyKey");
    }
  });

  it("rejects malformed successful task payloads", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({ tasks: [{ ...TASK, rank: "0" }], nextCursor: null, hasMore: false }),
    );
    await expect(transport.tasks(CONVERSATION_ID)).rejects.toThrow();
  });
});

describe("WorkspaceTransport members", () => {
  it("reads the workspace member directory from the members route", async () => {
    const requests: string[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse({ members: [CURRENT_USER.user] });
    });

    // The one call that can tell an already-bootstrapped client a member is gone: the route
    // answers with active memberships only, and `member.updated` cannot express a removal.
    await expect(transport.members()).resolves.toEqual({ members: [CURRENT_USER.user] });
    expect(requests).toEqual(["GET https://chat.example/v1/members"]);
  });

  it("rejects a member directory the wire contract does not allow", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({ members: [{ ...CURRENT_USER.user, status: "revoked" }] }),
    );

    // `userSchema` is strict, so a server that starts inventing a status field fails loudly here
    // instead of silently handing the renderer a shape the cache cannot store.
    await expect(transport.members()).rejects.toThrow();
  });
});

describe("WorkspaceTransport reactions", () => {
  it("hydrates and mutates encoded Unicode reactions through the scoped routes", async () => {
    const requests: { method: string; url: string; body: string | null }[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push({
        method: init.method ?? "GET",
        url,
        body: typeof init.body === "string" ? init.body : null,
      });
      if (init.method === "POST") return jsonResponse({ reactions: [REACTION] });
      if (init.method === "PUT") return jsonResponse({ reaction: REACTION, syncCursor: "43" });
      return jsonResponse({ removed: true, syncCursor: "44" });
    });

    await expect(transport.reactions([CLIENT_MESSAGE_ID])).resolves.toEqual({
      reactions: [REACTION],
    });
    await expect(transport.addReaction(CLIENT_MESSAGE_ID, "👩🏽‍💻")).resolves.toEqual({
      reaction: REACTION,
      syncCursor: "43",
    });
    await expect(transport.removeReaction(CLIENT_MESSAGE_ID, "👩🏽‍💻")).resolves.toEqual({
      removed: true,
      syncCursor: "44",
    });

    const reactionUrl = `https://chat.example/v1/messages/${CLIENT_MESSAGE_ID}/reactions/${encodeURIComponent("👩🏽‍💻")}`;
    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://chat.example/v1/reactions/query",
        body: JSON.stringify({ messageIds: [CLIENT_MESSAGE_ID] }),
      },
      { method: "PUT", url: reactionUrl, body: null },
      { method: "DELETE", url: reactionUrl, body: null },
    ]);
  });

  it("rejects malformed successful reaction responses", async () => {
    const transport = transportAnswering(() => jsonResponse({ reactions: ["not-a-reaction"] }));

    await expect(transport.reactions([CLIENT_MESSAGE_ID])).rejects.toThrow();
  });

  it("rejects reactions for a message outside the requested batch", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({
        reactions: [{ ...REACTION, messageId: "10000000-0000-4000-8000-000000000099" }],
      }),
    );

    await expect(transport.reactions([CLIENT_MESSAGE_ID])).rejects.toThrow("unrequested message");
  });
});

describe("WorkspaceTransport channel membership", () => {
  it("uses the scoped member routes and bodies for list, add, update, and remove", async () => {
    const requests: { method: string; url: string; body: string | null }[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push({
        method: init.method ?? "GET",
        url,
        body: typeof init.body === "string" ? init.body : null,
      });
      return init.method === "GET"
        ? jsonResponse(CHANNEL_MEMBERS_RESPONSE)
        : jsonResponse({ channelMembers: CHANNEL_MEMBERS_RESPONSE, syncCursor: "43" });
    });

    await expect(transport.channelMembers(CONVERSATION_ID)).resolves.toEqual(
      CHANNEL_MEMBERS_RESPONSE,
    );
    await transport.upsertChannelMember(CONVERSATION_ID, MEMBER_ID, { role: "member" });
    await transport.upsertChannelMember(CONVERSATION_ID, MEMBER_ID, { role: "owner" });
    await transport.removeChannelMember(CONVERSATION_ID, MEMBER_ID);

    expect(requests).toEqual([
      {
        method: "GET",
        url: `https://chat.example/v1/channels/${CONVERSATION_ID}/members`,
        body: null,
      },
      {
        method: "PUT",
        url: `https://chat.example/v1/channels/${CONVERSATION_ID}/members/${MEMBER_ID}`,
        body: JSON.stringify({ role: "member" }),
      },
      {
        method: "PUT",
        url: `https://chat.example/v1/channels/${CONVERSATION_ID}/members/${MEMBER_ID}`,
        body: JSON.stringify({ role: "owner" }),
      },
      {
        method: "DELETE",
        url: `https://chat.example/v1/channels/${CONVERSATION_ID}/members/${MEMBER_ID}`,
        body: null,
      },
    ]);
  });

  it("rejects a malformed successful member response", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({ ...CHANNEL_MEMBERS_RESPONSE, unexpected: true }),
    );

    await expect(transport.channelMembers(CONVERSATION_ID)).rejects.toThrow();
  });
});

describe("WorkspaceTransport search", () => {
  it("encodes the query and cursor and validates the result page", async () => {
    const requests: string[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse(SEARCH_RESPONSE);
    });

    await expect(
      transport.searchMessages({
        query: "quarterly avalanche",
        after: "cursor-2",
        limit: 25,
      }),
    ).resolves.toEqual(SEARCH_RESPONSE);
    expect(requests).toEqual([
      "GET https://chat.example/v1/search?query=quarterly+avalanche&after=cursor-2&limit=25",
    ]);
  });

  it("rejects a malformed successful search response", async () => {
    const transport = transportAnswering(() =>
      jsonResponse({ ...SEARCH_RESPONSE, unexpected: true }),
    );

    await expect(
      transport.searchMessages({ query: "quarterly avalanche", limit: 25 }),
    ).rejects.toThrow();
  });
});
