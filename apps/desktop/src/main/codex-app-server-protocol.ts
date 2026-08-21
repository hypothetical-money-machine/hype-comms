import { lstatSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import type {
  AiAgentHostEvent,
  AiAgentHostLocation,
  AiAgentHostPermissionRequest,
  AiAgentHostTool,
} from "./ai-agent-host";

/**
 * This projection was checked against `codex app-server generate-ts` from codex-cli 0.147.0.
 * It intentionally contains only the stable Lite methods used by Hype Comms.
 */
export const CODEX_APP_SERVER_SCHEMA_VERSION = "0.147.0";

export const MAX_CODEX_JSONL_LINE_BYTES = 8 * 1_024 * 1_024;
export const MAX_CODEX_QUEUED_INPUT_BYTES = 16 * 1_024 * 1_024;
export const MAX_CODEX_OUTGOING_ENVELOPE_BYTES = 1 * 1_024 * 1_024;
export const MAX_CODEX_PENDING_CLIENT_REQUESTS = 32;
export const MAX_CODEX_PENDING_SERVER_REQUESTS = 16;
export const MAX_CODEX_APPROVAL_QUEUE = 8;
export const MAX_CODEX_JSON_DEPTH = 64;
export const MAX_CODEX_JSON_NODES = 100_000;
export const MAX_CODEX_IDENTIFIER_LENGTH = 1_024;
export const MAX_CODEX_PROJECTED_TEXT_BYTES = 700_000;
export const MAX_CODEX_TOOL_TITLE_BYTES = 512;
export const MAX_CODEX_PERMISSION_PREVIEW_BYTES = 512;
export const MAX_CODEX_PLAN_STEPS = 100;
export const MAX_CODEX_ITEM_LOCATIONS = 100;
export const MAX_CODEX_LOCATION_BYTES = 4_096;
export const MAX_CODEX_COMMAND_TOKENS = 2_048;
export const MAX_CODEX_REQUEST_ARRAY_ITEMS = 256;

const MAX_CACHED_CODEX_WORKSPACE_ROOTS = 32;
const canonicalWorkspaceRoots = new Map<string, string>();

export type CodexRequestId = string | number;

export interface CodexRpcErrorValue {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type CodexJsonRpcMessage =
  | {
      readonly kind: "response";
      readonly id: CodexRequestId;
      readonly result?: unknown;
      readonly error?: CodexRpcErrorValue;
    }
  | {
      readonly kind: "request";
      readonly id: CodexRequestId;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown };

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

interface CorrelatedNotification {
  readonly threadId: string;
  readonly turnId: string;
}

export type CodexNotification =
  | { readonly kind: "thread-started"; readonly threadId: string }
  | ({ readonly kind: "turn-started"; readonly status: CodexTurnStatus } & CorrelatedNotification)
  | ({ readonly kind: "turn-completed"; readonly status: CodexTurnStatus } & CorrelatedNotification)
  | ({
      readonly kind: "agent-message-delta";
      readonly itemId: string;
      readonly delta: string;
    } & CorrelatedNotification)
  | ({
      readonly kind: "reasoning-summary-delta";
      readonly itemId: string;
      readonly delta: string;
      readonly summaryIndex: number;
    } & CorrelatedNotification)
  | ({ readonly kind: "item-started"; readonly item: CodexProjectedItem } & CorrelatedNotification)
  | ({
      readonly kind: "item-completed";
      readonly item: CodexProjectedItem;
    } & CorrelatedNotification)
  | ({
      readonly kind: "plan-updated";
      readonly plan: readonly CodexPlanStep[];
    } & CorrelatedNotification)
  | {
      readonly kind: "server-request-resolved";
      readonly threadId: string;
      /**
       * The app-server's approval callback key. Despite the wire name `requestId`, this is not
       * the JSON-RPC envelope id and must be correlated with `CodexServerRequest.approvalKey`.
       */
      readonly approvalKey: CodexRequestId;
    }
  | ({ readonly kind: "error"; readonly willRetry: boolean } & CorrelatedNotification)
  | { readonly kind: "unknown"; readonly method: string };

export interface CodexPlanStep {
  readonly step: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export type CodexProjectedItem =
  | { readonly type: "ignored"; readonly itemId: string }
  | { readonly type: "agent-message"; readonly itemId: string; readonly text: string }
  | { readonly type: "reasoning"; readonly itemId: string; readonly summary: readonly string[] }
  | {
      readonly type: "tool";
      readonly itemId: string;
      readonly title: string;
      readonly toolKind: "read" | "edit" | "execute" | "search" | "fetch" | "other";
      readonly status: "pending" | "in_progress" | "completed" | "failed" | "declined";
      readonly locations: readonly string[];
    };

export type CodexServerRequest =
  | {
      readonly kind: "command-approval";
      readonly rpcId: CodexRequestId;
      readonly approvalKey: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly command: string | null;
      readonly networkHost: string | null;
      readonly networkProtocol: "http" | "https" | "socks5Tcp" | "socks5Udp" | null;
    }
  | {
      readonly kind: "file-approval";
      readonly rpcId: CodexRequestId;
      readonly approvalKey: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly grantRoot: string | null;
    }
  | {
      readonly kind: "permissions-approval";
      readonly rpcId: CodexRequestId;
      readonly approvalKey: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly requestsNetwork: boolean;
      readonly requestsFileSystem: boolean;
    }
  | {
      readonly kind: "safe-negative";
      readonly rpcId: CodexRequestId;
      readonly method: "mcpServer/elicitation/request" | "item/tool/requestUserInput";
    }
  | { readonly kind: "unsupported"; readonly rpcId: CodexRequestId; readonly method: string }
  | { readonly kind: "unknown"; readonly rpcId: CodexRequestId; readonly method: string };

export type CodexWorkerPermissionDecision = "accept" | "decline" | "cancel";

export class CodexProtocolError extends Error {
  constructor(readonly reason: "invalid-message" | "incompatible-protocol" | "limit-exceeded") {
    super(`Codex app-server protocol failed: ${reason}`);
    this.name = "CodexProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CODEX_IDENTIFIER_LENGTH &&
    !value.includes("\0")
    ? value
    : null;
}

function requestId(value: unknown): CodexRequestId | null {
  if (typeof value === "string") return identifier(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const parsed = record(value);
  if (parsed === null) throw new CodexProtocolError("incompatible-protocol");
  return parsed;
}

function requiredIdentifier(value: unknown): string {
  const parsed = identifier(value);
  if (parsed === null) throw new CodexProtocolError("incompatible-protocol");
  return parsed;
}

function requiredString(value: unknown, maximumBytes = MAX_CODEX_PROJECTED_TEXT_BYTES): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new CodexProtocolError("incompatible-protocol");
  }
  return value;
}

function requiredNullableString(
  value: unknown,
  maximumBytes = MAX_CODEX_PROJECTED_TEXT_BYTES,
): string | null {
  return value === null ? null : requiredString(value, maximumBytes);
}

function optionalNullableString(
  object: Record<string, unknown>,
  key: string,
  maximumBytes = MAX_CODEX_PROJECTED_TEXT_BYTES,
): string | null {
  return Object.hasOwn(object, key) ? requiredNullableString(object[key], maximumBytes) : null;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new CodexProtocolError("incompatible-protocol");
  return value;
}

function requiredTimestamp(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CodexProtocolError("incompatible-protocol");
  }
  return parsed;
}

function requiredNullableFiniteNumber(value: unknown): number | null {
  if (value === null) return null;
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0) throw new CodexProtocolError("incompatible-protocol");
  return parsed;
}

function requiredArray(value: unknown, maximumItems: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new CodexProtocolError("incompatible-protocol");
  }
  return value;
}

