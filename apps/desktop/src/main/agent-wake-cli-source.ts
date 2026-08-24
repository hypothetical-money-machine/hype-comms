import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

import {
  agentWakeStreamRecordSchema,
  currentPrincipalSchema,
  entityIdSchema,
  sequenceSchema,
  type AgentWakeStreamRecord,
} from "@hype-comms/contracts";

import {
  AgentWakeSourceFailure,
  type AgentWakeEnrollmentAuthority,
  type AgentWakeIdentity,
  type AgentWakeSource,
  type AgentWakeSourceAccess,
  type AgentWakeSourceSession,
} from "./agent-wake-broker";
import {
  isAgentWakeExecutablePin,
  type AgentWakeExecutablePin,
  verifyAgentWakeExecutablePin,
} from "./agent-wake-configuration";
import {
  agentWakePositiveInteger,
  agentWakeProcessEnvironment,
  normalizeAgentWakeApiOrigin,
} from "./agent-wake-validation";

const DEFAULT_MAX_STDOUT_LINE_BYTES = 16 * 1_024;
const DEFAULT_MAX_STDOUT_BUFFER_BYTES = 256 * 1_024;
const DEFAULT_MAX_RECORD_QUEUE_DEPTH = 128;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 1_000;
const MAX_STOP_GRACE_MS = 2_000;

export interface AgentWakeCliBinding {
  readonly runtimeExecutablePath: string;
  readonly runtimeExecutablePin: AgentWakeExecutablePin;
  readonly cliEntrypointPath: string;
  readonly cliEntrypointPin: AgentWakeExecutablePin;
  readonly profile: string;
  readonly apiOrigin: string;
}

export type AgentWakeCliBindingResolver = (
  credentialHandle: string,
) => AgentWakeCliBinding | null | Promise<AgentWakeCliBinding | null>;

export interface AgentWakeCliSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export interface AgentWakeCliChildProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type AgentWakeCliProcessFactory = (
  executablePath: string,
  args: readonly string[],
  options: AgentWakeCliSpawnOptions,
) => AgentWakeCliChildProcess;

