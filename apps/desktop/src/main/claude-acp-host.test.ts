import type {
  AnyMessage,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import {
  buildClaudeAcpEnvironment,
  createClaudeAcpHost,
  resolveClaudeCodeExecutable,
  type ClaudeAcpHostCallbacks,
  type ClaudeAcpHostDependencies,
  type ClaudeAcpHostError,
  type ClaudeAcpWorker,
  type ClaudeAcpWorkerLaunch,
} from "./claude-acp-host";

type WorkerResponder = (message: AnyMessage, worker: FakeClaudeAcpWorker) => void;

const modeState = {
  currentModeId: "bypassPermissions",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "bypassPermissions", name: "Bypass permissions" },
  ],
};

const modeConfig = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "bypassPermissions",
  options: [
    { value: "default", name: "Manual" },
    { value: "bypassPermissions", name: "Bypass permissions" },
  ],
} as const;

function isRequest(message: AnyMessage): message is Extract<AnyMessage, { id: unknown }> & {
  method: string;
} {
  return "method" in message && "id" in message;
}

class FakeClaudeAcpWorker implements ClaudeAcpWorker {
  readonly spawned: Promise<void>;
  readonly sent: AnyMessage[] = [];
  killed = false;
  #messageListeners: Array<(message: unknown) => void> = [];
  #exitListeners: Array<(exitCode: number) => void> = [];
  #fatalErrorListeners: Array<() => void> = [];

  constructor(
    private readonly responder: WorkerResponder = standardResponder,
    spawned: Promise<void> = Promise.resolve(),
  ) {
    this.spawned = spawned;
  }

  postMessage(value: unknown): void {
    if (typeof value !== "object" || value === null || !("message" in value)) return;
    const envelope = value as { readonly message: AnyMessage };
    this.sent.push(envelope.message);
    queueMicrotask(() => this.responder(envelope.message, this));
  }

  kill(): void {
    this.killed = true;
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListeners.push(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.#exitListeners.push(listener);
  }

  onFatalError(listener: () => void): void {
    this.#fatalErrorListeners.push(listener);
  }

  emit(message: AnyMessage): void {
    this.emitEnvelope({ type: "acp", message });
  }

  emitEnvelope(envelope: unknown): void {
    for (const listener of this.#messageListeners) listener(envelope);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.#exitListeners) listener(exitCode);
  }

  emitFatalError(): void {
    for (const listener of this.#fatalErrorListeners) listener();
  }

  respond(id: string | number | null, result: unknown): void {
    this.emit({ jsonrpc: "2.0", id, result });
  }
}

function standardResponder(message: AnyMessage, worker: FakeClaudeAcpWorker): void {
  if (!isRequest(message)) return;
  switch (message.method) {
    case "initialize":
      worker.respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {} },
        },
      });
      break;
    case "session/new":
      worker.respond(message.id, {
        sessionId: "session-new",
        modes: modeState,
        configOptions: [modeConfig],
      });
      break;
    case "session/load":
      worker.respond(message.id, { modes: modeState, configOptions: [modeConfig] });
      break;
    case "session/set_config_option":
      worker.respond(message.id, {
        configOptions: [{ ...modeConfig, currentValue: "default" }],
      });
      break;
    case "session/set_mode":
    case "session/close":
      worker.respond(message.id, {});
      break;
    case "session/prompt":
      worker.respond(message.id, { stopReason: "end_turn" });
      break;
  }
}

function defaultCallbacks(overrides: Partial<ClaudeAcpHostCallbacks> = {}): ClaudeAcpHostCallbacks {
  return {
    onSessionUpdate: vi.fn(),
    requestPermission: vi.fn(() =>
      Promise.resolve<RequestPermissionResponse>({ outcome: { outcome: "cancelled" } }),
    ),
    onExit: vi.fn(),
    ...overrides,
  };
}

function requestFor(worker: FakeClaudeAcpWorker, method: string): AnyMessage | undefined {
  return worker.sent.find((message) => "method" in message && message.method === method);
}

