import { describe, expect, it } from "vitest";

import type { SendMessageOperation } from "@hmm-chat/contracts";

import { ChatSession, type SessionCookieStore, type SessionFetch } from "./chat-session";
import { WorkspaceTransport } from "./workspace-transport";

const API_ORIGIN = "https://chat.example";
const NOW = "2026-07-24T12:00:00.000Z";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const CLIENT_MESSAGE_ID = "10000000-0000-4000-8000-000000000010";

const CURRENT_USER = {
  user: {
    id: "10000000-0000-4000-8000-000000000001",
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

describe("WorkspaceTransport sync classification", () => {
  it("accepts a well-formed sync page", async () => {
    const transport = transportAnswering(() => jsonResponse(SYNC_RESPONSE));

    await expect(transport.sync("41")).resolves.toEqual({
      status: "accepted",
      response: SYNC_RESPONSE,
    });
  });

  it("sends the requested cursor and limit", async () => {
    const requests: string[] = [];
    const { transport } = createTransport(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse(SYNC_RESPONSE);
    });

    await transport.sync("41", 25);

    expect(requests).toEqual(["GET https://chat.example/v1/sync?after=41&limit=25"]);
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
});
