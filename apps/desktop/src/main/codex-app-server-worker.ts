import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AiAgentHostEvent,
  AiAgentHostPermissionOutcome,
  AiAgentHostPermissionRequest,
} from "./ai-agent-host";
import {
  CodexProtocolError,
  MAX_CODEX_APPROVAL_QUEUE,
  MAX_CODEX_JSONL_LINE_BYTES,
  MAX_CODEX_PENDING_CLIENT_REQUESTS,
  MAX_CODEX_PENDING_SERVER_REQUESTS,
  MAX_CODEX_OUTGOING_ENVELOPE_BYTES,
  MAX_CODEX_PROJECTED_TEXT_BYTES,
  MAX_CODEX_QUEUED_INPUT_BYTES,
  codexApprovalTool,
  codexItemEvent,
  codexPermissionRequest,
  codexThreadPolicy,
  codexTurnPolicy,
  encodeCodexClientNotification,
  encodeCodexClientRequest,
  encodeCodexServerError,
  encodeCodexServerResult,
  isMissingCodexThreadError,
  isSupportedCodexCliVersion,
  parseAccountResult,
  parseCodexCliVersion,
  parseCodexJsonRpcLine,
  parseCodexNotification,
  parseCodexServerRequest,
  parseEmptyResult,
  parseInitializeResult,
  parseThreadResult,
  parseTurnStartResult,
  truncateCodexUtf8,
  type CodexJsonRpcMessage,
  type CodexNotification,
  type CodexProjectedItem,
  type CodexRequestId,
  type CodexRpcErrorValue,
  type CodexServerRequest,
  type CodexWorkerPermissionDecision,
} from "./codex-app-server-protocol";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 3_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 3_000;
const MAX_VERSION_OUTPUT_BYTES = 4_096;
const MAX_STDERR_CAPTURE_BYTES = 64 * 1_024;
const PROCESS_CLEANUP_RESERVE_MS = 100;
const MAX_CODEX_TURN_CORRELATIONS = 1_000;
const MAX_CODEX_TURN_EVENTS = 4_000;
const MAX_CODEX_TURN_TEXT_BYTES = 2 * 1_024 * 1_024;
const MAX_CODEX_TURN_LOCATION_BYTES = 2 * 1_024 * 1_024;
const CODEX_JSONL_ACCUMULATION_BLOCK_BYTES = 16 * 1_024;

export type CodexWorkerErrorCode =
  | "not-installed"
  | "not-authenticated"
  | "unsupported-version"
  | "startup-failed"
  | "protocol-failed"
  | "conversation-not-found"
  | "conversation-failed"
  | "turn-failed";

export class CodexWorkerError extends Error {
  constructor(readonly code: CodexWorkerErrorCode) {
    super(`Codex worker failed: ${code}`);
    this.name = "CodexWorkerError";
  }
}

class CodexRemoteError extends Error {
  constructor(readonly value: CodexRpcErrorValue) {
    super("Codex app-server returned an RPC error");
    this.name = "CodexRemoteError";
  }
}

export interface CodexExecutableDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly canonicalize?: (candidate: string) => Promise<string>;
  readonly isExecutable?: (candidate: string) => Promise<boolean>;
}

export interface CodexKillableProcess {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type CodexProcessSignal = (pid: number, signal: NodeJS.Signals | 0) => void;

export function killCodexProcessGroup(
  child: CodexKillableProcess,
  platform: NodeJS.Platform = process.platform,
  sendSignal: CodexProcessSignal = process.kill,
): void {
  try {
    if (
      platform !== "win32" &&
      child.pid !== undefined &&
      Number.isSafeInteger(child.pid) &&
      child.pid > 0
    ) {
      sendSignal(-child.pid, "SIGKILL");
      return;
    }
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

function missingProcessGroup(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ESRCH"
  );
}

export function codexProcessGroupExists(
  processGroupId: number,
  sendSignal: CodexProcessSignal = process.kill,
): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return true;
  try {
    sendSignal(-processGroupId, 0);
    return true;
  } catch (error) {
    return !missingProcessGroup(error);
  }
}

function timerUntil(deadline: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    timer.unref();
  });
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CodexWorkerError("startup-failed");
  return remaining;
}

function boundedStartupOperation<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const timeoutMs = remainingTimeout(deadline);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CodexWorkerError("startup-failed"));
    }, timeoutMs);
    timeout.unref();
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
      return;
    }
    void pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function confirmCodexProcessGroupExit(
  processGroupId: number,
  deadline: number,
  sendSignal: CodexProcessSignal,
): Promise<boolean> {
  while (codexProcessGroupExists(processGroupId, sendSignal)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(10, remaining));
      timer.unref();
    });
  }
  return true;
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function absolutePathEntries(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  return (environment.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/gu, "").trim())
    .filter((entry) => entry.length > 0 && implementation.isAbsolute(entry));
}

function conventionalCodexPaths(
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    return [
      path.win32.join(homeDirectory, ".local", "bin", "codex.exe"),
      ...(localAppData === undefined
        ? []
        : [path.win32.join(localAppData, "Programs", "Codex", "codex.exe")]),
    ];
  }
  return [
    path.join(homeDirectory, ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    "/usr/bin/codex",
  ];
}

async function acceptedExecutable(
  candidate: string,
  dependencies: CodexExecutableDependencies,
): Promise<string | null> {
  const canonicalize = dependencies.canonicalize ?? realpath;
  const isExecutable = dependencies.isExecutable ?? executableFile;
  let canonical: string;
  try {
    canonical = await canonicalize(candidate);
  } catch {
    return null;
  }
  return (await isExecutable(canonical)) ? canonical : null;
}

/** Resolves a native executable only. Windows command shims are never considered. */
export async function resolveCodexExecutable(
  dependencies: CodexExecutableDependencies = {},
): Promise<string> {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const configured = environment.CODEX_EXECUTABLE?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!implementation.isAbsolute(configured) || configured.includes("\0")) {
      throw new CodexWorkerError("not-installed");
    }
    const accepted = await acceptedExecutable(configured, dependencies);
    if (accepted === null || (platform === "win32" && !accepted.toLowerCase().endsWith(".exe"))) {
      throw new CodexWorkerError("not-installed");
    }
    return accepted;
  }

  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const homeDirectory =
    dependencies.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const candidates = [
    ...absolutePathEntries(environment, platform).map((entry) =>
      implementation.join(entry, executableName),
    ),
    ...conventionalCodexPaths(platform, homeDirectory, environment),
  ];
  for (const candidate of new Set(candidates)) {
    const accepted = await acceptedExecutable(candidate, dependencies);
    if (accepted !== null) return accepted;
  }
  throw new CodexWorkerError("not-installed");
}

export class BoundedJsonlParser {
  #lineChunks: Buffer[] = [];
  #lineTail: Buffer | null = null;
  #lineTailBytes = 0;
  #lineBytes = 0;
  #ended = false;

