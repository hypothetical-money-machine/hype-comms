import path from "node:path";

import { utilityProcess, type UtilityProcess } from "electron";

import {
  AiAgentHostError,
  type AiAgentHost,
  type AiAgentHostCallbacks,
  type AiAgentHostEvent,
  type AiAgentHostLocation,
  type AiAgentHostPlanEntry,
  type AiAgentHostPermissionOutcome,
  type AiAgentHostPermissionRequest,
  type AiAgentHostTool,
  type CreateAiAgentHost,
} from "./ai-agent-host";
import type { CodexUtilityRequest, CodexWorkerErrorCode } from "./codex-app-server-worker";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 3_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 3_000;
const PROCESS_GROUP_CLEANUP_RESERVE_MS = 100;
const MAX_CODEX_WORKER_MESSAGE_BYTES = 1 * 1_024 * 1_024;
const MAX_PENDING_WORKER_REQUESTS = 32;
const MAX_PENDING_PERMISSION_REQUESTS = 32;
const WORKER_SERVICE_NAME = "Hype Comms Codex App Server";

const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "APPDATA",
  "CODEX_EXECUTABLE",
  "CODEX_HOME",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

export interface CodexUtilityWorkerLaunch {
  readonly modulePath: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CodexUtilityWorker {
  readonly spawned: Promise<void>;
  postMessage(message: unknown): void;
  killProcessGroup(processGroupId: number): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  onFatalError(listener: () => void): void;
}

export interface CodexAppServerHostDependencies {
  /** No product configuration mode is approved yet; tests must opt in with an injected worker. */
  readonly configurationMode?: "disabled" | "test-only";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly workerPath?: string;
  readonly forkWorker?: (launch: CodexUtilityWorkerLaunch) => CodexUtilityWorker;
  readonly startupSignal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
}

function boundedMessageBytes(value: unknown): number | null {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return bytes <= MAX_CODEX_WORKER_MESSAGE_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validWorkerErrorCode(value: unknown): value is CodexWorkerErrorCode {
  return (
    value === "not-installed" ||
    value === "not-authenticated" ||
    value === "unsupported-version" ||
    value === "startup-failed" ||
    value === "protocol-failed" ||
    value === "conversation-not-found" ||
    value === "conversation-failed" ||
    value === "turn-failed"
  );
}

function parseLocation(value: unknown): AiAgentHostLocation | null {
  const candidate = record(value);
  if (
    candidate === null ||
    typeof candidate.path !== "string" ||
    (candidate.line !== undefined &&
      candidate.line !== null &&
      !Number.isSafeInteger(candidate.line))
  ) {
    return null;
  }
  return {
    path: candidate.path,
    ...(candidate.line === undefined ? {} : { line: candidate.line as number | null }),
  };
}

function parseTool(value: unknown): AiAgentHostTool | null {
  const candidate = record(value);
  if (candidate === null || typeof candidate.id !== "string") return null;
  if (
    candidate.title !== undefined &&
    candidate.title !== null &&
    typeof candidate.title !== "string"
  ) {
    return null;
  }
  if (
    candidate.kind !== undefined &&
    candidate.kind !== null &&
    candidate.kind !== "read" &&
    candidate.kind !== "edit" &&
    candidate.kind !== "delete" &&
    candidate.kind !== "move" &&
    candidate.kind !== "search" &&
    candidate.kind !== "execute" &&
    candidate.kind !== "think" &&
    candidate.kind !== "fetch" &&
    candidate.kind !== "other"
  ) {
    return null;
  }
  if (
    candidate.status !== undefined &&
    candidate.status !== null &&
    candidate.status !== "pending" &&
    candidate.status !== "in_progress" &&
    candidate.status !== "completed" &&
    candidate.status !== "failed" &&
    candidate.status !== "declined"
  ) {
    return null;
  }
  let locations: readonly AiAgentHostLocation[] | null | undefined;
  if (candidate.locations === null) {
    locations = null;
  } else if (candidate.locations !== undefined) {
    if (!Array.isArray(candidate.locations)) return null;
    const parsed = candidate.locations.map(parseLocation);
    if (parsed.some((location) => location === null)) return null;
    locations = parsed as AiAgentHostLocation[];
  }
  return {
    id: candidate.id,
    ...(candidate.title === undefined ? {} : { title: candidate.title as string | null }),
    ...(candidate.kind === undefined ? {} : { kind: candidate.kind as AiAgentHostTool["kind"] }),
    ...(candidate.status === undefined
      ? {}
      : { status: candidate.status as AiAgentHostTool["status"] }),
    ...(locations === undefined ? {} : { locations }),
  };
}

function parseEvent(value: unknown): AiAgentHostEvent | null {
  const candidate = record(value);
  if (candidate === null || typeof candidate.conversationId !== "string") return null;
  switch (candidate.type) {
    case "message-update": {
      if (
        (candidate.messageId !== null && typeof candidate.messageId !== "string") ||
        (candidate.role !== "user" &&
          candidate.role !== "assistant" &&
          candidate.role !== "thought") ||
        (candidate.operation !== "append" && candidate.operation !== "replace") ||
        typeof candidate.text !== "string"
      ) {
        return null;
      }
      return {
        type: "message-update",
        conversationId: candidate.conversationId,
        messageId: candidate.messageId,
        role: candidate.role,
        operation: candidate.operation,
        text: candidate.text,
      };
    }
    case "tool-update": {
      const tool = parseTool(candidate.tool);
      if (typeof candidate.isCreation !== "boolean" || tool === null) return null;
      return {
        type: "tool-update",
        conversationId: candidate.conversationId,
        tool,
        isCreation: candidate.isCreation,
      };
    }
    case "plan-replace": {
      if (!Array.isArray(candidate.entries)) return null;
      const entries: AiAgentHostPlanEntry[] = [];
      for (const valueEntry of candidate.entries) {
        const entry = record(valueEntry);
        if (
          entry === null ||
          typeof entry.content !== "string" ||
          (entry.priority !== null &&
            entry.priority !== "low" &&
            entry.priority !== "medium" &&
            entry.priority !== "high") ||
          (entry.status !== "pending" &&
            entry.status !== "in_progress" &&
            entry.status !== "completed")
        ) {
          return null;
        }
        entries.push({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
        });
      }
      return {
        type: "plan-replace",
        conversationId: candidate.conversationId,
        entries,
      };
    }
    case "plan-remove":
      return { type: "plan-remove", conversationId: candidate.conversationId };
    default:
      return null;
  }
}

function parsePermissionRequest(value: unknown): AiAgentHostPermissionRequest | null {
  const candidate = record(value);
  if (
    candidate === null ||
    typeof candidate.conversationId !== "string" ||
    !Array.isArray(candidate.options) ||
    candidate.options.length === 0
  ) {
    return null;
  }
  const tool = parseTool(candidate.tool);
  if (tool === null) return null;
  const options: Array<AiAgentHostPermissionRequest["options"][number]> = [];
  const optionIds = new Set<string>();
  for (const valueOption of candidate.options) {
    const option = record(valueOption);
    if (
      option === null ||
      typeof option.id !== "string" ||
      typeof option.name !== "string" ||
      (option.kind !== "allow_once" && option.kind !== "reject_once")
    ) {
      return null;
    }
    if (optionIds.has(option.id)) return null;
    optionIds.add(option.id);
    options.push({ id: option.id, name: option.name, kind: option.kind });
  }
  return { conversationId: candidate.conversationId, tool, options };
}

type NormalizedCodexUtilityMessage =
  | { readonly type: "codex-response"; readonly id: number; readonly result: unknown }
  | { readonly type: "codex-error"; readonly id: number; readonly code: CodexWorkerErrorCode }
  | { readonly type: "codex-event"; readonly event: AiAgentHostEvent }
  | {
      readonly type: "codex-permission-request";
      readonly permissionId: number;
      readonly request: AiAgentHostPermissionRequest;
    }
  | { readonly type: "codex-process-group"; readonly processGroupId: number }
  | { readonly type: "codex-process-group-cleared"; readonly processGroupId: number }
  | { readonly type: "codex-exit"; readonly reason: "transport-failed" };

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 1 && (value as number) <= 2_147_483_647;
}

function parseUtilityMessage(value: unknown): NormalizedCodexUtilityMessage | null {
  if (boundedMessageBytes(value) === null) return null;
  const candidate = record(value);
  if (candidate === null) return null;
  switch (candidate.type) {
    case "codex-response":
      return nonNegativeSafeInteger(candidate.id) && Object.hasOwn(candidate, "result")
        ? { type: "codex-response", id: candidate.id, result: candidate.result }
        : null;
    case "codex-error":
      return nonNegativeSafeInteger(candidate.id) && validWorkerErrorCode(candidate.code)
        ? { type: "codex-error", id: candidate.id, code: candidate.code }
        : null;
    case "codex-event": {
      const event = parseEvent(candidate.event);
      return event === null ? null : { type: "codex-event", event };
    }
    case "codex-permission-request": {
      const request = parsePermissionRequest(candidate.request);
      return nonNegativeSafeInteger(candidate.permissionId) && request !== null
        ? { type: "codex-permission-request", permissionId: candidate.permissionId, request }
        : null;
    }
    case "codex-process-group":
      return positiveSafeInteger(candidate.processGroupId)
        ? { type: "codex-process-group", processGroupId: candidate.processGroupId }
        : null;
    case "codex-process-group-cleared":
      return positiveSafeInteger(candidate.processGroupId)
        ? { type: "codex-process-group-cleared", processGroupId: candidate.processGroupId }
        : null;
    case "codex-exit":
      return candidate.reason === "transport-failed"
        ? { type: "codex-exit", reason: "transport-failed" }
        : null;
    default:
      return null;
  }
}

export function buildCodexWorkerEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }
  return environment;
}