async function startFakeHost(
  worker: FakeClaudeAcpWorker,
  callbacks = defaultCallbacks(),
  captureLaunch?: (launch: ClaudeAcpWorkerLaunch) => void,
  dependencyOverrides: Partial<ClaudeAcpHostDependencies> = {},
) {
  return createClaudeAcpHost(callbacks, {
    environment: {
      PATH: "/opt/claude/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "test-api-key",
      HYPE_COMMS_SERVER_TOKEN: "must-not-leak",
      NODE_OPTIONS: "--inspect",
    },
    platform: "linux",
    homeDirectory: "/home/tester",
    workerPath: "/application/dist/main/claude-acp-worker.js",
    isExecutable: async (candidate) => candidate === "/opt/claude/bin/claude",
    forkWorker: (launch) => {
      captureLaunch?.(launch);
      return worker;
    },
    ...dependencyOverrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Claude Code executable discovery", () => {
  it("requires an absolute executable override and never falls through a bad override", async () => {
    const checked = vi.fn(() => Promise.resolve(true));

    await expect(
      resolveClaudeCodeExecutable({
        environment: {
          CLAUDE_CODE_EXECUTABLE: "relative/claude",
          PATH: "/otherwise-valid",
        },
        platform: "linux",
        homeDirectory: "/home/tester",
        isExecutable: checked,
      }),
    ).rejects.toMatchObject({ code: "claude-not-found" } satisfies Partial<ClaudeAcpHostError>);
    expect(checked).not.toHaveBeenCalled();
  });

  it("checks absolute PATH entries before conventional native-install locations", async () => {
    const checked: string[] = [];
    const executable = await resolveClaudeCodeExecutable({
      environment: { PATH: "relative:/first:/second" },
      platform: "linux",
      homeDirectory: "/home/tester",
      isExecutable: async (candidate) => {
        checked.push(candidate);
        return candidate === "/home/tester/.local/bin/claude";
      },
    });

    expect(executable).toBe("/home/tester/.local/bin/claude");
    expect(checked).toEqual(["/first/claude", "/second/claude", "/home/tester/.local/bin/claude"]);
  });

  it("uses Windows PATH semantics without invoking cmd.exe", async () => {
    const checked: string[] = [];
    const executable = await resolveClaudeCodeExecutable({
      environment: { PATH: 'relative;"C:\\Program Files\\Claude";D:\\Tools' },
      platform: "win32",
      homeDirectory: "C:\\Users\\tester",
      isExecutable: async (candidate) => {
        checked.push(candidate);
        return candidate === "D:\\Tools\\claude.exe";
      },
    });

    expect(executable).toBe("D:\\Tools\\claude.exe");
    expect(checked).toEqual(["C:\\Program Files\\Claude\\claude.exe", "D:\\Tools\\claude.exe"]);
  });
});

describe("Claude ACP host", () => {
  it("kills a worker that misses its spawn deadline and ignores a late spawn", async () => {
    vi.useFakeTimers();
    let resolveSpawn: (() => void) | undefined;
    const delayedSpawn = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });
    const worker = new FakeClaudeAcpWorker(standardResponder, delayedSpawn);
    const onExit = vi.fn();
    let markLaunched: (() => void) | undefined;
    const launched = new Promise<void>((resolve) => {
      markLaunched = resolve;
    });
    const startup = startFakeHost(worker, defaultCallbacks({ onExit }), () => markLaunched?.(), {
      startupTimeoutMs: 50,
    });
    const rejection = expect(startup).rejects.toMatchObject({
      code: "worker-launch-failed",
      message: "The Claude ACP worker could not start",
    });

    await launched;
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
    resolveSpawn?.();
    await Promise.resolve();

    expect(worker.killed).toBe(true);
    expect(worker.sent).toEqual([]);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("cancels an in-flight worker spawn when the startup signal aborts", async () => {
    const worker = new FakeClaudeAcpWorker(standardResponder, new Promise<void>(() => undefined));
    const controller = new AbortController();
    let markLaunched: (() => void) | undefined;
    const launched = new Promise<void>((resolve) => {
      markLaunched = resolve;
    });
    const startup = startFakeHost(worker, defaultCallbacks(), () => markLaunched?.(), {
      startupSignal: controller.signal,
      startupTimeoutMs: 60_000,
    });
    const rejection = expect(startup).rejects.toMatchObject({ code: "worker-launch-failed" });

    await launched;
    controller.abort();
    await rejection;

    expect(worker.killed).toBe(true);
    expect(worker.sent).toEqual([]);
  });

  it("kills a spawned worker when ACP initialization misses the startup deadline", async () => {
    vi.useFakeTimers();
    const worker = new FakeClaudeAcpWorker((message, currentWorker) => {
      if (isRequest(message) && message.method === "initialize") return;
      standardResponder(message, currentWorker);
    });
    const onExit = vi.fn();
    let markLaunched: (() => void) | undefined;
    const launched = new Promise<void>((resolve) => {
      markLaunched = resolve;
    });
    const startup = startFakeHost(worker, defaultCallbacks({ onExit }), () => markLaunched?.(), {
      startupTimeoutMs: 50,
    });
    const rejection = expect(startup).rejects.toMatchObject({
      code: "connection-failed",
      message: "The Claude ACP connection failed",
    });

    await launched;
    for (
      let attempt = 0;
      attempt < 5 && requestFor(worker, "initialize") === undefined;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(requestFor(worker, "initialize")).toBeDefined();
    await vi.advanceTimersByTimeAsync(51);
    await rejection;

    expect(worker.killed).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("launches with a scrubbed environment and drives the complete ACP v1 lifecycle", async () => {
    const worker = new FakeClaudeAcpWorker();
    const onExit = vi.fn();
    let launch: ClaudeAcpWorkerLaunch | undefined;
    const host = await startFakeHost(
      worker,
      defaultCallbacks({ onExit }),
      (value) => (launch = value),
    );

    expect(launch?.modulePath).toBe("/application/dist/main/claude-acp-worker.js");
    expect(launch?.environment).toMatchObject({
      PATH: "/opt/claude/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "test-api-key",
      CLAUDE_CODE_EXECUTABLE: "/opt/claude/bin/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(launch?.environment).not.toHaveProperty("HYPE_COMMS_SERVER_TOKEN");
    expect(launch?.environment).not.toHaveProperty("NODE_OPTIONS");

    const initialize = requestFor(worker, "initialize");
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    });

    await expect(host.newSession("/workspace/project")).resolves.toMatchObject({
      sessionId: "session-new",
    });
    expect(requestFor(worker, "session/new")).toMatchObject({
      params: { cwd: "/workspace/project", mcpServers: [] },
    });
    expect(requestFor(worker, "session/set_config_option")).toMatchObject({
      params: { sessionId: "session-new", configId: "mode", value: "default" },
    });

    await expect(host.prompt("session-new", "Please inspect this workspace")).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(requestFor(worker, "session/prompt")).toMatchObject({
      params: {
        sessionId: "session-new",
        prompt: [{ type: "text", text: "Please inspect this workspace" }],
      },
    });

    await host.cancel("session-new");
    expect(requestFor(worker, "session/cancel")).toMatchObject({
      params: { sessionId: "session-new" },
    });
    await host.close("session-new");
    expect(requestFor(worker, "session/close")).toMatchObject({
      params: { sessionId: "session-new" },
    });

    await host.dispose();
    worker.emitExit(0);
    expect(worker.killed).toBe(true);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("streams updates and returns only an exact user-selected permission option", async () => {
    let promptRequestId: string | number | null | undefined;
    let permissionResponse: unknown;
    const worker = new FakeClaudeAcpWorker((message, currentWorker) => {
      if (isRequest(message) && message.method === "session/prompt") {
        promptRequestId = message.id;
        currentWorker.emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-new",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Working" },
            },
          },
        });
        currentWorker.emit({
          jsonrpc: "2.0",
          id: 700,
          method: "session/request_permission",
          params: {
            sessionId: "session-new",
            toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      if (!("method" in message) && message.id === 700 && "result" in message) {
        permissionResponse = message.result;
        if (promptRequestId !== undefined) {
          currentWorker.respond(promptRequestId, { stopReason: "end_turn" });
        }
        return;
      }
      standardResponder(message, currentWorker);
    });
    const updates: SessionNotification[] = [];
    const permissionRequests: RequestPermissionRequest[] = [];
    const host = await startFakeHost(
      worker,
      defaultCallbacks({
        onSessionUpdate: (notification) => {
          updates.push(notification);
        },
        requestPermission: async (request, signal) => {
          expect(signal.aborted).toBe(false);
          permissionRequests.push(request);
          return { outcome: { outcome: "selected", optionId: "allow-once" } };
        },
      }),
    );

    await expect(host.prompt("session-new", "Run the checks")).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    expect(permissionRequests[0]?.toolCall.toolCallId).toBe("tool-1");
    expect(permissionResponse).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    await host.dispose();
  });

  it("fails closed when a permission callback returns an unknown option", async () => {
    let permissionResponse: unknown;
    const worker = new FakeClaudeAcpWorker((message, currentWorker) => {
      if (isRequest(message) && message.method === "session/prompt") {
        currentWorker.emit({
          jsonrpc: "2.0",
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId: "session-new",
            toolCall: { toolCallId: "tool-2", title: "Edit file", kind: "edit" },
            options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
          },
        });
        return;
      }
      if (!("method" in message) && message.id === "permission" && "result" in message) {
        permissionResponse = message.result;
        const prompt = requestFor(currentWorker, "session/prompt");
        if (prompt !== undefined && "id" in prompt) {
          currentWorker.respond(prompt.id, { stopReason: "cancelled" });
        }
        return;
      }
      standardResponder(message, currentWorker);
    });
    const host = await startFakeHost(
      worker,
      defaultCallbacks({
        requestPermission: async () => ({
          outcome: { outcome: "selected", optionId: "not-advertised" },
        }),
      }),
    );

    await host.prompt("session-new", "Edit it");
    expect(permissionResponse).toEqual({ outcome: { outcome: "cancelled" } });
    await host.dispose();
  });

  it("uses legacy session/set_mode when no mode config option is advertised", async () => {
    const worker = new FakeClaudeAcpWorker((message, currentWorker) => {
      if (isRequest(message) && message.method === "session/load") {
        currentWorker.respond(message.id, { modes: modeState, configOptions: [] });
        return;
      }
      standardResponder(message, currentWorker);
    });
    const host = await startFakeHost(worker);

    await expect(host.loadSession("/workspace/project", "existing-session")).resolves.toEqual({
      modes: modeState,
      configOptions: [],
    });
    expect(requestFor(worker, "session/set_mode")).toMatchObject({
      params: { sessionId: "existing-session", modeId: "default" },
    });
    await host.dispose();
  });

  it("bounds a hung session close and tears down the wedged transport", async () => {
    vi.useFakeTimers();
    const worker = new FakeClaudeAcpWorker((message, currentWorker) => {
      if (isRequest(message) && message.method === "session/close") return;
      standardResponder(message, currentWorker);
    });
    const onExit = vi.fn();
    const host = await startFakeHost(worker, defaultCallbacks({ onExit }), undefined, {
      startupTimeoutMs: 1_000,
      teardownTimeoutMs: 25,
    });
    const closing = host.close("session-new");
    const rejection = expect(closing).rejects.toMatchObject({
      code: "session-operation-failed",
      message: "The Claude ACP session operation failed",
    });

    await vi.advanceTimersByTimeAsync(26);
    await rejection;

    expect(worker.killed).toBe(true);
    expect(onExit).toHaveBeenCalledWith({ reason: "transport-failed", exitCode: null });
    await host.dispose();
  });

  it("enforces a byte-aware inbound queue budget before the count-only legacy cap", async () => {
    const worker = new FakeClaudeAcpWorker();
    const onExit = vi.fn();
    const host = await startFakeHost(worker, defaultCallbacks({ onExit }));
    const body = "x".repeat(1_024 * 1_024);

    for (let index = 0; index < 9; index++) {
      worker.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-new",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: body },
          },
        },
      });
    }

    expect(worker.killed).toBe(true);
    expect(onExit).toHaveBeenCalledWith({ reason: "transport-failed", exitCode: null });
    await host.dispose();
  });

  it("kills the worker and emits only a curated exit event for an invalid envelope", async () => {
    const worker = new FakeClaudeAcpWorker();
    const onExit = vi.fn();
    const host = await startFakeHost(worker, defaultCallbacks({ onExit }));

    worker.emitEnvelope({ type: "acp", message: "raw worker stderr must not escape" });

    expect(worker.killed).toBe(true);
    expect(onExit).toHaveBeenCalledWith({ reason: "transport-failed", exitCode: null });
    expect(JSON.stringify(onExit.mock.calls)).not.toContain("raw worker stderr");
    await host.dispose();
  });
});

describe("buildClaudeAcpEnvironment", () => {
  it("copies only explicit runtime/provider keys and overwrites safety controls", () => {
    expect(
      buildClaudeAcpEnvironment(
        {
          PATH: "/bin",
          HOME: "/home/tester",
          ANTHROPIC_API_KEY: "api-key",
          CLAUDE_CODE_EXECUTABLE: "/untrusted/override",
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
          DISABLE_AUTOUPDATER: "0",
          HYPE_COMMS_SERVER_TOKEN: "application-secret",
          NODE_OPTIONS: "--require /tmp/inject.js",
          LANG: "invalid\0value",
        },
        "/verified/claude",
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/tester",
      ANTHROPIC_API_KEY: "api-key",
      CLAUDE_CODE_EXECUTABLE: "/verified/claude",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });
});
