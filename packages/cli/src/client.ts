import type { z } from "zod";

import type { ResolvedProfile, StoredCredential } from "./config.js";
import {
  CliError,
  EXIT_CONTRACT,
  UsageError,
  apiResponseError,
  contractError,
  networkError,
} from "./errors.js";

export interface ApiRequestOptions<TRequest, TResponse> {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly requestSchema?: z.ZodType<TRequest>;
  readonly body?: TRequest;
  readonly responseSchema: z.ZodType<TResponse>;
  readonly acceptedStatuses?: readonly number[];
  readonly includeCredential?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly clientMessageId?: string;
}

export interface ApiResult<T> {
  readonly data: T;
  readonly response: Response;
}

export interface ApiClientOptions {
  readonly profile: ResolvedProfile;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

export const RESPONSE_BODY_MAX_BYTES = 4 * 1_024 * 1_024;

const RESPONSE_TOO_LARGE_MESSAGE = "The server response was too large";

class ResponseTooLargeError extends CliError {
  constructor() {
    super({
      exitCode: EXIT_CONTRACT,
      code: "INVALID_SERVER_CONTRACT",
      message: RESPONSE_TOO_LARGE_MESSAGE,
      retryable: false,
    });
  }
}

export interface EmptyApiRequestOptions<TRequest> {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly requestSchema?: z.ZodType<TRequest>;
  readonly body?: TRequest;
  readonly includeCredential?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly acceptedStatuses?: readonly number[];
}

function authorizationHeaders(credential: StoredCredential | undefined): Record<string, string> {
  if (credential === undefined) return {};
  if (credential.kind === "human") {
    return { cookie: `hype_comms_session=${credential.sessionToken}` };
  }
  return { authorization: `Bearer ${credential.token}` };
}

function responseAccepted(
  response: Response,
  acceptedStatuses: readonly number[] | undefined,
): boolean {
  return acceptedStatuses?.includes(response.status) ?? response.ok;
}

async function parseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().includes("application/json")) {
    throw contractError("The server response was not JSON");
  }
  let text: string;
  try {
    text = await readResponseText(response);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw networkError(error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError({
      exitCode: EXIT_CONTRACT,
      code: "INVALID_SERVER_CONTRACT",
      message: "The server returned malformed JSON",
      retryable: false,
      cause: error,
    });
  }
}

/**
 * Read an error response body without letting a non-JSON payload mask the HTTP status.
 * `apiResponseError` classifies by status when the body is not a recognizable envelope.
 */
