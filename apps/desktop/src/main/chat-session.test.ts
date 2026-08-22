import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthenticatedSessionContext,
  DesktopAuthVariant,
  MagicLinkToken,
} from "@hype-comms/contracts";

import {
  AUTHKIT_FAILED_MESSAGE,
  ChatSession,
  ChatSessionError,
  INVALID_MAGIC_LINK_MESSAGE,
  SESSION_SERVER_ERROR_MESSAGE,
  SESSION_UNREACHABLE_MESSAGE,
  type SessionCookieStore,
  type SessionFetch,
  type AuthenticatedSessionContextPersistence,
} from "./chat-session";

const API_ORIGIN = "https://chat.example";
const TOKEN = "A".repeat(43) as MagicLinkToken;
const NOW = "2026-07-24T12:00:00.000Z";
const CURRENT_USER_URL = "https://chat.example/v1/auth/me";
const SESSION_REFRESH_URL = "https://chat.example/v1/auth/session/refresh";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60_000;
const AUTHKIT_CODE = "C".repeat(43);
const AUTHKIT_VERIFIER = "V".repeat(43);
const AUTHKIT_STATE = "S".repeat(43);
const AUTHKIT_CHALLENGE = "H".repeat(43);
const INSTALLATION_ID = "10000000-0000-4000-8000-000000000003";

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

