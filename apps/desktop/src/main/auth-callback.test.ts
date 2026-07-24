import { describe, expect, it, vi } from "vitest";

import { parseAuthCallbackToken, processAuthCallback } from "./auth-callback";

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
});