  #append(segment: Buffer): void {
    let offset = 0;
    while (offset < segment.byteLength) {
      this.#lineTail ??= Buffer.allocUnsafe(CODEX_JSONL_ACCUMULATION_BLOCK_BYTES);
      const copied = Math.min(
        segment.byteLength - offset,
        CODEX_JSONL_ACCUMULATION_BLOCK_BYTES - this.#lineTailBytes,
      );
      segment.copy(this.#lineTail, this.#lineTailBytes, offset, offset + copied);
      offset += copied;
      this.#lineTailBytes += copied;
      this.#lineBytes += copied;
      if (this.#lineTailBytes === CODEX_JSONL_ACCUMULATION_BLOCK_BYTES) {
        this.#lineChunks.push(this.#lineTail);
        this.#lineTail = null;
        this.#lineTailBytes = 0;
      }
    }
  }

  #takeLine(): Buffer {
    const tail = this.#lineTail?.subarray(0, this.#lineTailBytes);
    const chunks = tail === undefined ? this.#lineChunks : [...this.#lineChunks, tail];
    const line =
      chunks.length === 0
        ? Buffer.alloc(0)
        : chunks.length === 1
          ? (chunks[0] ?? Buffer.alloc(0))
          : Buffer.concat(chunks, this.#lineBytes);
    this.#lineChunks = [];
    this.#lineTail = null;
    this.#lineTailBytes = 0;
    this.#lineBytes = 0;
    return line;
  }

  push(chunk: Uint8Array): CodexJsonRpcMessage[] {
    if (this.#ended) throw new CodexProtocolError("invalid-message");
    if (chunk.byteLength === 0) return [];
    if (chunk.byteLength > MAX_CODEX_QUEUED_INPUT_BYTES) {
      throw new CodexProtocolError("limit-exceeded");
    }
    const input = Buffer.from(chunk);
    const messages: CodexJsonRpcMessage[] = [];
    let offset = 0;
    while (offset < input.byteLength) {
      const newline = input.indexOf(0x0a, offset);
      const end = newline < 0 ? input.byteLength : newline;
      const segment = input.subarray(offset, end);
      if (this.#lineBytes + segment.byteLength > MAX_CODEX_JSONL_LINE_BYTES) {
        throw new CodexProtocolError("limit-exceeded");
      }
      if (segment.byteLength > 0) this.#append(segment);
      if (newline < 0) break;
      let line = this.#takeLine();
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.byteLength === 0 || line.byteLength > MAX_CODEX_JSONL_LINE_BYTES) {
        throw new CodexProtocolError("limit-exceeded");
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        throw new CodexProtocolError("invalid-message");
      }
      messages.push(parseCodexJsonRpcLine(decoded));
      offset = newline + 1;
    }
    return messages;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#lineBytes !== 0) throw new CodexProtocolError("invalid-message");
  }
}

export interface CodexByteTransport {
  readonly processGroupId?: number;
  write(bytes: Uint8Array): Promise<void>;
  closeInput(): void;
  kill(deadline?: number): boolean | void | Promise<boolean | void>;
  onData(listener: (chunk: Uint8Array) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: () => void): void;
}

