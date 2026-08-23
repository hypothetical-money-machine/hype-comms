import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { AgentWakeSourceAccess, AgentWakeSourceFailure } from "./agent-wake-broker";
import {
  AgentWakeCliSourceAdapter,
  type AgentWakeCliChildProcess,
  type AgentWakeCliProcessFactory,
  type AgentWakeCliSpawnOptions,
  type AgentWakeCliTimers,
} from "./agent-wake-cli-source";
import type { AgentWakeExecutablePin } from "./agent-wake-configuration";

const NOW = "2026-08-23T20:00:00.000Z";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_USER_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_AGENT_USER_ID = "10000000-0000-4000-8000-000000000003";
const CREDENTIAL_HANDLE = "credential-ref-1";
const RUNTIME_EXECUTABLE_PATH = "/opt/hype-comms/bin/node";
const CLI_ENTRYPOINT_PATH = "/opt/hype-comms/lib/hype-comms-cli.js";
const PROFILE = "wake-agent";
const API_ORIGIN = "https://chat.example.test";

function executablePin(
  configuredPath: string,
  fileKind: AgentWakeExecutablePin["fileKind"],
  inode: string,
): AgentWakeExecutablePin {
  const parent = configuredPath.slice(0, configuredPath.lastIndexOf("/"));
  return {
    version: 1,
    fileKind,
    configuredPath,
    canonicalPath: configuredPath,
    accountUid: 501,
    device: "1",
    inode,
    ownerUid: 501,
    groupId: 20,
    mode: fileKind === "native-executable" ? 0o100755 : 0o100600,
    size: "123",
    modificationTimeNs: "1",
    changeTimeNs: "1",
    sha256: "a".repeat(64),
    ancestors: ["/", "/opt", "/opt/hype-comms", parent].map((ancestor, index) => ({
      path: ancestor,
      device: "1",
      inode: String(100 + index),
      ownerUid: ancestor === "/" || ancestor === "/opt" ? 0 : 501,
      groupId: 20,
      mode: 0o040755,
    })),
  };
}

const RUNTIME_EXECUTABLE_PIN = executablePin(RUNTIME_EXECUTABLE_PATH, "native-executable", "2");
const CLI_ENTRYPOINT_PIN = executablePin(CLI_ENTRYPOINT_PATH, "cli-entrypoint", "3");

interface SpawnCall {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly options: AgentWakeCliSpawnOptions;
}

class FakeChildProcess extends EventEmitter implements AgentWakeCliChildProcess {
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

