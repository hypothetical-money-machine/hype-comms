import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiClient } from "../src/client.js";
import { CliError, EXIT_API, EXIT_CONTRACT, EXIT_TRANSIENT } from "../src/errors.js";
import { jsonResponse } from "./helpers.js";

function client(fetch: typeof globalThis.fetch): ApiClient {
  return new ApiClient({
    profile: {
      name: "test",
      apiOrigin: "https://chat.example.test",
      credential: { kind: "agent", token: `hmm_agent_${"a".repeat(43)}` },
      credentialOrigin: "https://chat.example.test",
      credentialFromEnvironment: true,
      configDirectory: "/unused",
    },
    fetch,
    timeoutMs: 1_000,
  });
}

describe("ApiClient", () => {
  it("sends bearer auth and preserves an idempotency key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer hmm_agent_${"a".repeat(43)}`);
      expect(headers.get("idempotency-key")).toBe("message-id");
      expect(init?.redirect).toBe("manual");
      return jsonResponse({ ok: true });
    });
    const response = await client(fetch).request({
      method: "POST",
      path: "/v1/example",
      body: { value: "hello" },
      requestSchema: z.object({ value: z.string() }).strict(),
      responseSchema: z.object({ ok: z.literal(true) }).strict(),
      headers: { "idempotency-key": "message-id" },
    });
    expect(response).toEqual({ ok: true });
  });

  it("rejects a credential bound to another origin before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const value = new ApiClient({
      profile: {
        name: "test",
        apiOrigin: "https://override.example.test",
        credential: { kind: "human", sessionToken: "s".repeat(43) },
        credentialOrigin: "https://stored.example.test",
        credentialFromEnvironment: false,
        configDirectory: "/unused",
      },
      fetch,
      timeoutMs: 1_000,
    });

    await expect(
      value.request({ path: "/v1/auth/me", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "CREDENTIAL_ORIGIN_MISMATCH",
    });
    await expect(
      value.requestEmpty({ method: "DELETE", path: "/v1/auth/session" }),
    ).rejects.toMatchObject({
      exitCode: 2,
      code: "CREDENTIAL_ORIGIN_MISMATCH",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("permits unauthenticated requests when a saved credential belongs to another origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return jsonResponse({ status: "ok" });
    });
    const value = new ApiClient({
      profile: {
        name: "test",
        apiOrigin: "https://override.example.test",
        credential: { kind: "human", sessionToken: "s".repeat(43) },
        credentialOrigin: "https://stored.example.test",
        credentialFromEnvironment: false,
        configDirectory: "/unused",
      },
      fetch,
      timeoutMs: 1_000,
    });

    await expect(
      value.request({
        path: "/livez",
        responseSchema: z.object({ status: z.literal("ok") }).strict(),
        includeCredential: false,
      }),
    ).resolves.toEqual({ status: "ok" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects redirects without following them", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
    );
    await expect(
      client(fetch).request({ path: "/v1/example", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CONTRACT,
      code: "REDIRECT_REJECTED",
    });
  });

  it("classifies permanent and transient API errors", async () => {
    const envelope = (code: "NOT_FOUND" | "RATE_LIMITED") => ({
      error: { code, message: "Rejected", requestId: "request-1" },
    });
    const permanent = client(
      vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(envelope("NOT_FOUND"), { status: 404 }),
      ),
    );
    const transient = client(
      vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(envelope("RATE_LIMITED"), {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      ),
    );

    await expect(
      permanent.request({ path: "/missing", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      exitCode: EXIT_API,
      retryable: false,
    });
    await expect(
      transient.request({ path: "/busy", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      exitCode: EXIT_TRANSIENT,
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it("classifies a non-JSON gateway error by status instead of as a contract failure", async () => {
    // An intermediary can answer with HTML. The retry loops key off `retryable`, so a 502 has to
    // stay transient rather than being downgraded because the body was not our error envelope.
    const value = client(
      vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(
      value.request({ path: "/v1/example", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      exitCode: EXIT_TRANSIENT,
      code: "UNEXPECTED_SERVER_RESPONSE",
      httpStatus: 502,
      retryable: true,
    });
  });

  it("treats a successful but invalid response as a contract failure", async () => {
    const value = client(vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: false })));
    await expect(
      value.request({
        path: "/v1/example",
        responseSchema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      value.request({
        path: "/v1/example",
        responseSchema: z.object({ ok: z.literal(true) }).strict(),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CONTRACT });
  });
});