export interface AgentWakeCliTimers {
  readonly setTimeout: (task: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface AgentWakeCliSourceAdapterOptions {
  readonly resolveBinding: AgentWakeCliBindingResolver;
  readonly verifyExecutable?: (pin: AgentWakeExecutablePin) => Promise<string>;
  readonly processFactory?: AgentWakeCliProcessFactory;
  readonly timers?: AgentWakeCliTimers;
  readonly environment?: NodeJS.ProcessEnv;
  readonly maxStdoutLineBytes?: number;
  readonly maxStdoutBufferBytes?: number;
  readonly maxRecordQueueDepth?: number;
  readonly commandTimeoutMs?: number;
  readonly stopGraceMs?: number;
}

declare const normalizedBinding: unique symbol;

/** An `AgentWakeCliBinding` proven to have passed `normalizeBinding`, which alone produces one. */
type NormalizedAgentWakeCliBinding = AgentWakeCliBinding & {
  readonly [normalizedBinding]: true;
};

interface SessionLimits {
  readonly maxLineBytes: number;
  readonly maxBufferBytes: number;
  readonly maxQueueDepth: number;
  readonly stopGraceMs: number;
}

function sourceFailure(
  code: ConstructorParameters<typeof AgentWakeSourceFailure>[0],
  retryable: boolean,
): AgentWakeSourceFailure {
  return new AgentWakeSourceFailure(code, retryable);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function classifyExit(code: number | null): AgentWakeSourceFailure {
  switch (code) {
    case 2:
      return sourceFailure("source-scope-invalid", false);
    case 3:
      return sourceFailure("source-authentication-required", false);
    case 4:
      return sourceFailure("source-scope-invalid", false);
    case 6:
      return sourceFailure("source-record-invalid", false);
    default:
      return sourceFailure("source-unavailable", true);
  }
}

function normalizeBinding(binding: AgentWakeCliBinding): NormalizedAgentWakeCliBinding | null {
  const apiOrigin = normalizeAgentWakeApiOrigin(binding.apiOrigin);
  if (
    !isAbsolute(binding.runtimeExecutablePath) ||
    binding.runtimeExecutablePath.includes("\0") ||
    !isAgentWakeExecutablePin(
      binding.runtimeExecutablePin,
      binding.runtimeExecutablePath,
      "native-executable",
    ) ||
    !isAbsolute(binding.cliEntrypointPath) ||
    binding.cliEntrypointPath.includes("\0") ||
    !isAgentWakeExecutablePin(
      binding.cliEntrypointPin,
      binding.cliEntrypointPath,
      "cli-entrypoint",
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(binding.profile) ||
    apiOrigin === null
  ) {
    return null;
  }
  return {
    runtimeExecutablePath: binding.runtimeExecutablePath,
    runtimeExecutablePin: binding.runtimeExecutablePin,
    cliEntrypointPath: binding.cliEntrypointPath,
    cliEntrypointPin: binding.cliEntrypointPin,
    profile: binding.profile,
    apiOrigin,
  } as NormalizedAgentWakeCliBinding;
}

function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return agentWakeProcessEnvironment({
    source: environment,
    fixed: { NO_COLOR: "1" },
    additionalAllowedKeys: ["HYPE_COMMS_CONFIG_DIR"],
  });
}

function bufferFromChunk(chunk: unknown): Buffer | null {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return null;
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function recordMatchesAccess(
  record: AgentWakeStreamRecord,
  access: AgentWakeSourceAccess,
): boolean {
  return record.workspaceId === access.workspaceId && record.agentUserId === access.agentUserId;
}

function drainStderr(stream: Readable): void {
  stream.on("error", () => {
    // Diagnostics are untrusted and deliberately never decoded, retained, logged, or rethrown.
  });
  stream.resume();
}

function destroyChildStreams(child: AgentWakeCliChildProcess): void {
  try {
    child.stdout.destroy();
  } catch {
    // The stable source failure remains authoritative during forced teardown.
  }
  try {
    child.stderr.destroy();
  } catch {
    // The stable source failure remains authoritative during forced teardown.
  }
}

function defaultProcessFactory(
  executablePath: string,
  args: readonly string[],
  options: AgentWakeCliSpawnOptions,
): AgentWakeCliChildProcess {
  return spawn(executablePath, [...args], {
    shell: options.shell,
    windowsHide: options.windowsHide,
    env: options.env,
    stdio: [...options.stdio],
  }) as unknown as AgentWakeCliChildProcess;
}

const defaultTimers: AgentWakeCliTimers = {
  setTimeout(task, delayMs) {
    const timer = setTimeout(task, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

class WakeCliSession implements AgentWakeSourceSession {
  readonly #child: AgentWakeCliChildProcess;
  readonly #access: AgentWakeSourceAccess;
  readonly #limits: SessionLimits;
  readonly #timers: AgentWakeCliTimers;
  readonly #closedPromise: Promise<void>;
  #resolveClosed: (() => void) | null = null;
  #buffer = Buffer.alloc(0);
  #queue: AgentWakeStreamRecord[] = [];
  #pending:
    | {
        readonly resolve: (record: AgentWakeStreamRecord) => void;
        readonly reject: (error: AgentWakeSourceFailure) => void;
      }
    | undefined;
  #terminalFailure: AgentWakeSourceFailure | null = null;
  #closed = false;
  #stopping = false;
  #paused = false;
  #stopPromise: Promise<void> | null = null;
  #acknowledgedCursor: string;

  constructor(
    child: AgentWakeCliChildProcess,
    access: AgentWakeSourceAccess,
    after: string,
    limits: SessionLimits,
    timers: AgentWakeCliTimers,
  ) {
    this.#child = child;
    this.#access = access;
    this.#acknowledgedCursor = after;
    this.#limits = limits;
    this.#timers = timers;
    this.#closedPromise = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    drainStderr(child.stderr);
    child.stdout.on("data", (chunk: unknown) => this.#onData(chunk));
    child.stdout.once("error", () => {
      this.#abort(sourceFailure("source-unavailable", true));
    });
    child.once("error", () => {
      this.#abort(sourceFailure("source-unavailable", true));
    });
    child.once("close", (code) => this.#onClose(code));
  }

  next(): Promise<AgentWakeStreamRecord> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      this.#drain();
      return Promise.resolve(queued);
    }
    if (this.#terminalFailure !== null && this.#buffer.length === 0) {
      return Promise.reject(this.#terminalFailure);
    }
    if (this.#pending !== undefined) {
      return Promise.reject(sourceFailure("source-record-invalid", false));
    }
    return new Promise<AgentWakeStreamRecord>((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#drain();
      this.#flushTerminal();
    });
  }

  acknowledge(cursor: string): Promise<void> {
    if (
      !sequenceSchema.safeParse(cursor).success ||
      BigInt(cursor) < BigInt(this.#acknowledgedCursor)
    ) {
      return Promise.reject(sourceFailure("source-record-invalid", false));
    }
    this.#acknowledgedCursor = cursor;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    return this.#stopPromise;
  }

  #onData(chunk: unknown): void {
    if (this.#closed || this.#terminalFailure !== null) return;
    const bytes = bufferFromChunk(chunk);
    if (
      bytes === null ||
      bytes.byteLength > this.#limits.maxBufferBytes - this.#buffer.byteLength
    ) {
      this.#abort(sourceFailure("source-client-replay-overflow", false));
      return;
    }
    this.#buffer =
      this.#buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.#buffer, bytes]);
    this.#drain();
  }

  #onClose(code: number | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resolveClosed?.();
    this.#resolveClosed = null;
    if (!this.#stopping && this.#terminalFailure === null) {
      this.#terminalFailure = classifyExit(code);
    }
    this.#drain();
    this.#flushTerminal();
  }

  #drain(): void {
    if (this.#stopping) return;
    while (this.#terminalFailure === null || this.#closed) {
      if (this.#pending === undefined && this.#queue.length >= this.#limits.maxQueueDepth) {
        this.#pause();
        return;
      }
      let newline = this.#buffer.indexOf(0x0a);
      if (newline === -1 && this.#closed && this.#buffer.length > 0) newline = this.#buffer.length;
      if (newline === -1) {
        if (this.#buffer.length > this.#limits.maxLineBytes) {
          this.#abort(sourceFailure("source-client-replay-overflow", false));
        }
        break;
      }
      const hasNewline = newline < this.#buffer.length;
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + (hasNewline ? 1 : 0));
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0 || line.length > this.#limits.maxLineBytes) {
        this.#abort(
          sourceFailure(
            line.length > this.#limits.maxLineBytes
              ? "source-client-replay-overflow"
              : "source-record-invalid",
            false,
          ),
        );
        return;
      }
      const text = decodeUtf8(line);
      let value: unknown;
      if (text === null) {
        this.#abort(sourceFailure("source-record-invalid", false));
        return;
      }
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        this.#abort(sourceFailure("source-record-invalid", false));
        return;
      }
      const parsed = agentWakeStreamRecordSchema.safeParse(value);
      if (!parsed.success) {
        this.#abort(sourceFailure("source-record-invalid", false));
        return;
      }
      if (!recordMatchesAccess(parsed.data, this.#access)) {
        this.#abort(sourceFailure("source-scope-invalid", false));
        return;
      }
      const pending = this.#pending;
      if (pending === undefined) {
        this.#queue.push(parsed.data);
      } else {
        this.#pending = undefined;
        pending.resolve(parsed.data);
      }
    }
    if (
      this.#paused &&
      this.#terminalFailure === null &&
      this.#queue.length < this.#limits.maxQueueDepth
    ) {
      this.#paused = false;
      try {
        this.#child.stdout.resume();
      } catch {
        this.#abort(sourceFailure("source-unavailable", true));
      }
    }
    this.#flushTerminal();
  }

  #pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    try {
      this.#child.stdout.pause();
    } catch {
      this.#abort(sourceFailure("source-unavailable", true));
    }
  }

  #flushTerminal(): void {
    if (
      this.#terminalFailure === null ||
      this.#pending === undefined ||
      this.#queue.length > 0 ||
      this.#buffer.length > 0
    ) {
      return;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    pending.reject(this.#terminalFailure);
  }

  #abort(error: AgentWakeSourceFailure): void {
    if (this.#terminalFailure !== null) return;
    this.#terminalFailure = error;
    this.#buffer = Buffer.alloc(0);
    this.#queue = [];
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
    this.#pause();
    try {
      this.#child.kill("SIGTERM");
    } catch {
      // The stable source failure above is authoritative; process cleanup errors contain no value.
    }
  }

  async #stopInternal(): Promise<void> {
    this.#stopping = true;
    this.#buffer = Buffer.alloc(0);
    this.#queue = [];
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(sourceFailure("source-unavailable", true));
    this.#pause();
    if (this.#closed) return;
    try {
      this.#child.kill("SIGTERM");
    } catch {
      // Continue to the bounded close wait and force-kill fallback.
    }
    if (await this.#waitForClose(this.#limits.stopGraceMs)) return;
    try {
      this.#child.kill("SIGKILL");
    } catch {
      // A process that raced to exit is already stopped.
    }
    if (await this.#waitForClose(this.#limits.stopGraceMs)) return;
    destroyChildStreams(this.#child);
  }

  #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.#closed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer: { handle?: unknown } = {};
      const finish = (closed: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer.handle !== undefined) this.#timers.clearTimeout(timer.handle);
        resolve(closed);
      };
      timer.handle = this.#timers.setTimeout(() => finish(false), timeoutMs);
      void this.#closedPromise.then(() => finish(true));
    });
  }
}

/**
 * Main-process-only authority and body-free source backed by the installed Hype Comms CLI.
 * Credential handles are resolved just in time and never cross the subprocess boundary.
 */
export class AgentWakeCliSourceAdapter implements AgentWakeEnrollmentAuthority, AgentWakeSource {
  readonly #resolveBinding: AgentWakeCliBindingResolver;
  readonly #verifyExecutable: (pin: AgentWakeExecutablePin) => Promise<string>;
  readonly #processFactory: AgentWakeCliProcessFactory;
  readonly #timers: AgentWakeCliTimers;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #limits: SessionLimits;
  readonly #commandTimeoutMs: number;

  constructor(options: AgentWakeCliSourceAdapterOptions) {
    this.#resolveBinding = options.resolveBinding;
    this.#verifyExecutable = options.verifyExecutable ?? verifyAgentWakeExecutablePin;
    this.#processFactory = options.processFactory ?? defaultProcessFactory;
    this.#timers = options.timers ?? defaultTimers;
    this.#environment = sanitizedEnvironment(options.environment ?? process.env);
    this.#limits = {
      maxLineBytes: agentWakePositiveInteger(
        options.maxStdoutLineBytes,
        DEFAULT_MAX_STDOUT_LINE_BYTES,
      ),
      maxBufferBytes: agentWakePositiveInteger(
        options.maxStdoutBufferBytes,
        DEFAULT_MAX_STDOUT_BUFFER_BYTES,
      ),
      maxQueueDepth: agentWakePositiveInteger(
        options.maxRecordQueueDepth,
        DEFAULT_MAX_RECORD_QUEUE_DEPTH,
      ),
      stopGraceMs: agentWakePositiveInteger(
        options.stopGraceMs,
        DEFAULT_STOP_GRACE_MS,
        MAX_STOP_GRACE_MS,
      ),
    };
    this.#commandTimeoutMs = agentWakePositiveInteger(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
  }

  async verify(input: {
    readonly credentialHandle: string;
    readonly expectedAgentUserId: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentWakeIdentity> {
    const binding = await this.#binding(input.credentialHandle);
    const value = await this.#runJson(
      binding,
      [...this.#baseArguments(binding), "auth", "whoami", "--json"],
      input.signal,
    );
    const principal = currentPrincipalSchema.safeParse(value);
    if (!principal.success) throw sourceFailure("source-record-invalid", false);
    if (!("type" in principal.data) || principal.data.type !== "agent") {
      throw sourceFailure("source-authentication-required", false);
    }
    if (principal.data.user.id !== input.expectedAgentUserId) {
      throw sourceFailure("source-scope-invalid", false);
    }
    if (!principal.data.scopes.includes("workspace:read")) {
      throw sourceFailure("source-scope-invalid", false);
    }
    return {
      apiOrigin: binding.apiOrigin,
      workspaceId: principal.data.workspaceId,
      agentUserId: principal.data.user.id,
    };
  }

  async captureHighWater(access: AgentWakeSourceAccess, signal?: AbortSignal): Promise<string> {
    if (signalAborted(signal)) throw sourceFailure("source-unavailable", true);
    const session = await this.#openSession(access, undefined, signal);
    const abort = (): void => {
      void session.stop().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signalAborted(signal)) abort();
    try {
      const record = await this.#withTimeout(session.next(), () => session.stop());
      if (signalAborted(signal)) throw sourceFailure("source-unavailable", true);
      if (record.type !== "agent.wake.checkpoint") {
        throw sourceFailure("source-record-invalid", false);
      }
      return record.cursor;
    } finally {
      signal?.removeEventListener("abort", abort);
      await session.stop();
    }
  }

  async open(
    input: AgentWakeSourceAccess & { readonly after: string },
  ): Promise<AgentWakeSourceSession> {
    if (!sequenceSchema.safeParse(input.after).success) {
      throw sourceFailure("source-record-invalid", false);
    }
    return this.#openSession(input, input.after);
  }

  async #binding(credentialHandle: string): Promise<NormalizedAgentWakeCliBinding> {
    if (
      credentialHandle.length === 0 ||
      credentialHandle.length > 512 ||
      credentialHandle.includes("\0")
    ) {
      throw sourceFailure("source-authentication-required", false);
    }
    let candidate: AgentWakeCliBinding | null;
    try {
      candidate = await this.#resolveBinding(credentialHandle);
    } catch {
      throw sourceFailure("source-unavailable", true);
    }
    if (candidate === null) throw sourceFailure("source-authentication-required", false);
    const binding = normalizeBinding(candidate);
    if (binding === null) throw sourceFailure("source-scope-invalid", false);
    return binding;
  }

  async #openSession(
    access: AgentWakeSourceAccess,
    after: string | undefined,
    signal?: AbortSignal,
  ): Promise<WakeCliSession> {
    if (
      !entityIdSchema.safeParse(access.workspaceId).success ||
      !entityIdSchema.safeParse(access.agentUserId).success
    ) {
      throw sourceFailure("source-scope-invalid", false);
    }
    const binding = await this.#binding(access.credentialHandle);
    if (normalizeAgentWakeApiOrigin(access.apiOrigin) !== binding.apiOrigin) {
      throw sourceFailure("source-scope-invalid", false);
    }
    const args = [
      ...this.#baseArguments(binding),
      "wake",
      "watch",
      "--json",
      ...(after === undefined ? [] : ["--after", after]),
    ];
    const { runtimeExecutablePath, cliEntrypointPath } = await this.#verifiedExecutablePaths(
      binding,
      signal,
    );
    const child = this.#spawn(runtimeExecutablePath, [cliEntrypointPath, ...args]);
    return new WakeCliSession(child, access, after ?? "0", this.#limits, this.#timers);
  }

  #baseArguments(binding: NormalizedAgentWakeCliBinding): readonly string[] {
    return ["--profile", binding.profile, "--api-origin", binding.apiOrigin];
  }

  async #verifiedExecutablePaths(
    binding: NormalizedAgentWakeCliBinding,
    signal?: AbortSignal,
  ): Promise<{
    readonly runtimeExecutablePath: string;
    readonly cliEntrypointPath: string;
  }> {
    let runtimeExecutablePath: string;
    let cliEntrypointPath: string;
    try {
      [runtimeExecutablePath, cliEntrypointPath] = await Promise.all([
        this.#verifyExecutable(binding.runtimeExecutablePin),
        this.#verifyExecutable(binding.cliEntrypointPin),
      ]);
    } catch {
      throw sourceFailure("source-scope-invalid", false);
    }
    if (signalAborted(signal)) throw sourceFailure("source-unavailable", true);
    return { runtimeExecutablePath, cliEntrypointPath };
  }

  #spawn(executablePath: string, args: readonly string[]): AgentWakeCliChildProcess {
    try {
      return this.#processFactory(executablePath, args, {
        shell: false,
        windowsHide: true,
        env: { ...this.#environment },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw sourceFailure("source-unavailable", true);
    }
  }

  async #runJson(
    binding: NormalizedAgentWakeCliBinding,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signalAborted(signal)) {
      throw sourceFailure("source-unavailable", true);
    }
    const { runtimeExecutablePath, cliEntrypointPath } = await this.#verifiedExecutablePaths(
      binding,
      signal,
    );
    const child = this.#spawn(runtimeExecutablePath, [cliEntrypointPath, ...args]);
    drainStderr(child.stderr);
    return new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let terminalError: AgentWakeSourceFailure | null = null;
      const timeout: { handle?: unknown } = {};
      const forceKill: { handle?: unknown } = {};
      const forceSettlement: { handle?: unknown } = {};
      const settle = (outcome: { readonly value: unknown } | { readonly error: unknown }): void => {
        if (settled) return;
        settled = true;
        if (timeout.handle !== undefined) this.#timers.clearTimeout(timeout.handle);
        if (forceKill.handle !== undefined) this.#timers.clearTimeout(forceKill.handle);
        if (forceSettlement.handle !== undefined) {
          this.#timers.clearTimeout(forceSettlement.handle);
        }
        signal?.removeEventListener("abort", abort);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const terminate = (error: AgentWakeSourceFailure): void => {
        if (settled || terminalError !== null) return;
        terminalError = error;
        if (timeout.handle !== undefined) this.#timers.clearTimeout(timeout.handle);
        const forceKillHandle = this.#timers.setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // A process that raced to exit is already stopped.
          }
          if (settled) return;
          const forceSettlementHandle = this.#timers.setTimeout(() => {
            destroyChildStreams(child);
            settle({ error });
          }, this.#limits.stopGraceMs);
          forceSettlement.handle = forceSettlementHandle;
          if (settled) this.#timers.clearTimeout(forceSettlementHandle);
        }, this.#limits.stopGraceMs);
        forceKill.handle = forceKillHandle;
        if (settled) this.#timers.clearTimeout(forceKillHandle);
        try {
          child.kill("SIGTERM");
        } catch {
          // The stable error code is the complete public failure.
        }
      };
      const abort = (): void => terminate(sourceFailure("source-unavailable", true));
      signal?.addEventListener("abort", abort, { once: true });
      timeout.handle = this.#timers.setTimeout(
        () => terminate(sourceFailure("source-unavailable", true)),
        this.#commandTimeoutMs,
      );
      child.stdout.on("data", (chunk: unknown) => {
        if (settled || terminalError !== null) return;
        const value = bufferFromChunk(chunk);
        if (value === null || value.byteLength > this.#limits.maxLineBytes - bytes) {
          terminate(sourceFailure("source-client-replay-overflow", false));
          return;
        }
        chunks.push(Buffer.from(value));
        bytes += value.byteLength;
      });
      child.stdout.once("error", () => terminate(sourceFailure("source-unavailable", true)));
      child.once("error", () => terminate(sourceFailure("source-unavailable", true)));
      child.once("close", (code) => {
        if (settled) return;
        if (terminalError !== null) {
          settle({ error: terminalError });
          return;
        }
        if (code !== 0) {
          settle({ error: classifyExit(code) });
          return;
        }
        const text = decodeUtf8(Buffer.concat(chunks, bytes))?.trim();
        if (text === undefined || text === "") {
          settle({ error: sourceFailure("source-record-invalid", false) });
          return;
        }
        try {
          settle({ value: JSON.parse(text) as unknown });
        } catch {
          settle({ error: sourceFailure("source-record-invalid", false) });
        }
      });
      if (signalAborted(signal)) abort();
    });
  }

  #withTimeout<T>(promise: Promise<T>, onTimeout: () => void | Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout: { handle?: unknown } = {};
      const finish = (outcome: { readonly value: T } | { readonly error: unknown }): void => {
        if (settled) return;
        settled = true;
        if (timeout.handle !== undefined) this.#timers.clearTimeout(timeout.handle);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      timeout.handle = this.#timers.setTimeout(() => {
        void Promise.resolve(onTimeout()).then(
          () => finish({ error: sourceFailure("source-unavailable", true) }),
          () => finish({ error: sourceFailure("source-unavailable", true) }),
        );
      }, this.#commandTimeoutMs);
      void promise.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }
}