const OTHER_USER = {
  ...CURRENT_USER,
  user: {
    ...CURRENT_USER.user,
    id: "10000000-0000-4000-8000-000000000004",
    displayName: "Avery",
  },
  email: "avery@example.com",
  workspaceId: "10000000-0000-4000-8000-000000000005",
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

class MemoryAuthenticatedContexts implements AuthenticatedSessionContextPersistence {
  credential: string | null = null;
  session: AuthenticatedSessionContext | null = null;

  async load(credential: string): Promise<AuthenticatedSessionContext | null> {
    if (credential !== this.credential) {
      this.credential = null;
      this.session = null;
      return null;
    }
    return this.session;
  }

  async replace(input: {
    readonly credential: string;
    readonly session: AuthenticatedSessionContext;
  }): Promise<void> {
    this.credential = input.credential;
    this.session = input.session;
  }

  async clear(): Promise<void> {
    this.credential = null;
    this.session = null;
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

function createSession(
  request: SessionFetch,
  cookies = new MemoryCookies(),
  authVariant: DesktopAuthVariant = "production",
  contexts?: AuthenticatedSessionContextPersistence,
): ChatSession {
  return new ChatSession({
    apiOrigin: API_ORIGIN,
    authVariant,
    cookies,
    request,
    ...(contexts === undefined ? {} : { contexts }),
  });
}

/** A jar holding a credential that is still valid for the full 30-day window. */
function storedIdentityCookies(): MemoryCookies {
  const cookies = new MemoryCookies();
  cookies.values.set("hype_comms_session", "identity-cookie");
  cookies.expirations.set("hype_comms_session", (Date.parse(NOW) + THIRTY_DAYS_MS) / 1000);
  return cookies;
}

function rotations(requests: readonly string[]): number {
  return requests.filter((request) => request === `POST ${SESSION_REFRESH_URL}`).length;
}

/** Anything short of a refusal by the service must leave the stored credential in the jar. */
function expectPreservedCredential(cookies: MemoryCookies): void {
  expect(cookies.removals).toEqual([]);
  expect(cookies.values.get("hype_comms_session")).toBe("identity-cookie");
}

describe("ChatSession restore", () => {
  it("restores the invited member identity without exposing its cookie", async () => {
    const requests: string[] = [];
    const cookies = new MemoryCookies();
    cookies.values.set("hype_comms_session", "identity-cookie");
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
    cookies.values.set("hype_comms_session", "expired-identity");
    const session = createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse({ error: "unauthorized" }, 401);
    }, cookies);

    await expect(session.restore()).resolves.toEqual({ status: "signed-out" });
    expect(requests).toEqual([`GET ${CURRENT_USER_URL}`, `POST ${SESSION_REFRESH_URL}`]);
    expect(rotations(requests)).toBe(1);
    expect(cookies.removals).toContain("hype_comms_session");
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
    expect(cookies.values.get("hype_comms_session")).toBe("identity-cookie");
  });

  it("keeps the stored credential when an origin or gateway check answers 403", async () => {
    const requests: string[] = [];
    const cookies = storedIdentityCookies();
    const session = createSession(async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return jsonResponse({ error: "forbidden" }, 403);
    }, cookies);

    await expect(session.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    // The identity endpoint answers 401 when it refuses a credential, so a 403 is never its
    // verdict: it comes from the allowed-origin check, a proxy, or a gateway. No rotation is
    // attempted either, because nothing suggests the credential has lapsed.
    expect(requests).toEqual([`GET ${CURRENT_USER_URL}`]);
    expectPreservedCredential(cookies);
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
    expect(cookies.values.get("hype_comms_session")).toBe("identity-cookie");
  });

  it("cold-restores only the identity bound to the exact preserved credential", async () => {
    const cookies = storedIdentityCookies();
    const contexts = new MemoryAuthenticatedContexts();
    const online = createSession(
      async () => jsonResponse(CURRENT_USER),
      cookies,
      "production",
      contexts,
    );
    await online.restore();
    online.stop();

    const offline = createSession(
      async () => {
        throw new TypeError("offline");
      },
      cookies,
      "production",
      contexts,
    );

    await expect(offline.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
      lastAuthenticatedSession: {
        method: "email",
        name: "Morgan",
        email: "morgan@example.com",
        userId: CURRENT_USER.user.id,
        workspaceId: CURRENT_USER.workspaceId,
      },
    });
  });

  it("does not restore a cache identity without a protected credential", async () => {
    const contexts = new MemoryAuthenticatedContexts();
    await contexts.replace({
      credential: "identity-cookie",
      session: {
        method: "email",
        name: "Morgan",
        email: "morgan@example.com",
        userId: CURRENT_USER.user.id,
        workspaceId: CURRENT_USER.workspaceId,
      },
    });
    const offline = createSession(
      async () => {
        throw new TypeError("offline");
      },
      new MemoryCookies(),
      "production",
      contexts,
    );

    await expect(offline.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
  });

  it("does not restore a cache identity after the protected credential is replaced", async () => {
    const cookies = storedIdentityCookies();
    const contexts = new MemoryAuthenticatedContexts();
    const online = createSession(
      async () => jsonResponse(CURRENT_USER),
      cookies,
      "production",
      contexts,
    );
    await online.restore();
    online.stop();
    cookies.values.set("hype_comms_session", "replacement-identity-cookie");

    const offline = createSession(
      async () => {
        throw new TypeError("offline");
      },
      cookies,
      "production",
      contexts,
    );

    await expect(offline.restore()).resolves.toEqual({
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
    expect(contexts.session).toBeNull();
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
    expect(cookies.values.get("hype_comms_session")).toBe("identity-cookie");
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
    expect(cookies.values.get("hype_comms_session")).toBe("identity-cookie");
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
    cookies.values.set("hype_comms_session", "identity-cookie");
    const session = createSession(async () => emptyResponse(), cookies);

    await expect(session.signOut()).resolves.toEqual({ status: "signed-out" });
    expect(cookies.removals).toEqual(["hype_comms_session"]);
    expect(session.consumeLogoutUrl()).toBeNull();
  });

  it("captures a validated AuthKit logout URL once without changing public session state", async () => {
    const logoutUrl =
      "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC";
    const cookies = storedIdentityCookies();
    const session = createSession(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "x-hype-comms-authkit-logout-url": logoutUrl },
        }),
      cookies,
    );

    await expect(session.signOut()).resolves.toEqual({ status: "signed-out" });
    expect(session.state).toEqual({ status: "signed-out" });
    expect(JSON.stringify(session.state)).not.toContain("session_01ABC");
    expect(session.consumeLogoutUrl()).toBe(logoutUrl);
    expect(session.consumeLogoutUrl()).toBeNull();
    expect(cookies.removals).toEqual(["hype_comms_session"]);
  });

  it("finishes local sign-out while ignoring an invalid provider logout header", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            "x-hype-comms-authkit-logout-url": "https://evil.example/logout?access_token=secret",
          },
        }),
      cookies,
    );

    await expect(session.signOut()).resolves.toEqual({ status: "signed-out" });
    expect(session.consumeLogoutUrl()).toBeNull();
    expect(cookies.removals).toEqual(["hype_comms_session"]);
  });
});

