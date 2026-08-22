import { describe, expect, it } from "vitest";

import { MAX_MAILTO_URL_LENGTH, normalizeExternalMailtoUrl } from "./external-mailto";

describe("normalizeExternalMailtoUrl", () => {
  it("accepts a plain single-recipient mailto", () => {
    expect(normalizeExternalMailtoUrl("mailto:dan@example.com")).toBe("mailto:dan@example.com");
  });

  it("accepts multiple comma-separated recipients", () => {
    expect(normalizeExternalMailtoUrl("mailto:a@example.com,b@example.org")).toBe(
      "mailto:a@example.com,b@example.org",
    );
  });

  it("accepts standard subject, body, cc, and bcc parameters", () => {
    const normalized = normalizeExternalMailtoUrl(
      "mailto:a@example.com?subject=Hello&body=Line%0D%0ANext&cc=b@example.org&bcc=c@example.net",
    );
    expect(normalized).toBe(
      "mailto:a@example.com?subject=Hello&body=Line%0D%0ANext&cc=b@example.org&bcc=c@example.net",
    );
  });

  it("accepts header-only recipients through the to parameter", () => {
    expect(normalizeExternalMailtoUrl("mailto:?to=a@example.com&subject=Hi")).toBe(
      "mailto:?to=a@example.com&subject=Hi",
    );
  });

  it("normalizes the scheme case", () => {
    expect(normalizeExternalMailtoUrl("MAILTO:a@example.com")).toBe("mailto:a@example.com");
  });

  it("rejects non-mailto schemes and unparseable values", () => {
    expect(normalizeExternalMailtoUrl("https://example.com")).toBeNull();
    expect(normalizeExternalMailtoUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalMailtoUrl("not a url at all")).toBeNull();
    expect(normalizeExternalMailtoUrl("")).toBeNull();
  });

  it("rejects values beyond the length cap", () => {
    const longAddress = `mailto:${"a".repeat(MAX_MAILTO_URL_LENGTH)}@example.com`;
    expect(longAddress.length).toBeGreaterThan(MAX_MAILTO_URL_LENGTH);
    expect(normalizeExternalMailtoUrl(longAddress)).toBeNull();
  });

  it("rejects recipients without an address or with malformed addresses", () => {
    expect(normalizeExternalMailtoUrl("mailto:")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:?subject=Hello%20there")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:no-at-sign.example.com")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:@example.com")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a@")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:bob@example.com@evil.example")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a b@example.com")).toBeNull();
  });

  it("rejects percent-encoded control characters smuggled into recipients", () => {
    expect(normalizeExternalMailtoUrl("mailto:a@example.com%0ABcc:x@y.example")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:%00@example.com")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a@example.com?subject=%0Ainjected")).toBeNull();
  });

  it("rejects raw control characters anywhere in the value", () => {
    expect(normalizeExternalMailtoUrl("mailto:a@example.com\r\nBcc:x@y.example")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a@example.com?body=tab%09here")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a@example.com?subject=%00lead")).toBeNull();
  });

  it("rejects unknown query keys that could become injected headers", () => {
    expect(normalizeExternalMailtoUrl("mailto:a@example.com?x-custom-header=one")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a@example.com?in-reply-to=<a@b.c>")).toBeNull();
  });

  it("rejects malformed percent encodings", () => {
    expect(normalizeExternalMailtoUrl("mailto:a@example.com?subject=%ZZ")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:%E0%A4%A@example.com")).toBeNull();
  });

  it("rejects domain characters that suggest path or authority confusion", () => {
    expect(normalizeExternalMailtoUrl("mailto:a@b.example/path")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto://a@b.example")).toBeNull();
    expect(normalizeExternalMailtoUrl("mailto:a@b.example:8080")).toBeNull();
  });
});