function assertKnownKeys(object: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new CodexProtocolError("incompatible-protocol");
  }
}

function assertJsonComplexity(value: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_CODEX_JSON_NODES || current.depth > MAX_CODEX_JSON_DEPTH) {
      throw new CodexProtocolError("limit-exceeded");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const object = record(current.value);
    if (object !== null) {
      for (const child of Object.values(object)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function preflightJsonDepth(source: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (codeUnit === 0x5c) escaped = true;
      else if (codeUnit === 0x22) inString = false;
      continue;
    }
    if (codeUnit === 0x22) {
      inString = true;
    } else if (codeUnit === 0x7b || codeUnit === 0x5b) {
      depth += 1;
      if (depth > MAX_CODEX_JSON_DEPTH) throw new CodexProtocolError("limit-exceeded");
    } else if (codeUnit === 0x7d || codeUnit === 0x5d) {
      depth -= 1;
      if (depth < 0) throw new CodexProtocolError("invalid-message");
    }
  }
  if (inString || depth !== 0) throw new CodexProtocolError("invalid-message");
}

/** Parses one already byte-bounded, strictly decoded JSONL line. */
export function parseCodexJsonRpcLine(source: string): CodexJsonRpcMessage {
  if (source.length === 0 || Buffer.byteLength(source, "utf8") > MAX_CODEX_JSONL_LINE_BYTES) {
    throw new CodexProtocolError("limit-exceeded");
  }
  preflightJsonDepth(source);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CodexProtocolError("invalid-message");
  }
  assertJsonComplexity(value);
  const envelope = record(value);
  if (envelope === null) throw new CodexProtocolError("invalid-message");

  const hasId = Object.hasOwn(envelope, "id");
  const id = requestId(envelope.id);
  const method = typeof envelope.method === "string" ? envelope.method : null;
  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (method !== null) {
    if (method.length === 0 || method.length > 256 || hasResult || hasError) {
      throw new CodexProtocolError("invalid-message");
    }
    assertKnownKeys(envelope, ["id", "method", "params"]);
    if (!Object.hasOwn(envelope, "params")) throw new CodexProtocolError("invalid-message");
    if (hasId) {
      if (id === null) throw new CodexProtocolError("invalid-message");
      return { kind: "request", id, method, params: envelope.params };
    }
    return { kind: "notification", method, params: envelope.params };
  }

  if (id === null || hasResult === hasError) throw new CodexProtocolError("invalid-message");
  assertKnownKeys(envelope, hasError ? ["id", "error"] : ["id", "result"]);
  if (hasError) {
    const error = record(envelope.error);
    const code = finiteNumber(error?.code);
    if (
      error === null ||
      code === null ||
      !Number.isSafeInteger(code) ||
      typeof error.message !== "string"
    ) {
      throw new CodexProtocolError("invalid-message");
    }
    assertKnownKeys(error, ["code", "message", "data"]);
    return {
      kind: "response",
      id,
      error: {
        code,
        message: requiredString(error.message, 16_384),
        ...(Object.hasOwn(error, "data") ? { data: error.data } : {}),
      },
    };
  }
  return { kind: "response", id, result: envelope.result };
}

function encodeEnvelope(value: unknown): Buffer {
  let encoded: Buffer;
  try {
    encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  } catch {
    throw new CodexProtocolError("invalid-message");
  }
  if (encoded.byteLength > MAX_CODEX_OUTGOING_ENVELOPE_BYTES) {
    throw new CodexProtocolError("limit-exceeded");
  }
  return encoded;
}

export function encodeCodexClientRequest(
  id: number,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Buffer {
  if (!Number.isSafeInteger(id) || id < 0 || method.length === 0 || method.length > 256) {
    throw new CodexProtocolError("invalid-message");
  }
  return encodeEnvelope({ method, id, params });
}

export function encodeCodexClientNotification(
  method: string,
  params?: Readonly<Record<string, unknown>>,
): Buffer {
  if (method.length === 0 || method.length > 256) {
    throw new CodexProtocolError("invalid-message");
  }
  return encodeEnvelope(params === undefined ? { method } : { method, params });
}

export function encodeCodexServerResult(id: CodexRequestId, result: unknown): Buffer {
  if (requestId(id) === null) throw new CodexProtocolError("invalid-message");
  return encodeEnvelope({ id, result });
}

export function encodeCodexServerError(
  id: CodexRequestId,
  code: -32601 | -32602,
  message: "Method not supported" | "Invalid params",
): Buffer {
  if (requestId(id) === null) throw new CodexProtocolError("invalid-message");
  return encodeEnvelope({ id, error: { code, message } });
}

export function parseCodexCliVersion(value: string): string | null {
  if (Buffer.byteLength(value, "utf8") > 4_096) return null;
  const match = /^codex-cli (\d+\.\d+\.\d+)(?:\r?\n)?$/u.exec(value);
  return match?.[1] ?? null;
}

export function isSupportedCodexCliVersion(version: string): boolean {
  return version === CODEX_APP_SERVER_SCHEMA_VERSION;
}

export function isMissingCodexThreadError(error: CodexRpcErrorValue): boolean {
  const message = error.message.trim().toLowerCase();
  return (
    /^(?:thread|conversation) (?:[^\s]+ )?(?:was )?not found\.?$/u.test(message) ||
    /^thread (?:[^\s]+ )?does not exist\.?$/u.test(message) ||
    /^no rollout found for thread(?: id)?(?: [^\s]+)?\.?$/u.test(message)
  );
}

function turnStatus(value: unknown): CodexTurnStatus {
  if (
    value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "inProgress"
  ) {
    return value;
  }
  throw new CodexProtocolError("incompatible-protocol");
}

function correlatedParams(value: unknown): CorrelatedNotification & Record<string, unknown> {
  const params = requiredRecord(value);
  return {
    ...params,
    threadId: requiredIdentifier(params.threadId),
    turnId: requiredIdentifier(params.turnId),
  };
}

function itemStatus(
  value: unknown,
): "pending" | "in_progress" | "completed" | "failed" | "declined" {
  switch (value) {
    case "inProgress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      throw new CodexProtocolError("incompatible-protocol");
  }
}

function sanitizeUnicode(value: string): string {
  let pieces: string[] | null = null;
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!isUnsafeUnicodeCodeUnit(value.charCodeAt(index))) continue;
    pieces ??= [];
    if (segmentStart < index) pieces.push(value.slice(segmentStart, index));
    pieces.push(" ");
    segmentStart = index + 1;
  }
  if (pieces === null) return value;
  if (segmentStart < value.length) pieces.push(value.slice(segmentStart));
  return pieces.join("");
}

function isUnsafeUnicodeCodeUnit(codeUnit: number): boolean {
  return (
    codeUnit <= 0x1f ||
    (codeUnit >= 0x7f && codeUnit <= 0x9f) ||
    (codeUnit >= 0x200b && codeUnit <= 0x200f) ||
    (codeUnit >= 0x202a && codeUnit <= 0x202e) ||
    (codeUnit >= 0x2060 && codeUnit <= 0x206f) ||
    codeUnit === 0xfeff
  );
}