function productionWorker(launch: CodexUtilityWorkerLaunch): CodexUtilityWorker {
  let processHandle: UtilityProcess;
  try {
    processHandle = utilityProcess.fork(launch.modulePath, [], {
      env: { ...launch.environment },
      serviceName: WORKER_SERVICE_NAME,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new AiAgentHostError("startup-failed");
  }
  const spawned = new Promise<void>((resolve, reject) => {
    processHandle.once("spawn", resolve);
    processHandle.once("exit", () => reject(new AiAgentHostError("startup-failed")));
    processHandle.once("error", () => reject(new AiAgentHostError("startup-failed")));
  });
  return {
    spawned,
    postMessage(message) {
      processHandle.postMessage(message);
    },
    killProcessGroup(processGroupId) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The group may already be gone; the host still kills the utility process afterward.
      }
    },
    kill() {
      processHandle.kill();
    },
    onMessage(listener) {
      processHandle.on("message", listener);
    },
    onExit(listener) {
      processHandle.on("exit", listener);
    },
    onFatalError(listener) {
      processHandle.on("error", listener);
    },
  };
}

interface PendingWorkerRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly resultKind: "empty" | "new-conversation";
  readonly timeout: ReturnType<typeof setTimeout>;
}

function timeoutValue(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mapWorkerError(code: CodexWorkerErrorCode): AiAgentHostError {
  return new AiAgentHostError(code);
}

const INVALID_WORKER_RESULT = Symbol("invalid-worker-result");

function parseWorkerResult(
  value: unknown,
  kind: PendingWorkerRequest["resultKind"],
): unknown | typeof INVALID_WORKER_RESULT {
  const candidate = record(value);
  if (candidate === null) return INVALID_WORKER_RESULT;
  if (kind === "empty") return {};
  return typeof candidate.conversationId === "string"
    ? { conversationId: candidate.conversationId }
    : INVALID_WORKER_RESULT;
}

function cleanupReserve(timeoutMs: number): number {
  return Math.min(PROCESS_GROUP_CLEANUP_RESERVE_MS, Math.max(1, Math.floor(timeoutMs / 4)));
}

function gracefulDeadline(timeoutMs: number): number {
  return Date.now() + timeoutMs - cleanupReserve(timeoutMs);
}

function remainingUntil(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

class CodexAppServerHostImplementation implements AiAgentHost {
  readonly #pending = new Map<number, PendingWorkerRequest>();
  readonly #permissions = new Map<
    number,
    { readonly controller: AbortController; readonly optionIds: ReadonlySet<string> }
  >();
  #nextId = 1;
  #nextPermissionId = 0;
  #disposed = false;
  #failed = false;
  #expectedExit = false;
  #exitReported = false;
  #connected = false;
  #processGroupId: number | null = null;
  #workerKilled = false;
  #disposePromise: Promise<void> | null = null;
  #retirementGracefulDeadline: number | null = null;

  constructor(
    private readonly worker: CodexUtilityWorker,
    private readonly callbacks: AiAgentHostCallbacks,
    private readonly operationTimeoutMs: number,
    private readonly interruptTimeoutMs: number,
    private readonly teardownTimeoutMs: number,
  ) {
    worker.onMessage((message) => this.#message(message));
    worker.onExit(() => this.#workerExit("exited"));
    worker.onFatalError(() => this.#workerExit("transport-failed"));
  }

  async connect(timeoutMs: number): Promise<void> {
    await this.#request(
      { type: "codex-request", id: 0, method: "connect" },
      timeoutMs,
      "empty",
      true,
    );
    if (this.#processGroupId === null) {
      this.#fail();
      throw new AiAgentHostError("protocol-failed");
    }
    this.#connected = true;
  }

  #message(value: unknown): void {
    if (this.#disposed || this.#failed) return;
    const message = parseUtilityMessage(value);
    if (message === null) {
      this.#fail();
      return;
    }
    switch (message.type) {
      case "codex-response":
      case "codex-error": {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
          this.#fail();
          return;
        }
        const result =
          message.type === "codex-response"
            ? parseWorkerResult(message.result, pending.resultKind)
            : undefined;
        if (result === INVALID_WORKER_RESULT) {
          this.#fail();
          return;
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.type === "codex-error") pending.reject(mapWorkerError(message.code));
        else pending.resolve(result);
        return;
      }
      case "codex-event":
        Promise.resolve(this.callbacks.onEvent(message.event)).catch(() => this.#fail());
        return;
      case "codex-permission-request":
        this.#permission(message.permissionId, message.request);
        return;
      case "codex-process-group":
        if (this.#connected || this.#processGroupId !== null) {
          this.#fail();
          return;
        }
        this.#processGroupId = message.processGroupId;
        return;
      case "codex-process-group-cleared":
        if (this.#processGroupId !== message.processGroupId) {
          this.#fail();
          return;
        }
        this.#processGroupId = null;
        return;
      case "codex-exit":
        this.#workerExit("transport-failed");
    }
  }

  #permission(permissionId: number, request: AiAgentHostPermissionRequest): void {
    if (
      permissionId !== this.#nextPermissionId ||
      this.#permissions.has(permissionId) ||
      this.#permissions.size >= MAX_PENDING_PERMISSION_REQUESTS ||
      this.#disposed ||
      this.#failed
    ) {
      this.#fail();
      return;
    }
    this.#nextPermissionId += 1;
    const controller = new AbortController();
    this.#permissions.set(permissionId, {
      controller,
      optionIds: new Set(request.options.map((option) => option.id)),
    });
    let outcome: Promise<AiAgentHostPermissionOutcome>;
    try {
      outcome = this.callbacks.requestPermission(request, controller.signal);
    } catch {
      outcome = Promise.resolve({ outcome: "cancelled" });
    }
    outcome.then(
      (selected) => this.#settlePermission(permissionId, selected),
      () => this.#settlePermission(permissionId, { outcome: "cancelled" }),
    );
  }

  #settlePermission(permissionId: number, outcome: AiAgentHostPermissionOutcome): void {
    const pending = this.#permissions.get(permissionId);
    if (pending === undefined || this.#disposed || this.#failed) return;
    this.#permissions.delete(permissionId);
    const validOutcome =
      outcome.outcome === "selected" && !pending.optionIds.has(outcome.optionId)
        ? ({ outcome: "cancelled" } as const)
        : outcome;
    const request: CodexUtilityRequest = {
      type: "codex-permission-response",
      permissionId,
      outcome: validOutcome,
    };
    try {
      this.worker.postMessage(request);
    } catch {
      this.#fail();
    }
  }

  #request(
    request: CodexUtilityRequest & { readonly type: "codex-request" },
    timeoutMs: number,
    resultKind: PendingWorkerRequest["resultKind"] = "empty",
    fixedId = false,
  ): Promise<unknown> {
    if (this.#disposed || this.#failed || this.#pending.size >= MAX_PENDING_WORKER_REQUESTS) {
      return Promise.reject(new AiAgentHostError("protocol-failed"));
    }
    const id = fixedId ? request.id : this.#nextId;
    if (!fixedId) this.#nextId += 1;
    if (!Number.isSafeInteger(id) || this.#pending.has(id)) {
      this.#fail();
      return Promise.reject(new AiAgentHostError("protocol-failed"));
    }
    const outgoing = { ...request, id } as CodexUtilityRequest;
    if (boundedMessageBytes(outgoing) === null) {
      return Promise.reject(new AiAgentHostError("protocol-failed"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AiAgentHostError("protocol-failed"));
        this.#fail();
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, resultKind, timeout });
      try {
        this.worker.postMessage(outgoing);
      } catch {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(new AiAgentHostError("protocol-failed"));
        this.#fail();
      }
    });
  }

  #abortPermissions(): void {
    for (const pending of this.#permissions.values()) pending.controller.abort();
    this.#permissions.clear();
  }

  #workerExit(reason: "exited" | "transport-failed"): void {
    if (this.#expectedExit || this.#exitReported) return;
    this.#exitReported = true;
    this.#workerKilled = true;
    this.#fail(false);
    try {
      this.callbacks.onExit({ reason });
    } catch {
      // Exit callbacks receive no process details and cannot prevent local cleanup.
    }
  }

  #killProcessGroup(): void {
    const processGroupId = this.#processGroupId;
    if (processGroupId === null) return;
    this.#processGroupId = null;
    try {
      this.worker.killProcessGroup(processGroupId);
    } catch {
      // Hard cleanup continues with the utility process even if the group is already gone.
    }
  }

  #killWorker(): void {
    if (this.#workerKilled) return;
    this.#workerKilled = true;
    try {
      this.worker.kill();
    } catch {
      // The utility worker may already have exited.
    }
  }

  #fail(killWorker = true): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#abortPermissions();
    const error = new AiAgentHostError("protocol-failed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#killProcessGroup();
    if (killWorker) this.#killWorker();
  }

  async newConversation(workspacePath: string): Promise<{ readonly conversationId: string }> {
    this.#retirementGracefulDeadline = null;
    const result = await this.#request(
      { type: "codex-request", id: 0, method: "new-conversation", workspacePath },
      this.operationTimeoutMs,
      "new-conversation",
    );
    const response = record(result);
    if (response === null || typeof response.conversationId !== "string") {
      this.#fail();
      throw new AiAgentHostError("protocol-failed");
    }
    return { conversationId: response.conversationId };
  }

  async resumeConversation(workspacePath: string, conversationId: string): Promise<void> {
    this.#retirementGracefulDeadline = null;
    await this.#request(
      {
        type: "codex-request",
        id: 0,
        method: "resume-conversation",
        workspacePath,
        conversationId,
      },
      this.operationTimeoutMs,
    );
  }

  async prompt(conversationId: string, prompt: string): Promise<void> {
    this.#retirementGracefulDeadline = null;
    await this.#request(
      { type: "codex-request", id: 0, method: "prompt", conversationId, prompt },
      DEFAULT_TURN_TIMEOUT_MS,
    );
  }

  async cancel(conversationId: string): Promise<void> {
    this.#abortPermissions();
    this.#retirementGracefulDeadline ??= gracefulDeadline(
      this.interruptTimeoutMs + this.teardownTimeoutMs,
    );
    await this.#request(
      { type: "codex-request", id: 0, method: "cancel", conversationId },
      remainingUntil(this.#retirementGracefulDeadline),
    );
  }

  async close(conversationId: string): Promise<void> {
    this.#abortPermissions();
    const timeoutMs =
      this.#retirementGracefulDeadline === null
        ? this.teardownTimeoutMs
        : remainingUntil(this.#retirementGracefulDeadline);
    await this.#request(
      { type: "codex-request", id: 0, method: "close", conversationId },
      timeoutMs,
    );
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeOnce();
    return this.#disposePromise;
  }

  async #disposeOnce(): Promise<void> {
    if (this.#disposed) return;
    this.#expectedExit = true;
    this.#abortPermissions();
    const teardownDeadline =
      this.#retirementGracefulDeadline ?? gracefulDeadline(this.teardownTimeoutMs);
    try {
      await this.#request(
        { type: "codex-request", id: 0, method: "dispose" },
        remainingUntil(teardownDeadline),
      );
    } catch {
      // Bounded graceful teardown falls through to a hard worker kill.
    }
    this.#disposed = true;
    this.#killProcessGroup();
    this.#killWorker();
  }
}

