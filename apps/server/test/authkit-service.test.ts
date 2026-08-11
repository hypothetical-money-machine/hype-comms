import {
  apiErrorEnvelopeSchema,
  authCapabilitiesSchema,
  currentUserSchema,
  type CurrentUser,
} from "@hmm-chat/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthKitIdentityProvider } from "../src/modules/identity/authkit-provider.js";
import {
  AuthKitCredentialRejectedError,
  type AuthKitRepository,
} from "../src/modules/identity/authkit-repository.js";
import { AuthKitService } from "../src/modules/identity/authkit-service.js";
import type { IdentityService } from "../src/modules/identity/service.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const CODE_CHALLENGE = "a".repeat(43);
const DESKTOP_STATE = "b".repeat(43);
const HANDOFF_CODE = "c".repeat(43);
const PROVIDER_STATE = "p".repeat(43);
const PROVIDER_CODE_VERIFIER = "v".repeat(43);
const PROVIDER_CODE = "provider-authorization-code";
const INSTALLATION_ID = "10000000-0000-4000-8000-000000000004";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_SESSION_ID = "10000000-0000-4000-8000-000000000005";
const SECOND_DEVICE_SESSION_ID = "10000000-0000-4000-8000-000000000006";
const THIRD_DEVICE_SESSION_ID = "10000000-0000-4000-8000-000000000007";
const SESSION_TOKEN = "s".repeat(43);
const SESSION_EXPIRES_AT = "2026-09-10T12:00:00.000Z";

const currentUser: CurrentUser = {
  user: {
    id: USER_ID,
    kind: "human",
    username: "owner",
    displayName: "Owner",
    avatarUrl: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  },
  email: "owner@example.com",
  workspaceId: WORKSPACE_ID,
  role: "owner",
};

const transaction = {
  providerState: PROVIDER_STATE,
  providerCodeVerifier: PROVIDER_CODE_VERIFIER,
  desktopCodeChallenge: CODE_CHALLENGE,
  desktopState: DESKTOP_STATE,
  expiresAt: new Date(NOW.getTime() + 10 * 60_000),
};

function unusedProvider(): AuthKitIdentityProvider {
  return {
    createAuthorization: vi.fn(),
    authenticateCode: vi.fn(),
    createLogoutUrl: vi.fn(),
    listActiveSessionIds: vi.fn().mockResolvedValue(new Set()),
  };
}

function repositoryWith(
  methods: Partial<{
    createTransaction: ReturnType<typeof vi.fn>;
    consumeTransaction: ReturnType<typeof vi.fn>;
    admitIdentity: ReturnType<typeof vi.fn>;
    exchangeHandoff: ReturnType<typeof vi.fn>;
    deleteExpiredState: ReturnType<typeof vi.fn>;
    listActiveAuthKitDeviceSessions: ReturnType<typeof vi.fn>;
    revokeAuthKitDeviceSessions: ReturnType<typeof vi.fn>;
  }> = {},
): AuthKitRepository {
  return {
    createTransaction: methods.createTransaction ?? vi.fn().mockResolvedValue(undefined),
    consumeTransaction: methods.consumeTransaction ?? vi.fn().mockResolvedValue(null),
    admitIdentity: methods.admitIdentity ?? vi.fn(),
    exchangeHandoff: methods.exchangeHandoff ?? vi.fn(),
    deleteExpiredState: methods.deleteExpiredState ?? vi.fn().mockResolvedValue(undefined),
    listActiveAuthKitDeviceSessions:
      methods.listActiveAuthKitDeviceSessions ?? vi.fn().mockResolvedValue([]),
    revokeAuthKitDeviceSessions:
      methods.revokeAuthKitDeviceSessions ?? vi.fn().mockResolvedValue(0),
  } as unknown as AuthKitRepository;
}

class FakeIdentityService {
  readonly authenticate = vi.fn(async () => currentUser);
  readonly signOut = vi.fn(async (): Promise<string | null> => null);

  asService(): IdentityService {
    return this as unknown as IdentityService;
  }
}

class FakeAuthKitService {
  readonly beginDesktopAuthorization = vi.fn();
  readonly completeCallback = vi.fn();
  readonly exchangeHandoff = vi.fn();
  readonly createLogoutUrl = vi.fn();

