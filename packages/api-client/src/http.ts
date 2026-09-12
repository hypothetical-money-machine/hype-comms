import type { z } from "zod";
import {
  ApiClientError,
  WorkspaceProtocolError,
  cancelResponse,
  requireWorkspaceProtocol,
} from "./errors.js";
import { readErrorResponse, readJsonResponse } from "./body.js";
import { JSON_RESPONSE_MAX_BYTES } from "./limits.js";

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
  readonly signal?: AbortSignal;
  readonly retry?: "idempotent_once";
}

export interface EmptyApiRequestOptions<TRequest> extends Omit<
  ApiRequestOptions<TRequest, never>,
  "responseSchema"
> {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
}

export interface ApiResult<T> {
  readonly data: T;
  readonly response: Response;
}

export interface HttpClientOptions {
  readonly origin: string;
  readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
  readonly credentialHeaders?: () =>
    Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  readonly timeoutMs: number;
}

export interface RawRequestOptions {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly includeCredential?: boolean;
  readonly body?: BodyInit;
  readonly signal?: AbortSignal;
  readonly acceptedStatuses?: readonly number[];
}

/** One authenticated request pipeline for JSON, empty responses, and bounded file transfers. */
export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {
    const origin = new URL(options.origin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.origin !== options.origin
    ) {
      throw new Error("The API origin must contain only an HTTP(S) origin");
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
      throw new Error("A positive request timeout is required");
  }

  async request<TRequest = never, TResponse = unknown>(
    options: ApiRequestOptions<TRequest, TResponse>,
  ): Promise<TResponse> {
    return (await this.requestWithResponse(options)).data;
  }

  async requestWithResponse<TRequest = never, TResponse = unknown>(
    options: ApiRequestOptions<TRequest, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    const request = this.#jsonRequest(options);
    if (options.retry !== undefined && !new Headers(options.headers).has("idempotency-key"))
      throw new Error("Mutation retries require an idempotency key");
    let opened: Awaited<ReturnType<HttpClient["open"]>>;
    try {
      opened = await this.open(request);
    } catch (error) {
      if (
        options.retry !== "idempotent_once" ||
        !(error instanceof ApiClientError) ||
        !(
          error.kind === "network" ||
          (error.kind === "http" &&
            error.response !== undefined &&
            (error.response.status >= 500 || [408, 425].includes(error.response.status)))
        )
      )
        throw error;
      opened = await this.open(request);
    }
    const { response, signal } = opened;
    const body = await readJsonResponse(response, signal);
    const parsed = options.responseSchema.safeParse(body);
    if (!parsed.success)
      throw new ApiClientError("contract", "The server returned an invalid response", response);
    return { data: parsed.data, response };
  }

  async requestEmpty<TRequest = never>(
    options: EmptyApiRequestOptions<TRequest>,
  ): Promise<Response> {
    const { response } = await this.open(this.#jsonRequest(options));
    if (response.status !== 204) {
      await cancelResponse(response);
      throw new ApiClientError("contract", "The server returned an unexpected response", response);
    }
    return response;
  }

  #jsonRequest<TRequest>(
    options: Omit<ApiRequestOptions<TRequest, unknown>, "responseSchema">,
  ): RawRequestOptions {
    const { requestSchema, body, ...request } = options;
    let serialized: string | undefined;
    if (body !== undefined) {
      if (requestSchema === undefined)
        throw new Error("A request schema is required when a body is provided");
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiClientError("request", "The client produced an invalid API request");
      serialized = JSON.stringify(parsed.data);
      if (new TextEncoder().encode(serialized).byteLength > JSON_RESPONSE_MAX_BYTES)
        throw new ApiClientError("request", "The API request was too large");
    }
    return {
      ...request,
      headers: {
        accept: "application/json",
        ...(serialized === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(serialized === undefined ? {} : { body: serialized }),
    };
  }

  /** Used by the bounded attachment pipeline; callers must consume or cancel the response. */
  async open(
    options: RawRequestOptions,
  ): Promise<{ readonly response: Response; readonly signal: AbortSignal }> {
    if (
      !options.path.startsWith("/") ||
      options.path.startsWith("//") ||
      options.path.includes("\\")
    )
      throw new Error("API paths must be absolute origin-relative paths");
    const url = new URL(options.path, this.options.origin);
    if (url.origin !== this.options.origin)
      throw new Error("API requests must stay on the configured origin");
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    signal.throwIfAborted();
    const credentials =
      options.includeCredential === false ? {} : await this.options.credentialHeaders?.();
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: options.method ?? "GET",
        headers: { ...credentials, ...options.headers },
        redirect: "manual",
        signal,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (error) {
      if (error instanceof WorkspaceProtocolError || error instanceof ApiClientError) throw error;
      if (
        !(error instanceof TypeError) &&
        !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      )
        throw error;
      throw new ApiClientError("network", "Could not reach the server", undefined, undefined, {
        cause: error,
      });
    }
    await requireWorkspaceProtocol(response);
    if (response.status >= 300 && response.status < 400) {
      await cancelResponse(response);
      throw new ApiClientError(
        "redirect",
        "The server attempted to redirect the request",
        response,
      );
    }
    if (!(options.acceptedStatuses?.includes(response.status) ?? response.ok)) {
      throw new ApiClientError(
        "http",
        `API request failed (${response.status})`,
        response,
        await readErrorResponse(response, signal),
      );
    }
    return { response, signal };
  }
}
