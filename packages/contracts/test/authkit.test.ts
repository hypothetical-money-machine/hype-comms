import { describe, expect, it } from "vitest";

import {
  authCapabilitiesSchema,
  authKitCallbackQuerySchema,
  authKitLogoutUrlSchema,
  authPkceCodeVerifierSchema,
  createDesktopAuthorizationRequestSchema,
  createDesktopAuthorizationResponseSchema,
  desktopAuthVariantSchema,
  desktopAuthCallbackParametersSchema,
  exchangeAuthHandoffRequestSchema,
  magicLinkLandingQuerySchema,
  requestMagicLinkSchema,
} from "../src/index.js";

const BASE64_URL_VALUE = "a".repeat(43);

describe("AuthKit contracts", () => {
  it("accepts strict desktop authorization inputs and credential-free HTTPS URLs", () => {
    expect(
      createDesktopAuthorizationRequestSchema.parse({
        codeChallenge: BASE64_URL_VALUE,
        state: "b".repeat(43),
      }),
    ).toEqual({ codeChallenge: BASE64_URL_VALUE, state: "b".repeat(43) });
    expect(
      createDesktopAuthorizationRequestSchema.parse({
        codeChallenge: BASE64_URL_VALUE,
        state: "b".repeat(43),
        variant: "development",
      }),
    ).toEqual({
      codeChallenge: BASE64_URL_VALUE,
      state: "b".repeat(43),
      variant: "development",
    });
    expect(
      createDesktopAuthorizationResponseSchema.parse({
        authorizationUrl: "https://api.workos.com/user_management/authorize?client_id=client_test",
      }),
    ).toMatchObject({ authorizationUrl: expect.stringContaining("https://api.workos.com/") });
  });

  it("allowlists AuthKit callback variants without exposing a magic-link selector", () => {
    expect(desktopAuthVariantSchema.parse("production")).toBe("production");
    expect(desktopAuthVariantSchema.parse("development")).toBe("development");
    expect(() => desktopAuthVariantSchema.parse("preview")).toThrow();
    expect(() =>
      createDesktopAuthorizationRequestSchema.parse({
        codeChallenge: BASE64_URL_VALUE,
        state: "b".repeat(43),
        variant: "preview",
      }),
    ).toThrow();

    expect(requestMagicLinkSchema.parse({ email: "MEMBER@example.com" })).toEqual({
      email: "member@example.com",
    });
    expect(() =>
      requestMagicLinkSchema.parse({
        email: "member@example.com",
        variant: "development",
      }),
    ).toThrow();
    expect(
      magicLinkLandingQuerySchema.parse({
        token: BASE64_URL_VALUE,
        variant: "development",
        utm_source: "mail",
      }),
    ).toEqual({ token: BASE64_URL_VALUE });
    expect(() =>
      requestMagicLinkSchema.parse({ email: "member@example.com", variant: "preview" }),
    ).toThrow();
    expect(
      magicLinkLandingQuerySchema.parse({ token: BASE64_URL_VALUE, variant: "preview" }),
    ).toEqual({ token: BASE64_URL_VALUE });
  });

  it("rejects unknown start fields, insecure URLs, credentials in URLs, and malformed PKCE", () => {
    expect(() =>
      createDesktopAuthorizationRequestSchema.parse({
        codeChallenge: BASE64_URL_VALUE,
        state: "b".repeat(43),
        email: "member@example.com",
      }),
    ).toThrow();
    expect(() =>
      createDesktopAuthorizationResponseSchema.parse({
        authorizationUrl: "http://api.workos.com/authorize",
      }),
    ).toThrow();
    expect(() =>
      createDesktopAuthorizationResponseSchema.parse({
        authorizationUrl: "https://user:secret@api.workos.com/authorize",
      }),
    ).toThrow();
    expect(() => authPkceCodeVerifierSchema.parse("not-long-enough")).toThrow();
    expect(() => authPkceCodeVerifierSchema.parse(`${"a".repeat(42)}+`)).toThrow();
  });

  it("keeps provider callback codes distinct from bounded desktop handoff codes", () => {
    expect(
      authKitCallbackQuerySchema.parse({
        code: "workos-authorization-code",
        state: "provider-state-value",
      }),
    ).toMatchObject({ code: "workos-authorization-code" });
    expect(
      desktopAuthCallbackParametersSchema.parse({
        code: "c".repeat(43),
        state: "d".repeat(43),
      }),
    ).toMatchObject({ code: "c".repeat(43) });
    expect(() =>
      desktopAuthCallbackParametersSchema.parse({
        code: "workos-authorization-code",
        state: "d".repeat(43),
      }),
    ).toThrow();
  });

  it("accepts only strict provider errors and a generic desktop failure", () => {
    expect(
      authKitCallbackQuerySchema.parse({
        error: "access_denied",
        error_description: "The user cancelled sign-in",
        state: "provider-state-value",
      }),
    ).toMatchObject({ error: "access_denied" });
    expect(
      desktopAuthCallbackParametersSchema.parse({
        error: "authentication_failed",
        state: "d".repeat(43),
      }),
    ).toMatchObject({ error: "authentication_failed" });
    expect(
      desktopAuthCallbackParametersSchema.parse({
        error: "authentication_failed",
      }),
    ).toEqual({ error: "authentication_failed" });
    expect(() =>
      desktopAuthCallbackParametersSchema.parse({
        code: "c".repeat(43),
      }),
    ).toThrow();
    expect(() =>
      desktopAuthCallbackParametersSchema.parse({
        error: "access_denied",
        state: "d".repeat(43),
      }),
    ).toThrow();
    expect(() =>
      authKitCallbackQuerySchema.parse({
        code: "provider-code",
        error: "access_denied",
        state: "provider-state-value",
      }),
    ).toThrow();
  });

  it("validates a PKCE-bound handoff and rejects extra device metadata", () => {
    const handoff = {
      code: "c".repeat(43),
      codeVerifier: "v".repeat(43),
      installationId: "10000000-0000-4000-8000-000000000004",
      platform: "linux",
      appVersion: " 0.2.0 ",
    };

    expect(exchangeAuthHandoffRequestSchema.parse(handoff)).toEqual({
      ...handoff,
      appVersion: "0.2.0",
    });
    expect(() =>
      exchangeAuthHandoffRequestSchema.parse({ ...handoff, accessToken: "do-not-accept" }),
    ).toThrow();
    expect(() =>
      exchangeAuthHandoffRequestSchema.parse({ ...handoff, platform: "android" }),
    ).toThrow();
  });

  it("keeps authentication capability discovery strict and explicit", () => {
    expect(authCapabilitiesSchema.parse({ authKit: true, magicLink: false })).toEqual({
      authKit: true,
      magicLink: false,
    });
    expect(() => authCapabilitiesSchema.parse({ authKit: true })).toThrow();
    expect(() =>
      authCapabilitiesSchema.parse({ authKit: true, magicLink: false, bearerTokens: true }),
    ).toThrow();
  });

  it("accepts only the exact credential-free WorkOS session logout endpoint", () => {
    expect(
      authKitLogoutUrlSchema.parse(
        "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC",
      ),
    ).toContain("session_01ABC");

    for (const value of [
      "http://api.workos.com/user_management/sessions/logout?session_id=session_01ABC",
      "https://user:secret@api.workos.com/user_management/sessions/logout?session_id=session_01ABC",
      "https://evil.example/user_management/sessions/logout?session_id=session_01ABC",
      "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC&return_to=https%3A%2F%2Fevil.example",
      "https://api.workos.com/user_management/sessions/logout?session_id=session_01ABC#secret",
      "https://api.workos.com/user_management/sessions/logout?session_id=access-token",
    ]) {
      expect(() => authKitLogoutUrlSchema.parse(value)).toThrow();
    }
  });
});
