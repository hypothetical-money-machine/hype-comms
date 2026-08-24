import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { AgentWakeSignal } from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AgentWakeProviderBinding, AgentWakeTargetResult } from "./agent-wake-broker";
import {
  AgentWakeProviderProcessTarget,
  type AgentWakeProviderExecutableConfig,
  type AgentWakeProviderProcessFactory,
  type AgentWakeProviderTimer,
  type AgentWakeProviderTimerHandle,
} from "./agent-wake-provider-process";
import type { AgentWakeExecutablePin } from "./agent-wake-configuration";

const AGENT_USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const EVENT_ID = "10000000-0000-4000-8000-000000000005";
const WAKE_ID = "a".repeat(64);
const NOW = "2026-08-23T18:00:00.000Z";
const EXECUTABLE_PATH = "/opt/hype/bin/agent-runtime-wake-adapter";
const EXECUTABLE_PIN: AgentWakeExecutablePin = {
  version: 1,
  fileKind: "native-executable",
  configuredPath: EXECUTABLE_PATH,
  canonicalPath: EXECUTABLE_PATH,
  accountUid: 501,
  device: "1",
  inode: "2",
  ownerUid: 501,
  groupId: 20,
  mode: 0o100755,
  size: "123",
  modificationTimeNs: "1",
  changeTimeNs: "1",
  sha256: "a".repeat(64),
  ancestors: [
    { path: "/", device: "1", inode: "1", ownerUid: 0, groupId: 0, mode: 0o040755 },
    { path: "/opt", device: "1", inode: "2", ownerUid: 0, groupId: 0, mode: 0o040755 },
    {
      path: "/opt/hype",
      device: "1",
      inode: "3",
      ownerUid: 501,
      groupId: 20,
      mode: 0o040755,
    },
    {
      path: "/opt/hype/bin",
      device: "1",
      inode: "4",
      ownerUid: 501,
      groupId: 20,
      mode: 0o040755,
    },
  ],
};

const WAKE: AgentWakeSignal = {
  version: 1,
  type: "agent.wake",
  delivery: "at_least_once",
  wakeId: WAKE_ID,
  eventId: EVENT_ID,
  workspaceSequence: "43",
  workspaceId: WORKSPACE_ID,
  agentUserId: AGENT_USER_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  threadRootId: null,
  occurredAt: NOW,
  reason: "direct_message",
};

const PROVIDER: AgentWakeProviderBinding = {
  adapterId: "agent-runtime-test",
  targetHandle: "opaque-target-handle",
};

