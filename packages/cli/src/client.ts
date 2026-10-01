import {
  ApiClientError,
  AttachmentClient,
  HttpClient,
  JSON_RESPONSE_MAX_BYTES,
  WorkspaceProtocolError,
  type ApiRequestOptions as SharedRequestOptions,
  type ApiResult,
  type DownloadRequestOptions,
  type DownloadResult,
  type EmptyApiRequestOptions,
} from "@hype-comms/api-client";
import type { ResolvedProfile } from "./config.js";
import {
  apiResponseError,
  CliError,
  EXIT_CONTRACT,
  EXIT_USAGE,
  networkError,
  UsageError,
} from "./errors.js";

export type { ApiResult, DownloadRequestOptions, DownloadResult, EmptyApiRequestOptions };
export const RESPONSE_BODY_MAX_BYTES = JSON_RESPONSE_MAX_BYTES;
export interface ApiRequestOptions<TRequest, TResponse> extends SharedRequestOptions<
  TRequest,
  TResponse
> {
  readonly clientMessageId?: string;
}
export interface ApiClientOptions {
  readonly profile: ResolvedProfile;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

export function clientError(error: unknown, clientMessageId?: string): Error {
  if (error instanceof WorkspaceProtocolError)
    return new CliError({
      exitCode: EXIT_CONTRACT,
      code: "UPGRADE_REQUIRED",
      message: error.message,
      ...(error.response === undefined ? {} : { httpStatus: error.response.status }),
      retryable: false,
    });
  if (!(error instanceof ApiClientError))
    return error instanceof Error ? error : new Error("The API request failed", { cause: error });
  if (error.kind === "network") return networkError(error.cause, clientMessageId);
  if (error.kind === "http" && error.response !== undefined)
    return apiResponseError(error.response, error.body, clientMessageId);
  const requestId = error.response?.headers.get("x-request-id");
  return new CliError({
    exitCode: error.kind === "request" ? EXIT_USAGE : EXIT_CONTRACT,
    code:
      error.kind === "request"
        ? "INVALID_REQUEST"
        : error.kind === "redirect"
          ? "REDIRECT_REJECTED"
          : "INVALID_SERVER_CONTRACT",
    message: error.message,
    retryable: false,
    ...(error.response === undefined ? {} : { httpStatus: error.response.status }),
    ...(requestId == null ? {} : { requestId }),
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
    cause: error,
  });
}

/** CLI policy: choose credentials and translate shared failures to stable process errors. */
export class ApiClient {
  readonly #http: HttpClient;
  readonly #attachments: AttachmentClient;
  constructor(options: ApiClientOptions) {
    const { profile } = options;
    this.#http = new HttpClient({
      origin: profile.apiOrigin,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      credentialHeaders: () => {
        if (profile.credential === undefined) return {};
        if (profile.credentialOrigin !== profile.apiOrigin)
          throw new UsageError(
            "The saved credential belongs to a different API origin; select its profile or provide HYPE_COMMS_TOKEN",
            "CREDENTIAL_ORIGIN_MISMATCH",
          );
        return profile.credential.kind === "human"
          ? { cookie: `hype_comms_session=${profile.credential.sessionToken}` }
          : { authorization: `Bearer ${profile.credential.token}` };
      },
    });
    this.#attachments = new AttachmentClient(this.#http);
  }
  async request<TRequest = never, TResponse = unknown>(
    options: ApiRequestOptions<TRequest, TResponse>,
  ): Promise<TResponse> {
    return (await this.requestWithResponse(options)).data;
  }
  async requestWithResponse<TRequest = never, TResponse = unknown>(
    options: ApiRequestOptions<TRequest, TResponse>,
  ): Promise<ApiResult<TResponse>> {
    try {
      return await this.#http.requestWithResponse(options);
    } catch (error) {
      throw clientError(error, options.clientMessageId);
    }
  }
  async requestEmpty<TRequest = never>(
    options: EmptyApiRequestOptions<TRequest>,
  ): Promise<Response> {
    try {
      return await this.#http.requestEmpty(options);
    } catch (error) {
      throw clientError(error);
    }
  }
  async download(options: DownloadRequestOptions): Promise<DownloadResult> {
    try {
      return await this.#attachments.download(options);
    } catch (error) {
      throw clientError(error);
    }
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
