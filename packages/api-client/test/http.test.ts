import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HttpClient,
  AttachmentClient,
  ApiClientError,
  JSON_RESPONSE_MAX_BYTES,
} from "../src/index.js";

function response(body: BodyInit | null, headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: { "x-hype-comms-protocol": "2", "content-type": "application/json", ...headers },
  });
}
const request = { path: "/v2/example", responseSchema: z.object({ ok: z.boolean() }).strict() };
function client(fetch: (url: URL, init: RequestInit) => Promise<Response>): HttpClient {
  return new HttpClient({
    origin: "https://chat.example",
    fetch,
    timeoutMs: 10_000,
    credentialHeaders: () => ({ authorization: "Bearer test" }),
  });
}

describe("shared request boundaries", () => {
  it("rejects foreign paths before fetching credentials or sending a request", async () => {
    const fetch = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(async () =>
      response("{}"),
    );
    for (const path of ["//other.example/path", "/\\other.example/path", "https://other.example"]) {
      await expect(client(fetch).request({ ...request, path })).rejects.toThrow("origin-relative");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a non-JSON success and reports a typed contract failure", async () => {
    const body = response("not json", { "content-type": "text/plain" });
    const cancel = vi.spyOn(body.body!, "cancel");
    await expect(client(async () => body).request(request)).rejects.toMatchObject({
      kind: "contract",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an oversized JSON stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(JSON_RESPONSE_MAX_BYTES + 1));
      },
      cancel,
    });
    await expect(client(async () => response(stream)).request(request)).rejects.toMatchObject({
      kind: "contract",
      message: "The server response was too large",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels pending response-body reads when the caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = response(new ReadableStream<Uint8Array>({ cancel }));
    const read = vi.spyOn(body.body!, "getReader");
    const result = client(async () => body).request({ ...request, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({
      kind: "network",
      cause: { name: "AbortError" },
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retries only opted-in mutations with their original idempotency key", async () => {
    const fetch = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(async () =>
      response('{"ok":true}'),
    );
    fetch.mockRejectedValueOnce(new TypeError("Connection lost"));
    const input = {
      ...request,
      method: "POST" as const,
      retry: "idempotent_once" as const,
      headers: { "idempotency-key": "original-key" },
    };
    await expect(client(fetch).request(input)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        ([, init]) => new Headers(init.headers).get("idempotency-key") === "original-key",
      ),
    ).toBe(true);
    await expect(client(fetch).request({ ...input, headers: {} })).rejects.toThrow(
      "idempotency key",
    );
    fetch.mockRejectedValueOnce(new ApiClientError("contract", "Invalid payload"));
    await expect(client(fetch).request(input)).rejects.toMatchObject({ kind: "contract" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("verifies attachment length and digest before returning bytes", async () => {
    const bytes = new TextEncoder().encode("attachment");
    const metadata = {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "x-content-sha256": "0".repeat(64),
    };
    const files = new AttachmentClient(client(async () => response(bytes, metadata)));
    await expect(
      files.download({ path: "/v2/files/test/content", maxBytes: 1024 }),
    ).rejects.toMatchObject({
      kind: "contract",
      message: "The attachment response digest did not match its metadata",
    });
  });
});