const CONFIG: AgentWakeProviderExecutableConfig = {
  adapterId: "agent-runtime-test",
  executablePath: EXECUTABLE_PATH,
  executablePin: EXECUTABLE_PIN,
  arguments: [],
};

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (this.#autoCloseOnKill && !this.#closed) {
      queueMicrotask(() => this.close(null, typeof signal === "string" ? signal : null));
    }
    return true;
  });
  #closed = false;
  readonly #autoCloseOnKill: boolean;

  constructor(autoCloseOnKill = true) {
    super();
    this.#autoCloseOnKill = autoCloseOnKill;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

class ManualTimer implements AgentWakeProviderTimer {
  task: (() => void) | null = null;
  delayMs: number | null = null;
  readonly handle: AgentWakeProviderTimerHandle = { cancel: vi.fn() };

  schedule(delayMs: number, task: () => void): AgentWakeProviderTimerHandle {
    this.delayMs = delayMs;
    this.task = task;
    return this.handle;
  }

  fire(): void {
    this.task?.();
  }
}

interface Harness {
  readonly target: AgentWakeProviderProcessTarget;
  readonly child: FakeChildProcess;
  readonly processFactory: ReturnType<typeof vi.fn<AgentWakeProviderProcessFactory>>;
  readonly timer: ManualTimer;
  readonly launched: Promise<void>;
}

function harness(
  options: {
    readonly matches?: readonly AgentWakeProviderExecutableConfig[];
    readonly environment?: NodeJS.ProcessEnv;
    readonly maxStdoutBytes?: number;
    readonly maxStderrBytes?: number;
    readonly processFactory?: AgentWakeProviderProcessFactory;
    readonly verifyExecutable?: (pin: AgentWakeExecutablePin) => Promise<string>;
    readonly autoCloseOnKill?: boolean;
  } = {},
): Harness {
  const child = new FakeChildProcess(options.autoCloseOnKill);
  let announceLaunch: (() => void) | undefined;
  const launched = new Promise<void>((resolve) => {
    announceLaunch = resolve;
  });
  const processFactory = vi.fn<AgentWakeProviderProcessFactory>(
    options.processFactory ??
      (() => {
        announceLaunch?.();
        return child as never;
      }),
  );
  const timer = new ManualTimer();
  const target = new AgentWakeProviderProcessTarget({
    resolveTarget: () => options.matches ?? [CONFIG],
    verifyExecutable: options.verifyExecutable ?? (async (pin) => pin.canonicalPath),
    processFactory,
    timer,
    timeoutMs: 1_234,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
    ...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
  });
  return { target, child, processFactory, timer, launched };
}

interface StartedRequest {
  readonly pending: Promise<AgentWakeTargetResult>;
  readonly request: Record<string, unknown>;
  readonly serializedRequest: string;
}

async function startRequest(
  value: Harness,
  options: {
    readonly controller?: AbortController;
    readonly provider?: AgentWakeProviderBinding;
    readonly wake?: AgentWakeSignal;
    readonly attempt?: number;
  } = {},
): Promise<StartedRequest> {
  const chunks: Buffer[] = [];
  value.child.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const inputEnded = new Promise<void>((resolve) => value.child.stdin.once("finish", resolve));
  const pending = value.target.accept({
    provider: options.provider ?? PROVIDER,
    wake: options.wake ?? WAKE,
    attempt: options.attempt ?? 2,
    signal: (options.controller ?? new AbortController()).signal,
  });
  await value.launched;
  value.child.emit("spawn");
  await inputEnded;
  const serializedRequest = Buffer.concat(chunks).toString("utf8");
  return {
    pending,
    request: JSON.parse(serializedRequest) as Record<string, unknown>,
    serializedRequest,
  };
}

function providerResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    type: "agent.wake.response",
    adapterId: PROVIDER.adapterId,
    wakeId: WAKE.wakeId,
    attempt: 2,
    status: "accepted",
    providerReceiptId: "provider-receipt-1",
    ...overrides,
  };
}

function closeWithResponse(child: FakeChildProcess, response: unknown, code = 0): void {
  child.stdout.write(`${typeof response === "string" ? response : JSON.stringify(response)}\n`);
  child.close(code);
}

