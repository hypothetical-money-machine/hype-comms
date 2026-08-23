import { createServer, type Server } from "node:http";
import { constants, createGzip, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiClient, RESPONSE_BODY_MAX_BYTES } from "../src/client.js";
import { CliError, EXIT_API, EXIT_CONTRACT, EXIT_TRANSIENT } from "../src/errors.js";
import { jsonResponse } from "./helpers.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

function client(
  fetch: typeof globalThis.fetch,
  apiOrigin = "https://chat.example.test",
): ApiClient {
  return new ApiClient({
    profile: {
      name: "test",
      apiOrigin,
      credential: { kind: "agent", token: `hype_comms_agent_${"a".repeat(43)}` },
      credentialOrigin: apiOrigin,
      credentialFromEnvironment: true,
      configDirectory: "/unused",
    },
    fetch,
    timeoutMs: 1_000,
  });
}

function jsonBodyOfByteLength(length: number): string {
  const prefix = '{"payload":"';
  const suffix = '"}';
  return `${prefix}${"a".repeat(length - prefix.length - suffix.length)}${suffix}`;
}

function streamedResponse(
  body: string,
  splitAt: number,
): {
  readonly response: Response;
  readonly wasCancelled: () => boolean;
} {
  const bytes = new TextEncoder().encode(body);
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === 0) {
        index += 1;
        controller.enqueue(bytes.subarray(0, splitAt));
      } else if (index === 1) {
        index += 1;
        controller.enqueue(bytes.subarray(splitAt));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { headers: { "content-type": "application/json" } }),
    wasCancelled: () => cancelled,
  };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

describe("ApiClient", () => {
  it("sends bearer auth and preserves an idempotency key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer hype_comms_agent_${"a".repeat(43)}`);
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

  it("accepts a response exactly at the byte limit", async () => {
    const value = client(
      vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(JSON.parse(jsonBodyOfByteLength(RESPONSE_BODY_MAX_BYTES)) as unknown),
      ),
    );

    await expect(
      value.request({
        path: "/v1/example",
        responseSchema: z.object({ payload: z.string() }).strict(),
      }),
    ).resolves.toMatchObject({ payload: expect.any(String) });
  });

  it("cancels an uncompressed response one byte over the limit", async () => {
    const oversized = streamedResponse(
      jsonBodyOfByteLength(RESPONSE_BODY_MAX_BYTES + 1),
      RESPONSE_BODY_MAX_BYTES,
    );
    const value = client(vi.fn<typeof globalThis.fetch>(async () => oversized.response));

    await expect(
      value.request({ path: "/v1/example", responseSchema: z.object({ payload: z.string() }) }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CONTRACT,
      code: "INVALID_SERVER_CONTRACT",
      retryable: false,
    });
    expect(oversized.wasCancelled()).toBe(true);
  });

  it("cancels an unfinished compressed success response after the decoded size limit", async () => {
    const chunk = Buffer.alloc(64 * 1_024, "a");
    const chunksToExceedLimit = RESPONSE_BODY_MAX_BYTES / chunk.byteLength;
    let responseClosed: (() => void) | undefined;
    let responseClosedBeforeEnd = false;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-type": "application/json",
      });
      const gzip = createGzip();
      gzip.pipe(response);
      response.once("close", () => {
        responseClosedBeforeEnd = !response.writableEnded;
        gzip.destroy();
        responseClosed?.();
      });
      let chunksWritten = 0;
      const writeChunk = (): void => {
        if (chunksWritten >= chunksToExceedLimit) return;
        chunksWritten += 1;
        gzip.write(chunk, () => {
          gzip.flush(constants.Z_SYNC_FLUSH, () => setTimeout(writeChunk, 1));
        });
      };
      gzip.write('{"payload":"', () => {
        gzip.flush(constants.Z_SYNC_FLUSH, () => setTimeout(writeChunk, 1));
      });
    });
    const origin = await listen(server);

    await expect(
      client(globalThis.fetch, origin).request({
        path: "/success",
        responseSchema: z.object({ payload: z.string() }).strict(),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CONTRACT, retryable: false });
    await closed;
    // The prefix plus exactly RESPONSE_BODY_MAX_BYTES of payload crosses the limit. The producer
    // deliberately leaves the response unfinished after that point, so only reader cancellation
    // can close it. A fixed producer-side chunk margin would be scheduler and transport dependent.
    expect(responseClosedBeforeEnd).toBe(true);
  });

  it("treats an oversized compressed error response as a non-retryable contract error", async () => {
    const server = createServer((_request, response) => {
      const body = jsonBodyOfByteLength(RESPONSE_BODY_MAX_BYTES + 1);
      response.writeHead(503, {
        "content-encoding": "gzip",
        "content-type": "application/json",
      });
      response.end(gzipSync(body));
    });
    const origin = await listen(server);

    await expect(
      client(globalThis.fetch, origin).request({ path: "/error", responseSchema: z.unknown() }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CONTRACT,
      code: "INVALID_SERVER_CONTRACT",
      retryable: false,
    });
  });
});
