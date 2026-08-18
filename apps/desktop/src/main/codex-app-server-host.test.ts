import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import type {
  AiAgentHostCallbacks,
  AiAgentHostPermissionOutcome,
  AiAgentHostPermissionRequest,
} from "./ai-agent-host";
import {
  buildCodexWorkerEnvironment,
  createCodexAppServerHost,
  type CodexAppServerHostDependencies,
  type CodexUtilityWorker,
  type CodexUtilityWorkerLaunch,
} from "./codex-app-server-host";
import type { CodexUtilityRequest } from "./codex-app-server-worker";

type WorkerResponder = (message: CodexUtilityRequest, worker: FakeCodexUtilityWorker) => void;

class FakeCodexUtilityWorker implements CodexUtilityWorker {
  readonly sent: CodexUtilityRequest[] = [];
  readonly killedProcessGroups: number[] = [];
  readonly cleanupOrder: string[] = [];
  readonly spawned: Promise<void>;
  killed = false;
  #messageListeners: Array<(message: unknown) => void> = [];
  #exitListeners: Array<(exitCode: number) => void> = [];
  #errorListeners: Array<() => void> = [];

  constructor(
    private readonly responder: WorkerResponder = standardResponder,
    spawned: Promise<void> = Promise.resolve(),
  ) {
    this.spawned = spawned;
  }

  postMessage(message: unknown): void {
    const request = message as CodexUtilityRequest;
    this.sent.push(request);
    queueMicrotask(() => this.responder(request, this));
  }

  kill(): void {
    this.killed = true;
    this.cleanupOrder.push("worker");
  }