describe("AgentWakeProviderProcessTarget", () => {
  it("spawns one fixed executable without a shell and sends one exact body-free request", async () => {
    const value = harness({
      environment: {
        PATH: "/safe/bin",
        NODE_OPTIONS: "--require=/tmp/untrusted.js",
        NODE_PATH: "/tmp/untrusted-modules",
        LANG: "en_US.UTF-8",
        HOME: "/Users/private",
        PROVIDER_TOKEN: "provider-secret",
      },
    });
    const started = await startRequest(value);

    expect(value.processFactory).toHaveBeenCalledWith(CONFIG.executablePath, CONFIG.arguments, {
      shell: false,
      windowsHide: true,
      env: {
        HYPE_AGENT_WAKE_PROTOCOL: "1",
        LANG: "en_US.UTF-8",
        HOME: "/Users/private",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(started.request).toEqual({
      version: 1,
      type: "agent.wake.request",
      adapterId: "agent-runtime-test",
      attempt: 2,
      wake: WAKE,
    });
    expect(started.serializedRequest.endsWith("\n")).toBe(true);
    expect(started.serializedRequest).not.toContain(PROVIDER.targetHandle);
    expect(started.serializedRequest).not.toContain("provider-secret");
    for (const forbidden of ["body", "history", "prompt", "token", "credential"]) {
      expect(started.request).not.toHaveProperty(forbidden);
      expect(started.request.wake).not.toHaveProperty(forbidden);
    }

    closeWithResponse(value.child, providerResponse());
    await expect(started.pending).resolves.toEqual({
      status: "accepted",
      providerReceiptId: "provider-receipt-1",
    });
    expect(value.timer.delayMs).toBe(1_234);
  });

  it.each(["accepted", "duplicate", "coalesced"] as const)(
    "propagates a bounded receipt for %s",
    async (status) => {
      const value = harness();
      const started = await startRequest(value);

      closeWithResponse(
        value.child,
        providerResponse({ status, providerReceiptId: `receipt-${status}` }),
      );

      await expect(started.pending).resolves.toEqual({
        status,
        providerReceiptId: `receipt-${status}`,
      });
    },
  );

  it.each([
    ["provider-overloaded", undefined],
    ["provider-rate-limited", 5_000],
    ["provider-unavailable", 0],
  ] as const)("maps the known retry code %s", async (code, retryAfterMs) => {
    const value = harness();
    const started = await startRequest(value);
    const response = providerResponse({
      status: "retry",
      code,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    delete response.providerReceiptId;

    closeWithResponse(value.child, response);

    await expect(started.pending).resolves.toEqual({
      status: "retry",
      code,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  });

  it.each([
    "provider-authentication-required",
    "provider-contract-invalid",
    "provider-rejected",
  ] as const)("maps the known blocked code %s", async (code) => {
    const value = harness();
    const started = await startRequest(value);
    const response = providerResponse({ status: "blocked", code });
    delete response.providerReceiptId;

    closeWithResponse(value.child, response);

    await expect(started.pending).resolves.toEqual({ status: "blocked", code });
  });

  it("blocks unknown, ambiguous, mismatched, and invalid executable bindings", async () => {
    const ambiguous = harness({ matches: [CONFIG, { ...CONFIG }] });
    const mismatched = harness({ matches: [{ ...CONFIG, adapterId: "another-runtime" }] });
    const invalidPath = harness({ matches: [{ ...CONFIG, executablePath: "relative/adapter" }] });
    const scriptPin = harness({
      matches: [
        {
          ...CONFIG,
          executablePin: { ...EXECUTABLE_PIN, fileKind: "cli-entrypoint" },
        },
      ],
    });
    const interpreterArguments = harness({
      matches: [{ ...CONFIG, arguments: ["/untrusted/adapter.js"] }],
    });
    const missing = harness({ matches: [] });

    for (const value of [
      ambiguous,
      mismatched,
      invalidPath,
      scriptPin,
      interpreterArguments,
      missing,
    ]) {
      await expect(
        value.target.accept({
          provider: PROVIDER,
          wake: WAKE,
          attempt: 1,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ status: "blocked", code: "provider-contract-invalid" });
      expect(value.processFactory).not.toHaveBeenCalled();
    }
  });

  it("rejects executable identity drift immediately before spawn without exposing details", async () => {
    const secret = "/private/replaced/agent-runtime-wake-adapter";
    const value = harness({
      verifyExecutable: async () => {
        throw new Error(secret);
      },
    });

    const result = await value.target.accept({
      provider: PROVIDER,
      wake: WAKE,
      attempt: 1,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ status: "blocked", code: "provider-contract-invalid" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(value.processFactory).not.toHaveBeenCalled();
  });

  it("retries only when process creation fails before a possible handoff", async () => {
    const synchronous = harness({
      processFactory: () => {
        throw new Error("private executable path detail");
      },
    });
    await expect(
      synchronous.target.accept({
        provider: PROVIDER,
        wake: WAKE,
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "retry", code: "provider-unavailable" });

    const asynchronous = harness();
    const pending = asynchronous.target.accept({
      provider: PROVIDER,
      wake: WAKE,
      attempt: 1,
      signal: new AbortController().signal,
    });
    await asynchronous.launched;
    asynchronous.child.emit("error", new Error("private provider detail"));
    await expect(pending).resolves.toEqual({ status: "retry", code: "provider-unavailable" });
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["extra output", `${JSON.stringify(providerResponse())}\nprovider debug output`],
    ["an unknown response field", { ...providerResponse(), debug: "private" }],
    ["a wake mismatch", providerResponse({ wakeId: "b".repeat(64) })],
    ["an attempt mismatch", providerResponse({ attempt: 3 })],
    ["an adapter mismatch", providerResponse({ adapterId: "another-runtime" })],
    ["an unknown retry code", providerResponse({ status: "retry", code: "retry-everything" })],
    ["an oversized receipt", providerResponse({ providerReceiptId: "r".repeat(513) })],
    [
      "an oversized retry delay",
      providerResponse({
        status: "retry",
        code: "provider-rate-limited",
        retryAfterMs: 86_400_001,
        providerReceiptId: undefined,
      }),
    ],
  ])("treats %s as ambiguous without exposing child output", async (_label, response) => {
    const value = harness();
    const started = await startRequest(value);

    closeWithResponse(value.child, response);

    const error = await started.pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "provider-outcome-ambiguous" });
    expect(String(error)).not.toContain("private");
    expect(value.child.kill).not.toHaveBeenCalled();
  });

  it("treats nonzero exit after handoff as ambiguous", async () => {
    const value = harness();
    const started = await startRequest(value);

    value.child.close(7);

    await expect(started.pending).rejects.toMatchObject({ code: "provider-outcome-ambiguous" });
    expect(value.child.kill).not.toHaveBeenCalled();
  });

  it("bounds stdout and stderr without retaining either stream", async () => {
    const stdout = harness({ maxStdoutBytes: 8 });
    const stdoutRequest = await startRequest(stdout);
    stdout.child.stdout.write(Buffer.alloc(9, 65));
    await expect(stdoutRequest.pending).rejects.toMatchObject({
      code: "provider-outcome-ambiguous",
    });
    expect(stdout.child.kill).toHaveBeenCalledWith("SIGKILL");

    const stderr = harness({ maxStderrBytes: 8 });
    const stderrRequest = await startRequest(stderr);
    stderr.child.stderr.write(Buffer.alloc(9, 66));
    await expect(stderrRequest.pending).rejects.toMatchObject({
      code: "provider-outcome-ambiguous",
    });
    expect(stderr.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills and marks a timed-out post-handoff request ambiguous", async () => {
    const value = harness({ autoCloseOnKill: false });
    const started = await startRequest(value);
    let settled = false;
    void started.pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    value.timer.fire();

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);
    expect(value.child.kill).toHaveBeenCalledWith("SIGKILL");
    value.child.close(null, "SIGKILL");
    await expect(started.pending).rejects.toMatchObject({ code: "provider-outcome-ambiguous" });
  });

  it("settles a failed request when inherited stdio prevents close", async () => {
    const value = harness({ autoCloseOnKill: false });
    const started = await startRequest(value);
    let settled = false;
    const rejection = started.pending.catch((error: unknown) => {
      settled = true;
      return error;
    });

    value.timer.fire();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);
    expect(value.child.kill).toHaveBeenCalledWith("SIGKILL");

    value.timer.fire();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const settledAfterDeadline = settled;
    if (!settledAfterDeadline) value.child.close(null, "SIGKILL");

    expect(settledAfterDeadline).toBe(true);
    expect(value.child.stdin.destroyed).toBe(true);
    expect(value.child.stdout.destroyed).toBe(true);
    expect(value.child.stderr.destroyed).toBe(true);
    await expect(rejection).resolves.toMatchObject({ code: "provider-outcome-ambiguous" });
  });

  it("kills an aborted post-handoff request without retrying it", async () => {
    const value = harness();
    const controller = new AbortController();
    const started = await startRequest(value, { controller });

    controller.abort();

    await expect(started.pending).rejects.toMatchObject({ code: "provider-operation-aborted" });
    expect(value.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each(["abort", "timeout"] as const)(
    "never hands off a request when %s wins the pre-spawn-event race",
    async (failureKind) => {
      const value = harness({ autoCloseOnKill: false });
      const controller = new AbortController();
      const chunks: Buffer[] = [];
      value.child.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      const pending = value.target.accept({
        provider: PROVIDER,
        wake: WAKE,
        attempt: 2,
        signal: controller.signal,
      });
      await value.launched;

      if (failureKind === "abort") controller.abort();
      else value.timer.fire();
      value.child.emit("spawn");
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(Buffer.concat(chunks)).toHaveLength(0);
      expect(value.child.kill).toHaveBeenCalledWith("SIGKILL");
      value.child.close(null, "SIGKILL");
      await expect(pending).rejects.toMatchObject({
        code: failureKind === "abort" ? "provider-operation-aborted" : "provider-outcome-ambiguous",
      });
    },
  );
});
