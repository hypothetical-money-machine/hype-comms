import { EventEmitter } from "node:events";
import { type spawn as nodeSpawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  AiAgentHostEvent,
  AiAgentHostPermissionOutcome,
  AiAgentHostPermissionRequest,
} from "./ai-agent-host";
import {
  BoundedJsonlParser,
  CodexAppServerWorkerRuntime,
  CodexRpcConnection,
  createCodexUtilityMessagePoster,
  createProductionCodexRuntime,
  killCodexProcessGroup,
  readCodexVersion,
  type CodexByteTransport,
  type CodexProcessSignal,
  type CodexUtilityMessage,
  type CodexWorkerCallbacks,
  resolveCodexExecutable,
} from "./codex-app-server-worker";
import {
  MAX_CODEX_JSONL_LINE_BYTES,
  MAX_CODEX_OUTGOING_ENVELOPE_BYTES,
} from "./codex-app-server-protocol";

type SentMessage = Record<string, unknown>;
type Responder = (message: SentMessage, transport: FakeTransport) => void;

class FakeTransport implements CodexByteTransport {
  readonly sent: SentMessage[] = [];
  readonly processGroupId?: number;
  killed = false;
  killedAt: number | undefined;
  killDeadline: number | undefined;
  inputClosed = false;
  #dataListeners: Array<(chunk: Uint8Array) => void> = [];
  #endListeners: Array<() => void> = [];
  #errorListeners: Array<() => void> = [];

  constructor(
    private readonly responder?: Responder,
    processGroupId?: number,
  ) {
    this.processGroupId = processGroupId;
  }

  write(bytes: Uint8Array): Promise<void> {
    const message = JSON.parse(Buffer.from(bytes).toString("utf8")) as SentMessage;
    this.sent.push(message);
    queueMicrotask(() => this.responder?.(message, this));
    return Promise.resolve();
  }

  closeInput(): void {
    this.inputClosed = true;
  }

  kill(deadline?: number): boolean {
    this.killed = true;
    this.killedAt = Date.now();
    this.killDeadline = deadline;
    return true;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.push(listener);
  }

  onEnd(listener: () => void): void {
    this.#endListeners.push(listener);
  }

  onError(listener: () => void): void {
    this.#errorListeners.push(listener);
  }