export function truncateCodexUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return value;
  return encoded
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function redactedAbsolutePaths(value: string): string {
  return value
    .replace(/(?:^|\s)(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`]+[\\/]?)+/gu, " <path>")
    .replace(/file:\/\/[^\s"'`]+/giu, "<path>");
}

function tokenizeCodexCommand(value: string): readonly string[] | null {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const finishToken = (): boolean => {
    if (!tokenStarted) return true;
    if (Buffer.byteLength(token, "utf8") > MAX_CODEX_PROJECTED_TEXT_BYTES) return false;
    tokens.push(token);
    token = "";
    tokenStarted = false;
    return tokens.length <= MAX_CODEX_COMMAND_TOKENS;
  };

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const character = isUnsafeUnicodeCodeUnit(codeUnit) ? " " : value.charAt(index);
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      tokenStarted = true;
      quote = character;
    } else if (character === "\\") {
      tokenStarted = true;
      escaped = true;
    } else if (/\s/u.test(character)) {
      if (!finishToken()) return null;
    } else {
      tokenStarted = true;
      token += character;
    }
  }
  if (quote !== null || escaped || !finishToken()) return null;
  return tokens;
}

function sensitiveCredentialName(value: string): boolean {
  const normalized = value
    .replace(/^-+/u, "")
    .replace(/[^a-z0-9]+/giu, "_")
    .toLowerCase();
  return (
    /(?:^|_)(?:api_?key|token|password|passwd|secret|credential|authorization|cookie)(?:_|$)/u.test(
      normalized,
    ) || /(?:^|_)(?:client_secret|private_key|access_key|auth)(?:_|$)/u.test(normalized)
  );
}

function sanitizeUrlToken(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === "file:") return "<path>";
  const authority = parsed.host.length > 0 ? parsed.host : "<redacted>";
  const credentials = parsed.username.length > 0 || parsed.password.length > 0;
  const userInfo = credentials ? "<redacted>@" : "";
  const pathSuffix = parsed.pathname === "" || parsed.pathname === "/" ? "" : "/<path>";
  const querySuffix = parsed.search.length > 0 ? "?<redacted>" : "";
  return `${parsed.protocol}//${userInfo}${authority}${pathSuffix}${querySuffix}`;
}

function sanitizeOrdinaryCommandToken(value: string): string | null {
  const url = sanitizeUrlToken(value);
  if (url === null || url !== value) return url;

  const assignment = /^([^=]+)=(.*)$/su.exec(value);
  if (assignment !== null) {
    const [, name, assignedValue] = assignment;
    if (name === undefined || assignedValue === undefined) return null;
    if (sensitiveCredentialName(name)) return `${name}=<redacted>`;
    if (path.isAbsolute(assignedValue) || path.win32.isAbsolute(assignedValue)) {
      return `${name}=<path>`;
    }
    const assignedUrl = sanitizeUrlToken(assignedValue);
    if (assignedUrl === null) return null;
    return `${name}=${assignedUrl}`;
  }

  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return "<path>";
  return value;
}

function isAuthorizationHeader(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator < 0) return false;
  return sensitiveCredentialName(value.slice(0, separator));
}

function headerContinuationCount(
  tokens: readonly string[],
  header: string,
  followingIndex: number,
): number {
  const separator = header.indexOf(":");
  const remainder =
    separator < 0
      ? ""
      : header
          .slice(separator + 1)
          .trim()
          .toLowerCase();
  if (remainder === "" && tokens[followingIndex] !== undefined) {
    const first = tokens[followingIndex]?.toLowerCase();
    return (first === "bearer" || first === "basic") && tokens[followingIndex + 1] !== undefined
      ? 2
      : 1;
  }
  return (remainder === "bearer" || remainder === "basic") && tokens[followingIndex] !== undefined
    ? 1
    : 0;
}

function isCommandDetail(value: string): boolean {
  if (value === "<redacted>" || value === "<path>") return false;
  const assignment = /^([^=]+)=/u.exec(value);
  if (assignment?.[1] !== undefined && sensitiveCredentialName(assignment[1])) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * Returns a bounded display-only command, or null when the command cannot be shown safely enough
 * to support an informed approval.
 */
export function sanitizeCodexCommandPreview(value: string): string | null {
  const tokens = tokenizeCodexCommand(value);
  if (tokens === null || tokens.length === 0) return null;

  const displayed: string[] = [];
  let informative = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return null;

    if (token === "-H" || token.toLowerCase() === "--header") {
      const header = tokens[index + 1];
      if (header === undefined) return null;
      displayed.push(token, "<redacted>");
      index += 1 + headerContinuationCount(tokens, header, index + 2);
      continue;
    }
    if (/^--header=/iu.test(token)) {
      displayed.push("--header=<redacted>");
      const header = token.slice(token.indexOf("=") + 1);
      index += headerContinuationCount(tokens, header, index + 1);
      continue;
    }
    if (token === "-u" || token.toLowerCase() === "--user") {
      if (tokens[index + 1] === undefined) return null;
      displayed.push(token, "<redacted>");
      index += 1;
      continue;
    }
    if (/^--user=/iu.test(token)) {
      displayed.push("--user=<redacted>");
      continue;
    }
    if (isAuthorizationHeader(token)) {
      displayed.push(`${token.slice(0, token.indexOf(":"))}:<redacted>`);
      const remainder = token
        .slice(token.indexOf(":") + 1)
        .trim()
        .toLowerCase();
      if (remainder === "" && tokens[index + 1] !== undefined) index += 1;
      if (
        (remainder === "" || remainder === "bearer" || remainder === "basic") &&
        tokens[index + 1] !== undefined
      ) {
        index += 1;
      }
      continue;
    }

    const inlineCredential = /^((?:--?)?[A-Za-z_][A-Za-z0-9_-]*)([=:])(.*)$/su.exec(token);
    if (
      inlineCredential?.[1] !== undefined &&
      inlineCredential[2] !== undefined &&
      inlineCredential[3] !== undefined &&
      sensitiveCredentialName(inlineCredential[1])
    ) {
      displayed.push(`${inlineCredential[1]}${inlineCredential[2]}<redacted>`);
      const assigned = inlineCredential[3].trim().toLowerCase();
      if (
        (assigned === "" || assigned === "bearer" || assigned === "basic") &&
        tokens[index + 1] !== undefined
      ) {
        index += 1;
      }
      continue;
    }

    const isCredentialArgument =
      /^(?:--?)?[A-Za-z_][A-Za-z0-9_-]*$/u.test(token) && sensitiveCredentialName(token);
    if (isCredentialArgument) {
      const next = tokens[index + 1];
      if (next === undefined) return null;
      displayed.push(token, "<redacted>");
      index +=
        (next === "=" || next.toLowerCase() === "bearer" || next.toLowerCase() === "basic") &&
        tokens[index + 2] !== undefined
          ? 2
          : 1;
      continue;
    }

    const sanitized = sanitizeOrdinaryCommandToken(token);
    if (sanitized === null) return null;
    displayed.push(sanitized);
    informative ||= isCommandDetail(sanitized);
  }

  if (!informative) return null;
  const preview = displayed.join(" ").replace(/\s+/gu, " ").trim();
  return truncateCodexUtf8(preview, MAX_CODEX_PERMISSION_PREVIEW_BYTES) || null;
}

