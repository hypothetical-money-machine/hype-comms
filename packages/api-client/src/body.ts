import { ApiClientError, cancelResponse } from "./errors.js";
import { JSON_RESPONSE_MAX_BYTES } from "./limits.js";

export class ResponseTooLargeError extends ApiClientError {
  constructor(response: Response) {
    super("contract", "The server response was too large", response);
  }
}

export async function readResponseBytes(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    abort = () => {
      reject(signal.reason);
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(response);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw new ApiClientError("network", "Could not read the server response", response, undefined, {
      cause: error,
    });
  } finally {
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonResponse(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await cancelResponse(response);
    throw new ApiClientError("contract", "The server response was not JSON", response);
  }
  const bytes = await readResponseBytes(response, JSON_RESPONSE_MAX_BYTES, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new ApiClientError(
      "contract",
      "The server returned malformed JSON",
      response,
      undefined,
      { cause: error },
    );
  }
}

export async function readErrorResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await readJsonResponse(response, signal);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw error;
    return undefined;
  }
}
