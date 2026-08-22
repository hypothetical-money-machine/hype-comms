import { describe, expect, it, vi } from "vitest";

import {
  parseAuthCallback,
  parseAuthCallbackToken,
  parseAuthKitCallback,
  processAuthCallback,
} from "./auth-callback";
import { AUTH_PROTOCOL_SCHEMES } from "./security";

const TOKEN = "A".repeat(43);
const PRODUCTION_SCHEME = AUTH_PROTOCOL_SCHEMES.production;

describe("magic-link callback processing", () => {
  it("exchanges exactly one valid callback token", async () => {
    const confirm = vi.fn(async () => true);
    const exchange = vi.fn(async () => undefined);

    await expect(
      processAuthCallback(
        `hype-comms://auth/callback?token=${TOKEN}`,
        PRODUCTION_SCHEME,
        confirm,
        exchange,
      ),
    ).resolves.toBe("succeeded");
    expect(confirm).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledWith(TOKEN);
  });

  it("does not exchange until the user confirms without passing the token to the prompt", async () => {
    const confirm = vi.fn(async (...arguments_: readonly unknown[]) => {
      expect(arguments_).toEqual([]);
      return false;
    });
    const exchange = vi.fn(async () => undefined);

    await expect(
      processAuthCallback(
        `hype-comms://auth/callback?token=${TOKEN}`,
        PRODUCTION_SCHEME,
        confirm,
        exchange,
      ),
    ).resolves.toBe("cancelled");
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    "hype-comms://auth/callback",
    "hype-comms://auth/callback?token=malformed",
    `hype-comms://auth/callback?token=${"A".repeat(87)}`,
    `hype-comms://auth/callback?token=${TOKEN}&token=${TOKEN}`,
    `hype-comms://auth/other?token=${TOKEN}`,
    `https://auth/callback?token=${TOKEN}`,
  ])("ignores an invalid callback without attempting an exchange: %s", async (url) => {
    const confirm = vi.fn(async () => true);
    const exchange = vi.fn(async () => undefined);

    expect(parseAuthCallbackToken(url, PRODUCTION_SCHEME)).toBeNull();
    await expect(processAuthCallback(url, PRODUCTION_SCHEME, confirm, exchange)).resolves.toBe(
      "ignored",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it("collapses exchange failures into a credential-free outcome", async () => {
    const confirm = vi.fn(async () => true);
    const exchange = vi.fn(async () => {
      throw new Error(`Server rejected ${TOKEN}`);
    });

    const outcome = await processAuthCallback(
      `hype-comms://auth/callback?token=${TOKEN}`,
      PRODUCTION_SCHEME,
      confirm,
      exchange,
    );

    expect(outcome).toBe("failed");
    expect(outcome).not.toContain(TOKEN);
  });

  it("preserves legacy token precedence when unrelated query parameters are present", () => {
    expect(
      parseAuthCallback(
        `hype-comms://auth/callback?token=${TOKEN}&code=legacy-metadata&state=legacy-metadata`,
        PRODUCTION_SCHEME,
      ),
    ).toEqual({ kind: "magic_link", token: TOKEN });
  });
});

describe("AuthKit callback parsing", () => {
  const code = "c".repeat(43);
  const state = "s".repeat(43);

  it("parses one strict HMM handoff code and desktop state", () => {
    const value = `hype-comms://auth/callback?code=${code}&state=${state}`;

    expect(parseAuthKitCallback(value, PRODUCTION_SCHEME)).toEqual({ code, state });
    expect(parseAuthCallback(value, PRODUCTION_SCHEME)).toEqual({
      kind: "authkit",
      callback: { code, state },
    });
  });

  it("parses only the fixed credential-free terminal error", () => {
    const value = `hype-comms://auth/callback?error=authentication_failed&state=${state}`;

    expect(parseAuthKitCallback(value, PRODUCTION_SCHEME)).toEqual({
      error: "authentication_failed",
      state,
    });
    expect(parseAuthCallback(value, PRODUCTION_SCHEME)).toEqual({
      kind: "authkit",
      callback: { error: "authentication_failed", state },
    });
  });

  it.each([
    `hype-comms://auth/callback?code=${code}`,
    `hype-comms://auth/callback?state=${state}`,
    `hype-comms://auth/callback?code=${code}&state=${state}&extra=value`,
    `hype-comms://auth/callback?code=${code}&code=${code}&state=${state}`,
    `hype-comms://auth/callback?code=${code}&state=${state}&state=${state}`,
    `hype-comms://auth/callback?code=${code}&error=authentication_failed&state=${state}`,
    `hype-comms://auth/callback?error=access_denied&state=${state}`,
    `hype-comms://auth/callback?error=authentication_failed&error_description=denied&state=${state}`,
    `hype-comms://auth/callback?code=workos-provider-code&state=${state}`,
    `hype-comms://auth/callback?code=${code}&state=workos-provider-state`,
    `hype-comms://auth:8443/callback?code=${code}&state=${state}`,
    `hype-comms://auth/callback?code=${code}&state=${state}#fragment`,
  ])("rejects a malformed, ambiguous, or provider-detail callback: %s", (value) => {
    expect(parseAuthKitCallback(value, PRODUCTION_SCHEME)).toBeNull();
    expect(parseAuthCallback(value, PRODUCTION_SCHEME)).toBeNull();
  });

  it("accepts only the callback scheme owned by this build", () => {
    const development = `hype-comms-dev://auth/callback?code=${code}&state=${state}`;
    const production = `hype-comms://auth/callback?code=${code}&state=${state}`;

    expect(parseAuthKitCallback(development, AUTH_PROTOCOL_SCHEMES.development)).toEqual({
      code,
      state,
    });
    expect(parseAuthKitCallback(development, PRODUCTION_SCHEME)).toBeNull();
    expect(parseAuthKitCallback(production, AUTH_PROTOCOL_SCHEMES.development)).toBeNull();
  });
});
