import { afterEach, describe, expect, it, vi } from "vitest";

import { apiResponseError, MAX_RETRY_AFTER_MS } from "../src/errors.js";

function rateLimitedResponse(retryAfter: string): Response {
  return new Response(null, { status: 429, headers: { "retry-after": retryAfter } });
}

const rateLimitEnvelope = {
  error: { code: "RATE_LIMITED", message: "Try again later", requestId: "request-1" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Retry-After", () => {
  it("parses an ordinary numeric Retry-After value", () => {
    expect(apiResponseError(rateLimitedResponse("2"), rateLimitEnvelope).retryAfterMs).toBe(2_000);
  });

  it("parses an HTTP-date Retry-After value", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00.000Z"));

    expect(
      apiResponseError(rateLimitedResponse("Thu, 01 Jan 2026 00:00:05 GMT"), rateLimitEnvelope)
        .retryAfterMs,
    ).toBe(5_000);
  });

  it("clamps an extremely large Retry-After value", () => {
    expect(
      apiResponseError(rateLimitedResponse("999999999999999"), rateLimitEnvelope).retryAfterMs,
    ).toBe(MAX_RETRY_AFTER_MS);
  });

  it("clamps a Retry-After value beyond Node's timer range", () => {
    expect(
      apiResponseError(rateLimitedResponse("2147483648"), rateLimitEnvelope).retryAfterMs,
    ).toBe(MAX_RETRY_AFTER_MS);
  });

  it("falls back when Retry-After is malformed", () => {
    expect(
      apiResponseError(rateLimitedResponse("not-a-delay"), rateLimitEnvelope).retryAfterMs,
    ).toBeUndefined();
  });

  it("falls back when Retry-After is negative", () => {
    expect(
      apiResponseError(rateLimitedResponse("-1"), rateLimitEnvelope).retryAfterMs,
    ).toBeUndefined();
  });
});