/** Creates the normalized Codex host after the utility worker completes version/auth startup. */
export async function createCodexAppServerHost(
  callbacks: AiAgentHostCallbacks,
  dependencies: CodexAppServerHostDependencies = {},
): Promise<AiAgentHost> {
  if (dependencies.configurationMode !== "test-only" || dependencies.forkWorker === undefined) {
    throw new AiAgentHostError("startup-failed");
  }
  if ((dependencies.platform ?? process.platform) === "win32") {
    throw new AiAgentHostError("startup-failed");
  }
  if (dependencies.startupSignal?.aborted === true) {
    throw new AiAgentHostError("startup-failed");
  }
  const startupTimeoutMs = timeoutValue(dependencies.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const launch: CodexUtilityWorkerLaunch = {
    modulePath: dependencies.workerPath ?? path.join(__dirname, "codex-app-server-worker.js"),
    environment: buildCodexWorkerEnvironment(dependencies.environment ?? process.env),
  };
  let worker: CodexUtilityWorker;
  try {
    worker = (dependencies.forkWorker ?? productionWorker)(launch);
  } catch (error) {
    if (error instanceof AiAgentHostError) throw error;
    throw new AiAgentHostError("startup-failed");
  }

  const host = new CodexAppServerHostImplementation(
    worker,
    callbacks,
    timeoutValue(dependencies.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS),
    timeoutValue(dependencies.interruptTimeoutMs, DEFAULT_INTERRUPT_TIMEOUT_MS),
    timeoutValue(dependencies.teardownTimeoutMs, DEFAULT_TEARDOWN_TIMEOUT_MS),
  );
  let startupTimeout: ReturnType<typeof setTimeout> | undefined;
  let startupAbortListener: (() => void) | undefined;
  const startupAbort = new Promise<never>((_, reject) => {
    const abort = (): void => reject(new AiAgentHostError("startup-failed"));
    startupAbortListener = abort;
    startupTimeout = setTimeout(abort, startupTimeoutMs);
    dependencies.startupSignal?.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([worker.spawned, startupAbort]);
    await Promise.race([host.connect(startupTimeoutMs), startupAbort]);
    return host;
  } catch (error) {
    await host.dispose();
    if (error instanceof AiAgentHostError) throw error;
    throw new AiAgentHostError("startup-failed");
  } finally {
    if (startupTimeout !== undefined) clearTimeout(startupTimeout);
    if (startupAbortListener !== undefined) {
      dependencies.startupSignal?.removeEventListener("abort", startupAbortListener);
    }
  }
}

export const createCodexAiAgentHost: CreateAiAgentHost = createCodexAppServerHost;