async function parseErrorBody(response: Response): Promise<unknown> {
  try {
    return await parseJson(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw error;
    return undefined;
  }
}

async function readResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > RESPONSE_BODY_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already over the limit; a cancellation failure must not mask that
          // non-retryable contract error.
        }
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class ApiClient {
  readonly #origin: string;
  readonly #credential: StoredCredential | undefined;
  readonly #credentialOrigin: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.#origin = options.profile.apiOrigin;
    this.#credential = options.profile.credential;
    this.#credentialOrigin = options.profile.credentialOrigin;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  #authorizationHeaders(includeCredential: boolean | undefined): Record<string, string> {
    if (includeCredential === false || this.#credential === undefined) return {};
    if (this.#credentialOrigin !== this.#origin) {
      throw new UsageError(
        "The saved credential belongs to a different API origin; select its profile or provide HYPE_COMMS_TOKEN",
        "CREDENTIAL_ORIGIN_MISMATCH",
      );
    }
    return authorizationHeaders(this.#credential);
  }

  async request<TRequest = never, TResponse = unknown>(
    options: ApiRequestOptions<TRequest, TResponse>,
  ): Promise<TResponse> {
    return (await this.requestWithResponse(options)).data;
  }

  async requestWithResponse<TRequest = never, TResponse = unknown>(
    options: ApiRequestOptions<TRequest, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    if (!options.path.startsWith("/") || options.path.startsWith("//")) {
      throw new Error("API paths must be absolute origin-relative paths");
    }
    const url = new URL(options.path, this.#origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let serializedBody: string | undefined;
    if (options.body !== undefined) {
      if (options.requestSchema === undefined) {
        throw new Error("A request schema is required when a body is provided");
      }
      const parsed = options.requestSchema.safeParse(options.body);
      if (!parsed.success) {
        throw new CliError({
          exitCode: 2,
          code: "INVALID_REQUEST",
          message: "The command produced an invalid API request",
          retryable: false,
        });
      }
      serializedBody = JSON.stringify(parsed.data);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...(serializedBody === undefined ? {} : { "content-type": "application/json" }),
      ...this.#authorizationHeaders(options.includeCredential),
      ...options.headers,
    };
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method ?? "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      });
    } catch (error) {
      throw networkError(error, options.clientMessageId);
    }

    if (response.status >= 300 && response.status < 400) {
      const requestId = response.headers.get("x-request-id");
      throw new CliError({
        exitCode: EXIT_CONTRACT,
        code: "REDIRECT_REJECTED",
        message: "The server attempted to redirect the request",
        httpStatus: response.status,
        ...(requestId === null ? {} : { requestId }),
        retryable: false,
        ...(options.clientMessageId === undefined
          ? {}
          : { clientMessageId: options.clientMessageId }),
      });
    }

    if (!responseAccepted(response, options.acceptedStatuses)) {
      throw apiResponseError(response, await parseErrorBody(response), options.clientMessageId);
    }
    const body = await parseJson(response);
    const parsed = options.responseSchema.safeParse(body);
    if (!parsed.success) {
      const requestId = response.headers.get("x-request-id");
      throw new CliError({
        exitCode: EXIT_CONTRACT,
        code: "INVALID_SERVER_CONTRACT",
        message: "The server returned an invalid response",
        httpStatus: response.status,
        ...(requestId === null ? {} : { requestId }),
        retryable: false,
        ...(options.clientMessageId === undefined
          ? {}
          : { clientMessageId: options.clientMessageId }),
      });
    }
    return { data: parsed.data, response };
  }

  async requestEmpty<TRequest = never>(
    options: EmptyApiRequestOptions<TRequest>,
  ): Promise<Response> {
    if (!options.path.startsWith("/") || options.path.startsWith("//")) {
      throw new Error("API paths must be absolute origin-relative paths");
    }
    let serializedBody: string | undefined;
    if (options.body !== undefined) {
      if (options.requestSchema === undefined) {
        throw new Error("A request schema is required when a body is provided");
      }
      const parsed = options.requestSchema.safeParse(options.body);
      if (!parsed.success) {
        throw new CliError({
          exitCode: 2,
          code: "INVALID_REQUEST",
          message: "The command produced an invalid API request",
          retryable: false,
        });
      }
      serializedBody = JSON.stringify(parsed.data);
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(serializedBody === undefined ? {} : { "content-type": "application/json" }),
      ...this.#authorizationHeaders(options.includeCredential),
      ...options.headers,
    };
    let response: Response;
    try {
      response = await this.#fetch(new URL(options.path, this.#origin), {
        method: options.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      });
    } catch (error) {
      throw networkError(error);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CliError({
        exitCode: EXIT_CONTRACT,
        code: "REDIRECT_REJECTED",
        message: "The server attempted to redirect the request",
        httpStatus: response.status,
        retryable: false,
      });
    }
    if (!(options.acceptedStatuses?.includes(response.status) ?? response.ok)) {
      throw apiResponseError(response, await parseErrorBody(response));
    }
    if (response.status !== 204) {
      throw contractError("The server returned an unexpected response");
    }
    return response;
  }
}

export function sessionTokenFromHeaders(headers: Headers): string | undefined {
  const values =
    "getSetCookie" in headers && typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter((value): value is string => value !== null);
  for (const value of values) {
    const match = /(?:^|,\s*)hype_comms_session=([^;,\s]*)/u.exec(value);
    if (match?.[1] !== undefined && match[1] !== "") return match[1];
  }
  return undefined;
}