  emit(message: unknown, fragments?: readonly number[]): void {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (fragments === undefined) {
      for (const listener of this.#dataListeners) listener(bytes);
      return;
    }
    let offset = 0;
    for (const length of fragments) {
      const next = bytes.subarray(offset, offset + length);
      offset += length;
      for (const listener of this.#dataListeners) listener(next);
    }
    if (offset < bytes.byteLength) {
      const remainder = bytes.subarray(offset);
      for (const listener of this.#dataListeners) listener(remainder);
    }
  }

  end(): void {
    for (const listener of this.#endListeners) listener();
  }

  fail(): void {
    for (const listener of this.#errorListeners) listener();
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor(readonly pid: number) {
    super();
  }
}

function missingGroupError(): Error & { readonly code: "ESRCH" } {
  return Object.assign(new Error("missing process group"), { code: "ESRCH" as const });
}

function isRequest(message: SentMessage, method: string): boolean {
  return message.method === method && typeof message.id === "number";
}

function response(transport: FakeTransport, message: SentMessage, result: unknown): void {
  transport.emit({ id: message.id, result });
}

function turnLifecycle(status: "inProgress" | "completed" | "interrupted" | "failed") {
  return {
    id: "turn-a",
    items: [],
    itemsView: "notLoaded",
    status,
    error:
      status === "failed"
        ? { message: "turn failed", codexErrorInfo: null, additionalDetails: null }
        : null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function standardResponder(message: SentMessage, transport: FakeTransport): void {
  if (isRequest(message, "initialize")) {
    response(transport, message, {
      userAgent: "codex_cli_rs/0.147.0",
      codexHome: "/home/tester/.codex",
      platformFamily: "unix",
      platformOs: "linux",
    });
  } else if (isRequest(message, "account/read")) {
    response(transport, message, {
      account: { type: "chatgpt", email: "private@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    });
  } else if (isRequest(message, "thread/start")) {
    transport.emit({
      method: "thread/started",
      params: { thread: { id: "thread-a" } },
    });
    response(transport, message, { thread: { id: "thread-a" } });
  } else if (isRequest(message, "thread/resume")) {
    response(transport, message, { thread: { id: "thread-a" } });
  } else if (isRequest(message, "turn/start")) {
    response(transport, message, { turn: { id: "turn-a", status: "inProgress" } });
    transport.emit({
      method: "turn/started",
      params: { threadId: "thread-a", turn: turnLifecycle("inProgress") },
    });
  } else if (isRequest(message, "turn/interrupt")) {
    response(transport, message, {});
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("interrupted") },
    });
  } else if (isRequest(message, "thread/unsubscribe")) {
    response(transport, message, {});
  }
}

function callbacks(
  overrides: Partial<CodexWorkerCallbacks> = {},
): CodexWorkerCallbacks & { readonly events: AiAgentHostEvent[] } {
  const events: AiAgentHostEvent[] = [];
  return {
    events,
    onEvent(event) {
      events.push(event);
    },
    requestPermission: vi.fn(() =>
      Promise.resolve<AiAgentHostPermissionOutcome>({ outcome: "cancelled" }),
    ),
    onFatal: vi.fn(),
    ...overrides,
  };
}

async function startedRuntime(
  transport = new FakeTransport(standardResponder),
  callbackValue = callbacks(),
): Promise<{ runtime: CodexAppServerWorkerRuntime; callbacks: typeof callbackValue }> {
  const runtime = new CodexAppServerWorkerRuntime(transport, callbackValue, {
    operationTimeoutMs: 1_000,
    interruptTimeoutMs: 1_000,
    teardownTimeoutMs: 1_000,
  });
  await runtime.initialize();
  return { runtime, callbacks: callbackValue };
}

async function waitForSent(transport: FakeTransport, method: string): Promise<SentMessage> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = transport.sent.find((candidate) => candidate.method === method);
    if (message !== undefined) return message;
    await Promise.resolve();
  }
  throw new Error(`missing ${method}`);
}

describe("bounded JSONL transport", () => {
  it("handles fragmentation, CRLF, several messages, and split UTF-8", () => {
    const parser = new BoundedJsonlParser();
    const source = Buffer.from(
      '{"method":"one","params":{"text":"hé"}}\r\n{"id":1,"result":{}}\n',
      "utf8",
    );
    const accent = source.indexOf(Buffer.from("é", "utf8"));
    expect(parser.push(source.subarray(0, accent + 1))).toEqual([]);
    expect(parser.push(source.subarray(accent + 1))).toEqual([
      { kind: "notification", method: "one", params: { text: "hé" } },
      { kind: "response", id: 1, result: {} },
    ]);
    expect(() => parser.end()).not.toThrow();
  });

  it("rejects invalid UTF-8 and EOF in the middle of a message", () => {
    const invalid = new BoundedJsonlParser();
    expect(() => invalid.push(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]))).toThrow();
    const incomplete = new BoundedJsonlParser();
    incomplete.push(Buffer.from('{"id":1', "utf8"));
    expect(() => incomplete.end()).toThrow();
  });

  it("parses a line delivered as thousands of single-byte fragments", () => {
    const parser = new BoundedJsonlParser();
    const line = Buffer.from(
      `${JSON.stringify({ method: "fragmented", params: { text: "x".repeat(8_000) } })}\n`,
      "utf8",
    );
    const messages = [];
    for (const byte of line) messages.push(...parser.push(Uint8Array.of(byte)));
    expect(messages).toEqual([
      { kind: "notification", method: "fragmented", params: { text: "x".repeat(8_000) } },
    ]);
    expect(() => parser.end()).not.toThrow();
  });

  it("bounds an incomplete line across chunks", () => {
    const parser = new BoundedJsonlParser();
    parser.push(Buffer.alloc(MAX_CODEX_JSONL_LINE_BYTES, 0x20));
    expect(() => parser.push(Uint8Array.of(0x20))).toThrowError(
      expect.objectContaining({ reason: "limit-exceeded" }),
    );
  });

  it("fails on duplicate or unsolicited responses", async () => {
    const transport = new FakeTransport();
    const onFatal = vi.fn();
    const connection = new CodexRpcConnection(transport, {
      onNotification: vi.fn(),
      onServerRequest: vi.fn(),
      onFatal,
    });
    const pending = connection.request("account/read", { refreshToken: false }, 1_000);
    const request = await waitForSent(transport, "account/read");
    transport.emit({ id: request.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
    transport.emit({ id: request.id, result: { duplicate: true } });
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});

describe("native Codex executable discovery", () => {
  it("rejects a bad override without falling through", async () => {
    const checked = vi.fn(() => Promise.resolve(true));
    await expect(
      resolveCodexExecutable({
        environment: { CODEX_EXECUTABLE: "relative/codex", PATH: "/valid" },
        platform: "linux",
        homeDirectory: "/home/tester",
        canonicalize: async (candidate) => candidate,
        isExecutable: checked,
      }),
    ).rejects.toMatchObject({ code: "not-installed" });
    expect(checked).not.toHaveBeenCalled();
  });

  it("uses only absolute PATH entries and canonicalizes a native binary", async () => {
    const checked: string[] = [];
    await expect(
      resolveCodexExecutable({
        environment: { PATH: "relative:/opt/codex/bin:/usr/bin" },
        platform: "linux",
        homeDirectory: "/home/tester",
        canonicalize: async (candidate) => `${candidate}.real`,
        isExecutable: async (candidate) => {
          checked.push(candidate);
          return candidate === "/opt/codex/bin/codex.real";
        },
      }),
    ).resolves.toBe("/opt/codex/bin/codex.real");
    expect(checked).toEqual(["/opt/codex/bin/codex.real"]);
  });

  it("never discovers a Windows command shim", async () => {
    await expect(
      resolveCodexExecutable({
        environment: { PATH: "C:\\Tools" },
        platform: "win32",
        homeDirectory: "C:\\Users\\tester",
        canonicalize: async (candidate) => candidate,
        isExecutable: async (candidate) => candidate.endsWith("codex.cmd"),
      }),
    ).rejects.toMatchObject({ code: "not-installed" });
  });
});

describe("Codex process groups and version preflight", () => {
  it("signals a POSIX process group by negative PID", () => {
    const child = { pid: 4312, kill: vi.fn(() => true) };
    const signal = vi.fn<CodexProcessSignal>();
    killCodexProcessGroup(child, "linux", signal);
    expect(signal).toHaveBeenCalledWith(-4312, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("never turns an invalid child PID into a positive signal target", () => {
    const child = { pid: -1, kill: vi.fn(() => true) };
    const signal = vi.fn<CodexProcessSignal>();
    killCodexProcessGroup(child, "linux", signal);
    expect(signal).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("announces, group-kills, confirms, and clears an oversized version preflight", async () => {
    const child = new FakeChildProcess(4313);
    let groupExists = true;
    let existenceProbes = 0;
    const order: string[] = [];
    const signal = vi.fn<CodexProcessSignal>((pid, value) => {
      expect(pid).toBe(-4313);
      if (value === "SIGKILL") {
        order.push("kill");
        return;
      }
      existenceProbes += 1;
      if (existenceProbes === 2) groupExists = false;
      if (!groupExists) throw missingGroupError();
    });
    const reading = readCodexVersion("/opt/codex", {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as unknown as typeof nodeSpawn,
      processSignal: signal,
      onProcessGroupSpawned(processGroupId) {
        order.push(`spawn:${processGroupId}`);
      },
      onProcessGroupCleared(processGroupId) {
        order.push(`clear:${processGroupId}`);
      },
    });
    child.stdout.write(Buffer.alloc(MAX_CODEX_OUTGOING_ENVELOPE_BYTES));

    await expect(reading).rejects.toMatchObject({ code: "unsupported-version" });
    expect(order).toEqual(["spawn:4313", "kill", "clear:4313"]);
    expect(signal).toHaveBeenCalledWith(-4313, 0);
    expect(existenceProbes).toBe(2);
  });

  it("starts version cleanup before the shared timeout to reserve confirmation time", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess(4314);
      let groupExists = true;
      let killedAt: number | null = null;
      const startedAt = Date.now();
      const signal: CodexProcessSignal = (pid, value) => {
        expect(pid).toBe(-4314);
        if (value === "SIGKILL") {
          killedAt = Date.now();
          groupExists = false;
          return;
        }
        if (!groupExists) throw missingGroupError();
      };
      const reading = readCodexVersion("/opt/codex", {
        platform: "linux",
        spawnProcess: vi.fn(() => child) as unknown as typeof nodeSpawn,
        processSignal: signal,
        versionTimeoutMs: 150,
      });
      const rejected = expect(reading).rejects.toMatchObject({ code: "startup-failed" });

      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(killedAt).toBe(startedAt + 50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Windows production startup before discovery or spawn", async () => {
    const spawnProcess = vi.fn();
    const canonicalize = vi.fn(async (candidate: string) => candidate);
    await expect(
      createProductionCodexRuntime(callbacks(), {
        platform: "win32",
        spawnProcess: spawnProcess as typeof nodeSpawn,
        canonicalize,
      }),
    ).rejects.toMatchObject({ code: "startup-failed" });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("replaces the cleared preflight group with an app-server group before initialization", async () => {
    const versionChild = new FakeChildProcess(4315);
    const appServerChild = new FakeChildProcess(4316);
    const activeGroups = new Set([4315, 4316]);
    const order: string[] = [];
    const signal: CodexProcessSignal = (pid, value) => {
      const processGroupId = -pid;
      if (value === "SIGKILL") {
        order.push(`kill:${processGroupId}`);
        activeGroups.delete(processGroupId);
        return;
      }
      if (!activeGroups.has(processGroupId)) throw missingGroupError();
    };
    let spawnCount = 0;
    const spawnProcess = vi.fn((_executable: string, args: readonly string[], options: unknown) => {
      spawnCount += 1;
      expect(options).toMatchObject({ shell: false, detached: true });
      if (spawnCount === 1) {
        expect(args).toEqual(["--version"]);
        queueMicrotask(() => {
          versionChild.stdout.write("codex-cli 0.147.0\n");
          versionChild.stdout.end();
          versionChild.emit("close", 0);
        });
        return versionChild;
      }
      expect(args).toEqual(["app-server", "--stdio"]);
      let input = "";
      appServerChild.stdin.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline < 0) break;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          const request = JSON.parse(line) as SentMessage;
          if (isRequest(request, "initialize")) {
            order.push("initialize");
            appServerChild.stdout.write(
              `${JSON.stringify({
                id: request.id,
                result: {
                  userAgent: "codex_cli_rs/0.147.0",
                  codexHome: "/home/tester/.codex",
                  platformFamily: "unix",
                  platformOs: "linux",
                },
              })}\n`,
            );
          } else if (isRequest(request, "account/read")) {
            appServerChild.stdout.write(
              `${JSON.stringify({
                id: request.id,
                result: {
                  account: { type: "chatgpt", email: "private@example.com", planType: "pro" },
                  requiresOpenaiAuth: true,
                },
              })}\n`,
            );
          }
        }
      });
      appServerChild.stdin.on("finish", () => appServerChild.stdout.end());
      return appServerChild;
    });

    const runtime = await createProductionCodexRuntime(callbacks(), {
      platform: "linux",
      environment: { CODEX_EXECUTABLE: "/opt/codex", PATH: "" },
      canonicalize: async (candidate) => candidate,
      isExecutable: async () => true,
      spawnProcess: spawnProcess as unknown as typeof nodeSpawn,
      processSignal: signal,
      onProcessGroupSpawned(processGroupId) {
        order.push(`spawn:${processGroupId}`);
      },
      onProcessGroupCleared(processGroupId) {
        order.push(`clear:${processGroupId}`);
      },
    });

    expect(runtime.processGroupId).toBe(4316);
    expect(order.slice(0, 5)).toEqual([
      "spawn:4315",
      "kill:4315",
      "clear:4315",
      "spawn:4316",
      "initialize",
    ]);
    await runtime.dispose();
    expect(order.slice(-2)).toEqual(["kill:4316", "clear:4316"]);
  });
});

describe("utility message bounds", () => {
  it("posts one small fatal message before disposing an oversized producer", () => {
    const order: string[] = [];
    const posted: CodexUtilityMessage[] = [];
    const poster = createCodexUtilityMessagePoster(
      {
        postMessage(message) {
          posted.push(message);
          order.push(`post:${message.type}`);
        },
      },
      () => order.push("dispose"),
    );
    const oversized: CodexUtilityMessage = {
      type: "codex-event",
      event: {
        type: "message-update",
        conversationId: "thread-a",
        messageId: "message-a",
        role: "assistant",
        operation: "append",
        text: "x".repeat(MAX_CODEX_OUTGOING_ENVELOPE_BYTES),
      },
    };

    expect(poster.post(oversized)).toBe(false);
    poster.fatal();
    expect(order).toEqual(["post:codex-exit", "dispose"]);
    expect(posted).toEqual([{ type: "codex-exit", reason: "transport-failed" }]);
  });
});

describe("Codex app-server worker state machine", () => {
  it("keeps malformed startup payloads and startup EOF classified as protocol failures", async () => {
    const malformedInitialize = new FakeTransport((message, target) => {
      if (isRequest(message, "initialize")) response(target, message, {});
    });
    await expect(
      new CodexAppServerWorkerRuntime(malformedInitialize, callbacks()).initialize(),
    ).rejects.toMatchObject({ code: "protocol-failed" });

    const malformedAccount = new FakeTransport((message, target) => {
      if (isRequest(message, "account/read")) {
        response(target, message, { account: null });
        return;
      }
      standardResponder(message, target);
    });
    await expect(
      new CodexAppServerWorkerRuntime(malformedAccount, callbacks()).initialize(),
    ).rejects.toMatchObject({ code: "protocol-failed" });

    const startupEof = new FakeTransport((message, target) => {
      if (isRequest(message, "initialize")) target.end();
    });
    await expect(
      new CodexAppServerWorkerRuntime(startupEof, callbacks()).initialize(),
    ).rejects.toMatchObject({ code: "protocol-failed" });

    const remoteStartupFailure = new FakeTransport((message, target) => {
      if (isRequest(message, "initialize")) {
        target.emit({ id: message.id, error: { code: -32_000, message: "startup rejected" } });
      }
    });
    await expect(
      new CodexAppServerWorkerRuntime(remoteStartupFailure, callbacks()).initialize(),
    ).rejects.toMatchObject({ code: "startup-failed" });
  });

  it("uses initialize, initialized, account/read, and the exact fixed policies", async () => {
    const transport = new FakeTransport(standardResponder);
    const { runtime } = await startedRuntime(transport);
    await expect(runtime.newConversation("/workspace/project")).resolves.toEqual({
      conversationId: "thread-a",
    });

    expect(transport.sent.map((message) => message.method).slice(0, 4)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "thread/start",
    ]);
    expect(transport.sent[0]).toMatchObject({
      params: {
        clientInfo: { name: "hype_comms", title: "Hype Comms", version: "1" },
        capabilities: null,
      },
    });
    expect(transport.sent[2]).toMatchObject({ params: { refreshToken: false } });
    expect(transport.sent[3]).toMatchObject({
      params: {
        cwd: "/workspace/project",
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });
  });

  it("distinguishes a missing conversation from other resume and protocol failures", async () => {
    const cases = [
      { message: "Thread thread-a not found", code: "conversation-not-found" },
      { message: "Authentication expired", code: "conversation-failed" },
      { message: "Request timed out", code: "conversation-failed" },
    ] as const;
    for (const testCase of cases) {
      const transport = new FakeTransport((message, target) => {
        if (isRequest(message, "thread/resume")) {
          target.emit({
            id: message.id,
            error: { code: -32_000, message: testCase.message },
          });
          return;
        }
        standardResponder(message, target);
      });
      const { runtime } = await startedRuntime(transport);
      await expect(
        runtime.resumeConversation("/workspace/project", "thread-a"),
      ).rejects.toMatchObject({ code: testCase.code });
    }

    const malformed = new FakeTransport((message, target) => {
      if (isRequest(message, "thread/resume")) {
        response(target, message, { thread: { id: 42 } });
        return;
      }
      standardResponder(message, target);
    });
    const malformedRuntime = await startedRuntime(malformed);
    await expect(
      malformedRuntime.runtime.resumeConversation("/workspace/project", "thread-a"),
    ).rejects.toMatchObject({ code: "protocol-failed" });

    const failed = new FakeTransport((message, target) => {
      if (isRequest(message, "thread/resume")) {
        target.fail();
        return;
      }
      standardResponder(message, target);
    });
    const failedRuntime = await startedRuntime(failed);
    await expect(
      failedRuntime.runtime.resumeConversation("/workspace/project", "thread-a"),
    ).rejects.toMatchObject({ code: "protocol-failed" });
  });

  it("keeps prompt pending after turn/start and replaces streamed text with the final item", async () => {
    const transport = new FakeTransport(standardResponder);
    const value = await startedRuntime(transport);
    await value.runtime.newConversation("/workspace/project");
    let settled = false;
    const prompting = value.runtime.prompt("thread-a", "Inspect this workspace").then(() => {
      settled = true;
    });
    const turnStart = await waitForSent(transport, "turn/start");
    expect(turnStart).toMatchObject({
      params: {
        threadId: "thread-a",
        input: [{ type: "text", text: "Inspect this workspace", text_elements: [] }],
        cwd: "/workspace/project",
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    transport.emit({
      method: "error",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        error: { message: "provider detail", codexErrorInfo: null, additionalDetails: null },
        willRetry: false,
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    transport.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "raw-provider-item",
        delta: "Work",
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "agentMessage",
          id: "raw-provider-item",
          text: "Work complete",
          phase: null,
          memoryCitation: null,
        },
        completedAtMs: 10,
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("completed") },
    });
    await prompting;

    expect(value.callbacks.events).toEqual([
      {
        type: "message-update",
        conversationId: "thread-a",
        messageId: "codex-item-1",
        role: "assistant",
        operation: "append",
        text: "Work",
      },
      {
        type: "message-update",
        conversationId: "thread-a",
        messageId: "codex-item-1",
        role: "assistant",
        operation: "replace",
        text: "Work complete",
      },
    ]);
    expect(JSON.stringify(value.callbacks.events)).not.toContain("raw-provider-item");
  });

  it("fails a turn after the bounded raw-item correlation table is full", async () => {
    const transport = new FakeTransport(standardResponder);
    const callbackValue = callbacks();
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Stream many items");
    const rejected = expect(prompting).rejects.toMatchObject({ code: "protocol-failed" });
    await waitForSent(transport, "turn/start");

    for (let index = 0; index <= 1_000; index += 1) {
      transport.emit({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          itemId: `raw-item-${index}`,
          delta: "x",
        },
      });
    }

    await rejected;
    expect(callbackValue.events).toHaveLength(1_000);
    expect(callbackValue.onFatal).toHaveBeenCalledTimes(1);
  });

  it("bounds both per-item and aggregate projected turn text", async () => {
    const cases = [
      [
        { itemId: "same-item", text: "x".repeat(400_000) },
        { itemId: "same-item", text: "x".repeat(400_000) },
      ],
      [
        { itemId: "item-a", text: "x".repeat(700_000) },
        { itemId: "item-b", text: "x".repeat(700_000) },
        { itemId: "item-c", text: "x".repeat(700_000) },
      ],
    ] as const;
    for (const deltas of cases) {
      const transport = new FakeTransport(standardResponder);
      const callbackValue = callbacks();
      const { runtime } = await startedRuntime(transport, callbackValue);
      await runtime.newConversation("/workspace/project");
      const prompting = runtime.prompt("thread-a", "Stream too much text");
      const rejected = expect(prompting).rejects.toMatchObject({ code: "protocol-failed" });
      await waitForSent(transport, "turn/start");
      for (const delta of deltas) {
        transport.emit({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-a",
            turnId: "turn-a",
            itemId: delta.itemId,
            delta: delta.text,
          },
        });
      }
      await rejected;
      expect(callbackValue.onFatal).toHaveBeenCalledTimes(1);
    }
  });

  it("starts each turn with fresh item and text projection state", async () => {
    const transport = new FakeTransport(standardResponder);
    const callbackValue = callbacks();
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation("/workspace/project");

    for (let turnIndex = 1; turnIndex <= 2; turnIndex += 1) {
      const prompting = runtime.prompt("thread-a", `Turn ${turnIndex}`);
      await vi.waitFor(() =>
        expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(
          turnIndex,
        ),
      );
      transport.emit({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          itemId: "same-raw-item",
          delta: "x".repeat(600_000),
        },
      });
      transport.emit({
        method: "turn/completed",
        params: { threadId: "thread-a", turn: turnLifecycle("completed") },
      });
      await prompting;
    }

    expect(
      callbackValue.events.map((event) => event.type === "message-update" && event.messageId),
    ).toEqual(["codex-item-1", "codex-item-2"]);
    expect(callbackValue.onFatal).not.toHaveBeenCalled();
  });

  it("queues a command approval, keeps reading, and returns only the selected Lite decision", async () => {
    const transport = new FakeTransport(standardResponder);
    let resolvePermission: ((value: AiAgentHostPermissionOutcome) => void) | undefined;
    const seenPermissions: AiAgentHostPermissionRequest[] = [];
    const callbackValue = callbacks({
      requestPermission(request) {
        seenPermissions.push(request);
        return new Promise((resolve) => {
          resolvePermission = resolve;
        });
      },
    });
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Run tests");
    await waitForSent(transport, "turn/start");

    transport.emit({
      id: "rpc-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "raw-command-item",
        approvalId: "raw-approval-id",
        environmentId: null,
        startedAtMs: 10,
        command: "npm test --token secret",
      },
    });
    transport.emit({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "raw-reasoning",
        summaryIndex: 0,
        delta: "Waiting for approval",
      },
    });
    await vi.waitFor(() => expect(seenPermissions).toHaveLength(1));
    expect(seenPermissions[0]?.options.map((option) => option.id)).toEqual(["accept", "decline"]);
    expect(JSON.stringify(seenPermissions[0])).not.toContain("secret");
    expect(callbackValue.events).toHaveLength(1);

    resolvePermission?.({ outcome: "selected", optionId: "accept" });
    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({ id: "rpc-approval", result: { decision: "accept" } }),
    );
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("completed") },
    });
    await prompting;
  });

  it("correlates resolved approvals by the payload key and releases the stored RPC id", async () => {
    const transport = new FakeTransport(standardResponder);
    let permissionSignal: AbortSignal | undefined;
    let resolvePermission: ((value: AiAgentHostPermissionOutcome) => void) | undefined;
    const callbackValue = callbacks({
      requestPermission(_request, signal) {
        permissionSignal = signal;
        return new Promise((resolve) => {
          resolvePermission = resolve;
        });
      },
    });
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Run tests");
    await waitForSent(transport, "turn/start");
    transport.emit({
      id: "rpc-envelope-id",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "raw-command-item",
        approvalId: "approval-payload-key",
        environmentId: null,
        startedAtMs: 10,
        command: "npm test",
      },
    });
    await vi.waitFor(() => expect(permissionSignal).toBeDefined());

    transport.emit({
      method: "serverRequest/resolved",
      params: { threadId: "thread-a", requestId: "approval-payload-key" },
    });
    await vi.waitFor(() => expect(permissionSignal?.aborted).toBe(true));
    resolvePermission?.({ outcome: "selected", optionId: "accept" });
    await Promise.resolve();
    expect(transport.sent).not.toContainEqual({
      id: "rpc-envelope-id",
      result: { decision: "accept" },
    });
    expect(callbackValue.onFatal).not.toHaveBeenCalled();

    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("completed") },
    });
    await prompting;
  });

