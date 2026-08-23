import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import { agentWakeSignalSchema } from "@hype-comms/contracts";
import { z } from "zod";

import type {
  AgentWakeProviderBinding,
  AgentWakeTarget,
  AgentWakeTargetResult,
} from "./agent-wake-broker";
import {
  isAgentWakeExecutablePin,
  type AgentWakeExecutablePin,
  verifyAgentWakeExecutablePin,
} from "./agent-wake-configuration";

export const AGENT_WAKE_PROVIDER_DEFAULT_TIMEOUT_MS = 30_000;
export const AGENT_WAKE_PROVIDER_DEFAULT_MAX_STDOUT_BYTES = 16 * 1_024;
export const AGENT_WAKE_PROVIDER_DEFAULT_MAX_STDERR_BYTES = 8 * 1_024;

const MAX_REQUEST_BYTES = 16 * 1_024;
const MAX_RETRY_AFTER_MS = 86_400_000;

const adapterIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const providerReceiptIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Expected an opaque receipt ID");

const providerResponseBaseShape = {
  version: z.literal(1),
  type: z.literal("agent.wake.response"),
  adapterId: adapterIdSchema,
  wakeId: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

const providerResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...providerResponseBaseShape,
      status: z.literal("accepted"),
      providerReceiptId: providerReceiptIdSchema,
    })
    .strict(),
  z
    .object({
      ...providerResponseBaseShape,
      status: z.literal("duplicate"),
      providerReceiptId: providerReceiptIdSchema,
    })
    .strict(),
  z
    .object({
      ...providerResponseBaseShape,
      status: z.literal("coalesced"),
      providerReceiptId: providerReceiptIdSchema,
    })
    .strict(),
  z
    .object({
      ...providerResponseBaseShape,
      status: z.literal("retry"),
      code: z.enum(["provider-overloaded", "provider-rate-limited", "provider-unavailable"]),
      retryAfterMs: z.number().int().nonnegative().max(MAX_RETRY_AFTER_MS).optional(),
    })
    .strict(),
  z
    .object({
      ...providerResponseBaseShape,
      status: z.literal("blocked"),
      code: z.enum([
        "provider-authentication-required",
        "provider-contract-invalid",
        "provider-rejected",
      ]),
    })
    .strict(),
]);

export interface AgentWakeProviderExecutableConfig {
  readonly adapterId: string;
  readonly executablePath: string;
  readonly executablePin: AgentWakeExecutablePin;
  readonly arguments: readonly string[];
}

/** Zero or multiple matches are configuration errors, never an arbitrary binding choice. */
export type AgentWakeProviderExecutableResolver = (
  targetHandle: string,
) =>
  | readonly AgentWakeProviderExecutableConfig[]
  | Promise<readonly AgentWakeProviderExecutableConfig[]>;

export interface AgentWakeProviderTimerHandle {
  cancel(): void;
}

export interface AgentWakeProviderTimer {
  schedule(delayMs: number, task: () => void): AgentWakeProviderTimerHandle;
}

export interface AgentWakeProviderSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

