import { apiErrorEnvelopeSchema, type ApiErrorCode } from "@hype-comms/contracts";

export const EXIT_SUCCESS = 0;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_API = 4;
export const EXIT_TRANSIENT = 5;
export const EXIT_CONTRACT = 6;

/**
 * Retry-After is capped at the watch command's existing maximum backoff (including jitter).
 * This keeps server-provided delays useful without allowing a server to park the CLI or exceed
 * Node's reliable timer range.
 */
export const MAX_RETRY_AFTER_MS = 12_500;

export type CliExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_USAGE
  | typeof EXIT_AUTH
  | typeof EXIT_API
  | typeof EXIT_TRANSIENT
  | typeof EXIT_CONTRACT;

export interface CliErrorOptions {
  readonly exitCode: Exclude<CliExitCode, 0>;
  readonly code: string;
  readonly message: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly clientMessageId?: string;
  readonly cause?: unknown;
}

const AGENT_TOKEN_PATTERN = /hype_comms_agent_[A-Za-z0-9_-]+/gu;
const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/)[^/\s@]+@/giu;
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/gu;
const LONG_CREDENTIAL_PATTERN = /\b[A-Za-z0-9_-]{43,86}\b/gu;

export function safeMessage(message: string): string {
  const cleaned = message
    .replace(AGENT_TOKEN_PATTERN, "[credential]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[credential]@")
    .replace(ABSOLUTE_PATH_PATTERN, " [path]")
    .replace(LONG_CREDENTIAL_PATTERN, "[credential]")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim();
  return cleaned.length === 0 ? "The operation failed" : cleaned.slice(0, 500);
}

export class CliError extends Error {
  readonly exitCode: Exclude<CliExitCode, 0>;
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly clientMessageId: string | undefined;

  constructor(options: CliErrorOptions) {
    super(safeMessage(options.message), { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? options.exitCode === EXIT_TRANSIENT;
    this.retryAfterMs = options.retryAfterMs;
    this.clientMessageId = options.clientMessageId;
  }

  toJSON(): {
    error: {
      code: string;
      message: string;
      httpStatus: number | null;
      requestId: string | null;
      retryable: boolean;
      retryAfterMs: number | null;
      clientMessageId: string | null;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        httpStatus: this.httpStatus ?? null,
        requestId: this.requestId ?? null,
        retryable: this.retryable,
        retryAfterMs: this.retryAfterMs ?? null,
        clientMessageId: this.clientMessageId ?? null,
      },
    };
  }
}

export class UsageError extends CliError {
  constructor(message: string, code = "USAGE") {
    super({ exitCode: EXIT_USAGE, code, message });
    this.name = "UsageError";
  }
}

export function contractError(message = "The server returned an invalid response"): CliError {
  return new CliError({
    exitCode: EXIT_CONTRACT,
    code: "INVALID_SERVER_CONTRACT",
    message,
    retryable: false,
  });
}

function exitCodeForApi(status: number): Exclude<CliExitCode, 0> {
  if (status === 401 || status === 403) return EXIT_AUTH;
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return EXIT_TRANSIENT;
  }
  return EXIT_API;
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    if (seconds >= MAX_RETRY_AFTER_MS / 1_000) return MAX_RETRY_AFTER_MS;
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now()));
}

export function apiResponseError(
  response: Response,
  body: unknown,
  clientMessageId?: string,
): CliError {
  const parsed = apiErrorEnvelopeSchema.safeParse(body);
  const exitCode = exitCodeForApi(response.status);
  const retryDelay = retryAfterMs(response.headers);
  if (!parsed.success) {
    // An intermediary (proxy, load balancer) can answer with HTML instead of our envelope. The
    // HTTP status still classifies the failure, so a 502 stays retryable rather than being
    // downgraded to a non-retryable contract error the retry loops refuse to handle.
    return new CliError({
      exitCode,
      code: "UNEXPECTED_SERVER_RESPONSE",
      message: "The server returned an unrecognized error response",
      httpStatus: response.status,
      retryable: exitCode === EXIT_TRANSIENT,
      ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
    });
  }
  return new CliError({
    exitCode,
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    httpStatus: response.status,
    requestId: parsed.data.error.requestId,
    retryable: exitCode === EXIT_TRANSIENT,
    ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
  });
}

export function networkError(error: unknown, clientMessageId?: string): CliError {
  const timedOut =
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
  return new CliError({
    exitCode: EXIT_TRANSIENT,
    code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
    message: timedOut ? "The request timed out" : "The server could not be reached",
    retryable: true,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
    cause: error,
  });
}

export function apiCodeIsAuthentication(code: ApiErrorCode): boolean {
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError({
    exitCode: EXIT_TRANSIENT,
    code: "UNEXPECTED_ERROR",
    message: "The operation failed unexpectedly",
    retryable: false,
    cause: error,
  });
}
