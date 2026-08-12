import { NotFoundException, OauthException } from "@workos-inc/node";
import { createLocalJWKSet, errors as joseErrors, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthKitIdentityRejectedError,
  AuthKitProviderUnavailableError,
  createWorkOSAccessTokenVerifier,
  createWorkOSAuthKitIdentityProvider,
  DEFAULT_WORKOS_JWT_ISSUER,
  validateWorkOSAccessTokenClaims,
  WorkOSAuthKitIdentityProvider,
} from "../src/modules/identity/authkit-provider.js";
import {
  startWorkOSEmulateFixture,
  type WorkOSEmulateFixture,
} from "./helpers/workos-emulate.js";

const PROVIDER_STATE = "p".repeat(43);
const PROVIDER_CODE_VERIFIER = "v".repeat(43);
const PROVIDER_CODE = "provider-authorization-code";
const AUTHORIZATION_URL =
  `https://api.workos.com/user_management/authorize?client_id=client_test` +
  `&state=${PROVIDER_STATE}`;
const LOGOUT_URL =
  "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC";

const VERIFIED_USER_ID = "user_01TESTMORGAN";
const VERIFIED_EMAIL = "Morgan@Example.COM";

const fixtures: WorkOSEmulateFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.close()));
});

async function emulateFixture(
  users: Parameters<typeof startWorkOSEmulateFixture>[0]["users"] = [
    {
      id: VERIFIED_USER_ID,
      email: VERIFIED_EMAIL,
      emailVerified: true,
    },
  ],
): Promise<WorkOSEmulateFixture> {
  const fixture = await startWorkOSEmulateFixture({ users });
  fixtures.push(fixture);
  return fixture;
}