describe("ChatSession magic links", () => {
  it("keeps an active identity and its scope transition untouched when an exchange has no verdict", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async (url) => {
      if (url === CURRENT_USER_URL) return jsonResponse(CURRENT_USER);
      return jsonResponse({ error: "boom" }, 500);
    }, cookies);
    await session.restore();
    const transitions: unknown[] = [];
    session.subscribe((state) => transitions.push(state));

    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(SESSION_SERVER_ERROR_MESSAGE);

    expect(session.state).toMatchObject({
      status: "signed-in",
      userId: CURRENT_USER.user.id,
      workspaceId: CURRENT_USER.workspaceId,
    });
    expect(transitions).toEqual([]);
    expectPreservedCredential(cookies);
    session.stop();
  });

  it("publishes one complete state transition when a confirmed link replaces an active identity", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async (url) => {
      if (url === CURRENT_USER_URL) return jsonResponse(CURRENT_USER);
      return jsonResponse(OTHER_USER);
    }, cookies);
    await session.restore();
    const transitions: unknown[] = [];
    session.subscribe((state) => transitions.push(state));

    await expect(session.exchangeMagicLink(TOKEN)).resolves.toMatchObject({
      status: "signed-in",
      userId: OTHER_USER.user.id,
      workspaceId: OTHER_USER.workspaceId,
    });

    expect(transitions).toEqual([
      {
        status: "signed-in",
        method: "email",
        name: "Avery",
        email: "avery@example.com",
        userId: OTHER_USER.user.id,
        workspaceId: OTHER_USER.workspaceId,
      },
    ]);
    expect(cookies.removals).toEqual([]);
    session.stop();
  });

  it("keeps an active identity and its scope transition intact when a link is rejected", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async (url) => {
      if (url === CURRENT_USER_URL) return jsonResponse(CURRENT_USER);
      return jsonResponse({ error: "unauthorized" }, 401);
    }, cookies);
    await session.restore();
    const transitions: unknown[] = [];
    session.subscribe((state) => transitions.push(state));

    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(INVALID_MAGIC_LINK_MESSAGE);

    expect(session.state).toMatchObject({
      status: "signed-in",
      userId: CURRENT_USER.user.id,
      workspaceId: CURRENT_USER.workspaceId,
    });
    expect(transitions).toEqual([]);
    expectPreservedCredential(cookies);
    session.stop();
  });

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

  it("signs out when the service refuses a link while no identity is active", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(
      async () => jsonResponse({ error: "unauthorized" }, 401),
      cookies,
    );

    // A link can establish no session while signed out, so an explicit refusal remains terminal.
    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(INVALID_MAGIC_LINK_MESSAGE);
    expect(session.state).toEqual({ status: "signed-out", message: INVALID_MAGIC_LINK_MESSAGE });
    expect(cookies.removals).toEqual(["hype_comms_session"]);
  });

  it("keeps the stored credential when the exchange cannot reach the server", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async () => {
      throw new TypeError("fetch failed");
    }, cookies);

    // Clicking a sign-in link while offline must not sign an already-signed-in device out.
    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(ChatSessionError);
    expect(session.state).toEqual({
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
    expectPreservedCredential(cookies);
  });

  it("keeps the stored credential when the exchange fails with a server error", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(async () => jsonResponse({ error: "boom" }, 500), cookies);

    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(ChatSessionError);
    expect(session.state).toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    expectPreservedCredential(cookies);
  });

  it("keeps the stored credential when the exchange returns an unparseable body", async () => {
    const cookies = storedIdentityCookies();
    // A proxy or gateway notice answered in place of the exchange: not a refusal of the link.
    const session = createSession(async () => new Response("not json"), cookies);

    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(ChatSessionError);
    expect(session.state).toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    expectPreservedCredential(cookies);
  });

  it("keeps the stored credential when the exchange response fails its schema", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(
      async () => jsonResponse({ user: { id: "not-a-uuid" }, role: "member" }),
      cookies,
    );

    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(ChatSessionError);
    expect(session.state).toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    expectPreservedCredential(cookies);
  });

  it("keeps the stored credential when the workspace answers 409 at capacity", async () => {
    const cookies = storedIdentityCookies();
    const session = createSession(
      async () =>
        jsonResponse(
          {
            error: {
              code: "CONFLICT",
              message: "The workspace is at capacity",
              requestId: "request-1",
            },
          },
          409,
        ),
      cookies,
    );

    // `POST /v1/auth/session` answers 409 when the workspace is full. That refuses the request,
    // never the link, so the credential this device already holds is untouched.
    await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(ChatSessionError);
    expect(session.state).toEqual({
      status: "session-unavailable",
      reason: "server_error",
      message: SESSION_SERVER_ERROR_MESSAGE,
    });
    expectPreservedCredential(cookies);
  });

  // A tunnelled or proxied deployment answers these on the exchange path without the service ever
  // refusing the link: 404 or 405 during a partial deploy or rollback, 408 or 429 when slow or
  // rate-limited, 400, 410, or 413 from an edge that rewrote or aged out the request.
  it.each([400, 404, 405, 408, 410, 413, 429])(
    "keeps the stored credential when the exchange is refused with %i",
    async (status) => {
      const cookies = storedIdentityCookies();
      const session = createSession(async () => jsonResponse({ error: "nope" }, status), cookies);

      await expect(session.exchangeMagicLink(TOKEN)).rejects.toThrow(ChatSessionError);
      expect(session.state).toEqual({
        status: "session-unavailable",
        reason: "server_error",
        message: SESSION_SERVER_ERROR_MESSAGE,
      });
      expectPreservedCredential(cookies);
    },
  );

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
    const bodies: unknown[] = [];
    const session = createSession(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ status: "accepted" }, 202);
    });

    await expect(session.requestMagicLink({ email: "morgan@example.com" })).resolves.toEqual({
      status: "email-sent",
    });
    expect(bodies).toEqual([{ email: "morgan@example.com" }]);
  });

  it("never lets the build flavor select a magic-link callback", async () => {
    const bodies: unknown[] = [];
    const session = createSession(
      async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({ status: "accepted" }, 202);
      },
      new MemoryCookies(),
      "development",
    );

    await session.requestMagicLink({ email: "morgan@example.com" });
    expect(bodies).toEqual([{ email: "morgan@example.com" }]);
  });
});