  writeStdout(value: unknown): void {
    this.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function principal(
  scopes: readonly ("workspace:read" | "messages:write")[] = ["workspace:read", "messages:write"],
): unknown {
  return {
    type: "agent",
    user: {
      id: AGENT_USER_ID,
      kind: "agent",
      username: "wake-agent",
      displayName: "Wake Agent",
      avatarUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    workspaceId: WORKSPACE_ID,
    role: "member",
    scopes,
  };
}

function checkpoint(
  cursor: string,
  overrides: { readonly agentUserId?: string; readonly workspaceId?: string } = {},
): Record<string, unknown> {
  return {
    version: 1,
    type: "agent.wake.checkpoint",
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    agentUserId: overrides.agentUserId ?? AGENT_USER_ID,
    cursor,
  };
}

function access(overrides: Partial<AgentWakeSourceAccess> = {}): AgentWakeSourceAccess {
  return {
    credentialHandle: CREDENTIAL_HANDLE,
    apiOrigin: API_ORIGIN,
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_USER_ID,
    ...overrides,
  };
}

function processHarness(
  onSpawn?: (child: FakeChildProcess, call: SpawnCall) => void,
  autoCloseOnKill = true,
): {
  readonly calls: SpawnCall[];
  readonly children: FakeChildProcess[];
  readonly factory: AgentWakeCliProcessFactory;
} {
  const calls: SpawnCall[] = [];
  const children: FakeChildProcess[] = [];
  const factory: AgentWakeCliProcessFactory = (executablePath, args, options) => {
    const child = new FakeChildProcess(autoCloseOnKill);
    const call = { executablePath, args: [...args], options };
    calls.push(call);
    children.push(child);
    queueMicrotask(() => onSpawn?.(child, call));
    return child;
  };
  return { calls, children, factory };
}

function adapter(
  factory: AgentWakeCliProcessFactory,
  overrides: Partial<ConstructorParameters<typeof AgentWakeCliSourceAdapter>[0]> = {},
): AgentWakeCliSourceAdapter {
  return new AgentWakeCliSourceAdapter({
    resolveBinding: (handle) =>
      handle === CREDENTIAL_HANDLE
        ? {
            runtimeExecutablePath: RUNTIME_EXECUTABLE_PATH,
            runtimeExecutablePin: RUNTIME_EXECUTABLE_PIN,
            cliEntrypointPath: CLI_ENTRYPOINT_PATH,
            cliEntrypointPin: CLI_ENTRYPOINT_PIN,
            profile: PROFILE,
            apiOrigin: `${API_ORIGIN}/`,
          }
        : null,
    processFactory: factory,
    verifyExecutable: async (pin) => pin.canonicalPath,
    environment: {
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
      HYPE_COMMS_CONFIG_DIR: "/Users/tester/.config/hype-comms",
      HYPE_COMMS_TOKEN: "must-not-cross-process-boundary",
      NODE_OPTIONS: "--require=/tmp/untrusted.js",
      NODE_PATH: "/tmp/untrusted-modules",
      UNRELATED_SECRET: "must-not-cross-process-boundary",
    },
    commandTimeoutMs: 1_000,
    stopGraceMs: 100,
    ...overrides,
  });
}

function expectFailure(
  promise: Promise<unknown>,
  code: ConstructorParameters<typeof AgentWakeSourceFailure>[0],
  retryable: boolean,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: "AgentWakeSourceFailure",
    code,
    retryable,
    message: `Agent wake source failed: ${code}`,
  });
}

describe("AgentWakeCliSourceAdapter", () => {
  it("verifies an agent with a fixed, credential-free auth command and sanitized environment", async () => {
    const harness = processHarness((child) => {
      child.writeStdout(principal());
      child.close(0);
    });
    const source = adapter(harness.factory);

    await expect(
      source.verify({
        credentialHandle: CREDENTIAL_HANDLE,
        expectedAgentUserId: AGENT_USER_ID,
      }),
    ).resolves.toEqual({
      apiOrigin: API_ORIGIN,
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
    });
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0]!;
    expect(call.executablePath).toBe(RUNTIME_EXECUTABLE_PATH);
    expect(call.args).toEqual([
      CLI_ENTRYPOINT_PATH,
      "--profile",
      PROFILE,
      "--api-origin",
      API_ORIGIN,
      "auth",
      "whoami",
      "--json",
    ]);
    expect(call.options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(call.options.env).toEqual({
      NO_COLOR: "1",
      HOME: "/Users/tester",
      HYPE_COMMS_CONFIG_DIR: "/Users/tester/.config/hype-comms",
    });
    expect(JSON.stringify(call)).not.toContain(CREDENTIAL_HANDLE);
    expect(JSON.stringify(call)).not.toContain("must-not-cross-process-boundary");
  });

  it("rechecks the pinned runtime and entrypoint before every spawn and fails closed", async () => {
    const secret = "/private/replaced/hype-comms-cli";
    const verifyExecutable = vi
      .fn<(pin: AgentWakeExecutablePin) => Promise<string>>()
      .mockResolvedValueOnce(RUNTIME_EXECUTABLE_PATH)
      .mockResolvedValueOnce(CLI_ENTRYPOINT_PATH)
      .mockResolvedValueOnce(RUNTIME_EXECUTABLE_PATH)
      .mockRejectedValueOnce(new Error(secret));
    const harness = processHarness((child) => {
      child.writeStdout(principal());
      child.close(0);
    });
    const source = adapter(harness.factory, { verifyExecutable });

    await expect(
      source.verify({
        credentialHandle: CREDENTIAL_HANDLE,
        expectedAgentUserId: AGENT_USER_ID,
      }),
    ).resolves.toMatchObject({ agentUserId: AGENT_USER_ID });
    const rejected = source.verify({
      credentialHandle: CREDENTIAL_HANDLE,
      expectedAgentUserId: AGENT_USER_ID,
    });

    await expectFailure(rejected, "source-scope-invalid", false);
    await expect(rejected).rejects.not.toThrow(secret);
    expect(verifyExecutable).toHaveBeenCalledTimes(4);
    expect(harness.calls).toHaveLength(1);
  });

  it("stops an active whoami child when supervised startup is aborted", async () => {
    const harness = processHarness(undefined, false);
    const source = adapter(harness.factory, { stopGraceMs: 1 });
    const controller = new AbortController();
    const verifying = source.verify({
      credentialHandle: CREDENTIAL_HANDLE,
      expectedAgentUserId: AGENT_USER_ID,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.children).toHaveLength(1));
    let settled = false;
    void verifying.then(
      () => (settled = true),
      () => (settled = true),
    );

    controller.abort();

    await vi.waitFor(() => expect(harness.children[0]?.kill).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    harness.children[0]?.close(null, "SIGKILL");
    await expectFailure(verifying, "source-unavailable", true);
    expect(harness.children[0]?.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(harness.children[0]?.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("captures the first future-only checkpoint without supplying an after cursor", async () => {
    const harness = processHarness((child) => {
      child.writeStdout(checkpoint("41"));
    });
    const source = adapter(harness.factory);

    await expect(source.captureHighWater(access())).resolves.toBe("41");
    expect(harness.calls[0]?.args).toEqual([
      CLI_ENTRYPOINT_PATH,
      "--profile",
      PROFILE,
      "--api-origin",
      API_ORIGIN,
      "wake",
      "watch",
      "--json",
    ]);
    expect(harness.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops an active high-water child when supervised startup is aborted", async () => {
    const harness = processHarness(undefined, false);
    const source = adapter(harness.factory, { stopGraceMs: 1 });
    const controller = new AbortController();
    const capturing = source.captureHighWater(access(), controller.signal);
    await vi.waitFor(() => expect(harness.children).toHaveLength(1));
    let settled = false;
    void capturing.then(
      () => (settled = true),
      () => (settled = true),
    );

    controller.abort();

    await vi.waitFor(() => expect(harness.children[0]?.kill).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    harness.children[0]?.close(null, "SIGKILL");
    await expectFailure(capturing, "source-unavailable", true);
    expect(harness.children[0]?.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(harness.children[0]?.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("rejects an authenticated agent that lacks wake read scope", async () => {
    const harness = processHarness((child) => {
      child.writeStdout(principal(["messages:write"]));
      child.close(0);
    });
    const source = adapter(harness.factory);

    await expectFailure(
      source.verify({
        credentialHandle: CREDENTIAL_HANDLE,
        expectedAgentUserId: AGENT_USER_ID,
      }),
      "source-scope-invalid",
      false,
    );
  });

  it("opens from the durable cursor, strictly parses records, and backpressures stdout", async () => {
    const harness = processHarness();
    const source = adapter(harness.factory, {
      maxRecordQueueDepth: 1,
      maxStdoutLineBytes: 1_024,
      maxStdoutBufferBytes: 4_096,
    });
    const session = await source.open({ ...access(), after: "7" });
    const child = harness.children[0]!;
    const first = checkpoint("8");
    const second = checkpoint("9");

    child.writeStdout(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    expect(child.stdout.isPaused()).toBe(true);
    await expect(session.next()).resolves.toEqual(first);
    expect(child.stdout.isPaused()).toBe(true);
    await expect(session.next()).resolves.toEqual(second);
    expect(child.stdout.isPaused()).toBe(false);
    await expect(session.acknowledge("9")).resolves.toBeUndefined();
    expect(harness.calls[0]?.args).toEqual([
      CLI_ENTRYPOINT_PATH,
      "--profile",
      PROFILE,
      "--api-origin",
      API_ORIGIN,
      "wake",
      "watch",
      "--json",
      "--after",
      "7",
    ]);
    await session.stop();
  });

  it("rejects a non-body-free stream record without reflecting its content", async () => {
    const harness = processHarness();
    const source = adapter(harness.factory);
    const session = await source.open({ ...access(), after: "7" });
    const pending = session.next();
    const secret = "private message body that must never escape";

    harness.children[0]!.writeStdout({ ...checkpoint("8"), body: secret });
    await expectFailure(pending, "source-record-invalid", false);
    expect(harness.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(pending).rejects.not.toThrow(secret);
    await session.stop();
  });

  it("classifies a record for another agent as a nonretryable scope failure", async () => {
    const harness = processHarness();
    const source = adapter(harness.factory);
    const session = await source.open({ ...access(), after: "7" });
    const pending = session.next();

    harness.children[0]!.writeStdout(checkpoint("8", { agentUserId: OTHER_AGENT_USER_ID }));
    await expectFailure(pending, "source-scope-invalid", false);
    await session.stop();
  });

  it("bounds unterminated stdout and reports replay overflow", async () => {
    const harness = processHarness();
    const source = adapter(harness.factory, {
      maxStdoutLineBytes: 128,
      maxStdoutBufferBytes: 128,
    });
    const session = await source.open({ ...access(), after: "7" });
    const pending = session.next();

    harness.children[0]!.stdout.write(Buffer.alloc(129, 0x61));
    await expectFailure(pending, "source-client-replay-overflow", false);
    expect(harness.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    await session.stop();
  });

  it("maps credential revocation to a stable nonretryable authentication failure", async () => {
    const secret = "raw CLI stderr with credential-like material";
    const harness = processHarness();
    const source = adapter(harness.factory);
    const session = await source.open({ ...access(), after: "7" });
    const pending = session.next();

    harness.children[0]!.stderr.write(secret.repeat(10_000));
    harness.children[0]!.close(3);
    await expectFailure(pending, "source-authentication-required", false);
    await expect(pending).rejects.not.toThrow(secret);
    await session.stop();
  });

  it("maps a transient CLI exit to a retryable source failure", async () => {
    const harness = processHarness();
    const source = adapter(harness.factory);
    const session = await source.open({ ...access(), after: "7" });
    const pending = session.next();

    harness.children[0]!.close(5);
    await expectFailure(pending, "source-unavailable", true);
    await session.stop();
  });

  it("stops cleanly, aborts a pending read, and uses the injected timers", async () => {
    const setTimer = vi.fn((task: () => void, delayMs: number) => setTimeout(task, delayMs));
    const clearTimer = vi.fn((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    );
    const timers: AgentWakeCliTimers = {
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    };
    const harness = processHarness();
    const source = adapter(harness.factory, { timers });
    const session = await source.open({ ...access(), after: "7" });
    const pending = session.next();
    const firstStop = session.stop();
    const secondStop = session.stop();

    expect(firstStop).toBe(secondStop);
    await expect(firstStop).resolves.toBeUndefined();
    await expectFailure(pending, "source-unavailable", true);
    expect(harness.children[0]?.kill).toHaveBeenCalledTimes(1);
    expect(harness.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(clearTimer).toHaveBeenCalled();
  });
});
