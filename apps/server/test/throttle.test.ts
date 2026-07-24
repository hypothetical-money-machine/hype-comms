import { describe, expect, it } from "vitest";

import { SignInThrottle } from "../src/modules/chat/throttle.js";

describe("sign-in throttle", () => {
  it("allows attempts until the failure budget is spent", () => {
    const now = 1_000;
    const throttle = new SignInThrottle({ maxFailures: 3, windowMs: 60_000, now: () => now });

    expect(throttle.retryAfterMs("1.2.3.4")).toBe(0);
    throttle.recordFailure("1.2.3.4");
    throttle.recordFailure("1.2.3.4");
    expect(throttle.retryAfterMs("1.2.3.4")).toBe(0);

    throttle.recordFailure("1.2.3.4");
    expect(throttle.retryAfterMs("1.2.3.4")).toBe(60_000);
  });

  it("keeps budgets independent per key", () => {
    const now = 0;
    const throttle = new SignInThrottle({ maxFailures: 1, windowMs: 60_000, now: () => now });

    throttle.recordFailure("1.2.3.4");

    expect(throttle.retryAfterMs("1.2.3.4")).toBeGreaterThan(0);
    expect(throttle.retryAfterMs("5.6.7.8")).toBe(0);
  });

  it("clears the budget once the window elapses", () => {
    let now = 0;
    const throttle = new SignInThrottle({ maxFailures: 1, windowMs: 60_000, now: () => now });

    throttle.recordFailure("1.2.3.4");
    expect(throttle.retryAfterMs("1.2.3.4")).toBe(60_000);

    now = 60_000;
    expect(throttle.retryAfterMs("1.2.3.4")).toBe(0);
  });

  it("forgets failures after a successful sign-in", () => {
    const now = 0;
    const throttle = new SignInThrottle({ maxFailures: 2, windowMs: 60_000, now: () => now });

    throttle.recordFailure("1.2.3.4");
    throttle.recordSuccess("1.2.3.4");
    throttle.recordFailure("1.2.3.4");

    expect(throttle.retryAfterMs("1.2.3.4")).toBe(0);
  });
});