  asService(): AuthKitService {
    return this as unknown as AuthKitService;
  }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("AuthKitService", () => {
  it("consumes provider state before exchange and never exchanges a replay", async () => {
    const authenticateCode = vi.fn().mockResolvedValue({
      provider: "workos",
      subject: "user_01ABC",
      verifiedEmail: "member@example.com",
      providerSessionId: "session_01ABC",
    });
    const provider: AuthKitIdentityProvider = {
      createAuthorization: vi.fn(),
      authenticateCode,
      createLogoutUrl: vi.fn(),
      listActiveSessionIds: vi.fn().mockResolvedValue(new Set()),
    };
    const consumeTransaction = vi
      .fn()
      .mockResolvedValueOnce(transaction)
      .mockResolvedValueOnce(null);
    const admitIdentity = vi.fn().mockResolvedValue({
      handoffCode: HANDOFF_CODE,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    const service = new AuthKitService({
      provider,
      repository: repositoryWith({ consumeTransaction, admitIdentity }),
      now: () => NOW,
    });
    const input = {
      kind: "success" as const,
      code: PROVIDER_CODE,
      providerState: PROVIDER_STATE,
      ipAddress: "127.0.0.1",
      userAgent: "Hype Comms test",
    };

    await expect(service.completeCallback(input)).resolves.toEqual({
      kind: "success",
      handoffCode: HANDOFF_CODE,
      desktopState: DESKTOP_STATE,
    });
    await expect(service.completeCallback(input)).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Authentication could not be completed",
    });

    expect(consumeTransaction).toHaveBeenCalledTimes(2);
    expect(authenticateCode).toHaveBeenCalledOnce();
    expect(consumeTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      authenticateCode.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(authenticateCode).toHaveBeenCalledWith({
      code: PROVIDER_CODE,
      codeVerifier: PROVIDER_CODE_VERIFIER,
      ipAddress: "127.0.0.1",
      userAgent: "Hype Comms test",
    });
    expect(admitIdentity).toHaveBeenCalledWith({
      providerSubject: "user_01ABC",
      verifiedEmail: "member@example.com",
      workosSessionId: "session_01ABC",
      desktopCodeChallenge: CODE_CHALLENGE,
      now: NOW,
    });
  });

  it("collapses cancellation and terminal provider failures to the same desktop result", async () => {
    const authenticateCode = vi.fn().mockRejectedValue(new Error(`leaked ${PROVIDER_CODE}`));
    const consumeTransaction = vi.fn().mockResolvedValue(transaction);
    const service = new AuthKitService({
      provider: {
        createAuthorization: vi.fn(),
        authenticateCode,
        createLogoutUrl: vi.fn(),
        listActiveSessionIds: vi.fn().mockResolvedValue(new Set()),
      },
      repository: repositoryWith({ consumeTransaction }),
      now: () => NOW,
    });

    await expect(
      service.completeCallback({ kind: "error", providerState: PROVIDER_STATE }),
    ).resolves.toEqual({ kind: "error", desktopState: DESKTOP_STATE });
    expect(authenticateCode).not.toHaveBeenCalled();

    await expect(
      service.completeCallback({
        kind: "success",
        code: PROVIDER_CODE,
        providerState: PROVIDER_STATE,
      }),
    ).resolves.toEqual({ kind: "error", desktopState: DESKTOP_STATE });
  });

  it("maps rejected handoffs to a generic credential refusal and dependencies to unavailable", async () => {
    const exchangeHandoff = vi
      .fn()
      .mockRejectedValueOnce(new AuthKitCredentialRejectedError())
      .mockRejectedValueOnce(new Error("database unavailable"));
    const service = new AuthKitService({
      provider: unusedProvider(),
      repository: repositoryWith({ exchangeHandoff }),
      now: () => NOW,
    });
    const input = {
      code: HANDOFF_CODE,
      codeVerifier: "d".repeat(43),
      installationId: INSTALLATION_ID,
      platform: "linux" as const,
      appVersion: "0.2.0",
    };

    await expect(service.exchangeHandoff(input, undefined)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Authentication could not be completed",
    });
    await expect(service.exchangeHandoff(input, undefined)).rejects.toMatchObject({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Authentication is temporarily unavailable",
    });
  });

  it("uses its clock for bounded persistent AuthKit state cleanup", async () => {
    const deleteExpiredState = vi.fn().mockResolvedValue({ transactions: 2, handoffs: 1 });
    const service = new AuthKitService({
      provider: unusedProvider(),
      repository: repositoryWith({ deleteExpiredState }),
      now: () => NOW,
    });

    await expect(service.deleteExpiredState()).resolves.toBeUndefined();
    expect(deleteExpiredState).toHaveBeenCalledWith(NOW);
  });

  it("reconciles an exact local snapshot while preserving subjects with unavailable state", async () => {
    const listActiveAuthKitDeviceSessions = vi.fn().mockResolvedValue([
      {
        deviceSessionId: DEVICE_SESSION_ID,
        providerSubject: "user_01ABC",
        workosSessionId: "session_01ACTIVE",
      },
      {
        deviceSessionId: SECOND_DEVICE_SESSION_ID,
        providerSubject: "user_01ABC",
        workosSessionId: "session_01ENDED",
      },
      {
        deviceSessionId: THIRD_DEVICE_SESSION_ID,
        providerSubject: "user_02ABC",
        workosSessionId: "session_02UNKNOWN",
      },
    ]);
    const revokeAuthKitDeviceSessions = vi.fn().mockResolvedValue(1);
    const listActiveSessionIds = vi
      .fn()
      .mockResolvedValueOnce(new Set(["session_01ACTIVE"]))
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"));
    const service = new AuthKitService({
      provider: {
        createAuthorization: vi.fn(),
        authenticateCode: vi.fn(),
        createLogoutUrl: vi.fn(),
        listActiveSessionIds,
      },
      repository: repositoryWith({
        listActiveAuthKitDeviceSessions,
        revokeAuthKitDeviceSessions,
      }),
      now: () => NOW,
    });

    await expect(service.reconcileActiveSessions()).resolves.toEqual({
      checked: 2,
      revoked: 1,
      unavailableSubjects: 1,
    });
    expect(listActiveAuthKitDeviceSessions).toHaveBeenCalledWith(NOW);
    expect(listActiveSessionIds).toHaveBeenNthCalledWith(1, "user_01ABC");
    expect(listActiveSessionIds).toHaveBeenNthCalledWith(2, "user_02ABC");
    expect(revokeAuthKitDeviceSessions).toHaveBeenCalledWith([SECOND_DEVICE_SESSION_ID], NOW);
  });

  it("returns only validated provider logout URLs and treats provider failures as absent", () => {
    const createLogoutUrl = vi
      .fn()
      .mockReturnValueOnce(
        "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC",
      )
      .mockReturnValueOnce("https://evil.example/logout?access_token=secret")
      .mockImplementationOnce(() => {
        throw new Error("provider unavailable");
      });
    const service = new AuthKitService({
      provider: {
        createAuthorization: vi.fn(),
        authenticateCode: vi.fn(),
        createLogoutUrl,
        listActiveSessionIds: vi.fn().mockResolvedValue(new Set()),
      },
      repository: repositoryWith(),
      now: () => NOW,
    });

    expect(service.createLogoutUrl("session_01ABC")).toContain("api.workos.com");
    expect(service.createLogoutUrl("session_01ABC")).toBeNull();
    expect(service.createLogoutUrl("session_01ABC")).toBeNull();
  });
});

describe("AuthKit routes", () => {
  it("keeps configured AuthKit admission fail-closed until its rollout gate is enabled", async () => {
    const disabledIdentity = new FakeIdentityService();
    const disabled = await buildApp({
      identity: { service: disabledIdentity.asService(), selfServiceMagicLink: false },
    });
    apps.push(disabled);
    const stagedIdentity = new FakeIdentityService();
    const stagedAuthKit = new FakeAuthKitService();
    const staged = await buildApp({
      identity: {
        service: stagedIdentity.asService(),
        authKitService: stagedAuthKit.asService(),
      },
    });
    apps.push(staged);
    const enabledIdentity = new FakeIdentityService();
    const enabledAuthKit = new FakeAuthKitService();
    const enabled = await buildApp({
      identity: {
        service: enabledIdentity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: enabledAuthKit.asService(),
      },
    });
    apps.push(enabled);

    const [
      disabledResponse,
      stagedResponse,
      enabledResponse,
      absentStart,
      stagedStart,
      stagedCallback,
      stagedExchange,
    ] = await Promise.all([
      disabled.inject({ method: "GET", url: "/v1/auth/capabilities" }),
      staged.inject({ method: "GET", url: "/v1/auth/capabilities" }),
      enabled.inject({ method: "GET", url: "/v1/auth/capabilities" }),
      disabled.inject({
        method: "POST",
        url: "/v1/auth/desktop-authorizations",
        payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
      }),
      staged.inject({
        method: "POST",
        url: "/v1/auth/desktop-authorizations",
        payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
      }),
      staged.inject({
        method: "GET",
        url: `/v1/auth/workos/callback?code=${PROVIDER_CODE}&state=${PROVIDER_STATE}`,
      }),
      staged.inject({
        method: "POST",
        url: "/v1/auth/exchange",
        payload: {
          code: HANDOFF_CODE,
          codeVerifier: "d".repeat(43),
          installationId: INSTALLATION_ID,
          platform: "linux",
          appVersion: "0.2.0",
        },
      }),
    ]);

    expect(authCapabilitiesSchema.parse(disabledResponse.json())).toEqual({
      authKit: false,
      magicLink: false,
    });
    expect(authCapabilitiesSchema.parse(stagedResponse.json())).toEqual({
      authKit: false,
      magicLink: true,
    });
    expect(authCapabilitiesSchema.parse(enabledResponse.json())).toEqual({
      authKit: true,
      magicLink: true,
    });
    expect(disabledResponse.headers["cache-control"]).toBe("no-store");
    expect(stagedResponse.headers["cache-control"]).toBe("no-store");
    expect(enabledResponse.headers["cache-control"]).toBe("no-store");
    expect(absentStart.statusCode).toBe(404);
    expect(stagedStart.statusCode).toBe(404);
    expect(stagedCallback.statusCode).toBe(404);
    expect(stagedExchange.statusCode).toBe(404);
    expect(stagedAuthKit.beginDesktopAuthorization).not.toHaveBeenCalled();
    expect(stagedAuthKit.completeCallback).not.toHaveBeenCalled();
    expect(stagedAuthKit.exchangeHandoff).not.toHaveBeenCalled();
  });

  it("adds a strict logout header only for an AuthKit-created local session", async () => {
    const identity = new FakeIdentityService();
    const authKit = new FakeAuthKitService();
    const logoutUrl =
      "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC";
    identity.signOut
      .mockResolvedValueOnce("session_01ABC")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("session_01ABC");
    authKit.createLogoutUrl
      .mockReturnValueOnce(logoutUrl)
      .mockReturnValueOnce("https://evil.example/logout?access_token=secret");
    const app = await buildApp({
      cookieSecure: false,
      identity: { service: identity.asService(), authKitService: authKit.asService() },
    });
    apps.push(app);
    const headers = { cookie: `hmm_session=${SESSION_TOKEN}` };

    const authKitResponse = await app.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers,
    });
    const magicLinkResponse = await app.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers,
    });
    const invalidProviderResponse = await app.inject({
      method: "DELETE",
      url: "/v1/auth/session",
      headers,
    });