export type AgentWakeProviderProcessFactory = (
  executablePath: string,
  arguments_: readonly string[],
  options: AgentWakeProviderSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface AgentWakeProviderProcessTargetOptions {
  readonly resolveTarget: AgentWakeProviderExecutableResolver;
  readonly verifyExecutable?: (pin: AgentWakeExecutablePin) => Promise<string>;
  readonly processFactory?: AgentWakeProviderProcessFactory;
  readonly timer?: AgentWakeProviderTimer;
  /** Environment source that is reduced to an explicit non-secret allowlist before spawning. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export type AgentWakeProviderProcessErrorCode =
  "provider-operation-aborted" | "provider-outcome-ambiguous";

/** Error text deliberately carries no process output, request, path, handle, or credential. */
export class AgentWakeProviderProcessError extends Error {
  constructor(readonly code: AgentWakeProviderProcessErrorCode) {
    super("Agent wake provider operation did not produce a safe result");
    this.name = "AgentWakeProviderProcessError";
  }
}

const defaultTimer: AgentWakeProviderTimer = {
  schedule(delayMs, task) {
    const handle = setTimeout(task, delayMs);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

const defaultProcessFactory: AgentWakeProviderProcessFactory = (
  executablePath,
  arguments_,
  options,
) =>
  spawn(executablePath, [...arguments_], {
    shell: options.shell,
    windowsHide: options.windowsHide,
    env: options.env,
    stdio: [...options.stdio],
  });

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validOpaqueHandle(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function validExecutableConfig(value: unknown): value is AgentWakeProviderExecutableConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AgentWakeProviderExecutableConfig>;
  return (
    adapterIdSchema.safeParse(candidate.adapterId).success &&
    typeof candidate.executablePath === "string" &&
    isAbsolute(candidate.executablePath) &&
    candidate.executablePath.length <= 4_096 &&
    !candidate.executablePath.includes("\0") &&
    isAgentWakeExecutablePin(
      candidate.executablePin,
      candidate.executablePath,
      "native-executable",
    ) &&
    Array.isArray(candidate.arguments) &&
    candidate.arguments.length === 0
  );
}

const ALLOWED_ENVIRONMENT_KEYS = [
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
] as const;

function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HYPE_AGENT_WAKE_PROTOCOL: "1" };
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length <= 4_096 && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  return environment;
}

function parseSingleResponse(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const line = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) return null;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function mappedResponse(
  value: unknown,
  binding: AgentWakeProviderBinding,
  wakeId: string,
  attempt: number,
): AgentWakeTargetResult | null {
  const parsed = providerResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.adapterId !== binding.adapterId ||
    parsed.data.wakeId !== wakeId ||
    parsed.data.attempt !== attempt
  ) {
    return null;
  }
  const response = parsed.data;
  if (
    response.status === "accepted" ||
    response.status === "duplicate" ||
    response.status === "coalesced"
  ) {
    return { status: response.status, providerReceiptId: response.providerReceiptId };
  }
  if (response.status === "blocked") {
    return { status: "blocked", code: response.code };
  }
  return response.retryAfterMs === undefined
    ? { status: "retry", code: response.code }
    : { status: "retry", code: response.code, retryAfterMs: response.retryAfterMs };
}

/**
 * Runs one provider request in one fixed executable. Once the child successfully spawns, every
 * transport or protocol failure is treated as outcome-ambiguous: the provider may have accepted
 * the wake before its response was lost. Only a synchronous spawn failure or a pre-spawn `error`
 * is safely retryable.
 */
export class AgentWakeProviderProcessTarget implements AgentWakeTarget {
  readonly #resolveTarget: AgentWakeProviderExecutableResolver;
  readonly #verifyExecutable: (pin: AgentWakeExecutablePin) => Promise<string>;
  readonly #processFactory: AgentWakeProviderProcessFactory;
  readonly #timer: AgentWakeProviderTimer;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;

  constructor(options: AgentWakeProviderProcessTargetOptions) {
    this.#resolveTarget = options.resolveTarget;
    this.#verifyExecutable = options.verifyExecutable ?? verifyAgentWakeExecutablePin;
    this.#processFactory = options.processFactory ?? defaultProcessFactory;
    this.#timer = options.timer ?? defaultTimer;
    this.#environment = sanitizedEnvironment(options.environment ?? process.env);
    this.#timeoutMs = positiveInteger(options.timeoutMs, AGENT_WAKE_PROVIDER_DEFAULT_TIMEOUT_MS);
    this.#maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes,
      AGENT_WAKE_PROVIDER_DEFAULT_MAX_STDOUT_BYTES,
    );
    this.#maxStderrBytes = positiveInteger(
      options.maxStderrBytes,
      AGENT_WAKE_PROVIDER_DEFAULT_MAX_STDERR_BYTES,
    );
  }

  async accept(input: Parameters<AgentWakeTarget["accept"]>[0]): Promise<AgentWakeTargetResult> {
    if (input.signal.aborted) {
      throw new AgentWakeProviderProcessError("provider-operation-aborted");
    }
    if (
      !validOpaqueHandle(input.provider.adapterId) ||
      !validOpaqueHandle(input.provider.targetHandle) ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt <= 0 ||
      !agentWakeSignalSchema.safeParse(input.wake).success
    ) {
      return { status: "blocked", code: "provider-contract-invalid" };
    }

    let matches: readonly AgentWakeProviderExecutableConfig[];
    try {
      matches = await this.#resolveTarget(input.provider.targetHandle);
    } catch {
      return { status: "retry", code: "provider-unavailable" };
    }
    if (input.signal.aborted) {
      throw new AgentWakeProviderProcessError("provider-operation-aborted");
    }
    if (!Array.isArray(matches)) {
      return { status: "blocked", code: "provider-contract-invalid" };
    }
    const config: unknown = matches.length === 1 ? matches[0] : undefined;
    if (
      config === undefined ||
      !validExecutableConfig(config) ||
      config.adapterId !== input.provider.adapterId
    ) {
      return { status: "blocked", code: "provider-contract-invalid" };
    }

    const request = Buffer.from(
      `${JSON.stringify({
        version: 1,
        type: "agent.wake.request",
        adapterId: config.adapterId,
        attempt: input.attempt,
        wake: input.wake,
      })}\n`,
      "utf8",
    );
    if (request.byteLength > MAX_REQUEST_BYTES) {
      return { status: "blocked", code: "provider-contract-invalid" };
    }

    let executablePath: string;
    try {
      executablePath = await this.#verifyExecutable(config.executablePin);
    } catch {
      return { status: "blocked", code: "provider-contract-invalid" };
    }
    if (input.signal.aborted) {
      throw new AgentWakeProviderProcessError("provider-operation-aborted");
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#processFactory(executablePath, [...config.arguments], {
        shell: false,
        windowsHide: true,
        env: { ...this.#environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return { status: "retry", code: "provider-unavailable" };
    }

    return new Promise<AgentWakeTargetResult>((resolve, reject) => {
      let settled = false;
      let spawned = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let closed = false;
      let failure: AgentWakeProviderProcessErrorCode | null = null;
      const stdoutChunks: Buffer[] = [];
      let timeout: AgentWakeProviderTimerHandle | null = null;

      const kill = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Cleanup failure cannot make an ambiguous provider outcome safe to retry.
        }
      };
      const cleanup = (): void => {
        timeout?.cancel();
        input.signal.removeEventListener("abort", abort);
      };
      const complete = (result: AgentWakeTargetResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const rejectFailure = (): void => {
        if (settled || failure === null) return;
        settled = true;
        cleanup();
        reject(new AgentWakeProviderProcessError(failure));
      };
      const fail = (code: AgentWakeProviderProcessErrorCode): void => {
        if (settled || failure !== null) return;
        failure = code;
        cleanup();
        if (closed) {
          rejectFailure();
          return;
        }
        kill();
      };
      const abort = (): void => fail("provider-operation-aborted");

      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.#maxStdoutBytes) {
          fail("provider-outcome-ambiguous");
          return;
        }
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.#maxStderrBytes) fail("provider-outcome-ambiguous");
      });
      child.stdin.once("error", () => fail("provider-outcome-ambiguous"));
      child.stdout.once("error", () => fail("provider-outcome-ambiguous"));
      child.stderr.once("error", () => fail("provider-outcome-ambiguous"));
      child.once("spawn", () => {
        if (settled) return;
        spawned = true;
        if (failure !== null || input.signal.aborted) {
          if (failure === null) fail("provider-operation-aborted");
          else kill();
          return;
        }
        child.stdin.end(request);
      });
      child.once("error", () => {
        if (settled || failure !== null) return;
        if (!spawned) {
          settled = true;
          cleanup();
          resolve({ status: "retry", code: "provider-unavailable" });
          return;
        }
        fail("provider-outcome-ambiguous");
      });
      child.once("close", (code) => {
        if (settled) return;
        closed = true;
        if (failure !== null) {
          rejectFailure();
          return;
        }
        if (!spawned) {
          settled = true;
          cleanup();
          resolve({ status: "retry", code: "provider-unavailable" });
          return;
        }
        if (code !== 0) {
          fail("provider-outcome-ambiguous");
          return;
        }
        const response = mappedResponse(
          parseSingleResponse(Buffer.concat(stdoutChunks, stdoutBytes)),
          input.provider,
          input.wake.wakeId,
          input.attempt,
        );
        if (response === null) {
          fail("provider-outcome-ambiguous");
          return;
        }
        complete(response);
      });
      timeout = this.#timer.schedule(this.#timeoutMs, () => fail("provider-outcome-ambiguous"));
      if (settled) timeout.cancel();
      if (input.signal.aborted) abort();
    });
  }
}