  it("uses locations from the matching projected file item for file approval", async () => {
    const workspacePath = process.cwd();
    const transport = new FakeTransport(standardResponder);
    let resolvePermission: ((value: AiAgentHostPermissionOutcome) => void) | undefined;
    const seenPermissions: AiAgentHostPermissionRequest[] = [];
    const callbackValue = callbacks({
      requestPermission(request) {
        seenPermissions.push(request);
        return new Promise((resolve) => {
          resolvePermission = resolve;
        });
      },
    });
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation(workspacePath);
    const prompting = runtime.prompt("thread-a", "Edit package metadata");
    await waitForSent(transport, "turn/start");
    transport.emit({
      method: "item/started",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        item: {
          type: "fileChange",
          id: "file-change-item",
          status: "inProgress",
          changes: [
            {
              path: `${workspacePath}/package.json`,
              kind: { type: "update", move_path: null },
              diff: "private patch",
            },
          ],
        },
        startedAtMs: 10,
      },
    });
    transport.emit({
      id: "rpc-file-approval",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "file-change-item",
        startedAtMs: 11,
        reason: null,
        grantRoot: null,
      },
    });

    await vi.waitFor(() => expect(seenPermissions).toHaveLength(1));
    expect(seenPermissions[0]?.tool.locations).toEqual([{ path: "package.json" }]);
    resolvePermission?.({ outcome: "selected", optionId: "decline" });
    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({
        id: "rpc-file-approval",
        result: { decision: "decline" },
      }),
    );
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("completed") },
    });
    await prompting;
  });

  it("denies blanket permission profiles with an empty turn-scoped grant", async () => {
    const transport = new FakeTransport(standardResponder);
    const callbackValue = callbacks();
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Use network");
    await waitForSent(transport, "turn/start");
    transport.emit({
      id: "rpc-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "permissions-item",
        environmentId: null,
        startedAtMs: 10,
        cwd: "/workspace/project",
        reason: "network",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({
        id: "rpc-permissions",
        result: { permissions: {}, scope: "turn" },
      }),
    );
    expect(callbackValue.requestPermission).not.toHaveBeenCalled();
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("completed") },
    });
    await prompting;
  });

  it("waits for interrupted completion rather than treating interrupt acknowledgement as completion", async () => {
    const transport = new FakeTransport(standardResponder);
    const { runtime } = await startedRuntime(transport);
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Keep working");
    await waitForSent(transport, "turn/start");
    await expect(runtime.cancel("thread-a")).resolves.toBeUndefined();
    await expect(prompting).rejects.toMatchObject({ code: "turn-failed" });
  });

  it("cancels an approval that arrives after cancellation is requested", async () => {
    const transport = new FakeTransport((message, target) => {
      if (isRequest(message, "turn/interrupt")) return;
      standardResponder(message, target);
    });
    const callbackValue = callbacks();
    const { runtime } = await startedRuntime(transport, callbackValue);
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Keep working");
    const promptResult = prompting.catch((error: unknown) => error);
    await waitForSent(transport, "turn/start");

    const cancelling = runtime.cancel("thread-a");
    const interrupt = await waitForSent(transport, "turn/interrupt");
    transport.emit({
      id: "late-rpc-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "late-command-item",
        approvalId: "late-approval-key",
        environmentId: null,
        startedAtMs: 10,
        command: "npm test",
      },
    });
    await vi.waitFor(() =>
      expect(transport.sent).toContainEqual({
        id: "late-rpc-approval",
        result: { decision: "cancel" },
      }),
    );
    expect(callbackValue.requestPermission).not.toHaveBeenCalled();

    response(transport, interrupt, {});
    transport.emit({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: turnLifecycle("interrupted") },
    });
    await expect(cancelling).resolves.toBeUndefined();
    await expect(promptResult).resolves.toMatchObject({ code: "turn-failed" });
  });

  it("uses one teardown deadline and reserves time for a process-group kill", async () => {
    const transport = new FakeTransport((message, target) => {
      if (isRequest(message, "turn/interrupt") || isRequest(message, "thread/unsubscribe")) return;
      standardResponder(message, target);
    }, 4317);
    const callbackValue = callbacks();
    const runtime = new CodexAppServerWorkerRuntime(transport, callbackValue, {
      operationTimeoutMs: 1_000,
      interruptTimeoutMs: 1_000,
      teardownTimeoutMs: 150,
    });
    await runtime.initialize();
    await runtime.newConversation("/workspace/project");
    const prompting = runtime.prompt("thread-a", "Keep working");
    const promptResult = prompting.catch((error: unknown) => error);
    await waitForSent(transport, "turn/start");

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const disposing = runtime.dispose();
      expect(runtime.dispose()).toBe(disposing);
      await vi.advanceTimersByTimeAsync(49);
      expect(transport.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(101);
      await disposing;

      expect(transport.inputClosed).toBe(true);
      expect(transport.killed).toBe(true);
      expect(transport.killedAt).toBeLessThanOrEqual(startedAt + 51);
      expect(transport.killDeadline).toBe(startedAt + 150);
      await expect(promptResult).resolves.toMatchObject({ code: "protocol-failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