    expect(authKitResponse.statusCode).toBe(204);
    expect(authKitResponse.headers["cache-control"]).toBe("no-store");
    expect(authKitResponse.headers["x-hmm-authkit-logout-url"]).toBe(logoutUrl);
    expect(magicLinkResponse.statusCode).toBe(204);
    expect(magicLinkResponse.headers["cache-control"]).toBe("no-store");
    expect(magicLinkResponse.headers).not.toHaveProperty("x-hmm-authkit-logout-url");
    expect(invalidProviderResponse.statusCode).toBe(204);
    expect(invalidProviderResponse.headers["cache-control"]).toBe("no-store");
    expect(invalidProviderResponse.headers).not.toHaveProperty("x-hmm-authkit-logout-url");
    expect(identity.signOut).toHaveBeenCalledTimes(3);
  });

  it("returns a generic unavailable response when authorization cannot start", async () => {
    const providerSecret = "upstream-provider-secret";
    const service = new AuthKitService({
      provider: {
        createAuthorization: vi.fn().mockRejectedValue(new Error(providerSecret)),
        authenticateCode: vi.fn(),
        createLogoutUrl: vi.fn(),
        listActiveSessionIds: vi.fn().mockResolvedValue(new Set()),
      },
      repository: repositoryWith(),
      now: () => NOW,
    });
    const identity = new FakeIdentityService();
    const app = await buildApp({
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: service,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/desktop-authorizations",
      payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
    });

    expect(response.statusCode).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Authentication is temporarily unavailable",
    });
    expect(response.body).not.toContain(providerSecret);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("throttles authorization starts per client IP with an explicit retry window", async () => {
    const identity = new FakeIdentityService();
    const authKit = new FakeAuthKitService();
    authKit.beginDesktopAuthorization.mockResolvedValue({
      authorizationUrl:
        "https://api.workos.com/user_management/authorize?client_id=client_test&state=opaque",
    });
    const app = await buildApp({
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: authKit.asService(),
      },
    });
    apps.push(app);
    const request = {
      method: "POST" as const,
      url: "/v1/auth/desktop-authorizations",
      payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
    };

    const allowed = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      allowed.push(await app.inject(request));
    }
    const throttled = await app.inject(request);

    expect(allowed.every((response) => response.statusCode === 201)).toBe(true);
    expect(throttled.statusCode).toBe(429);
    expect(apiErrorEnvelopeSchema.parse(throttled.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many requests",
    });
    expect(throttled.headers["cache-control"]).toBe("no-store");
    expect(throttled.headers["retry-after"]).toBe("900");
    expect(authKit.beginDesktopAuthorization).toHaveBeenCalledTimes(10);
  });

  it("ignores forwarded client IPs received from an untrusted peer", async () => {
    const identity = new FakeIdentityService();
    const authKit = new FakeAuthKitService();
    authKit.beginDesktopAuthorization.mockResolvedValue({
      authorizationUrl:
        "https://api.workos.com/user_management/authorize?client_id=client_test&state=opaque",
    });
    const app = await buildApp({
      trustedProxies: ["10.0.0.0/8"],
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: authKit.asService(),
      },
    });
    apps.push(app);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/desktop-authorizations",
        remoteAddress: "192.0.2.20",
        headers: { "x-forwarded-for": attempt % 2 === 0 ? "198.51.100.10" : "203.0.113.10" },
        payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
      });
      expect(response.statusCode).toBe(201);
    }

    const throttled = await app.inject({
      method: "POST",
      url: "/v1/auth/desktop-authorizations",
      remoteAddress: "192.0.2.20",
      headers: { "x-forwarded-for": "203.0.113.11" },
      payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
    });

    expect(throttled.statusCode).toBe(429);
    expect(authKit.beginDesktopAuthorization).toHaveBeenCalledTimes(10);
  });

  it("gives forwarded clients separate AuthKit budgets only behind a trusted peer", async () => {
    const identity = new FakeIdentityService();
    const authKit = new FakeAuthKitService();
    authKit.beginDesktopAuthorization.mockResolvedValue({
      authorizationUrl:
        "https://api.workos.com/user_management/authorize?client_id=client_test&state=opaque",
    });
    const app = await buildApp({
      trustedProxies: ["10.0.0.0/8"],
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: authKit.asService(),
      },
    });
    apps.push(app);
    const injectFrom = (clientIp: string) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/desktop-authorizations",
        remoteAddress: "10.20.30.40",
        headers: { "x-forwarded-for": clientIp },
        payload: { codeChallenge: CODE_CHALLENGE, state: DESKTOP_STATE },
      });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await injectFrom("198.51.100.10")).statusCode).toBe(201);
    }

    const [firstClientThrottled, distinctClientAllowed] = await Promise.all([
      injectFrom("198.51.100.10"),
      injectFrom("203.0.113.10"),
    ]);

    expect(firstClientThrottled.statusCode).toBe(429);
    expect(distinctClientAllowed.statusCode).toBe(201);
    expect(authKit.beginDesktopAuthorization).toHaveBeenCalledTimes(11);
  });

  it("uses one fixed credential-free custom callback and hides provider cancellation details", async () => {
    const identity = new FakeIdentityService();
    const authKit = new FakeAuthKitService();
    authKit.completeCallback.mockResolvedValue({
      kind: "error",
      desktopState: DESKTOP_STATE,
    });
    const app = await buildApp({
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: authKit.asService(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url:
        `/v1/auth/workos/callback?error=access_denied&state=${PROVIDER_STATE}` +
        "&error_description=The%20user%20cancelled%20sign-in",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `hmm-chat://auth/callback?error=authentication_failed&state=${DESKTOP_STATE}`,
    );
    const callback = new URL(response.headers.location ?? "");
    expect(callback.protocol).toBe("hmm-chat:");
    expect(callback.host).toBe("auth");
    expect(callback.pathname).toBe("/callback");
    expect(callback.username).toBe("");
    expect(callback.password).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers.location).not.toContain("access_denied");
    expect(response.headers.location).not.toContain("cancelled");
    expect(authKit.completeCallback).toHaveBeenCalledWith({
      kind: "error",
      providerState: PROVIDER_STATE,
    });
  });

  it("rejects malformed and invalid handoffs before creating a local session", async () => {
    const exchangeHandoff = vi.fn().mockRejectedValue(new AuthKitCredentialRejectedError());
    const service = new AuthKitService({
      provider: unusedProvider(),
      repository: repositoryWith({ exchangeHandoff }),
      now: () => NOW,
    });
    const identity = new FakeIdentityService();
    const app = await buildApp({
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: service,
      },
    });
    apps.push(app);
    const request = {
      code: HANDOFF_CODE,
      codeVerifier: "d".repeat(43),
      installationId: INSTALLATION_ID,
      platform: "linux",
      appVersion: "0.2.0",
    };

    const [malformed, rejected] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/exchange",
        payload: { ...request, code: "too-short" },
      }),
      app.inject({ method: "POST", url: "/v1/auth/exchange", payload: request }),
    ]);

    expect(malformed.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(malformed.json()).error.code).toBe("BAD_REQUEST");
    expect(rejected.statusCode).toBe(401);
    expect(apiErrorEnvelopeSchema.parse(rejected.json()).error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Authentication could not be completed",
    });
    expect(exchangeHandoff).toHaveBeenCalledOnce();
    expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it("sets the existing HttpOnly cookie and returns the current user after exchange", async () => {
    const identity = new FakeIdentityService();
    const authKit = new FakeAuthKitService();
    authKit.exchangeHandoff.mockResolvedValue({
      token: SESSION_TOKEN,
      expiresAt: SESSION_EXPIRES_AT,
    });
    const app = await buildApp({
      cookieSecure: false,
      identity: {
        service: identity.asService(),
        authKitAdmissionEnabled: true,
        authKitService: authKit.asService(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/exchange",
      headers: { "user-agent": "Hype Comms integration test" },
      payload: {
        code: HANDOFF_CODE,
        codeVerifier: "d".repeat(43),
        installationId: INSTALLATION_ID,
        platform: "linux",
        appVersion: " 0.2.0 ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(currentUserSchema.parse(response.json())).toEqual(currentUser);
    expect(response.body).not.toContain(SESSION_TOKEN);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toContain(`hmm_session=${SESSION_TOKEN}`);
    expect(response.headers["set-cookie"]).toContain("Path=/");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["set-cookie"]).not.toContain("Secure");
    expect(authKit.exchangeHandoff).toHaveBeenCalledWith(
      {
        code: HANDOFF_CODE,
        codeVerifier: "d".repeat(43),
        installationId: INSTALLATION_ID,
        platform: "linux",
        appVersion: "0.2.0",
      },
      "Hype Comms integration test",
    );
    expect(identity.authenticate).toHaveBeenCalledWith(SESSION_TOKEN);
  });
});