interface PendingRpcRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function idKey(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`;
}

export interface CodexRpcCallbacks {
  readonly onNotification: (method: string, params: unknown) => void | Promise<void>;
  readonly onServerRequest: (
    id: CodexRequestId,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
  readonly onFatal: () => void;
}

/** Owns byte parsing, serialized writes, request correlation, and bounded RPC state. */
export class CodexRpcConnection {
  readonly #parser = new BoundedJsonlParser();
  readonly #pending = new Map<number, PendingRpcRequest>();
  readonly #serverRequests = new Set<string>();
  readonly ended: Promise<void>;
  readonly #markEnded: () => void;
  #nextId = 0;
  #writeTail: Promise<void> = Promise.resolve();
  #failed = false;

  constructor(
    private readonly transport: CodexByteTransport,
    private readonly callbacks: CodexRpcCallbacks,
  ) {
    let markEnded: (() => void) | undefined;
    this.ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    this.#markEnded = () => markEnded?.();
    transport.onData((chunk) => {
      try {
        for (const message of this.#parser.push(chunk)) this.#dispatch(message);
      } catch {
        this.fail();
      }
    });
    transport.onEnd(() => {
      this.#markEnded();
      try {
        this.#parser.end();
      } catch {
        // Either clean EOF or an incomplete line is fatal while the connection is active.
      }
      this.fail();
    });
    transport.onError(() => {
      this.#markEnded();
      this.fail();
    });
  }

  #queueWrite(bytes: Uint8Array): Promise<void> {
    if (this.#failed) return Promise.reject(new CodexWorkerError("protocol-failed"));
    const write = this.#writeTail.then(() => this.transport.write(bytes));
    this.#writeTail = write.catch(() => undefined);
    write.catch(() => this.fail());
    return write;
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.#failed || this.#pending.size >= MAX_CODEX_PENDING_CLIENT_REQUESTS) {
      this.fail();
      return Promise.reject(new CodexWorkerError("protocol-failed"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    if (!Number.isSafeInteger(this.#nextId)) {
      this.fail();
      return Promise.reject(new CodexWorkerError("protocol-failed"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexWorkerError("protocol-failed"));
        this.fail();
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      void this.#queueWrite(encodeCodexClientRequest(id, method, params)).catch(() => undefined);
    });
  }

  notify(method: string, params?: Readonly<Record<string, unknown>>): Promise<void> {
    return this.#queueWrite(encodeCodexClientNotification(method, params));
  }

  respond(id: CodexRequestId, result: unknown): Promise<void> {
    const key = idKey(id);
    if (!this.#serverRequests.delete(key)) {
      this.fail();
      return Promise.reject(new CodexWorkerError("protocol-failed"));
    }
    return this.#queueWrite(encodeCodexServerResult(id, result));
  }

  respondError(
    id: CodexRequestId,
    code: -32601 | -32602,
    message: "Method not supported" | "Invalid params",
  ): Promise<void> {
    const key = idKey(id);
    if (!this.#serverRequests.delete(key)) {
      this.fail();
      return Promise.reject(new CodexWorkerError("protocol-failed"));
    }
    return this.#queueWrite(encodeCodexServerError(id, code, message));
  }

  resolveServerRequest(id: CodexRequestId): void {
    this.#serverRequests.delete(idKey(id));
  }

  #dispatch(message: CodexJsonRpcMessage): void {
    if (this.#failed) return;
    switch (message.kind) {
      case "response": {
        if (typeof message.id !== "number") {
          this.fail();
          return;
        }
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
          this.fail();
          return;
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error !== undefined) pending.reject(new CodexRemoteError(message.error));
        else pending.resolve(message.result);
        return;
      }
      case "notification":
        Promise.resolve(this.callbacks.onNotification(message.method, message.params)).catch(() =>
          this.fail(),
        );
        return;
      case "request": {
        const key = idKey(message.id);
        if (
          this.#serverRequests.has(key) ||
          this.#serverRequests.size >= MAX_CODEX_PENDING_SERVER_REQUESTS
        ) {
          this.fail();
          return;
        }
        this.#serverRequests.add(key);
        Promise.resolve(
          this.callbacks.onServerRequest(message.id, message.method, message.params),
        ).catch(() => {
          if (this.#serverRequests.has(key)) {
            void this.respondError(message.id, -32602, "Invalid params").catch(() => undefined);
          }
          this.fail();
        });
      }
    }
  }

  fail(): void {
    if (this.#failed) return;
    this.#failed = true;
    const error = new CodexWorkerError("protocol-failed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#serverRequests.clear();
    try {
      this.callbacks.onFatal();
    } catch {
      // The worker reports only a stable failure state.
    }
  }

  close(): void {
    if (!this.#failed) {
      this.#failed = true;
      const error = new CodexWorkerError("protocol-failed");
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#serverRequests.clear();
    }
    this.transport.closeInput();
  }

  async kill(deadline?: number): Promise<boolean> {
    return (await this.transport.kill(deadline)) !== false;
  }

  get processGroupId(): number | null {
    return this.transport.processGroupId ?? null;
  }
}

export interface CodexWorkerCallbacks {
  readonly onEvent: (event: AiAgentHostEvent) => void | Promise<void>;
  readonly requestPermission: (
    request: AiAgentHostPermissionRequest,
    signal: AbortSignal,
  ) => Promise<AiAgentHostPermissionOutcome>;
  readonly onFatal: () => void;
}

export interface CodexWorkerRuntimeOptions {
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
  readonly onProcessGroupCleared?: (processGroupId: number) => void;
}

interface ActiveTurn {
  readonly threadId: string;
  turnId: string | null;
  cancellationRequested: boolean;
  localFailureRequested: boolean;
  interruptRequested: boolean;
  responseReceived: boolean;
  terminalStatus: "completed" | "interrupted" | "failed" | null;
  settled: boolean;
  readonly ready: Promise<void>;
  readonly markReady: () => void;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface QueuedApproval {
  readonly localItemId: string;
  readonly request: Extract<CodexServerRequest, { kind: "command-approval" | "file-approval" }>;
  readonly controller: AbortController;
  settled: boolean;
}

interface ProjectedFileLocations {
  readonly locations: readonly string[];
  readonly bytes: number;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  };
}

function boundedTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: CodexWorkerErrorCode,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CodexWorkerError(code));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new CodexWorkerError(code));
      },
    );
  });
}

function remoteDecision(outcome: AiAgentHostPermissionOutcome): CodexWorkerPermissionDecision {
  if (outcome.outcome !== "selected") return "cancel";
  return outcome.optionId === "accept" || outcome.optionId === "decline"
    ? outcome.optionId
    : "cancel";
}

/** The app-server state machine. No raw protocol value is emitted through its callbacks. */
export class CodexAppServerWorkerRuntime {
  readonly #rpc: CodexRpcConnection;
  readonly #startupTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #interruptTimeoutMs: number;
  readonly #teardownTimeoutMs: number;
  readonly #startupDeadline: number | null;
  readonly #onProcessGroupCleared: ((processGroupId: number) => void) | undefined;
  readonly #rawToLocalItem = new Map<string, string>();
  readonly #fileLocationsByRawItem = new Map<string, ProjectedFileLocations>();
  readonly #itemTextBytes = new Map<string, number>();
  readonly #approvalQueue: QueuedApproval[] = [];
  readonly #approvalsByResolutionKey = new Map<string, QueuedApproval>();
  #initialized = false;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #workspacePath: string | null = null;
  #threadId: string | null = null;
  #activeTurn: ActiveTurn | null = null;
  #approvalActive = false;
  #fatalReported = false;
  #turnEventCount = 0;
  #turnTextBytes = 0;
  #turnLocationBytes = 0;
  #nextLocalItemId = 1;

  constructor(
    transport: CodexByteTransport,
    private readonly callbacks: CodexWorkerCallbacks,
    options: CodexWorkerRuntimeOptions = {},
    startupDeadline?: number,
  ) {
    this.#startupTimeoutMs = positiveTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.#operationTimeoutMs = positiveTimeout(
      options.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
    );
    this.#interruptTimeoutMs = positiveTimeout(
      options.interruptTimeoutMs,
      DEFAULT_INTERRUPT_TIMEOUT_MS,
    );
    this.#teardownTimeoutMs = positiveTimeout(
      options.teardownTimeoutMs,
      DEFAULT_TEARDOWN_TIMEOUT_MS,
    );
    this.#startupDeadline =
      startupDeadline !== undefined && Number.isFinite(startupDeadline) && startupDeadline > 0
        ? startupDeadline
        : null;
    this.#onProcessGroupCleared = options.onProcessGroupCleared;
    this.#rpc = new CodexRpcConnection(transport, {
      onNotification: (method, params) => this.#notification(method, params),
      onServerRequest: (id, method, params) => this.#serverRequest(id, method, params),
      onFatal: () => this.#fatal(),
    });
  }

  async initialize(): Promise<void> {
    if (this.#disposed || this.#initialized) throw new CodexWorkerError("startup-failed");
    const startupDeadline = this.#startupDeadline ?? Date.now() + this.#startupTimeoutMs;
    try {
      parseInitializeResult(
        await this.#rpc.request(
          "initialize",
          {
            clientInfo: {
              name: "hype_comms",
              title: "Hype Comms",
              version: "1",
            },
            capabilities: null,
          },
          remainingTimeout(startupDeadline),
        ),
      );
      await this.#rpc.notify("initialized");
      const account = parseAccountResult(
        await this.#rpc.request(
          "account/read",
          { refreshToken: false },
          remainingTimeout(startupDeadline),
        ),
      );
      if (!account.authenticated) throw new CodexWorkerError("not-authenticated");
      this.#initialized = true;
    } catch (error) {
      if (error instanceof CodexWorkerError && error.code === "not-authenticated") throw error;
      if (
        (error instanceof CodexWorkerError && error.code === "protocol-failed") ||
        error instanceof CodexProtocolError
      ) {
        throw new CodexWorkerError("protocol-failed");
      }
      throw new CodexWorkerError("startup-failed");
    }
  }

  get processGroupId(): number | null {
    return this.#rpc.processGroupId;
  }

  #assertReady(): void {
    if (!this.#initialized || this.#disposed) throw new CodexWorkerError("protocol-failed");
  }

  #assertWorkspace(workspacePath: string): void {
    if (
      workspacePath.length === 0 ||
      workspacePath.length > 4_096 ||
      workspacePath.includes("\0") ||
      !path.isAbsolute(workspacePath) ||
      path.normalize(workspacePath) !== workspacePath
    ) {
      throw new CodexWorkerError("conversation-failed");
    }
  }

  async newConversation(workspacePath: string): Promise<{ readonly conversationId: string }> {
    this.#assertReady();
    this.#assertWorkspace(workspacePath);
    if (this.#threadId !== null) throw new CodexWorkerError("conversation-failed");
    this.#workspacePath = workspacePath;
    try {
      const response = parseThreadResult(
        await this.#rpc.request(
          "thread/start",
          codexThreadPolicy(workspacePath),
          this.#operationTimeoutMs,
        ),
      );
      this.#threadId = response.threadId;
      return { conversationId: response.threadId };
    } catch {
      this.#workspacePath = null;
      throw new CodexWorkerError("conversation-failed");
    }
  }

  async resumeConversation(workspacePath: string, conversationId: string): Promise<void> {
    this.#assertReady();
    this.#assertWorkspace(workspacePath);
    if (this.#threadId !== null || conversationId.length === 0 || conversationId.includes("\0")) {
      throw new CodexWorkerError("conversation-failed");
    }
    this.#workspacePath = workspacePath;
    try {
      const response = parseThreadResult(
        await this.#rpc.request(
          "thread/resume",
          { threadId: conversationId, ...codexThreadPolicy(workspacePath) },
          this.#operationTimeoutMs,
        ),
      );
      if (response.threadId !== conversationId) throw new CodexWorkerError("protocol-failed");
      this.#threadId = response.threadId;
    } catch (error) {
      this.#workspacePath = null;
      if (error instanceof CodexRemoteError) {
        if (isMissingCodexThreadError(error.value)) {
          throw new CodexWorkerError("conversation-not-found");
        }
        throw new CodexWorkerError("conversation-failed");
      }
      if (error instanceof CodexWorkerError) throw error;
      throw new CodexWorkerError("protocol-failed");
    }
  }

  #localItemId(rawItemId: string): string {
    const existing = this.#rawToLocalItem.get(rawItemId);
    if (existing !== undefined) return existing;
    if (this.#rawToLocalItem.size >= MAX_CODEX_TURN_CORRELATIONS) {
      throw new CodexWorkerError("protocol-failed");
    }
    const local = `codex-item-${this.#nextLocalItemId}`;
    this.#nextLocalItemId += 1;
    if (!Number.isSafeInteger(this.#nextLocalItemId)) {
      throw new CodexWorkerError("protocol-failed");
    }
    this.#rawToLocalItem.set(rawItemId, local);
    return local;
  }

  #resetTurnProjectionState(): void {
    this.#rawToLocalItem.clear();
    this.#fileLocationsByRawItem.clear();
    this.#itemTextBytes.clear();
    this.#turnEventCount = 0;
    this.#turnTextBytes = 0;
    this.#turnLocationBytes = 0;
  }

  #rememberFileLocations(rawItemId: string, locations: readonly string[]): void {
    const bytes = locations.reduce(
      (total, location) => total + Buffer.byteLength(location, "utf8"),
      0,
    );
    const previousBytes = this.#fileLocationsByRawItem.get(rawItemId)?.bytes ?? 0;
    const nextTotal = this.#turnLocationBytes - previousBytes + bytes;
    if (nextTotal > MAX_CODEX_TURN_LOCATION_BYTES) {
      throw new CodexWorkerError("protocol-failed");
    }
    this.#fileLocationsByRawItem.set(rawItemId, { locations, bytes });
    this.#turnLocationBytes = nextTotal;
  }

  async #emit(event: AiAgentHostEvent): Promise<void> {
    this.#turnEventCount += 1;
    if (this.#turnEventCount > MAX_CODEX_TURN_EVENTS) {
      throw new CodexWorkerError("protocol-failed");
    }
    if (event.type === "message-update") {
      const itemKey = event.messageId ?? `${event.role}:anonymous`;
      const previousBytes = this.#itemTextBytes.get(itemKey) ?? 0;
      const eventBytes = Buffer.byteLength(event.text, "utf8");
      const nextBytes = event.operation === "append" ? previousBytes + eventBytes : eventBytes;
      const nextTotal = this.#turnTextBytes - previousBytes + nextBytes;
      if (nextBytes > MAX_CODEX_PROJECTED_TEXT_BYTES || nextTotal > MAX_CODEX_TURN_TEXT_BYTES) {
        throw new CodexWorkerError("protocol-failed");
      }
      this.#itemTextBytes.set(itemKey, nextBytes);
      this.#turnTextBytes = nextTotal;
    }
    try {
      await this.callbacks.onEvent(event);
    } catch {
      this.#fatal();
    }
  }

  async prompt(conversationId: string, prompt: string): Promise<void> {
    this.#assertReady();
    if (
      this.#threadId !== conversationId ||
      this.#workspacePath === null ||
      this.#activeTurn !== null ||
      Buffer.byteLength(prompt, "utf8") > MAX_CODEX_PROJECTED_TEXT_BYTES
    ) {
      throw new CodexWorkerError("turn-failed");
    }
    const ready = deferred();
    const completion = deferred();
    this.#resetTurnProjectionState();
    const active: ActiveTurn = {
      threadId: conversationId,
      turnId: null,
      cancellationRequested: false,
      localFailureRequested: false,
      interruptRequested: false,
      responseReceived: false,
      terminalStatus: null,
      settled: false,
      ready: ready.promise,
      markReady: ready.resolve,
      completion: completion.promise,
      resolve: completion.resolve,
      reject: completion.reject,
    };
    this.#activeTurn = active;

    try {
      const result = parseTurnStartResult(
        await this.#rpc.request(
          "turn/start",
          {
            threadId: conversationId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            ...codexTurnPolicy(this.#workspacePath),
          },
          this.#operationTimeoutMs,
        ),
      );
      if (active.turnId !== null && active.turnId !== result.turnId) {
        throw new CodexWorkerError("protocol-failed");
      }
      active.turnId = result.turnId;
      active.responseReceived = true;
      active.markReady();
      this.#interruptLocalFailure(active);
      this.#finishTurnIfReady(active);
      await active.completion;
    } catch (error) {
      if (this.#activeTurn === active) {
        this.#activeTurn = null;
        this.#resetTurnProjectionState();
      }
      this.#cancelApprovals();
      if (!active.settled) {
        active.settled = true;
        active.markReady();
        active.reject(new CodexWorkerError("turn-failed"));
      }
      void active.completion.catch(() => undefined);
      throw error instanceof CodexWorkerError ? error : new CodexWorkerError("turn-failed");
    }
  }

  #finishTurnIfReady(active: ActiveTurn): void {
    if (
      active.settled ||
      !active.responseReceived ||
      active.turnId === null ||
      active.terminalStatus === null
    ) {
      return;
    }
    active.settled = true;
    if (this.#activeTurn === active) this.#activeTurn = null;
    this.#cancelApprovals();
    this.#resetTurnProjectionState();
    if (active.terminalStatus === "completed" && !active.localFailureRequested) active.resolve();
    else active.reject(new CodexWorkerError("turn-failed"));
  }

  async cancel(conversationId: string): Promise<void> {
    this.#assertReady();
    const active = this.#activeTurn;
    if (active === null || active.threadId !== conversationId) return;
    active.cancellationRequested = true;
    this.#cancelApprovals();
    await boundedTimeout(active.ready, this.#interruptTimeoutMs, "turn-failed");
    if (active.turnId === null) throw new CodexWorkerError("turn-failed");
    if (!active.interruptRequested) {
      active.interruptRequested = true;
      try {
        parseEmptyResult(
          await this.#rpc.request(
            "turn/interrupt",
            { threadId: active.threadId, turnId: active.turnId },
            this.#interruptTimeoutMs,
          ),
        );
      } catch {
        // Completion can win the race with the interrupt acknowledgement.
        if (active.terminalStatus === null) throw new CodexWorkerError("turn-failed");
      }
    }
    try {
      await boundedTimeout(active.completion, this.#teardownTimeoutMs, "turn-failed");
    } catch {
      if (active.terminalStatus !== "interrupted") throw new CodexWorkerError("turn-failed");
    }
  }

  async close(conversationId: string): Promise<void> {
    this.#assertReady();
    if (this.#threadId !== conversationId) return;
    this.#cancelApprovals();
    if (this.#activeTurn !== null) await this.cancel(conversationId);
    try {
      await boundedTimeout(
        this.#rpc
          .request("thread/unsubscribe", { threadId: conversationId }, this.#teardownTimeoutMs)
          .then((result) => parseEmptyResult(result)),
        this.#teardownTimeoutMs,
        "conversation-failed",
      );
    } catch {
      // Unsubscribe is best effort and is not required for teardown.
    }
    this.#threadId = null;
    this.#workspacePath = null;
    this.#resetTurnProjectionState();
  }

  async #notification(method: string, params: unknown): Promise<void> {
    if (this.#workspacePath === null) {
      // Initialization can emit additive account/config notifications. Recognized lifecycle
      // notifications before a thread exists are incompatible.
      if (method === "thread/started" || method.startsWith("turn/") || method.startsWith("item/")) {
        this.#fatal();
      }
      return;
    }
    let notification: CodexNotification;
    try {
      notification = parseCodexNotification(method, params, this.#workspacePath);
    } catch {
      this.#fatal();
      return;
    }
    switch (notification.kind) {
      case "unknown":
      case "thread-started":
        return;
      case "server-request-resolved": {
        if (notification.threadId !== this.#threadId) return;
        const approval = this.#approvalsByResolutionKey.get(String(notification.approvalKey));
        if (approval !== undefined) {
          approval.settled = true;
          approval.controller.abort();
          this.#approvalsByResolutionKey.delete(approval.request.approvalKey);
          this.#rpc.resolveServerRequest(approval.request.rpcId);
          const index = this.#approvalQueue.indexOf(approval);
          if (index >= 0) this.#approvalQueue.splice(index, 1);
          void this.#drainApprovalQueue();
        }
        return;
      }
      default:
        break;
    }

    const active = this.#activeTurn;
    if (
      active === null ||
      notification.threadId !== active.threadId ||
      (active.turnId !== null && notification.turnId !== active.turnId)
    ) {
      return;
    }
    if (active.turnId === null && notification.kind !== "turn-started") {
      // Deltas or completion cannot precede both the start response and started notification.
      this.#fatal();
      return;
    }
    switch (notification.kind) {
      case "turn-started":
        if (notification.status !== "inProgress") {
          this.#fatal();
          return;
        }
        active.turnId = notification.turnId;
        this.#interruptLocalFailure(active);
        return;
      case "turn-completed":
        if (notification.status === "inProgress") {
          this.#fatal();
          return;
        }
        active.terminalStatus = notification.status;
        this.#finishTurnIfReady(active);
        return;
      case "agent-message-delta":
        await this.#emit({
          type: "message-update",
          conversationId: active.threadId,
          messageId: this.#localItemId(notification.itemId),
          role: "assistant",
          operation: "append",
          text: truncateCodexUtf8(notification.delta, MAX_CODEX_PROJECTED_TEXT_BYTES),
        });
        return;
      case "reasoning-summary-delta":
        await this.#emit({
          type: "message-update",
          conversationId: active.threadId,
          messageId: this.#localItemId(notification.itemId),
          role: "thought",
          operation: "append",
          text: truncateCodexUtf8(notification.delta, MAX_CODEX_PROJECTED_TEXT_BYTES),
        });
        return;
      case "item-started":
      case "item-completed": {
        const item =
          notification.kind === "item-completed"
            ? this.#completedProjection(notification.item)
            : notification.item;
        const event = codexItemEvent(
          active.threadId,
          this.#localItemId(item.itemId),
          item,
          notification.kind === "item-started" ? "started" : "completed",
        );
        const updatesFileLocations = item.type === "tool" && item.toolKind === "edit";
        if (updatesFileLocations) {
          this.#rememberFileLocations(item.itemId, item.locations);
        }
        if (event !== null) await this.#emit(event);
        if (updatesFileLocations) void this.#drainApprovalQueue();
        return;
      }
      case "plan-updated":
        await this.#emit({
          type: "plan-replace",
          conversationId: active.threadId,
          entries: notification.plan.map((entry) => ({
            content: entry.step,
            priority: null,
            status: entry.status,
          })),
        });
        return;
      case "error":
        // `turn/completed` is the only authoritative terminal signal, including after a
        // non-retrying error notification.
        return;
    }
  }

  #completedProjection(item: CodexProjectedItem): CodexProjectedItem {
    return item.type === "tool" && item.status === "in_progress"
      ? { ...item, status: "completed" }
      : item;
  }

  async #serverRequest(id: CodexRequestId, method: string, params: unknown): Promise<void> {
    let request: CodexServerRequest;
    try {
      request = parseCodexServerRequest(id, method, params);
    } catch {
      await this.#rpc.respondError(id, -32602, "Invalid params");
      this.#fatal();
      return;
    }
    switch (request.kind) {
      case "permissions-approval":
        // Candidate 0.147.0 exposes only a blanket network grant. Lite never presents it as a
        // destination-scoped permission and grants neither network nor extra filesystem access.
        await this.#rpc.respond(request.rpcId, { permissions: {}, scope: "turn" });
        return;
      case "safe-negative":
        await this.#rpc.respond(
          request.rpcId,
          request.method === "mcpServer/elicitation/request"
            ? { action: "cancel", content: null, _meta: null }
            : { answers: {} },
        );
        return;
      case "unsupported":
        await this.#rpc.respondError(request.rpcId, -32601, "Method not supported");
        this.#failTurn();
        return;
      case "unknown":
        await this.#rpc.respondError(request.rpcId, -32601, "Method not supported");
        return;
      case "command-approval":
      case "file-approval":
        break;
    }

    const active = this.#activeTurn;
    if (
      active === null ||
      active.turnId === null ||
      active.cancellationRequested ||
      active.localFailureRequested ||
      request.threadId !== active.threadId ||
      request.turnId !== active.turnId
    ) {
      await this.#rpc.respond(request.rpcId, { decision: "cancel" });
      return;
    }
    if (this.#approvalQueue.length >= MAX_CODEX_APPROVAL_QUEUE) {
      await this.#rpc.respond(request.rpcId, { decision: "cancel" });
      this.#failTurn();
      return;
    }
    const approval: QueuedApproval = {
      localItemId: this.#localItemId(request.itemId),
      request,
      controller: new AbortController(),
      settled: false,
    };
    if (this.#approvalsByResolutionKey.has(request.approvalKey)) {
      await this.#rpc.respond(request.rpcId, { decision: "cancel" });
      this.#fatal();
      return;
    }
    this.#approvalQueue.push(approval);
    this.#approvalsByResolutionKey.set(request.approvalKey, approval);
    await this.#drainApprovalQueue();
  }

  async #drainApprovalQueue(): Promise<void> {
    if (this.#approvalActive) return;
    const approval = this.#approvalQueue.find((candidate) => !candidate.settled);
    if (approval === undefined || this.#workspacePath === null) return;
    if (
      approval.request.kind === "file-approval" &&
      !this.#fileLocationsByRawItem.has(approval.request.itemId)
    ) {
      return;
    }
    this.#approvalActive = true;
    try {
      const tool = codexApprovalTool(
        approval.request,
        approval.localItemId,
        this.#workspacePath,
        this.#fileLocationsByRawItem.get(approval.request.itemId)?.locations ?? [],
      );
      const outcome = await this.callbacks.requestPermission(
        codexPermissionRequest(approval.request.threadId, tool),
        approval.controller.signal,
      );
      if (!approval.settled) {
        approval.settled = true;
        this.#approvalsByResolutionKey.delete(approval.request.approvalKey);
        await this.#rpc.respond(approval.request.rpcId, { decision: remoteDecision(outcome) });
      }
    } catch {
      if (!approval.settled) {
        approval.settled = true;
        this.#approvalsByResolutionKey.delete(approval.request.approvalKey);
        await this.#rpc
          .respond(approval.request.rpcId, { decision: "cancel" })
          .catch(() => undefined);
      }
    } finally {
      const index = this.#approvalQueue.indexOf(approval);
      if (index >= 0) this.#approvalQueue.splice(index, 1);
      this.#approvalActive = false;
      void this.#drainApprovalQueue();
    }
  }

  #cancelApprovals(): void {
    for (const approval of this.#approvalQueue) {
      if (approval.settled) continue;
      approval.settled = true;
      approval.controller.abort();
      this.#approvalsByResolutionKey.delete(approval.request.approvalKey);
      void this.#rpc.respond(approval.request.rpcId, { decision: "cancel" }).catch(() => undefined);
    }
    this.#approvalQueue.length = 0;
  }

  #failTurn(): void {
    const active = this.#activeTurn;
    if (active === null || active.settled || active.localFailureRequested) return;
    active.localFailureRequested = true;
    this.#cancelApprovals();
    this.#interruptLocalFailure(active);
  }

  #interruptLocalFailure(active: ActiveTurn): void {
    if (
      !active.localFailureRequested ||
      active.interruptRequested ||
      active.settled ||
      active.turnId === null ||
      active.terminalStatus !== null
    ) {
      return;
    }
    active.interruptRequested = true;
    void this.#rpc
      .request(
        "turn/interrupt",
        { threadId: active.threadId, turnId: active.turnId },
        this.#interruptTimeoutMs,
      )
      .then((result) => {
        parseEmptyResult(result);
        return boundedTimeout(active.completion, this.#teardownTimeoutMs, "turn-failed");
      })
      .catch(() => {
        if (this.#activeTurn === active && !active.settled && active.terminalStatus === null) {
          this.#fatal();
        }
      });
  }

  #fatal(): void {
    if (this.#fatalReported) return;
    this.#fatalReported = true;
    this.#rpc.fail();
    this.#cancelApprovals();
    const active = this.#activeTurn;
    if (active !== null && !active.settled) {
      active.settled = true;
      active.markReady();
      active.reject(
        new CodexWorkerError(active.localFailureRequested ? "turn-failed" : "protocol-failed"),
      );
      void active.completion.catch(() => undefined);
      this.#activeTurn = null;
    }
    this.#resetTurnProjectionState();
    try {
      this.callbacks.onFatal();
    } catch {
      // No raw transport state is reported.
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#disposeWithinDeadline();
    return this.#disposePromise;
  }

  async #disposeWithinDeadline(): Promise<void> {
    const deadline = Date.now() + Math.max(1, this.#teardownTimeoutMs);
    const cleanupReserve = Math.min(
      PROCESS_CLEANUP_RESERVE_MS,
      Math.max(0, this.#teardownTimeoutMs - 1),
    );
    const operationCutoff = deadline - cleanupReserve;
    this.#cancelApprovals();
    const threadId = this.#threadId;
    const active = this.#activeTurn;
    if (active !== null) {
      active.cancellationRequested = true;
      const readyRemaining = operationCutoff - Date.now();
      if (readyRemaining > 0) {
        await boundedTimeout(active.ready, readyRemaining, "turn-failed").catch(() => undefined);
      }
      if (active.turnId !== null && active.terminalStatus === null) {
        const interruptRemaining = operationCutoff - Date.now();
        if (interruptRemaining > 0) {
          await boundedTimeout(
            this.#rpc
              .request(
                "turn/interrupt",
                { threadId: active.threadId, turnId: active.turnId },
                interruptRemaining,
              )
              .then((result) => parseEmptyResult(result)),
            interruptRemaining,
            "turn-failed",
          ).catch(() => undefined);
        }
      }
      const completionRemaining = operationCutoff - Date.now();
      if (!active.settled && completionRemaining > 0) {
        await boundedTimeout(active.completion, completionRemaining, "turn-failed").catch(
          () => undefined,
        );
      }
    }
    if (threadId !== null) {
      const unsubscribeRemaining = operationCutoff - Date.now();
      if (unsubscribeRemaining > 0) {
        await boundedTimeout(
          this.#rpc
            .request("thread/unsubscribe", { threadId }, unsubscribeRemaining)
            .then((result) => parseEmptyResult(result)),
          unsubscribeRemaining,
          "conversation-failed",
        ).catch(() => undefined);
      }
    }
    if (active !== null && !active.settled) {
      active.settled = true;
      active.markReady();
      active.reject(new CodexWorkerError("turn-failed"));
      void active.completion.catch(() => undefined);
    }
    this.#activeTurn = null;
    this.#threadId = null;
    this.#workspacePath = null;
    this.#resetTurnProjectionState();
    try {
      this.#rpc.close();
    } catch {
      // Process-group cleanup remains mandatory even if stdin cannot be closed cleanly.
    }
    await Promise.race([this.#rpc.ended, timerUntil(operationCutoff)]);
    // Kill the process group even after clean app-server EOF so command descendants cannot remain.
    const processGroupId = this.#rpc.processGroupId;
    const groupCleared = await Promise.race([
      this.#rpc.kill(deadline),
      timerUntil(deadline).then(() => false),
    ]);
    if (processGroupId !== null && groupCleared) {
      try {
        this.#onProcessGroupCleared?.(processGroupId);
      } catch {
        // The host retains the active group handle when a clear cannot be delivered.
      }
    }
  }
}

function processTransport(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  sendSignal: CodexProcessSignal,
): CodexByteTransport {
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    // Keep only a byte count up to a small bound for internal classification. No raw stderr is
    // decoded, logged, or sent to the main process.
    stderrBytes = Math.min(MAX_STDERR_CAPTURE_BYTES, stderrBytes + chunk.byteLength);
  });
  const processGroupId =
    child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 0
      ? child.pid
      : undefined;
  return {
    ...(processGroupId === undefined ? {} : { processGroupId }),
    write(bytes) {
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(bytes, (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      });
    },
    closeInput() {
      child.stdin.end();
    },
    async kill(deadline = Date.now()) {
      killCodexProcessGroup(child, platform, sendSignal);
      if (platform === "win32" || processGroupId === undefined) return false;
      return confirmCodexProcessGroupExit(processGroupId, deadline, sendSignal);
    },
    onData(listener) {
      child.stdout.on("data", (chunk: Buffer) => listener(chunk));
    },
    onEnd(listener) {
      child.stdout.once("end", listener);
      child.once("exit", listener);
    },
    onError(listener) {
      child.once("error", listener);
      child.stdin.once("error", listener);
      child.stdout.once("error", listener);
    },
  };
}

export interface ProductionWorkerDependencies extends CodexExecutableDependencies {
  readonly spawnProcess?: typeof spawn;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  readonly processSignal?: CodexProcessSignal;
  readonly onProcessGroupSpawned?: (processGroupId: number) => boolean | void;
  readonly onProcessGroupCleared?: (processGroupId: number) => boolean | void;
}

type VersionOutcome =
  | { readonly value: string; readonly error?: never }
  | { readonly value?: never; readonly error: CodexWorkerError };

export async function readCodexVersion(
  executable: string,
  dependencies: ProductionWorkerDependencies,
): Promise<string> {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const sendSignal = dependencies.processSignal ?? process.kill;
  const timeoutMs = positiveTimeout(dependencies.versionTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const cleanupReserve = Math.min(PROCESS_CLEANUP_RESERVE_MS, Math.max(0, timeoutMs - 1));
  const operationCutoff = deadline - cleanupReserve;
  return new Promise<string>((resolve, reject) => {
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let finalizing = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(executable, ["--version"], {
        shell: false,
        detached: platform !== "win32",
        env: { ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch {
      reject(new CodexWorkerError("not-installed"));
      return;
    }
    const processGroupId = child.pid;
    if (
      platform === "win32" ||
      processGroupId === undefined ||
      !Number.isSafeInteger(processGroupId) ||
      processGroupId <= 0
    ) {
      killCodexProcessGroup(child, platform, sendSignal);
      reject(new CodexWorkerError("startup-failed"));
      return;
    }

    let announced = false;
    try {
      announced = dependencies.onProcessGroupSpawned?.(processGroupId) !== false;
    } catch {
      announced = false;
    }

    const finalize = (outcome: VersionOutcome): void => {
      if (finalizing) return;
      finalizing = true;
      clearTimeout(timeout);
      killCodexProcessGroup(child, platform, sendSignal);
      void (async () => {
        const groupGone = await confirmCodexProcessGroupExit(processGroupId, deadline, sendSignal);
        if (!groupGone) {
          reject(new CodexWorkerError("startup-failed"));
          return;
        }
        if (announced) {
          try {
            if (dependencies.onProcessGroupCleared?.(processGroupId) === false) {
              reject(new CodexWorkerError("startup-failed"));
              return;
            }
          } catch {
            reject(new CodexWorkerError("startup-failed"));
            return;
          }
        }
        if (outcome.error !== undefined) reject(outcome.error);
        else resolve(outcome.value);
      })();
    };

    const timeout = setTimeout(
      () => finalize({ error: new CodexWorkerError("startup-failed") }),
      Math.max(0, operationCutoff - Date.now()),
    );
    timeout.unref();
    if (!announced) {
      finalize({ error: new CodexWorkerError("startup-failed") });
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (finalizing) return;
      if (outputBytes + chunk.byteLength > MAX_VERSION_OUTPUT_BYTES) {
        finalize({ error: new CodexWorkerError("unsupported-version") });
        return;
      }
      outputChunks.push(Buffer.from(chunk));
      outputBytes += chunk.byteLength;
    });
    child.stderr.on("data", () => {
      // Drain without decoding or retaining provider diagnostics.
    });
    child.once("error", () => {
      finalize({ error: new CodexWorkerError("not-installed") });
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finalize({ error: new CodexWorkerError("startup-failed") });
        return;
      }
      const output = Buffer.concat(outputChunks, outputBytes);
      const version = parseCodexCliVersion(output.toString("utf8"));
      if (version === null || !isSupportedCodexCliVersion(version)) {
        finalize({ error: new CodexWorkerError("unsupported-version") });
        return;
      }
      finalize({ value: version });
    });
  });
}

export async function createProductionCodexRuntime(
  callbacks: CodexWorkerCallbacks,
  dependencies: ProductionWorkerDependencies = {},
): Promise<CodexAppServerWorkerRuntime> {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const sendSignal = dependencies.processSignal ?? process.kill;
  const startupDeadline =
    Date.now() + positiveTimeout(dependencies.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  if (platform === "win32") throw new CodexWorkerError("startup-failed");
  const executable = await boundedStartupOperation(startupDeadline, () =>
    resolveCodexExecutable({ ...dependencies, environment }),
  );
  const versionTimeoutMs = remainingTimeout(startupDeadline);
  await readCodexVersion(executable, {
    ...dependencies,
    environment,
    platform,
    processSignal: sendSignal,
    versionTimeoutMs: Math.min(
      positiveTimeout(dependencies.versionTimeoutMs, versionTimeoutMs),
      versionTimeoutMs,
    ),
  });
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(executable, ["app-server", "--stdio"], {
      shell: false,
      detached: true,
      env: { ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch {
    throw new CodexWorkerError("startup-failed");
  }
  const processGroupId = child.pid;
  if (
    processGroupId === undefined ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    killCodexProcessGroup(child, platform, sendSignal);
    throw new CodexWorkerError("startup-failed");
  }
  try {
    if (dependencies.onProcessGroupSpawned?.(processGroupId) === false) {
      throw new CodexWorkerError("startup-failed");
    }
  } catch {
    killCodexProcessGroup(child, platform, sendSignal);
    await confirmCodexProcessGroupExit(
      processGroupId,
      Date.now() + positiveTimeout(dependencies.teardownTimeoutMs, DEFAULT_TEARDOWN_TIMEOUT_MS),
      sendSignal,
    );
    throw new CodexWorkerError("startup-failed");
  }
  const runtime = new CodexAppServerWorkerRuntime(
    processTransport(child, platform, sendSignal),
    callbacks,
    {
      startupTimeoutMs: dependencies.startupTimeoutMs,
      operationTimeoutMs: dependencies.operationTimeoutMs,
      interruptTimeoutMs: dependencies.interruptTimeoutMs,
      teardownTimeoutMs: dependencies.teardownTimeoutMs,
      onProcessGroupCleared: dependencies.onProcessGroupCleared,
    },
    startupDeadline,
  );
  try {
    await runtime.initialize();
    return runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type CodexUtilityRequest =
  | { readonly type: "codex-request"; readonly id: number; readonly method: "connect" }
  | {
      readonly type: "codex-request";
      readonly id: number;
      readonly method: "new-conversation";
      readonly workspacePath: string;
    }
  | {
      readonly type: "codex-request";
      readonly id: number;
      readonly method: "resume-conversation";
      readonly workspacePath: string;
      readonly conversationId: string;
    }
  | {
      readonly type: "codex-request";
      readonly id: number;
      readonly method: "prompt";
      readonly conversationId: string;
      readonly prompt: string;
    }
  | {
      readonly type: "codex-request";
      readonly id: number;
      readonly method: "cancel" | "close";
      readonly conversationId: string;
    }
  | { readonly type: "codex-request"; readonly id: number; readonly method: "dispose" }
  | {
      readonly type: "codex-permission-response";
      readonly permissionId: number;
      readonly outcome: AiAgentHostPermissionOutcome;
    };

export type CodexUtilityMessage =
  | { readonly type: "codex-response"; readonly id: number; readonly result: unknown }
  | { readonly type: "codex-error"; readonly id: number; readonly code: CodexWorkerErrorCode }
  | { readonly type: "codex-event"; readonly event: AiAgentHostEvent }
  | { readonly type: "codex-process-group"; readonly processGroupId: number }
  | { readonly type: "codex-process-group-cleared"; readonly processGroupId: number }
  | {
      readonly type: "codex-permission-request";
      readonly permissionId: number;
      readonly request: AiAgentHostPermissionRequest;
    }
  | { readonly type: "codex-exit"; readonly reason: "transport-failed" };

export interface CodexUtilityMessagePort {
  postMessage(message: CodexUtilityMessage): void;
}

export interface CodexUtilityMessagePoster {
  post(message: CodexUtilityMessage): boolean;
  fatal(): void;
}

/** Posts a fixed small fatal signal before asking the caller to dispose an oversized producer. */
export function createCodexUtilityMessagePoster(
  port: CodexUtilityMessagePort,
  onOversize: () => void,
): CodexUtilityMessagePoster {
  let fatalPosted = false;
  const fatalMessage: CodexUtilityMessage = {
    type: "codex-exit",
    reason: "transport-failed",
  };
  const fatal = (): void => {
    if (fatalPosted) return;
    fatalPosted = true;
    port.postMessage(fatalMessage);
  };
  return {
    fatal,
    post(message) {
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      } catch {
        bytes = MAX_CODEX_OUTGOING_ENVELOPE_BYTES + 1;
      }
      if (bytes > MAX_CODEX_OUTGOING_ENVELOPE_BYTES) {
        fatal();
        onOversize();
        return false;
      }
      port.postMessage(message);
      return true;
    },
  };
}

function utilityRequest(value: unknown): CodexUtilityRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
  if (bytes > 1_024 * 1_024) return null;
  if (candidate.type === "codex-permission-response") {
    if (!Number.isSafeInteger(candidate.permissionId)) return null;
    const outcome = candidate.outcome;
    if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) return null;
    const outcomeRecord = outcome as Record<string, unknown>;
    if (
      outcomeRecord.outcome !== "cancelled" &&
      !(outcomeRecord.outcome === "selected" && typeof outcomeRecord.optionId === "string")
    ) {
      return null;
    }
    return value as CodexUtilityRequest;
  }
  if (candidate.type !== "codex-request" || !Number.isSafeInteger(candidate.id)) return null;
  if (
    candidate.method === "connect" ||
    candidate.method === "dispose" ||
    (candidate.method === "new-conversation" && typeof candidate.workspacePath === "string") ||
    (candidate.method === "resume-conversation" &&
      typeof candidate.workspacePath === "string" &&
      typeof candidate.conversationId === "string") ||
    (candidate.method === "prompt" &&
      typeof candidate.conversationId === "string" &&
      typeof candidate.prompt === "string") ||
    ((candidate.method === "cancel" || candidate.method === "close") &&
      typeof candidate.conversationId === "string")
  ) {
    return value as CodexUtilityRequest;
  }
  return null;
}

function workerErrorCode(error: unknown): CodexWorkerErrorCode {
  return error instanceof CodexWorkerError ? error.code : "protocol-failed";
}

export async function runCodexUtilityWorker(): Promise<void> {
  const parentPort = process.parentPort;
  if (parentPort === null || parentPort === undefined) {
    throw new CodexWorkerError("startup-failed");
  }
  let runtime: CodexAppServerWorkerRuntime | null = null;
  let nextPermissionId = 0;
  const permissions = new Map<
    number,
    {
      readonly resolve: (outcome: AiAgentHostPermissionOutcome) => void;
      readonly signal: AbortSignal;
    }
  >();
  const poster = createCodexUtilityMessagePoster(parentPort, () => {
    void runtime?.dispose().then(
      () => {
        process.exitCode = 1;
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
  const post = (message: CodexUtilityMessage): void => {
    poster.post(message);
  };

  parentPort.on("message", (event) => {
    const request = utilityRequest(event.data);
    if (request === null) {
      void runtime?.dispose();
      process.exitCode = 1;
      return;
    }
    if (request.type === "codex-permission-response") {
      const pending = permissions.get(request.permissionId);
      if (pending !== undefined && !pending.signal.aborted) {
        permissions.delete(request.permissionId);
        pending.resolve(request.outcome);
      }
      return;
    }
    void (async () => {
      try {
        if (request.method === "connect") {
          if (runtime !== null) throw new CodexWorkerError("startup-failed");
          runtime = await createProductionCodexRuntime(
            {
              onEvent(eventValue) {
                post({ type: "codex-event", event: eventValue });
              },
              requestPermission(requestValue, signal) {
                const permissionId = nextPermissionId;
                nextPermissionId += 1;
                return new Promise<AiAgentHostPermissionOutcome>((resolve) => {
                  permissions.set(permissionId, { resolve, signal });
                  signal.addEventListener(
                    "abort",
                    () => {
                      if (permissions.delete(permissionId)) resolve({ outcome: "cancelled" });
                    },
                    { once: true },
                  );
                  post({
                    type: "codex-permission-request",
                    permissionId,
                    request: requestValue,
                  });
                });
              },
              onFatal() {
                const current = runtime;
                if (current === null) {
                  post({ type: "codex-exit", reason: "transport-failed" });
                  return;
                }
                void current.dispose().then(
                  () => post({ type: "codex-exit", reason: "transport-failed" }),
                  () => post({ type: "codex-exit", reason: "transport-failed" }),
                );
              },
            },
            {
              onProcessGroupSpawned(processGroupId) {
                return poster.post({ type: "codex-process-group", processGroupId });
              },
              onProcessGroupCleared(processGroupId) {
                return poster.post({ type: "codex-process-group-cleared", processGroupId });
              },
            },
          );
          post({ type: "codex-response", id: request.id, result: {} });
          return;
        }
        if (runtime === null) throw new CodexWorkerError("startup-failed");
        switch (request.method) {
          case "new-conversation":
            post({
              type: "codex-response",
              id: request.id,
              result: await runtime.newConversation(request.workspacePath),
            });
            return;
          case "resume-conversation":
            await runtime.resumeConversation(request.workspacePath, request.conversationId);
            break;
          case "prompt":
            await runtime.prompt(request.conversationId, request.prompt);
            break;
          case "cancel":
            await runtime.cancel(request.conversationId);
            break;
          case "close":
            await runtime.close(request.conversationId);
            break;
          case "dispose":
            await runtime.dispose();
            break;
        }
        post({ type: "codex-response", id: request.id, result: {} });
      } catch (error) {
        post({ type: "codex-error", id: request.id, code: workerErrorCode(error) });
      }
    })();
  });
}

if (process.parentPort !== null && process.parentPort !== undefined) {
  void runCodexUtilityWorker().catch(() => {
    process.exitCode = 1;
  });
}
