import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MagicLinkToken } from "@hmm-chat/contracts";

import {
  ChatSession,
  ChatSessionError,
  INVALID_MAGIC_LINK_MESSAGE,
  SESSION_SERVER_ERROR_MESSAGE,
  SESSION_UNREACHABLE_MESSAGE,
  type SessionCookieStore,
  type SessionFetch,
} from "./chat-session";

const API_ORIGIN = "https://chat.example";
const TOKEN = "A".repeat(43) as MagicLinkToken;
const NOW = "2026-07-24T12:00:00.000Z";
const CURRENT_USER_URL = "https://chat.example/v1/auth/me";
const SESSION_REFRESH_URL = "https://chat.example/v1/auth/session/refresh";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60_000;

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
  /** Seconds since the epoch, matching how Electron reports cookie expiry. */
  readonly expirations = new Map<string, number>();
  readonly removals: string[] = [];
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async get(filter: { readonly url: string; readonly name: string }) {
    const value = this.values.get(filter.name);
    if (value === undefined) return [];
    return [{ name: filter.name, value, expirationDate: this.expirations.get(filter.name) }];
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

/** A jar holding a credential that is still valid for the full 30-day window. */
function storedIdentityCookies(): MemoryCookies {
  const cookies = new MemoryCookies();
  cookies.values.set("hmm_session", "identity-cookie");
  cookies.expirations.set("hmm_session", (Date.parse(NOW) + THIRTY_DAYS_MS) / 1000);
  return cookies;
}

function rotations(requests: readonly string[]): number {
  return requests.filter((request) => request === `POST ${SESSION_REFRESH_URL}`).length;
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

  it("clears a rejected identity session only after a single refresh attempt fails", async () => {
    const requests: string[] = [];
    const cookies = new MemoryCookies();
    cookies.values.set("hmm_session", "expired-identity");
    const session = createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse({ error: "unauthorized" }, 401);
    }, cookies);

    await expect(session.restore()).resolves.toEqual({ status: "signed-out" });
    expect(requests).toEqual([`GET ${CURRENT_USER_URL}`, `POST ${SESSION_REFRESH_URL}`]);
    expect(rotations(requests)).toBe(1);
    expect(cookies.removals).toContain("hmm_session");
  });

  it("recovers an expired credential with one rotation instead of signing out", async () => {
    const requests: string[] = [];
    const cookies = storedIdentityCookies();
    const session = createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      if (url === SESSION_REFRESH_URL) return emptyResponse();
      return requests.filter((request) => request === `GET ${CURRENT_USER_URL}`).length === 1
        ? jsonResponse({ error: "unauthorized" }, 401)
        : jsonResponse(CURRENT_USER);
    }, cookies);

    await expect(session.restore()).resolves.toMatchObject({ status: "signed-in" });
    expect(requests).toEqual([
      `GET ${CURRENT_USER_URL}`,
      `POST ${SESSION_REFRESH_URL}`,
      `GET ${CURRENT_USER_URL}`,
    ]);
    expect(cookies.removals).toEqual([]);
    session.stop();
  });

  it("keeps the stored credential when the identity check fails with a server error", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async () => jsonResponse({ error: "boom" }, 500), cookies);

    await expect(session.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    expect(cookies.removals).toEqual([]);
    expect(cookies.values.get("hmm_session")).toBe("identity-cookie");
  });

  it("keeps the stored credential when the device is offline at launch", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async () => {
      throw new TypeError("fetch failed");
    }, cookies);

    await expect(session.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
    expect(cookies.removals).toEqual([]);
    expect(cookies.values.get("hmm_session")).toBe("identity-cookie");
  });

  it("keeps the stored credential when the identity check times out", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async () => {
      throw new DOMException("", "TimeoutError");
    }, cookies);

    await expect(session.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
    expect(cookies.removals).toEqual([]);
    expect(cookies.values.get("hmm_session")).toBe("identity-cookie");
  });

  it("keeps the stored credential when the identity response fails its schema", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(
      async () => jsonResponse({ user: { id: "not-a-uuid" }, role: "member" }),
      cookies,
    );

    await expect(session.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    expect(cookies.removals).toEqual([]);
    expect(cookies.values.get("hmm_session")).toBe("identity-cookie");
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

describe("ChatSession renewal", () => {
  // Only the globals the renewal timer needs, so response bodies still resolve normally.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRenewingSession(
    refresh: () => Response,
    cookies: MemoryCookies,
    requests: string[],
  ): ChatSession {
    return createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return url === SESSION_REFRESH_URL ? refresh() : jsonResponse(CURRENT_USER);
    }, cookies);
  }

  it("rotates the stored credential before the thirty-day window lapses", async () => {
    const requests: string[] = [];
    const cookies = storedIdentityCookies();
    const session = createRenewingSession(() => emptyResponse(), cookies, requests);

    await session.restore();
    expect(rotations(requests)).toBe(0);

    await vi.advanceTimersByTimeAsync(TWELVE_HOURS_MS);

    expect(rotations(requests)).toBe(1);
    expect(session.state).toMatchObject({ status: "signed-in" });
    expect(cookies.removals).toEqual([]);
    session.stop();
  });

  it("retries a failed renewal instead of signing the device out", async () => {
    const requests: string[] = [];
    const cookies = storedIdentityCookies();
    const session = createRenewingSession(() => emptyResponse(503), cookies, requests);

    await session.restore();
    await vi.advanceTimersByTimeAsync(TWELVE_HOURS_MS);

    expect(rotations(requests)).toBe(1);
    expect(session.state).toMatchObject({ status: "signed-in" });
    expect(cookies.removals).toEqual([]);

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);

    expect(rotations(requests)).toBe(2);
    expect(session.state).toMatchObject({ status: "signed-in" });
    expect(cookies.removals).toEqual([]);
    session.stop();
  });

  it("never clears the credential when a renewal is rejected", async () => {
    const requests: string[] = [];
    const cookies = storedIdentityCookies();
    const session = createRenewingSession(
      () => jsonResponse({ error: "unauthorized" }, 401),
      cookies,
      requests,
    );

    await session.restore();
    await vi.advanceTimersByTimeAsync(TWELVE_HOURS_MS);

    expect(rotations(requests)).toBe(1);
    expect(session.state).toMatchObject({ status: "signed-in" });
    expect(cookies.removals).toEqual([]);
    expect(cookies.values.get("hmm_session")).toBe("identity-cookie");
    session.stop();
  });

  it("stops the renewal timer on sign-out", async () => {
    const requests: string[] = [];
    const cookies = storedIdentityCookies();
    const session = createRenewingSession(() => emptyResponse(), cookies, requests);

    await session.restore();
    await session.signOut();
    requests.length = 0;

    await vi.advanceTimersByTimeAsync(2 * TWELVE_HOURS_MS);

    expect(requests).toEqual([]);
    expect(session.state).toEqual({ status: "signed-out" });
  });
});