describe("ChatSession AuthKit", () => {
  it("discovers AuthKit while retaining a legacy-server magic-link fallback", async () => {
    const capable = createSession(async () => jsonResponse({ authKit: true, magicLink: false }));
    await expect(capable.getAuthCapabilities()).resolves.toEqual({
      authKit: true,
      magicLink: false,
    });

    const legacy = createSession(async () => jsonResponse({ error: "not found" }, 404));
    await expect(legacy.getAuthCapabilities()).resolves.toEqual({
      authKit: false,
      magicLink: true,
    });
  });

  it("starts only with a strict desktop challenge and state", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const session = createSession(async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(
        { authorizationUrl: "https://api.workos.com/user_management/authorize" },
        201,
      );
    });

    await expect(
      session.beginDesktopAuthorization({
        codeChallenge: AUTHKIT_CHALLENGE,
        state: AUTHKIT_STATE,
      }),
    ).resolves.toEqual({
      authorizationUrl: "https://api.workos.com/user_management/authorize",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://chat.example/v1/auth/desktop-authorizations");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      codeChallenge: AUTHKIT_CHALLENGE,
      state: AUTHKIT_STATE,
    });
  });

  it("binds development AuthKit starts to the development callback identity", async () => {
    const bodies: unknown[] = [];
    const session = createSession(
      async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(
          { authorizationUrl: "https://api.workos.com/user_management/authorize" },
          201,
        );
      },
      new MemoryCookies(),
      "development",
    );

    await session.beginDesktopAuthorization({
      codeChallenge: AUTHKIT_CHALLENGE,
      state: AUTHKIT_STATE,
    });
    expect(bodies).toEqual([
      {
        codeChallenge: AUTHKIT_CHALLENGE,
        state: AUTHKIT_STATE,
        variant: "development",
      },
    ]);
  });

  it("exchanges a one-use handoff into the existing cookie identity", async () => {
    const requests: { readonly url: string; readonly init: RequestInit }[] = [];
    const session = createSession(async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(CURRENT_USER);
    });

    await expect(
      session.exchangeAuthKitHandoff({
        code: AUTHKIT_CODE,
        codeVerifier: AUTHKIT_VERIFIER,
        installationId: INSTALLATION_ID,
        platform: "linux",
        appVersion: "0.1.23",
      }),
    ).resolves.toMatchObject({ status: "signed-in", email: "morgan@example.com" });
    expect(requests[0]?.url).toBe("https://chat.example/v1/auth/exchange");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      code: AUTHKIT_CODE,
      codeVerifier: AUTHKIT_VERIFIER,
      installationId: INSTALLATION_ID,
      platform: "linux",
      appVersion: "0.1.23",
    });
    expect(JSON.stringify(session.state)).not.toContain(AUTHKIT_CODE);
    session.stop();
  });

  it("collapses an indeterminate handoff into a credential-free terminal state", async () => {
    const session = createSession(async () => {
      throw new Error(`lost after ${AUTHKIT_CODE}`);
    });

    await expect(
      session.exchangeAuthKitHandoff({
        code: AUTHKIT_CODE,
        codeVerifier: AUTHKIT_VERIFIER,
        installationId: INSTALLATION_ID,
        platform: "linux",
        appVersion: "0.1.23",
      }),
    ).rejects.toThrow(AUTHKIT_FAILED_MESSAGE);
    expect(session.state).toEqual({
      status: "signed-out",
      message: AUTHKIT_FAILED_MESSAGE,
    });
    expect(JSON.stringify(session.state)).not.toContain(AUTHKIT_CODE);
    expect(JSON.stringify(session.state)).not.toContain(AUTHKIT_VERIFIER);
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
    expect(cookies.values.get("hype_comms_session")).toBe("identity-cookie");
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
