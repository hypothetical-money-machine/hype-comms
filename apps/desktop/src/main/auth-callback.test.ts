import { describe, expect, it, vi } from "vitest";

import {
  parseAuthCallback,
  parseAuthCallbackToken,
  parseAuthKitCallback,
  processAuthCallback,
} from "./auth-callback";

const TOKEN = "A".repeat(43);

describe("magic-link callback processing", () => {
  it("exchanges exactly one valid callback token", async () => {
    const exchange = vi.fn(async () => undefined);

    await expect(
      processAuthCallback(`hmm-chat://auth/callback?token=${TOKEN}`, exchange),
    ).resolves.toBe("succeeded");
    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledWith(TOKEN);
  });

  it.each([
    "hmm-chat://auth/callback",
    "hmm-chat://auth/callback?token=malformed",
    `hmm-chat://auth/callback?token=${"A".repeat(87)}`,
    `hmm-chat://auth/callback?token=${TOKEN}&token=${TOKEN}`,
    `hmm-chat://auth/other?token=${TOKEN}`,
    `https://auth/callback?token=${TOKEN}`,
  ])("ignores an invalid callback without attempting an exchange: %s", async (url) => {
    const exchange = vi.fn(async () => undefined);

    expect(parseAuthCallbackToken(url)).toBeNull();
    await expect(processAuthCallback(url, exchange)).resolves.toBe("ignored");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("collapses exchange failures into a credential-free outcome", async () => {
    const exchange = vi.fn(async () => {
      throw new Error(`Server rejected ${TOKEN}`);
    });

    const outcome = await processAuthCallback(`hmm-chat://auth/callback?token=${TOKEN}`, exchange);

    expect(outcome).toBe("failed");
    expect(outcome).not.toContain(TOKEN);
  });

  it("preserves legacy token precedence when unrelated query parameters are present", () => {
    expect(
      parseAuthCallback(
        `hmm-chat://auth/callback?token=${TOKEN}&code=legacy-metadata&state=legacy-metadata`,
      ),
    ).toEqual({ kind: "magic_link", token: TOKEN });
  });
});

describe("AuthKit callback parsing", () => {
  const code = "c".repeat(43);
  const state = "s".repeat(43);

  it("parses one strict HMM handoff code and desktop state", () => {
    const value = `hmm-chat://auth/callback?code=${code}&state=${state}`;

    expect(parseAuthKitCallback(value)).toEqual({ code, state });
    expect(parseAuthCallback(value)).toEqual({
      kind: "authkit",
      callback: { code, state },
    });
  });

  it("parses only the fixed credential-free terminal error", () => {
    const value = `hmm-chat://auth/callback?error=authentication_failed&state=${state}`;

    expect(parseAuthKitCallback(value)).toEqual({
      error: "authentication_failed",
      state,
    });
    expect(parseAuthCallback(value)).toEqual({
      kind: "authkit",
      callback: { error: "authentication_failed", state },
    });
  });

  it.each([
    `hmm-chat://auth/callback?code=${code}`,
    `hmm-chat://auth/callback?state=${state}`,
    `hmm-chat://auth/callback?code=${code}&state=${state}&extra=value`,
    `hmm-chat://auth/callback?code=${code}&code=${code}&state=${state}`,
    `hmm-chat://auth/callback?code=${code}&state=${state}&state=${state}`,
    `hmm-chat://auth/callback?code=${code}&error=authentication_failed&state=${state}`,
    `hmm-chat://auth/callback?error=access_denied&state=${state}`,
    `hmm-chat://auth/callback?error=authentication_failed&error_description=denied&state=${state}`,
    `hmm-chat://auth/callback?code=workos-provider-code&state=${state}`,
    `hmm-chat://auth/callback?code=${code}&state=workos-provider-state`,
    `hmm-chat://auth:8443/callback?code=${code}&state=${state}`,
    `hmm-chat://auth/callback?code=${code}&state=${state}#fragment`,
  ])("rejects a malformed, ambiguous, or provider-detail callback: %s", (value) => {
    expect(parseAuthKitCallback(value)).toBeNull();
    expect(parseAuthCallback(value)).toBeNull();
  });
});