export function sanitizeCodexLabel(value: string, fallback: string): string {
  const sanitized = redactedAbsolutePaths(sanitizeUnicode(value)).replace(/\s+/gu, " ").trim();
  return truncateCodexUtf8(sanitized || fallback, MAX_CODEX_TOOL_TITLE_BYTES);
}

export function normalizeCodexNetworkHost(value: string): string | null {
  const normalized = sanitizeUnicode(value)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (normalized.length === 0 || normalized.length > 253 || /[\s/@?#\\]/u.test(normalized)) {
    return null;
  }
  if (normalized.includes(":")) return isIP(normalized) === 6 ? normalized : null;
  if (isIP(normalized) === 4) return normalized;
  const labels = normalized.split(".");
  return labels.every(
    (label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  )
    ? normalized
    : null;
}

function isMissingPathError(error: unknown): boolean {
  const code = record(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function realPathIncludingMissingLeaf(absolutePath: string): string | null {
  let existingAncestor = absolutePath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const resolvedAncestor = realpathSync.native(existingAncestor);
      return path.resolve(resolvedAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) return null;
      try {
        // A broken symlink or another existing-but-unresolvable entry must not be treated as a
        // missing path. Following it during the approved write could escape the workspace.
        lstatSync(existingAncestor);
        return null;
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) return null;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return null;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function canonicalWorkspaceRoot(workspacePath: string): string | null {
  const cached = canonicalWorkspaceRoots.get(workspacePath);
  if (cached !== undefined) {
    canonicalWorkspaceRoots.delete(workspacePath);
    canonicalWorkspaceRoots.set(workspacePath, cached);
    return cached;
  }

  let resolved: string;
  try {
    resolved = realpathSync.native(workspacePath);
  } catch {
    return null;
  }

  if (canonicalWorkspaceRoots.size >= MAX_CACHED_CODEX_WORKSPACE_ROOTS) {
    const oldest = canonicalWorkspaceRoots.keys().next().value;
    if (oldest !== undefined) canonicalWorkspaceRoots.delete(oldest);
  }
  canonicalWorkspaceRoots.set(workspacePath, resolved);
  return resolved;
}

function workspaceRelativeLocation(candidate: unknown, workspacePath: string): string | null {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.includes("\0") ||
    sanitizeUnicode(candidate) !== candidate ||
    Buffer.byteLength(candidate, "utf8") > MAX_CODEX_LOCATION_BYTES ||
    !path.isAbsolute(workspacePath) ||
    path.normalize(workspacePath) !== workspacePath ||
    path.normalize(candidate) !== candidate
  ) {
    return null;
  }

  const lexicalPath = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workspacePath, candidate);
  if (!isContainedPath(workspacePath, lexicalPath)) return null;

  // Cache only the canonical security root. Candidate paths are resolved on every use so a stale
  // cache entry fails closed if the workspace or one of its descendants is replaced by a symlink.
  const realWorkspace = canonicalWorkspaceRoot(workspacePath);
  if (realWorkspace === null) return null;
  const realCandidate = realPathIncludingMissingLeaf(lexicalPath);
  if (realCandidate === null || !isContainedPath(realWorkspace, realCandidate)) return null;

  const relative = path.relative(workspacePath, lexicalPath);
  const displayed = relative === "" ? "." : relative.split(path.sep).join("/");
  return Buffer.byteLength(displayed, "utf8") <= MAX_CODEX_LOCATION_BYTES ? displayed : null;
}

function requiredWorkspaceLocation(candidate: unknown, workspacePath: string): string {
  const location = workspaceRelativeLocation(candidate, workspacePath);
  if (location === null) throw new CodexProtocolError("incompatible-protocol");
  return location;
}

function validateCommandActions(value: unknown): void {
  for (const candidate of requiredArray(value, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
    const action = requiredRecord(candidate);
    switch (action.type) {
      case "read":
        assertKnownKeys(action, ["type", "command", "name", "path"]);
        requiredString(action.command, 100_000);
        requiredString(action.name, 4_096);
        requiredString(action.path, MAX_CODEX_LOCATION_BYTES);
        break;
      case "listFiles":
        assertKnownKeys(action, ["type", "command", "path"]);
        requiredString(action.command, 100_000);
        requiredNullableString(action.path, MAX_CODEX_LOCATION_BYTES);
        break;
      case "search":
        assertKnownKeys(action, ["type", "command", "query", "path"]);
        requiredString(action.command, 100_000);
        requiredNullableString(action.query, 100_000);
        requiredNullableString(action.path, MAX_CODEX_LOCATION_BYTES);
        break;
      case "unknown":
        assertKnownKeys(action, ["type", "command"]);
        requiredString(action.command, 100_000);
        break;
      default:
        throw new CodexProtocolError("incompatible-protocol");
    }
  }
}

function validateFileChange(value: unknown, workspacePath: string): readonly string[] {
  const change = requiredRecord(value);
  assertKnownKeys(change, ["path", "kind", "diff"]);
  const locations = [requiredWorkspaceLocation(change.path, workspacePath)];
  requiredString(change.diff, MAX_CODEX_PROJECTED_TEXT_BYTES);
  const kind = requiredRecord(change.kind);
  switch (kind.type) {
    case "add":
    case "delete":
      assertKnownKeys(kind, ["type"]);
      break;
    case "update": {
      assertKnownKeys(kind, ["type", "move_path"]);
      const movePath = requiredNullableString(kind.move_path, MAX_CODEX_LOCATION_BYTES);
      if (movePath !== null) locations.push(requiredWorkspaceLocation(movePath, workspacePath));
      break;
    }
    default:
      throw new CodexProtocolError("incompatible-protocol");
  }
  return locations;
}

function validateIgnoredItem(item: Record<string, unknown>): void {
  switch (item.type) {
    case "userMessage":
      assertKnownKeys(item, ["type", "id", "clientId", "content"]);
      requiredNullableString(item.clientId, MAX_CODEX_IDENTIFIER_LENGTH);
      for (const inputValue of requiredArray(item.content, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
        const input = requiredRecord(inputValue);
        requiredString(input.type, 128);
      }
      break;
    case "hookPrompt":
      assertKnownKeys(item, ["type", "id", "fragments"]);
      for (const fragmentValue of requiredArray(item.fragments, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
        const fragment = requiredRecord(fragmentValue);
        assertKnownKeys(fragment, ["text", "hookRunId"]);
        requiredString(fragment.text);
        requiredIdentifier(fragment.hookRunId);
      }
      break;
    case "plan":
      assertKnownKeys(item, ["type", "id", "text"]);
      requiredString(item.text);
      break;
    case "dynamicToolCall":
      assertKnownKeys(item, [
        "type",
        "id",
        "namespace",
        "tool",
        "arguments",
        "status",
        "contentItems",
        "success",
        "durationMs",
      ]);
      requiredNullableString(item.namespace, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredString(item.tool, MAX_CODEX_IDENTIFIER_LENGTH);
      if (item.status !== "inProgress" && item.status !== "completed" && item.status !== "failed") {
        throw new CodexProtocolError("incompatible-protocol");
      }
      if (item.contentItems !== null) {
        requiredArray(item.contentItems, MAX_CODEX_REQUEST_ARRAY_ITEMS);
      }
      if (item.success !== null) requiredBoolean(item.success);
      requiredNullableFiniteNumber(item.durationMs);
      break;
    case "collabAgentToolCall":
      assertKnownKeys(item, [
        "type",
        "id",
        "tool",
        "status",
        "senderThreadId",
        "receiverThreadIds",
        "prompt",
        "model",
        "reasoningEffort",
        "agentsStates",
      ]);
      if (
        item.tool !== "spawnAgent" &&
        item.tool !== "sendInput" &&
        item.tool !== "resumeAgent" &&
        item.tool !== "wait" &&
        item.tool !== "closeAgent"
      ) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      if (item.status !== "inProgress" && item.status !== "completed" && item.status !== "failed") {
        throw new CodexProtocolError("incompatible-protocol");
      }
      requiredIdentifier(item.senderThreadId);
      for (const receiver of requiredArray(item.receiverThreadIds, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
        requiredIdentifier(receiver);
      }
      requiredNullableString(item.prompt);
      requiredNullableString(item.model, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredNullableString(item.reasoningEffort, 128);
      if (Object.keys(requiredRecord(item.agentsStates)).length > MAX_CODEX_REQUEST_ARRAY_ITEMS) {
        throw new CodexProtocolError("limit-exceeded");
      }
      break;
    case "subAgentActivity":
      assertKnownKeys(item, ["type", "id", "kind", "agentThreadId", "agentPath"]);
      if (item.kind !== "started" && item.kind !== "interacted" && item.kind !== "interrupted") {
        throw new CodexProtocolError("incompatible-protocol");
      }
      requiredIdentifier(item.agentThreadId);
      requiredString(item.agentPath, MAX_CODEX_LOCATION_BYTES);
      break;
    case "sleep":
      assertKnownKeys(item, ["type", "id", "durationMs"]);
      requiredTimestamp(item.durationMs);
      break;
    case "imageGeneration":
      assertKnownKeys(item, [
        "type",
        "id",
        "status",
        "revisedPrompt",
        "result",
        "transparentBackground",
        "savedPath",
      ]);
      requiredString(item.status, 1_024);
      requiredNullableString(item.revisedPrompt);
      requiredString(item.result);
      if (Object.hasOwn(item, "transparentBackground")) {
        requiredBoolean(item.transparentBackground);
      }
      if (Object.hasOwn(item, "savedPath")) {
        requiredString(item.savedPath, MAX_CODEX_LOCATION_BYTES);
      }
      break;
    case "enteredReviewMode":
    case "exitedReviewMode":
      assertKnownKeys(item, ["type", "id", "review"]);
      requiredString(item.review);
      break;
    case "contextCompaction":
      assertKnownKeys(item, ["type", "id"]);
      break;
    default:
      throw new CodexProtocolError("incompatible-protocol");
  }
}

function projectedItem(value: unknown, workspacePath: string): CodexProjectedItem {
  const item = requiredRecord(value);
  const itemId = requiredIdentifier(item.id);
  switch (item.type) {
    case "userMessage":
    case "hookPrompt":
    case "plan":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "sleep":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      validateIgnoredItem(item);
      return { type: "ignored", itemId };
    case "agentMessage": {
      assertKnownKeys(item, ["type", "id", "text", "phase", "memoryCitation"]);
      if (item.phase !== null && item.phase !== "commentary" && item.phase !== "final_answer") {
        throw new CodexProtocolError("incompatible-protocol");
      }
      if (item.memoryCitation !== null) {
        const citation = requiredRecord(item.memoryCitation);
        assertKnownKeys(citation, ["entries", "threadIds"]);
        requiredArray(citation.entries, MAX_CODEX_REQUEST_ARRAY_ITEMS);
        for (const threadId of requiredArray(citation.threadIds, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
          requiredIdentifier(threadId);
        }
      }
      return { type: "agent-message", itemId, text: requiredString(item.text) };
    }
    case "reasoning": {
      assertKnownKeys(item, ["type", "id", "summary", "content"]);
      const summary = requiredArray(item.summary, 100).map((entry) =>
        requiredString(entry, 100_000),
      );
      for (const entry of requiredArray(item.content, 100)) {
        requiredString(entry, 100_000);
      }
      return {
        type: "reasoning",
        itemId,
        summary,
      };
    }
    case "commandExecution": {
      assertKnownKeys(item, [
        "type",
        "id",
        "pluginId",
        "scriptPath",
        "command",
        "cwd",
        "processId",
        "source",
        "status",
        "commandActions",
        "aggregatedOutput",
        "exitCode",
        "durationMs",
      ]);
      requiredNullableString(item.pluginId, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredNullableString(item.scriptPath, MAX_CODEX_LOCATION_BYTES);
      requiredString(item.cwd, MAX_CODEX_LOCATION_BYTES);
      requiredNullableString(item.processId, MAX_CODEX_IDENTIFIER_LENGTH);
      if (
        item.source !== "agent" &&
        item.source !== "userShell" &&
        item.source !== "unifiedExecStartup" &&
        item.source !== "unifiedExecInteraction"
      ) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      validateCommandActions(item.commandActions);
      requiredNullableString(item.aggregatedOutput, MAX_CODEX_JSONL_LINE_BYTES);
      const exitCode = item.exitCode;
      if (
        exitCode !== null &&
        (finiteNumber(exitCode) === null || !Number.isSafeInteger(exitCode))
      ) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      requiredNullableFiniteNumber(item.durationMs);
      const command = sanitizeCodexCommandPreview(requiredString(item.command, 100_000));
      return {
        type: "tool",
        itemId,
        title: command ?? "Run a command",
        toolKind: "execute",
        status: itemStatus(item.status),
        locations: [],
      };
    }
    case "fileChange": {
      assertKnownKeys(item, ["type", "id", "changes", "status"]);
      const changes = requiredArray(item.changes, MAX_CODEX_ITEM_LOCATIONS);
      const locations = changes.flatMap((change) => validateFileChange(change, workspacePath));
      const uniqueLocations = [...new Set(locations)];
      if (uniqueLocations.length > MAX_CODEX_ITEM_LOCATIONS) {
        throw new CodexProtocolError("limit-exceeded");
      }
      return {
        type: "tool",
        itemId,
        title: "Change workspace files",
        toolKind: "edit",
        status: itemStatus(item.status),
        locations: uniqueLocations,
      };
    }
    case "mcpToolCall": {
      assertKnownKeys(item, [
        "type",
        "id",
        "server",
        "tool",
        "status",
        "arguments",
        "appContext",
        "mcpAppResourceUri",
        "pluginId",
        "readOnlyHint",
        "result",
        "error",
        "durationMs",
      ]);
      requiredString(item.server, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredString(item.tool, MAX_CODEX_IDENTIFIER_LENGTH);
      if (item.status !== "inProgress" && item.status !== "completed" && item.status !== "failed") {
        throw new CodexProtocolError("incompatible-protocol");
      }
      if (item.appContext !== null) requiredRecord(item.appContext);
      if (Object.hasOwn(item, "mcpAppResourceUri")) {
        requiredString(item.mcpAppResourceUri, 100_000);
      }
      requiredNullableString(item.pluginId, MAX_CODEX_IDENTIFIER_LENGTH);
      if (item.readOnlyHint !== null) requiredBoolean(item.readOnlyHint);
      if (item.result !== null) requiredRecord(item.result);
      if (item.error !== null) requiredRecord(item.error);
      requiredNullableFiniteNumber(item.durationMs);
      return {
        type: "tool",
        itemId,
        title: "Use an external tool",
        toolKind: "other",
        status: itemStatus(item.status),
        locations: [],
      };
    }
    case "webSearch": {
      assertKnownKeys(item, ["type", "id", "query", "action", "results"]);
      const query = requiredString(item.query, 100_000);
      if (item.action !== null) requiredRecord(item.action);
      if (item.results !== null) requiredArray(item.results, MAX_CODEX_REQUEST_ARRAY_ITEMS);
      return {
        type: "tool",
        itemId,
        title: sanitizeCodexLabel(query, "Search the web"),
        toolKind: "search",
        status: "in_progress",
        locations: [],
      };
    }
    case "imageView": {
      assertKnownKeys(item, ["type", "id", "path"]);
      const location = workspaceRelativeLocation(item.path, workspacePath);
      return {
        type: "tool",
        itemId,
        title: "View an image",
        toolKind: "read",
        status: "in_progress",
        locations: location === null ? [] : [location],
      };
    }
    default:
      throw new CodexProtocolError("incompatible-protocol");
  }
}

function validateTurnError(value: unknown): void {
  const error = requiredRecord(value);
  assertKnownKeys(error, ["message", "codexErrorInfo", "additionalDetails"]);
  requiredString(error.message, 16_384);
  if (error.codexErrorInfo !== null) requiredRecord(error.codexErrorInfo);
  requiredNullableString(error.additionalDetails, 16_384);
}

function projectedTurnLifecycle(
  value: unknown,
  workspacePath: string,
): { readonly turnId: string; readonly status: CodexTurnStatus } {
  const turn = requiredRecord(value);
  assertKnownKeys(turn, [
    "id",
    "items",
    "itemsView",
    "status",
    "error",
    "startedAt",
    "completedAt",
    "durationMs",
  ]);
  for (const item of requiredArray(turn.items, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
    projectedItem(item, workspacePath);
  }
  if (turn.itemsView !== "notLoaded" && turn.itemsView !== "summary" && turn.itemsView !== "full") {
    throw new CodexProtocolError("incompatible-protocol");
  }
  const status = turnStatus(turn.status);
  if (turn.error !== null) validateTurnError(turn.error);
  if (status !== "failed" && turn.error !== null) {
    throw new CodexProtocolError("incompatible-protocol");
  }
  requiredNullableFiniteNumber(turn.startedAt);
  requiredNullableFiniteNumber(turn.completedAt);
  requiredNullableFiniteNumber(turn.durationMs);
  return { turnId: requiredIdentifier(turn.id), status };
}

export function parseCodexNotification(
  method: string,
  value: unknown,
  workspacePath: string,
): CodexNotification {
  switch (method) {
    case "thread/started": {
      const params = requiredRecord(value);
      assertKnownKeys(params, ["thread"]);
      const thread = requiredRecord(params.thread);
      return { kind: "thread-started", threadId: requiredIdentifier(thread.id) };
    }
    case "turn/started": {
      const params = requiredRecord(value);
      assertKnownKeys(params, ["threadId", "turn"]);
      const turn = projectedTurnLifecycle(params.turn, workspacePath);
      return {
        kind: "turn-started",
        threadId: requiredIdentifier(params.threadId),
        turnId: turn.turnId,
        status: turn.status,
      };
    }
    case "turn/completed": {
      const params = requiredRecord(value);
      assertKnownKeys(params, ["threadId", "turn"]);
      const turn = projectedTurnLifecycle(params.turn, workspacePath);
      return {
        kind: "turn-completed",
        threadId: requiredIdentifier(params.threadId),
        turnId: turn.turnId,
        status: turn.status,
      };
    }
    case "item/agentMessage/delta": {
      const params = correlatedParams(value);
      assertKnownKeys(params, ["threadId", "turnId", "itemId", "delta"]);
      return {
        kind: "agent-message-delta",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: requiredIdentifier(params.itemId),
        delta: requiredString(params.delta),
      };
    }
    case "item/reasoning/summaryTextDelta": {
      const params = correlatedParams(value);
      assertKnownKeys(params, ["threadId", "turnId", "itemId", "delta", "summaryIndex"]);
      const summaryIndex = finiteNumber(params.summaryIndex);
      if (summaryIndex === null || !Number.isSafeInteger(summaryIndex) || summaryIndex < 0) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      return {
        kind: "reasoning-summary-delta",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: requiredIdentifier(params.itemId),
        delta: requiredString(params.delta),
        summaryIndex,
      };
    }
    case "item/started":
    case "item/completed": {
      const params = correlatedParams(value);
      assertKnownKeys(
        params,
        method === "item/started"
          ? ["threadId", "turnId", "item", "startedAtMs"]
          : ["threadId", "turnId", "item", "completedAtMs"],
      );
      requiredTimestamp(method === "item/started" ? params.startedAtMs : params.completedAtMs);
      return {
        kind: method === "item/started" ? "item-started" : "item-completed",
        threadId: params.threadId,
        turnId: params.turnId,
        item: projectedItem(params.item, workspacePath),
      };
    }
    case "turn/plan/updated": {
      const params = correlatedParams(value);
      assertKnownKeys(params, ["threadId", "turnId", "explanation", "plan"]);
      requiredNullableString(params.explanation, 100_000);
      if (!Array.isArray(params.plan) || params.plan.length > MAX_CODEX_PLAN_STEPS) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      return {
        kind: "plan-updated",
        threadId: params.threadId,
        turnId: params.turnId,
        plan: params.plan.map((entry) => {
          const step = requiredRecord(entry);
          const status = step.status;
          if (status !== "pending" && status !== "inProgress" && status !== "completed") {
            throw new CodexProtocolError("incompatible-protocol");
          }
          return {
            step: sanitizeCodexLabel(requiredString(step.step, 100_000), "Codex step"),
            status: status === "inProgress" ? "in_progress" : status,
          };
        }),
      };
    }
    case "serverRequest/resolved": {
      const params = requiredRecord(value);
      assertKnownKeys(params, ["threadId", "requestId"]);
      const id = requestId(params.requestId);
      if (id === null) throw new CodexProtocolError("incompatible-protocol");
      return {
        kind: "server-request-resolved",
        threadId: requiredIdentifier(params.threadId),
        approvalKey: id,
      };
    }
    case "error": {
      const params = correlatedParams(value);
      assertKnownKeys(params, ["threadId", "turnId", "error", "willRetry"]);
      const error = record(params.error);
      if (typeof params.willRetry !== "boolean" || error === null) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      validateTurnError(error);
      return {
        kind: "error",
        threadId: params.threadId,
        turnId: params.turnId,
        willRetry: params.willRetry,
      };
    }
    case "item/reasoning/textDelta":
      // Raw reasoning is recognized and intentionally discarded.
      {
        const params = correlatedParams(value);
        assertKnownKeys(params, ["threadId", "turnId", "itemId", "delta", "contentIndex"]);
        requiredIdentifier(params.itemId);
        requiredString(params.delta);
        const contentIndex = finiteNumber(params.contentIndex);
        if (contentIndex === null || !Number.isSafeInteger(contentIndex) || contentIndex < 0) {
          throw new CodexProtocolError("incompatible-protocol");
        }
      }
      return { kind: "unknown", method };
    default:
      return { kind: "unknown", method };
  }
}

function approvalKey(params: Record<string, unknown>): string {
  if (!Object.hasOwn(params, "approvalId") || params.approvalId === null) {
    return requiredIdentifier(params.itemId);
  }
  return requiredIdentifier(params.approvalId);
}

function networkProtocol(value: unknown): "http" | "https" | "socks5Tcp" | "socks5Udp" | null {
  return value === "http" || value === "https" || value === "socks5Tcp" || value === "socks5Udp"
    ? value
    : null;
}

export function parseCodexServerRequest(
  rpcId: CodexRequestId,
  method: string,
  value: unknown,
): CodexServerRequest {
  if (requestId(rpcId) === null) throw new CodexProtocolError("invalid-message");
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const params = requiredRecord(value);
      assertKnownKeys(params, [
        "threadId",
        "turnId",
        "itemId",
        "startedAtMs",
        "approvalId",
        "environmentId",
        "reason",
        "networkApprovalContext",
        "command",
        "cwd",
        "commandActions",
        "proposedExecpolicyAmendment",
        "proposedNetworkPolicyAmendments",
      ]);
      requiredTimestamp(params.startedAtMs);
      requiredNullableString(params.environmentId, MAX_CODEX_IDENTIFIER_LENGTH);
      optionalNullableString(params, "reason", 16_384);
      optionalNullableString(params, "cwd", MAX_CODEX_LOCATION_BYTES);
      if (Object.hasOwn(params, "commandActions") && params.commandActions !== null) {
        validateCommandActions(params.commandActions);
      }
      if (
        Object.hasOwn(params, "proposedExecpolicyAmendment") &&
        params.proposedExecpolicyAmendment !== null
      ) {
        requiredRecord(params.proposedExecpolicyAmendment);
      }
      if (
        Object.hasOwn(params, "proposedNetworkPolicyAmendments") &&
        params.proposedNetworkPolicyAmendments !== null
      ) {
        for (const amendment of requiredArray(
          params.proposedNetworkPolicyAmendments,
          MAX_CODEX_REQUEST_ARRAY_ITEMS,
        )) {
          requiredRecord(amendment);
        }
      }
      const context =
        params.networkApprovalContext === null || params.networkApprovalContext === undefined
          ? null
          : requiredRecord(params.networkApprovalContext);
      if (context !== null) assertKnownKeys(context, ["host", "protocol"]);
      const protocol = context === null ? null : networkProtocol(context.protocol);
      const host =
        context === null ? null : normalizeCodexNetworkHost(requiredString(context.host, 1_024));
      if (context !== null && (protocol === null || host === null)) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      const rawCommand = optionalNullableString(params, "command", 100_000);
      const command = rawCommand === null ? null : sanitizeCodexCommandPreview(rawCommand);
      if (context === null && command === null) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      return {
        kind: "command-approval",
        rpcId,
        approvalKey: approvalKey(params),
        threadId: requiredIdentifier(params.threadId),
        turnId: requiredIdentifier(params.turnId),
        itemId: requiredIdentifier(params.itemId),
        command,
        networkHost: host,
        networkProtocol: protocol,
      };
    }
    case "item/fileChange/requestApproval": {
      const params = requiredRecord(value);
      assertKnownKeys(params, [
        "threadId",
        "turnId",
        "itemId",
        "startedAtMs",
        "reason",
        "grantRoot",
      ]);
      requiredTimestamp(params.startedAtMs);
      optionalNullableString(params, "reason", 16_384);
      return {
        kind: "file-approval",
        rpcId,
        approvalKey: approvalKey(params),
        threadId: requiredIdentifier(params.threadId),
        turnId: requiredIdentifier(params.turnId),
        itemId: requiredIdentifier(params.itemId),
        grantRoot: optionalNullableString(params, "grantRoot", MAX_CODEX_LOCATION_BYTES),
      };
    }
    case "item/permissions/requestApproval": {
      const params = requiredRecord(value);
      assertKnownKeys(params, [
        "threadId",
        "turnId",
        "itemId",
        "environmentId",
        "startedAtMs",
        "cwd",
        "reason",
        "permissions",
      ]);
      requiredTimestamp(params.startedAtMs);
      requiredNullableString(params.environmentId, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredString(params.cwd, MAX_CODEX_LOCATION_BYTES);
      requiredNullableString(params.reason, 16_384);
      const permissions = requiredRecord(params.permissions);
      assertKnownKeys(permissions, ["network", "fileSystem"]);
      const network = permissions.network === null ? null : requiredRecord(permissions.network);
      const fileSystem =
        permissions.fileSystem === null ? null : requiredRecord(permissions.fileSystem);
      if (network !== null) {
        assertKnownKeys(network, ["enabled"]);
        if (network.enabled !== true && network.enabled !== false && network.enabled !== null) {
          throw new CodexProtocolError("incompatible-protocol");
        }
      }
      if (fileSystem !== null) {
        assertKnownKeys(fileSystem, ["read", "write", "globScanMaxDepth", "entries"]);
        for (const key of ["read", "write"] as const) {
          if (fileSystem[key] !== null) {
            for (const filePath of requiredArray(fileSystem[key], MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
              requiredString(filePath, MAX_CODEX_LOCATION_BYTES);
            }
          }
        }
        if (Object.hasOwn(fileSystem, "globScanMaxDepth")) {
          const depth = finiteNumber(fileSystem.globScanMaxDepth);
          if (depth === null || !Number.isSafeInteger(depth) || depth < 0) {
            throw new CodexProtocolError("incompatible-protocol");
          }
        }
        if (Object.hasOwn(fileSystem, "entries")) {
          for (const entry of requiredArray(fileSystem.entries, MAX_CODEX_REQUEST_ARRAY_ITEMS)) {
            requiredRecord(entry);
          }
        }
      }
      return {
        kind: "permissions-approval",
        rpcId,
        approvalKey: approvalKey(params),
        threadId: requiredIdentifier(params.threadId),
        turnId: requiredIdentifier(params.turnId),
        itemId: requiredIdentifier(params.itemId),
        requestsNetwork: network?.enabled === true,
        requestsFileSystem: fileSystem !== null,
      };
    }
    case "mcpServer/elicitation/request": {
      const params = requiredRecord(value);
      const mode = params.mode;
      const commonKeys = ["threadId", "turnId", "serverName", "mode", "_meta", "message"];
      requiredIdentifier(params.threadId);
      requiredNullableString(params.turnId, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredString(params.serverName, MAX_CODEX_IDENTIFIER_LENGTH);
      requiredString(params.message, 100_000);
      if (params._meta !== null && record(params._meta) === null) {
        throw new CodexProtocolError("incompatible-protocol");
      }
      if (mode === "form" || mode === "openai/form") {
        assertKnownKeys(params, [...commonKeys, "requestedSchema"]);
        requiredRecord(params.requestedSchema);
      } else if (mode === "url") {
        assertKnownKeys(params, [...commonKeys, "url", "elicitationId"]);
        requiredString(params.url, 100_000);
        requiredIdentifier(params.elicitationId);
      } else {
        throw new CodexProtocolError("incompatible-protocol");
      }
      return { kind: "safe-negative", rpcId, method };
    }
    case "item/tool/requestUserInput": {
      const params = requiredRecord(value);
      assertKnownKeys(params, [
        "threadId",
        "turnId",
        "itemId",
        "questions",
        "isBlocking",
        "autoResolutionMs",
      ]);
      requiredIdentifier(params.threadId);
      requiredIdentifier(params.turnId);
      requiredIdentifier(params.itemId);
      requiredBoolean(params.isBlocking);
      requiredNullableFiniteNumber(params.autoResolutionMs);
      for (const questionValue of requiredArray(params.questions, 3)) {
        const question = requiredRecord(questionValue);
        assertKnownKeys(question, ["id", "header", "question", "isOther", "isSecret", "options"]);
        requiredIdentifier(question.id);
        requiredString(question.header, 1_024);
        requiredString(question.question, 16_384);
        requiredBoolean(question.isOther);
        requiredBoolean(question.isSecret);
        if (question.options !== null) {
          for (const optionValue of requiredArray(question.options, 3)) {
            const option = requiredRecord(optionValue);
            assertKnownKeys(option, ["label", "description"]);
            requiredString(option.label, 1_024);
            requiredString(option.description, 16_384);
          }
        }
      }
      return { kind: "safe-negative", rpcId, method };
    }
    case "item/tool/call":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "applyPatchApproval":
    case "execCommandApproval":
      return { kind: "unsupported", rpcId, method };
    default:
      return { kind: "unknown", rpcId, method };
  }
}

export function parseInitializeResult(value: unknown): { readonly userAgent: string } {
  const response = requiredRecord(value);
  assertKnownKeys(response, ["userAgent", "codexHome", "platformFamily", "platformOs"]);
  requiredString(response.codexHome, MAX_CODEX_LOCATION_BYTES);
  requiredString(response.platformFamily, 1_024);
  requiredString(response.platformOs, 1_024);
  return { userAgent: requiredString(response.userAgent, 4_096) };
}

export function parseAccountResult(value: unknown): { readonly authenticated: boolean } {
  const response = requiredRecord(value);
  assertKnownKeys(response, ["account", "requiresOpenaiAuth"]);
  const requiresOpenaiAuth = requiredBoolean(response.requiresOpenaiAuth);
  if (response.account !== null) {
    const account = requiredRecord(response.account);
    switch (account.type) {
      case "apiKey":
        assertKnownKeys(account, ["type"]);
        break;
      case "chatgpt": {
        assertKnownKeys(account, ["type", "email", "planType"]);
        requiredNullableString(account.email, 16_384);
        const planTypes = new Set([
          "free",
          "go",
          "plus",
          "pro",
          "prolite",
          "team",
          "self_serve_business_prolite",
          "self_serve_business_usage_based",
          "business",
          "ent26",
          "enterprise_cbp_automation",
          "enterprise_cbp_usage_based",
          "enterprise",
          "edu",
          "unknown",
        ]);
        if (typeof account.planType !== "string" || !planTypes.has(account.planType)) {
          throw new CodexProtocolError("incompatible-protocol");
        }
        break;
      }
      case "amazonBedrock":
        assertKnownKeys(account, ["type", "usesCodexManagedCredentials"]);
        requiredBoolean(account.usesCodexManagedCredentials);
        break;
      default:
        throw new CodexProtocolError("incompatible-protocol");
    }
  }
  return { authenticated: !requiresOpenaiAuth || response.account !== null };
}

export function parseThreadResult(value: unknown): { readonly threadId: string } {
  const response = requiredRecord(value);
  const thread = requiredRecord(response.thread);
  return { threadId: requiredIdentifier(thread.id) };
}

export function parseTurnStartResult(value: unknown): { readonly turnId: string } {
  const response = requiredRecord(value);
  assertKnownKeys(response, ["turn"]);
  const turn = requiredRecord(response.turn);
  if (turnStatus(turn.status) !== "inProgress") {
    throw new CodexProtocolError("incompatible-protocol");
  }
  return { turnId: requiredIdentifier(turn.id) };
}

export function parseEmptyResult(value: unknown): void {
  const result = requiredRecord(value);
  if (Object.keys(result).length !== 0) throw new CodexProtocolError("incompatible-protocol");
}

export function codexThreadPolicy(workspacePath: string): Readonly<Record<string, unknown>> {
  return {
    cwd: workspacePath,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
}

export function codexTurnPolicy(workspacePath: string): Readonly<Record<string, unknown>> {
  return {
    cwd: workspacePath,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      // The selected cwd is already the implicit writable root. An empty list prevents adding
      // another root while remaining faithful to the 0.147.0 generated schema.
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

export function codexItemEvent(
  conversationId: string,
  localItemId: string,
  item: CodexProjectedItem,
  operation: "started" | "completed",
): AiAgentHostEvent | null {
  if (item.type === "ignored") return null;
  if (item.type === "agent-message") {
    return {
      type: "message-update",
      conversationId,
      messageId: localItemId,
      role: "assistant",
      operation: "replace",
      text: item.text,
    };
  }
  if (item.type === "reasoning") {
    return {
      type: "message-update",
      conversationId,
      messageId: localItemId,
      role: "thought",
      operation: "replace",
      text: item.summary.join("\n"),
    };
  }
  const locations: AiAgentHostLocation[] = item.locations.map((location) => ({ path: location }));
  return {
    type: "tool-update",
    conversationId,
    isCreation: operation === "started",
    tool: {
      id: localItemId,
      title: item.title,
      kind: item.toolKind,
      status: item.status,
      locations,
    },
  };
}

export function codexApprovalTool(
  request: Extract<CodexServerRequest, { kind: "command-approval" | "file-approval" }>,
  localItemId: string,
  workspacePath: string,
  fileLocations: readonly string[],
): AiAgentHostTool {
  if (request.kind === "command-approval") {
    if (request.networkHost !== null && request.networkProtocol !== null) {
      const displayedHost = request.networkHost.includes(":")
        ? `[${request.networkHost}]`
        : request.networkHost;
      const destination = `Connect to ${request.networkProtocol}://${displayedHost}`;
      return {
        id: localItemId,
        title: destination,
        kind: "execute",
        status: "pending",
        locations: [],
      };
    }
    if (request.command === null) throw new CodexProtocolError("incompatible-protocol");
    return {
      id: localItemId,
      title: request.command,
      kind: "execute",
      status: "pending",
      locations: [],
    };
  }
  if (fileLocations.length > MAX_CODEX_ITEM_LOCATIONS) {
    throw new CodexProtocolError("limit-exceeded");
  }
  if (fileLocations.length === 0) throw new CodexProtocolError("incompatible-protocol");
  const candidates = [...fileLocations, ...(request.grantRoot === null ? [] : [request.grantRoot])];
  const locations = [
    ...new Set(candidates.map((candidate) => requiredWorkspaceLocation(candidate, workspacePath))),
  ];
  return {
    id: localItemId,
    title: "Change workspace files",
    kind: "edit",
    status: "pending",
    locations: locations.map((location) => ({ path: location })),
  };
}

export function codexPermissionRequest(
  conversationId: string,
  tool: AiAgentHostTool,
): AiAgentHostPermissionRequest {
  return {
    conversationId,
    tool,
    options: [
      { id: "accept", name: "Allow once", kind: "allow_once" },
      { id: "decline", name: "Reject", kind: "reject_once" },
    ],
  };
}