  killProcessGroup(processGroupId: number): void {
    this.killedProcessGroups.push(processGroupId);
    this.cleanupOrder.push(`group:${processGroupId}`);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListeners.push(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.#exitListeners.push(listener);
  }

  onFatalError(listener: () => void): void {
    this.#errorListeners.push(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.#messageListeners) listener(message);
  }

  emitExit(exitCode = 1): void {
    for (const listener of this.#exitListeners) listener(exitCode);
  }

  emitError(): void {
    for (const listener of this.#errorListeners) listener();
  }
}

function standardResponder(message: CodexUtilityRequest, worker: FakeCodexUtilityWorker): void {
  if (message.type !== "codex-request") return;
  if (message.method === "connect") {
    worker.emit({ type: "codex-process-group", processGroupId: 4_100 });
    worker.emit({ type: "codex-response", id: message.id, result: {} });
  } else if (message.method === "new-conversation") {
    worker.emit({
      type: "codex-response",
      id: message.id,
      result: { conversationId: "thread-cursor" },
    });
  } else {
    worker.emit({ type: "codex-response", id: message.id, result: {} });
  }
}

function callbacks(overrides: Partial<AiAgentHostCallbacks> = {}): AiAgentHostCallbacks {
  return {
    onEvent: vi.fn(),
    requestPermission: vi.fn(() =>
      Promise.resolve<AiAgentHostPermissionOutcome>({ outcome: "cancelled" }),
    ),
    onExit: vi.fn(),
    ...overrides,
  };
}

async function createFakeHost(
  worker: FakeCodexUtilityWorker,
  callbackValue = callbacks(),
  captureLaunch?: (launch: CodexUtilityWorkerLaunch) => void,
  overrides: Partial<CodexAppServerHostDependencies> = {},
) {
  return createCodexAppServerHost(callbackValue, {
    configurationMode: "test-only",
    environment: {
      PATH: "/opt/codex/bin:/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      CODEX_EXECUTABLE: "/opt/codex/bin/codex",
      OPENAI_API_KEY: "must-not-leak",
      HYPE_COMMS_SERVER_TOKEN: "must-not-leak",
      NODE_OPTIONS: "--inspect",
    },
    workerPath: "/application/dist/main/codex-app-server-worker.js",
    forkWorker(launch) {
      captureLaunch?.(launch);
      return worker;
    },
    startupTimeoutMs: 1_000,
    operationTimeoutMs: 1_000,
    interruptTimeoutMs: 100,
    teardownTimeoutMs: 100,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Codex utility worker boundary", () => {
  it("keeps the production factory disabled until a configuration mode is approved", async () => {
    const forkWorker = vi.fn(() => new FakeCodexUtilityWorker());
    await expect(
      createCodexAppServerHost(callbacks(), {
        forkWorker,
        workerPath: "/application/dist/main/codex-app-server-worker.js",
      }),
    ).rejects.toMatchObject({ code: "startup-failed" });
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it("rejects native Windows before launching an injected worker", async () => {
    const forkWorker = vi.fn(() => new FakeCodexUtilityWorker());
    await expect(
      createCodexAppServerHost(callbacks(), {
        configurationMode: "test-only",
        platform: "win32",
        forkWorker,
      }),
    ).rejects.toMatchObject({ code: "startup-failed" });
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted startup before launching an injected worker", async () => {
    const startup = new AbortController();
    startup.abort();
    const forkWorker = vi.fn(() => new FakeCodexUtilityWorker());

    await expect(
      createCodexAppServerHost(callbacks(), {
        configurationMode: "test-only",
        forkWorker,
        startupSignal: startup.signal,
      }),
    ).rejects.toMatchObject({ code: "startup-failed" });
    expect(forkWorker).not.toHaveBeenCalled();
  });

  it("removes the exact startup abort listener after successful startup", async () => {
    const startup = new AbortController();
    const addEventListener = vi.spyOn(startup.signal, "addEventListener");
    const removeEventListener = vi.spyOn(startup.signal, "removeEventListener");
    const host = await createFakeHost(new FakeCodexUtilityWorker(), callbacks(), undefined, {
      startupSignal: startup.signal,
    });

    const abortListener = addEventListener.mock.calls[0]?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", abortListener);
    await host.dispose();
  });

  it("removes the exact startup abort listener after startup is aborted", async () => {
    const startup = new AbortController();
    const addEventListener = vi.spyOn(startup.signal, "addEventListener");
    const removeEventListener = vi.spyOn(startup.signal, "removeEventListener");
    const worker = new FakeCodexUtilityWorker(
      standardResponder,
      new Promise<void>(() => undefined),
    );
    const host = createFakeHost(worker, callbacks(), undefined, {
      startupSignal: startup.signal,
    });

    startup.abort();
    await expect(host).rejects.toMatchObject({ code: "startup-failed" });
    const abortListener = addEventListener.mock.calls[0]?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", abortListener);
  });

  it("passes only the environment needed for native discovery, auth files, locale, and TLS", () => {
    expect(
      buildCodexWorkerEnvironment({
        PATH: "/usr/bin",
        HOME: "/home/tester",
        CODEX_HOME: "/home/tester/.codex",
        CODEX_EXECUTABLE: "/usr/bin/codex",
        HTTPS_PROXY: "http://proxy.invalid",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        OPENAI_API_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        NODE_OPTIONS: "--inspect",
        HYPE_COMMS_SERVER_TOKEN: "secret",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/home/tester/.codex",
      CODEX_EXECUTABLE: "/usr/bin/codex",
      HTTPS_PROXY: "http://proxy.invalid",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
    });
  });

  it("completes worker startup before returning and drives the neutral lifecycle", async () => {
    const worker = new FakeCodexUtilityWorker();
    let launch: CodexUtilityWorkerLaunch | undefined;
    const host = await createFakeHost(worker, callbacks(), (value) => (launch = value));

    expect(launch).toEqual({
      modulePath: "/application/dist/main/codex-app-server-worker.js",
      environment: {
        CODEX_EXECUTABLE: "/opt/codex/bin/codex",
        HOME: "/home/tester",
        LANG: "en_US.UTF-8",
        PATH: "/opt/codex/bin:/usr/bin",
      },
    });
    expect(worker.sent[0]).toEqual({ type: "codex-request", id: 0, method: "connect" });

    await expect(host.newConversation("/workspace/project")).resolves.toEqual({
      conversationId: "thread-cursor",
    });
    await host.prompt("thread-cursor", "Inspect this workspace");
    await host.cancel("thread-cursor");
    await host.close("thread-cursor");

    expect(worker.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "new-conversation",
          workspacePath: "/workspace/project",
        }),
        expect.objectContaining({
          method: "prompt",
          conversationId: "thread-cursor",
          prompt: "Inspect this workspace",
        }),
        expect.objectContaining({ method: "cancel", conversationId: "thread-cursor" }),
        expect.objectContaining({ method: "close", conversationId: "thread-cursor" }),
      ]),
    );
    await host.dispose();
    expect(worker.killed).toBe(true);
    expect(worker.killedProcessGroups).toEqual([4_100]);
    expect(worker.cleanupOrder).toEqual(["group:4100", "worker"]);
  });

  it("shares one in-flight disposal across concurrent callers", async () => {
    const worker = new FakeCodexUtilityWorker();
    const host = await createFakeHost(worker);

    await Promise.all([host.dispose(), host.dispose()]);

    expect(
      worker.sent.filter(
        (message) => message.type === "codex-request" && message.method === "dispose",
      ),
    ).toHaveLength(1);
    expect(worker.cleanupOrder).toEqual(["group:4100", "worker"]);
  });

  it("keeps standalone close available for replacing a conversation on the same host", async () => {
    const worker = new FakeCodexUtilityWorker();
    const host = await createFakeHost(worker);

    await host.close("old-thread");
    await expect(host.newConversation("/workspace/project")).resolves.toEqual({
      conversationId: "thread-cursor",
    });

    expect(worker.killed).toBe(false);
    await host.dispose();
  });

  it("forwards only validated normalized events", async () => {
    const onEvent = vi.fn();
    const worker = new FakeCodexUtilityWorker();
    const host = await createFakeHost(worker, callbacks({ onEvent }));
    worker.emit({
      type: "codex-event",
      event: {
        type: "message-update",
        conversationId: "thread-cursor",
        messageId: "local-item",
        role: "assistant",
        operation: "append",
        text: "Hello",
        privateEventField: "must-not-cross",
      },
      privateMessageField: "must-not-cross",
    });
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledWith({
      type: "message-update",
      conversationId: "thread-cursor",
      messageId: "local-item",
      role: "assistant",
      operation: "append",
      text: "Hello",
    });
    await host.dispose();
  });

  it("round-trips one permission outcome and aborts it during disposal", async () => {
    const worker = new FakeCodexUtilityWorker();
    const requests: AiAgentHostPermissionRequest[] = [];
    const signals: AbortSignal[] = [];
    let resolvePermission: ((outcome: AiAgentHostPermissionOutcome) => void) | undefined;
    const host = await createFakeHost(
      worker,
      callbacks({
        requestPermission(request, signal) {
          requests.push(request);
          signals.push(signal);
          return new Promise((resolve) => {
            resolvePermission = resolve;
          });
        },
      }),
    );
    worker.emit({
      type: "codex-permission-request",
      permissionId: 0,
      request: {
        conversationId: "thread-cursor",
        tool: {
          id: "local-tool",
          title: "npm test",
          kind: "execute",
          status: "pending",
          privateToolField: "must-not-cross",
        },
        options: [
          {
            id: "accept",
            name: "Allow once",
            kind: "allow_once",
            privateOptionField: "must-not-cross",
          },
          { id: "decline", name: "Reject", kind: "reject_once" },
        ],
        privateRequestField: "must-not-cross",
      },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      conversationId: "thread-cursor",
      tool: { id: "local-tool", title: "npm test", kind: "execute", status: "pending" },
      options: [
        { id: "accept", name: "Allow once", kind: "allow_once" },
        { id: "decline", name: "Reject", kind: "reject_once" },
      ],
    });
    resolvePermission?.({ outcome: "selected", optionId: "accept" });
    await vi.waitFor(() =>
      expect(worker.sent).toContainEqual({
        type: "codex-permission-response",
        permissionId: 0,
        outcome: { outcome: "selected", optionId: "accept" },
      }),
    );

    worker.emit({
      type: "codex-permission-request",
      permissionId: 1,
      request: {
        conversationId: "thread-cursor",
        tool: { id: "local-tool-2", kind: "edit" },
        options: [{ id: "decline", name: "Reject", kind: "reject_once" }],
      },
    });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await host.dispose();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("maps worker failures to fixed host error codes", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type !== "codex-request") return;
      if (message.method === "connect") {
        currentWorker.emit({ type: "codex-process-group", processGroupId: 4_150 });
        currentWorker.emit({ type: "codex-response", id: message.id, result: {} });
      } else {
        currentWorker.emit({ type: "codex-error", id: message.id, code: "unsupported-version" });
      }
    });
    const host = await createFakeHost(worker);
    await expect(host.newConversation("/workspace/project")).rejects.toMatchObject({
      code: "unsupported-version",
      message: "AI agent host failed: unsupported-version",
    });
    await host.dispose();
  });

  it("preserves the distinct conversation-not-found worker error", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type !== "codex-request") return;
      if (message.method === "connect") {
        currentWorker.emit({ type: "codex-process-group", processGroupId: 4_200 });
        currentWorker.emit({ type: "codex-response", id: message.id, result: {} });
      } else {
        currentWorker.emit({
          type: "codex-error",
          id: message.id,
          code: "conversation-not-found",
        });
      }
    });
    const host = await createFakeHost(worker);
    await expect(
      host.resumeConversation("/workspace/project", "missing-thread"),
    ).rejects.toMatchObject({
      code: "conversation-not-found",
      message: "AI agent host failed: conversation-not-found",
    });
    await host.dispose();
  });

  it("rejects session-wide permission options at the utility boundary", async () => {
    const requestPermission = vi.fn(() =>
      Promise.resolve<AiAgentHostPermissionOutcome>({ outcome: "cancelled" }),
    );
    const worker = new FakeCodexUtilityWorker();
    const host = await createFakeHost(worker, callbacks({ requestPermission }));

    worker.emit({
      type: "codex-permission-request",
      permissionId: 0,
      request: {
        conversationId: "thread-cursor",
        tool: { id: "local-tool", kind: "execute" },
        options: [{ id: "always", name: "Allow for session", kind: "allow_always" }],
      },
    });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(worker.killedProcessGroups).toEqual([4_100]);
    expect(worker.killed).toBe(true);
    await host.dispose();
  });

  it("requires an active app-server process group before accepting connect", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type === "codex-request" && message.method === "connect") {
        currentWorker.emit({ type: "codex-response", id: message.id, result: {} });
      }
    });

    await expect(createFakeHost(worker)).rejects.toMatchObject({ code: "protocol-failed" });
    expect(worker.killed).toBe(true);
  });

  it("tracks preflight replacement and clears only a confirmed matching group", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type !== "codex-request") return;
      if (message.method === "connect") {
        currentWorker.emit({ type: "codex-process-group", processGroupId: 3_100 });
        currentWorker.emit({ type: "codex-process-group-cleared", processGroupId: 3_100 });
        currentWorker.emit({ type: "codex-process-group", processGroupId: 4_100 });
        currentWorker.emit({ type: "codex-response", id: message.id, result: {} });
      } else if (message.method === "dispose") {
        currentWorker.emit({ type: "codex-process-group-cleared", processGroupId: 4_100 });
        currentWorker.emit({ type: "codex-response", id: message.id, result: {} });
      } else {
        currentWorker.emit({ type: "codex-response", id: message.id, result: {} });
      }
    });
    const host = await createFakeHost(worker);

    await host.dispose();

    expect(worker.killedProcessGroups).toEqual([]);
    expect(worker.cleanupOrder).toEqual(["worker"]);
  });

  it("kills the retained group when the utility worker exits during preflight", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type === "codex-request" && message.method === "connect") {
        currentWorker.emit({ type: "codex-process-group", processGroupId: 3_200 });
        currentWorker.emitExit(1);
      }
    });

    await expect(createFakeHost(worker)).rejects.toMatchObject({ code: "protocol-failed" });
    expect(worker.killedProcessGroups).toEqual([3_200]);
  });

  it("fails closed on a mismatched process-group clear without losing the active handle", async () => {
    const worker = new FakeCodexUtilityWorker();
    const host = await createFakeHost(worker);

    worker.emit({ type: "codex-process-group-cleared", processGroupId: 4_101 });

    expect(worker.killedProcessGroups).toEqual([4_100]);
    expect(worker.cleanupOrder).toEqual(["group:4100", "worker"]);
    await host.dispose();
  });

  it("fails closed when a second group is announced before the first is cleared", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type === "codex-request" && message.method === "connect") {
        currentWorker.emit({ type: "codex-process-group", processGroupId: 3_300 });
        currentWorker.emit({ type: "codex-process-group", processGroupId: 4_300 });
      }
    });

    await expect(createFakeHost(worker)).rejects.toMatchObject({ code: "protocol-failed" });
    expect(worker.killedProcessGroups).toEqual([3_300]);
    expect(worker.cleanupOrder).toEqual(["group:3300", "worker"]);
  });

  it("reserves part of one teardown deadline for main-process hard cleanup", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type !== "codex-request") return;
      if (message.method === "dispose") return;
      standardResponder(message, currentWorker);
    });
    const host = await createFakeHost(worker, callbacks(), undefined, { teardownTimeoutMs: 100 });
    vi.useFakeTimers();
    try {
      const disposal = host.dispose();
      await vi.advanceTimersByTimeAsync(74);
      expect(worker.cleanupOrder).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await disposal;
      expect(worker.cleanupOrder).toEqual(["group:4100", "worker"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one bounded retirement deadline across cancel, close, and dispose", async () => {
    const worker = new FakeCodexUtilityWorker((message, currentWorker) => {
      if (message.type === "codex-request" && message.method === "connect") {
        standardResponder(message, currentWorker);
      }
    });
    const host = await createFakeHost(worker, callbacks(), undefined, {
      interruptTimeoutMs: 100,
      teardownTimeoutMs: 100,
    });
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const retirement = (async () => {
        await host.cancel("thread-cursor").catch(() => undefined);
        await host.close("thread-cursor").catch(() => undefined);
        await host.dispose();
      })();

      await vi.advanceTimersByTimeAsync(149);
      expect(worker.cleanupOrder).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await retirement;

      expect(Date.now() - startedAt).toBe(150);
      expect(worker.cleanupOrder).toEqual(["group:4100", "worker"]);
      expect(
        worker.sent.filter(
          (message) =>
            message.type === "codex-request" &&
            (message.method === "cancel" ||
              message.method === "close" ||
              message.method === "dispose"),
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills the worker on malformed messages without forwarding raw values", async () => {
    const onEvent = vi.fn();
    const worker = new FakeCodexUtilityWorker();
    const host = await createFakeHost(worker, callbacks({ onEvent }));
    worker.emit({ type: "codex-event", event: { raw: "PRIVATE PROTOCOL PAYLOAD" } });
    expect(worker.killed).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("reports an unexpected worker exit once with no exit code or diagnostics", async () => {
    const onExit = vi.fn();
    const worker = new FakeCodexUtilityWorker();
    await createFakeHost(worker, callbacks({ onExit }));
    worker.emitExit(73);
    worker.emitError();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({ reason: "exited" });
    expect(worker.killedProcessGroups).toEqual([4_100]);
  });

  it("kills a worker that misses its spawn deadline", async () => {
    vi.useFakeTimers();
    const worker = new FakeCodexUtilityWorker(
      standardResponder,
      new Promise<void>(() => undefined),
    );
    const startup = createFakeHost(worker, callbacks(), undefined, { startupTimeoutMs: 50 });
    const rejection = expect(startup).rejects.toMatchObject({ code: "startup-failed" });
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
    expect(worker.killed).toBe(true);
    vi.useRealTimers();
  });
});