describe("WorkOS access-token verification", () => {
  it("requires bounded identity, session, temporal, unique, and expected-client claims", () => {
    const claims = {
      iss: DEFAULT_WORKOS_JWT_ISSUER,
      sub: "user_01ABC",
      sid: "session_01ABC",
      client_id: "client_test",
      jti: "01HQSXZXPPFPKMDD32RKTFY6PV",
      exp: 1_709_193_857,
      iat: 1_709_193_557,
    };

    expect(validateWorkOSAccessTokenClaims(claims, "client_test")).toEqual({
      subject: "user_01ABC",
      sessionId: "session_01ABC",
    });
    for (const requiredClaim of ["exp", "iat", "jti", "sid"] as const) {
      const missing = Object.fromEntries(
        Object.entries(claims).filter(([claim]) => claim !== requiredClaim),
      );
      expect(() => validateWorkOSAccessTokenClaims(missing, "client_test")).toThrow(
        "Unexpected WorkOS access-token claims",
      );
    }
    expect(() =>
      validateWorkOSAccessTokenClaims({ ...claims, client_id: "client_other" }, "client_test"),
    ).toThrow("Unexpected WorkOS access-token claims");
    expect(() =>
      validateWorkOSAccessTokenClaims(
        { ...claims, iss: "https://auth.example.com" },
        "client_test",
      ),
    ).toThrow("Unexpected WorkOS access-token claims");
    expect(() =>
      validateWorkOSAccessTokenClaims({ ...claims, exp: claims.iat }, "client_test"),
    ).toThrow("Unexpected WorkOS access-token claims");
    expect(() =>
      validateWorkOSAccessTokenClaims({ ...claims, act: { sub: "support_user" } }, "client_test"),
    ).toThrow("Unexpected WorkOS access-token claims");
  });

  it("verifies an RS256 signature against JWKS before accepting the expected client_id", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "test-key" };
    const verifyAccessToken = createWorkOSAccessTokenVerifier(
      "client_test",
      createLocalJWKSet({ keys: [publicJwk] }),
    );
    const issuedAt = Math.floor(Date.now() / 1_000);
    const sign = (clientId: string, issuer = DEFAULT_WORKOS_JWT_ISSUER) =>
      new SignJWT({
        sid: "session_01ABC",
        client_id: clientId,
        jti: "01HQSXZXPPFPKMDD32RKTFY6PV",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setSubject("user_01ABC")
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .sign(privateKey);

    await expect(verifyAccessToken(await sign("client_test"))).resolves.toEqual({
      subject: "user_01ABC",
      sessionId: "session_01ABC",
    });
    await expect(verifyAccessToken(await sign("client_other"))).rejects.toBeInstanceOf(
      joseErrors.JWTClaimValidationFailed,
    );

    const verifyCustomIssuer = createWorkOSAccessTokenVerifier(
      "client_test",
      createLocalJWKSet({ keys: [publicJwk] }),
      "https://auth.example.com",
    );
    await expect(
      verifyCustomIssuer(await sign("client_test", "https://auth.example.com")),
    ).resolves.toEqual({
      subject: "user_01ABC",
      sessionId: "session_01ABC",
    });
    await expect(verifyCustomIssuer(await sign("client_test"))).rejects.toBeInstanceOf(
      joseErrors.JWTClaimValidationFailed,
    );

    const { privateKey: unrelatedPrivateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({
      sid: "session_01ABC",
      client_id: "client_test",
      jti: "01HQSXZXPPFPKMDD32RKTFY6PV",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(DEFAULT_WORKOS_JWT_ISSUER)
      .setSubject("user_01ABC")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(unrelatedPrivateKey);
    await expect(verifyAccessToken(forged)).rejects.toBeInstanceOf(
      joseErrors.JWSSignatureVerificationFailed,
    );
  });
});

describe("WorkOS AuthKit identity provider (WorkOS Emulate)", () => {
  it("exchanges an emulator authorization code for a verified local identity", async () => {
    const fixture = await emulateFixture();
    const authorization = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });

    const identity = await fixture.provider.authenticateCode({
      code: authorization.code,
      codeVerifier: authorization.codeVerifier,
      ipAddress: "127.0.0.1",
      userAgent: "Hype Comms test",
    });

    expect(identity).toEqual({
      provider: "workos",
      subject: VERIFIED_USER_ID,
      verifiedEmail: "morgan@example.com",
      providerSessionId: expect.stringMatching(/^session_[A-Za-z0-9]+$/),
    });
    expect(JSON.stringify(identity)).not.toMatch(/eyJ/);
    expect(JSON.stringify(identity)).not.toContain(authorization.code);
  });

  it("lists active sessions created by the emulator after a successful exchange", async () => {
    const fixture = await emulateFixture();
    const first = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });
    const firstIdentity = await fixture.provider.authenticateCode({
      code: first.code,
      codeVerifier: first.codeVerifier,
    });
    const second = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });
    const secondIdentity = await fixture.provider.authenticateCode({
      code: second.code,
      codeVerifier: second.codeVerifier,
    });

    await expect(fixture.provider.listActiveSessionIds(VERIFIED_USER_ID)).resolves.toEqual(
      new Set([firstIdentity.providerSessionId, secondIdentity.providerSessionId]),
    );
  });

  it("treats a definitively deleted WorkOS user as having no active sessions", async () => {
    const fixture = await emulateFixture();
    const authorization = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });
    await fixture.provider.authenticateCode({
      code: authorization.code,
      codeVerifier: authorization.codeVerifier,
    });

    await fixture.workos.userManagement.deleteUser(VERIFIED_USER_ID);

    await expect(fixture.provider.listActiveSessionIds(VERIFIED_USER_ID)).resolves.toEqual(
      new Set(),
    );
  });

  it("rejects unverified emails from the emulator", async () => {
    const fixture = await emulateFixture([
      {
        id: "user_01UNVERIFIED",
        email: "unverified@example.com",
        emailVerified: false,
      },
    ]);
    const authorization = await fixture.authorizeCode({
      loginHint: "unverified@example.com",
    });

    await expect(
      fixture.provider.authenticateCode({
        code: authorization.code,
        codeVerifier: authorization.codeVerifier,
      }),
    ).rejects.toBeInstanceOf(AuthKitIdentityRejectedError);
  });

  it("classifies invalid emulator authorization codes as identity rejections", async () => {
    const fixture = await emulateFixture();
    const authorization = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });

    await expect(
      fixture.provider.authenticateCode({
        code: "invalid-authorization-code",
        codeVerifier: authorization.codeVerifier,
      }),
    ).rejects.toBeInstanceOf(AuthKitIdentityRejectedError);
  });

  it("rejects a reused authorization code after a successful emulator exchange", async () => {
    const fixture = await emulateFixture();
    const authorization = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });
    await fixture.provider.authenticateCode({
      code: authorization.code,
      codeVerifier: authorization.codeVerifier,
    });

    await expect(
      fixture.provider.authenticateCode({
        code: authorization.code,
        codeVerifier: authorization.codeVerifier,
      }),
    ).rejects.toBeInstanceOf(AuthKitIdentityRejectedError);
  });

  it("rejects a PKCE verifier that does not match the emulator authorization", async () => {
    const fixture = await emulateFixture();
    const authorization = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });

    await expect(
      fixture.provider.authenticateCode({
        code: authorization.code,
        codeVerifier: "x".repeat(43),
      }),
    ).rejects.toBeInstanceOf(AuthKitIdentityRejectedError);
  });

  it("never treats an invalid subject as a complete inactive session set", async () => {
    const fixture = await emulateFixture();

    await expect(fixture.provider.listActiveSessionIds("not-a-workos-user")).rejects.toBeInstanceOf(
      AuthKitProviderUnavailableError,
    );
  });

  it("rejects raw HTTP authorization URLs from the emulator against HTTPS contracts", async () => {
    const fixture = await emulateFixture();

    // The official SDK points authorize at the emulator origin (http://localhost:…). Production
    // Hype Comms only accepts credential-free HTTPS authorization material, so the adapter must
    // refuse that surface rather than open a non-HTTPS provider URL in the system browser.
    await expect(fixture.provider.createAuthorization()).rejects.toBeInstanceOf(
      AuthKitProviderUnavailableError,
    );
  });

  it("builds the production factory against the emulator transport overrides", async () => {
    const fixture = await emulateFixture();
    const host = new URL(fixture.emulator.url);
    const provider = createWorkOSAuthKitIdentityProvider({
      apiKey: fixture.emulator.apiKey,
      clientId: fixture.clientId,
      redirectUri: fixture.redirectUri,
      jwtIssuer: DEFAULT_WORKOS_JWT_ISSUER,
      apiHostname: host.hostname,
      port: Number(host.port),
      https: false,
    });
    const authorization = await fixture.authorizeCode({ loginHint: VERIFIED_EMAIL });

    await expect(
      provider.authenticateCode({
        code: authorization.code,
        codeVerifier: authorization.codeVerifier,
      }),
    ).resolves.toMatchObject({
      provider: "workos",
      subject: VERIFIED_USER_ID,
      verifiedEmail: "morgan@example.com",
    });
  });
});

