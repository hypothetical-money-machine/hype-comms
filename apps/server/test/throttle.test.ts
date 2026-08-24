import { describe, expect, it } from "vitest";

import { FixedWindowAttemptThrottle, SignInThrottle } from "../src/throttle.js";

describe("fixed-window attempt throttle", () => {
  it("counts every attempt, isolates keys, and resets at the window boundary", () => {
    let now = 1_000;
    const throttle = new FixedWindowAttemptThrottle({
      maxAttempts: 2,
      windowMs: 60_000,
      now: () => now,
    });

    expect(throttle.recordAttempt("1.2.3.4")).toBe(0);
    expect(throttle.recordAttempt("1.2.3.4")).toBe(0);
    expect(throttle.recordAttempt("1.2.3.4")).toBe(60_000);
    expect(throttle.recordAttempt("5.6.7.8")).toBe(0);

    now += 60_000;
    expect(throttle.recordAttempt("1.2.3.4")).toBe(0);
  });
});

describe("sign-in throttle", () => {
  it("limits total requests per client even when the client rotates recipient addresses", () => {
    const throttle = new SignInThrottle({
      maxRequestsPerClient: 2,
      maxRequestsPerEmailPerClient: 10,
    });

    expect(throttle.recordMagicLinkRequest("first@example.com", "1.2.3.4")).toBe(true);
    expect(throttle.recordMagicLinkRequest("second@example.com", "1.2.3.4")).toBe(true);
    expect(throttle.recordMagicLinkRequest("third@example.com", "1.2.3.4")).toBe(false);
    expect(throttle.recordMagicLinkRequest("third@example.com", "5.6.7.8")).toBe(true);
  });

  it("isolates per-email request budgets by client", () => {
    const throttle = new SignInThrottle({
      maxRequestsPerClient: 10,
      maxRequestsPerEmailPerClient: 2,
    });

    expect(throttle.recordMagicLinkRequest("member@example.com", "1.2.3.4")).toBe(true);
    expect(throttle.recordMagicLinkRequest("member@example.com", "1.2.3.4")).toBe(true);
    expect(throttle.recordMagicLinkRequest("member@example.com", "1.2.3.4")).toBe(false);
    expect(throttle.recordMagicLinkRequest("other@example.com", "1.2.3.4")).toBe(true);
    expect(throttle.recordMagicLinkRequest("member@example.com", "5.6.7.8")).toBe(true);
  });

  it("bounds deliveries per email across clients and resets at the window boundary", () => {
    let now = 0;
    const throttle = new SignInThrottle({
      maxDeliveriesPerEmail: 2,
      windowMs: 60_000,
      now: () => now,
    });

    expect(throttle.reserveMagicLinkDelivery("member@example.com")).toBe(true);
    expect(throttle.reserveMagicLinkDelivery("member@example.com")).toBe(true);
    expect(throttle.reserveMagicLinkDelivery("member@example.com")).toBe(false);
    expect(throttle.reserveMagicLinkDelivery("other@example.com")).toBe(true);

    now = 60_000;
    expect(throttle.reserveMagicLinkDelivery("member@example.com")).toBe(true);
  });
});
