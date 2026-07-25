import { describe, expect, it } from "vitest";

import type { MagicLinkToken } from "@hmm-chat/contracts";

import {
  ChatSession,
  ChatSessionError,
  INVALID_MAGIC_LINK_MESSAGE,
  type SessionCookieStore,
  type SessionFetch,
} from "./chat-session";

const API_ORIGIN = "https://chat.example";
const TOKEN = "A".repeat(43) as MagicLinkToken;
const NOW = "2026-07-24T12:00:00.000Z";

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

class MemoryCookies implements SessionCookieStore {
  readonly values = new Map<string, string>();
  readonly removals: string[] = [];
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async get(filter: { readonly url: string; readonly name: string }) {
    const value = this.values.get(filter.name);
    return value === undefined ? [] : [{ name: filter.name, value }];
  }

  async remove(_url: string, name: string): Promise<void> {
    this.events.push(`remove ${name}`);
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

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function createSession(request: SessionFetch, cookies = new MemoryCookies()): ChatSession {
  return new ChatSession({ apiOrigin: API_ORIGIN, cookies, request });
}

describe("ChatSession restore", () => {
  it("restores the invited member identity without exposing its cookie", async () => {
    const requests: string[] = [];
    const cookies = new MemoryCookies();
    cookies.values.set("hmm_session", "identity-cookie");
    const session = createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      if (url.endsWith("/v1/auth/me")) return jsonResponse(CURRENT_USER);
      throw new Error(`Unexpected request ${url}`);
    }, cookies);

    await expect(session.restore()).resolves.toEqual({
      status: "signed-in",
      method: "email",
      name: "Morgan",
      email: "morgan@example.com",
      userId: CURRENT_USER.user.id,
      workspaceId: CURRENT_USER.workspaceId,
    });
    expect(requests).toEqual(["GET https://chat.example/v1/auth/me"]);
  });

  it("clears a rejected identity session instead of falling back to shared access", async () => {
    const requests: string[] = [];
    const cookies = new MemoryCookies();
    cookies.values.set("hmm_session", "expired-identity");
    const session = createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse({ error: "unauthorized" }, 401);
    }, cookies);

    await expect(session.restore()).resolves.toEqual({ status: "signed-out" });
    expect(requests).toEqual(["GET https://chat.example/v1/auth/me"]);
    expect(cookies.removals).toContain("hmm_session");
  });
});

describe("ChatSession lifecycle", () => {
  it("exchanges a magic link for the invited member identity", async () => {
    const events: string[] = [];
    const cookies = new MemoryCookies(events);
    const session = createSession(async (url, init) => {
      events.push(`${init.method} ${new URL(url).pathname}`);
      return url.endsWith("/v1/auth/session") ? jsonResponse(CURRENT_USER) : emptyResponse();
    }, cookies);

    await expect(session.exchangeMagicLink(TOKEN)).resolves.toEqual({
      status: "signed-in",
      method: "email",
      name: "Morgan",
      email: "morgan@example.com",
      userId: CURRENT_USER.user.id,
      workspaceId: CURRENT_USER.workspaceId,
    });
    expect(events).toEqual(["POST /v1/auth/session"]);
  });

  it("clears the identity cookie on sign-out", async () => {
    const cookies = new MemoryCookies();
    cookies.values.set("hmm_session", "identity-cookie");
    const session = createSession(async () => emptyResponse(), cookies);

    await expect(session.signOut()).resolves.toEqual({ status: "signed-out" });
    expect(cookies.removals).toEqual(["hmm_session"]);
  });
});

describe("ChatSession magic links", () => {
  it("publishes only a generic, token-free state and error after a failed exchange", async () => {
    const session = createSession(async () =>
      jsonResponse(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Rejected ${TOKEN}`,
            requestId: "request-1",
          },
        },
        401,
      ),
    );

    let caught: unknown;
    try {
      await session.exchangeMagicLink(TOKEN);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChatSessionError);
    expect(caught).toMatchObject({ message: INVALID_MAGIC_LINK_MESSAGE });
    expect(session.state).toEqual({
      status: "signed-out",
      message: INVALID_MAGIC_LINK_MESSAGE,
    });
    expect(JSON.stringify(session.state)).not.toContain(TOKEN);
    expect(caught instanceof Error ? caught.message : "").not.toContain(TOKEN);
  });

  it("returns manual administrator delivery as information instead of an error", async () => {
    const session = createSession(async () =>
      jsonResponse(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Sign-in links are issued by an administrator",
            requestId: "request-1",
          },
        },
        503,
      ),
    );

    await expect(session.requestMagicLink({ email: "Morgan@example.com" })).resolves.toEqual({
      status: "administrator-delivery",
      message: "Sign-in links are issued by an administrator",
    });
  });

  it("maps an accepted email request to the waiting-for-link state", async () => {
    const session = createSession(async () => jsonResponse({ status: "accepted" }, 202));

    await expect(session.requestMagicLink({ email: "morgan@example.com" })).resolves.toEqual({
      status: "email-sent",
    });
  });
});