describe("WorkOS AuthKit identity provider (adapter edge cases)", () => {
  it("uses server-held PKCE and reduces WorkOS secrets to a verified identity", async () => {
    const getAuthorizationUrlWithPKCE = vi.fn().mockResolvedValue({
      url: AUTHORIZATION_URL,
      state: PROVIDER_STATE,
      codeVerifier: PROVIDER_CODE_VERIFIER,
    });
    const authenticateWithCode = vi.fn().mockResolvedValue({
      accessToken: "workos-access-secret",
      refreshToken: "workos-refresh-secret",
      user: {
        id: "user_01ABC",
        email: "Morgan@Example.COM",
        emailVerified: true,
      },
    });
    const getLogoutUrl = vi.fn().mockReturnValue(LOGOUT_URL);
    const verifyAccessToken = vi.fn().mockResolvedValue({
      subject: "user_01ABC",
      sessionId: "session_01ABC",
    });
    const provider = new WorkOSAuthKitIdentityProvider({
      client: { getAuthorizationUrlWithPKCE, authenticateWithCode, getLogoutUrl },
      clientId: "client_test",
      redirectUri: "http://127.0.0.1:3000/v1/auth/workos/callback",
      verifyAccessToken,
    });

    const authorization = await provider.createAuthorization();
    const identity = await provider.authenticateCode({
      code: PROVIDER_CODE,
      codeVerifier: PROVIDER_CODE_VERIFIER,
      ipAddress: "127.0.0.1",
      userAgent: "Hype Comms test",
    });
    const logoutUrl = provider.createLogoutUrl("session_01ABC");

    expect(getAuthorizationUrlWithPKCE).toHaveBeenCalledWith({
      provider: "authkit",
      clientId: "client_test",
      redirectUri: "http://127.0.0.1:3000/v1/auth/workos/callback",
    });
    expect(authorization).toEqual({
      authorizationUrl: AUTHORIZATION_URL,
      state: PROVIDER_STATE,
      codeVerifier: PROVIDER_CODE_VERIFIER,
    });
    expect(authenticateWithCode).toHaveBeenCalledWith({
      code: PROVIDER_CODE,
      codeVerifier: PROVIDER_CODE_VERIFIER,
      clientId: "client_test",
      ipAddress: "127.0.0.1",
      userAgent: "Hype Comms test",
    });
    expect(identity).toEqual({
      provider: "workos",
      subject: "user_01ABC",
      verifiedEmail: "morgan@example.com",
      providerSessionId: "session_01ABC",
    });
    expect(getLogoutUrl).toHaveBeenCalledWith({ sessionId: "session_01ABC" });
    expect(logoutUrl).toBe(LOGOUT_URL);
    expect(verifyAccessToken).toHaveBeenCalledWith("workos-access-secret");
    expect(JSON.stringify(identity)).not.toContain("workos-access-secret");
    expect(JSON.stringify(identity)).not.toContain("workos-refresh-secret");
  });

  it("paginates and validates the complete active-session set for reconciliation", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        object: "list",
        data: [
          {
            object: "session",
            id: "session_01ACTIVE",
            userId: "user_01ABC",
            status: "active",
          },
        ],
        listMetadata: { after: "session_01ACTIVE" },
      })
      .mockResolvedValueOnce({
        object: "list",
        data: [
          {
            object: "session",
            id: "session_01SECOND",
            userId: "user_01ABC",
            status: "active",
          },
        ],
        listMetadata: { after: null },
      });
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode: vi.fn(),
        getLogoutUrl: vi.fn(),
        listSessions,
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn(),
    });

    await expect(provider.listActiveSessionIds("user_01ABC")).resolves.toEqual(
      new Set(["session_01ACTIVE", "session_01SECOND"]),
    );
    expect(listSessions).toHaveBeenNthCalledWith(1, "user_01ABC", { limit: 100 });
    expect(listSessions).toHaveBeenNthCalledWith(2, "user_01ABC", {
      limit: 100,
      after: "session_01ACTIVE",
    });
  });

  it("never treats malformed or cross-subject session pages as an inactive session set", async () => {
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode: vi.fn(),
        getLogoutUrl: vi.fn(),
        listSessions: vi.fn().mockResolvedValue({
          object: "list",
          data: [
            {
              object: "session",
              id: "session_01ACTIVE",
              userId: "user_DIFFERENT",
              status: "active",
            },
          ],
          listMetadata: { after: null },
        }),
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn(),
    });

    await expect(provider.listActiveSessionIds("user_01ABC")).rejects.toBeInstanceOf(
      AuthKitProviderUnavailableError,
    );
  });

  it("maps definitive NotFoundException pages to an empty active-session set", async () => {
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode: vi.fn(),
        getLogoutUrl: vi.fn(),
        listSessions: vi.fn().mockRejectedValue(
          new NotFoundException({
            path: "/user_management/users/user_01DELETED/sessions",
            requestID: "request_01ABC",
          }),
        ),
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn(),
    });

    await expect(provider.listActiveSessionIds("user_01DELETED")).resolves.toEqual(new Set());
  });

  it("rejects every impersonation signal", async () => {
    const verifiedAuthentication = {
      accessToken: "workos-access-secret",
      refreshToken: "workos-refresh-secret",
      user: {
        id: "user_01ABC",
        email: "Morgan@Example.COM",
        emailVerified: true,
      },
    };
    const authenticateWithCode = vi
      .fn()
      .mockResolvedValueOnce({
        ...verifiedAuthentication,
        impersonator: { email: "operator@example.com", reason: "Support" },
      })
      .mockResolvedValueOnce({
        ...verifiedAuthentication,
        authenticationMethod: "Impersonation",
      });
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode,
        getLogoutUrl: vi.fn(),
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn().mockResolvedValue({
        subject: "user_01ABC",
        sessionId: "session_01ABC",
      }),
    });
    const input = { code: PROVIDER_CODE, codeVerifier: PROVIDER_CODE_VERIFIER };

    await expect(provider.authenticateCode(input)).rejects.toBeInstanceOf(
      AuthKitIdentityRejectedError,
    );
    await expect(provider.authenticateCode(input)).rejects.toBeInstanceOf(
      AuthKitIdentityRejectedError,
    );
  });

  it("rejects token/user subject mismatches and JOSE failures", async () => {
    const verifyAccessToken = vi
      .fn()
      .mockResolvedValueOnce({ subject: "user_other", sessionId: "session_01ABC" })
      .mockRejectedValueOnce(new joseErrors.JWTExpired("expired", {}, "exp", "check_failed"));
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode: vi.fn().mockResolvedValue({
          accessToken: "workos-access-secret",
          refreshToken: "workos-refresh-secret",
          user: {
            id: "user_01ABC",
            email: "Morgan@Example.COM",
            emailVerified: true,
          },
        }),
        getLogoutUrl: vi.fn(),
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken,
    });
    const input = { code: PROVIDER_CODE, codeVerifier: PROVIDER_CODE_VERIFIER };

    await expect(provider.authenticateCode(input)).rejects.toBeInstanceOf(
      AuthKitIdentityRejectedError,
    );
    await expect(provider.authenticateCode(input)).rejects.toBeInstanceOf(
      AuthKitIdentityRejectedError,
    );
  });

  it("classifies code denials separately while sanitizing upstream and malformed responses", async () => {
    const authenticateWithCode = vi
      .fn()
      .mockRejectedValueOnce(
        new OauthException(400, "request-id", "invalid_grant", `expired ${PROVIDER_CODE}`, {
          code: PROVIDER_CODE,
        }),
      )
      .mockRejectedValueOnce(new Error(`upstream leaked ${PROVIDER_CODE}`))
      .mockResolvedValueOnce({
        accessToken: "token",
        user: {
          id: "user_01ABC",
          email: "Morgan@Example.COM",
          emailVerified: true,
        },
      });
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode,
        getLogoutUrl: vi.fn(),
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn(),
    });
    const input = { code: PROVIDER_CODE, codeVerifier: PROVIDER_CODE_VERIFIER };

    await expect(provider.authenticateCode(input)).rejects.toBeInstanceOf(
      AuthKitIdentityRejectedError,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let error: unknown;
      try {
        await provider.authenticateCode(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AuthKitProviderUnavailableError);
      expect((error as Error).message).not.toContain(PROVIDER_CODE);
    }
  });

  it("rejects malformed authorization material without exposing it", async () => {
    const getAuthorizationUrlWithPKCE = vi
      .fn()
      .mockResolvedValueOnce({
        url: "http://api.workos.com/authorize",
        state: PROVIDER_STATE,
        codeVerifier: PROVIDER_CODE_VERIFIER,
      })
      .mockRejectedValueOnce(new Error(`upstream leaked ${PROVIDER_CODE_VERIFIER}`));
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE,
        authenticateWithCode: vi.fn(),
        getLogoutUrl: vi.fn(),
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn(),
    });

    await expect(provider.createAuthorization()).rejects.toBeInstanceOf(
      AuthKitProviderUnavailableError,
    );
    let error: unknown;
    try {
      await provider.createAuthorization();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthKitProviderUnavailableError);
    expect((error as Error).message).not.toContain(PROVIDER_CODE_VERIFIER);
  });

  it("rejects malformed, mismatched, and secret-bearing logout URLs", () => {
    const getLogoutUrl = vi
      .fn()
      .mockReturnValueOnce(
        "https://api.workos.com/user_management/sessions/logout?session_id=session_other",
      )
      .mockReturnValueOnce(
        "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC&api_key=sk_secret",
      )
      .mockImplementationOnce(() => {
        throw new Error("sk_secret");
      });
    const provider = new WorkOSAuthKitIdentityProvider({
      client: {
        getAuthorizationUrlWithPKCE: vi.fn(),
        authenticateWithCode: vi.fn(),
        getLogoutUrl,
      },
      clientId: "client_test",
      redirectUri: "https://chat.example/v1/auth/workos/callback",
      verifyAccessToken: vi.fn(),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let error: unknown;
      try {
        provider.createLogoutUrl("session_01ABC");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AuthKitProviderUnavailableError);
      expect((error as Error).message).not.toContain("sk_secret");
    }
  });
});
