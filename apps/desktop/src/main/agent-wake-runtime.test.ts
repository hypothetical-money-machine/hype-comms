import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AgentWakeSourceFailure,
  type AgentWakeIdentity,
  type AgentWakeInboxStore,
  type AgentWakeScheduledTask,
  type AgentWakeScheduler,
  type AgentWakeSourceAccess,
  type AgentWakeSourceSession,
  type AgentWakeStoreMutation,
  type AgentWakeTarget,
  type StoredAgentWakeEnrollment,
} from "./agent-wake-broker";
import type { AgentWakeConfiguration } from "./agent-wake-configuration";
import { AgentWakeFileStore, AgentWakeFileStoreError } from "./agent-wake-file-store";
import { AgentWakeRuntimeError, startAgentWakeRuntime } from "./agent-wake-runtime";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_USER_ID = "10000000-0000-4000-8000-000000000002";

function configuration(): AgentWakeConfiguration {
  return {
    version: 1,
    enrollmentId: "grok-bot-pilot",
    expectedAgentUserId: AGENT_USER_ID,
    source: {
      credentialHandle: "hype-cli-grok-bot-pilot",
      runtimeExecutablePath: "/opt/hype/bin/node",
      runtimeExecutableSha256: "a".repeat(64),
      cliEntrypointPath: "/opt/hype/lib/hype-comms-cli.js",
      cliEntrypointSha256: "b".repeat(64),
      profile: "grok-bot-pilot",
      apiOrigin: "https://chat.example.test",
    },
    target: {
      targetHandle: "agent-runtime-primary",
      adapterId: "agent-runtime-test",
      executablePath: "/opt/hype/bin/agent-runtime-wake-hook",
      executableSha256: "c".repeat(64),
      arguments: [],
    },
  };
}

class IdleSession implements AgentWakeSourceSession {
  readonly #pending: Promise<unknown>;
  #resolve: ((record: unknown) => void) | undefined;
  readonly stop = vi.fn(async () => {
    this.#resolve?.({
      version: 1,
      type: "agent.wake.checkpoint",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      cursor: "12",
    });
  });

  constructor() {
    this.#pending = new Promise<unknown>((resolve) => {
      this.#resolve = resolve;
    });
  }

  next(): Promise<unknown> {
    return this.#pending;
  }

  acknowledge(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAuthorityAndSource {
  readonly identity: AgentWakeIdentity = {
    apiOrigin: "https://chat.example.test",
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_USER_ID,
  };
  readonly verify = vi.fn(
    async (input: {
      readonly credentialHandle: string;
      readonly expectedAgentUserId: string;
      readonly signal?: AbortSignal;
    }) => {
      void input;
      return this.identity;
    },
  );
  readonly captureHighWater = vi.fn(
    async (sourceAccess: AgentWakeSourceAccess, signal?: AbortSignal) => {
      void sourceAccess;
      void signal;
      return "12";
    },
  );
  readonly opens: Array<AgentWakeSourceAccess & { readonly after: string }> = [];
  readonly sessions: IdleSession[] = [];

  async open(input: AgentWakeSourceAccess & { readonly after: string }): Promise<IdleSession> {
    this.opens.push(input);
    const session = new IdleSession();
    this.sessions.push(session);
    return session;
  }
}

interface ScheduledEntry {
  readonly delayMs: number;
  readonly task: () => void;
  cancelled: boolean;
}

class ManualStartupScheduler implements AgentWakeScheduler {
  readonly entries: ScheduledEntry[] = [];

  schedule(delayMs: number, task: () => void): AgentWakeScheduledTask {
    const entry = { delayMs, task, cancelled: false };
    this.entries.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  }

  runNext(): void {
    const entry = this.entries.find((candidate) => !candidate.cancelled);
    if (entry === undefined) throw new Error("Expected a pending startup retry");
    entry.cancelled = true;
    entry.task();
  }

  get pending(): readonly ScheduledEntry[] {
    return this.entries.filter((entry) => !entry.cancelled);
  }
}

const unusedTarget: AgentWakeTarget = {
  accept: vi.fn<AgentWakeTarget["accept"]>(async () => ({
    status: "accepted",
    providerReceiptId: "unused-receipt",
  })),
};

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "hype-comms-agent-wake-runtime-"));
}

describe("agent wake runtime", () => {
  it("requires runtime, CLI entrypoint, and target pins for the production adapters", async () => {
    const userDataPath = await temporaryDirectory();

    await expect(
      startAgentWakeRuntime({
        configuration: configuration(),
        userDataPath,
        target: unusedTarget,
      }),
    ).rejects.toEqual(new AgentWakeRuntimeError("executable-integrity-invalid"));
    await expect(
      startAgentWakeRuntime({
        configuration: configuration(),
        userDataPath,
        authorityAndSource: new FakeAuthorityAndSource(),
      }),
    ).rejects.toEqual(new AgentWakeRuntimeError("executable-integrity-invalid"));
  });

  it("captures one future boundary, persists the opaque binding, and resumes from it", async () => {
    const userDataPath = await temporaryDirectory();
    const store = new AgentWakeFileStore({ userDataPath });
    const adapter = new FakeAuthorityAndSource();
    const first = await startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      store,
      authorityAndSource: adapter,
      target: unusedTarget,
    });

    expect(first.initialStatus).toMatchObject({ phase: "running", cursor: "12" });
    await vi.waitFor(() => expect(adapter.opens).toHaveLength(1));
    expect(adapter.opens[0]).toMatchObject({
      credentialHandle: "hype-cli-grok-bot-pilot",
      after: "12",
    });
    expect(adapter.captureHighWater).toHaveBeenCalledOnce();
    await first.dispose();

    const second = await startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      store,
      authorityAndSource: adapter,
      target: unusedTarget,
    });
    await vi.waitFor(() => expect(adapter.opens).toHaveLength(2));
    expect(adapter.captureHighWater).toHaveBeenCalledOnce();
    expect(second.initialStatus.cursor).toBe("12");
    await second.dispose();
  });

  it("propagates the startup signal through verification and high-water capture", async () => {
    const userDataPath = await temporaryDirectory();
    const adapter = new FakeAuthorityAndSource();
    const controller = new AbortController();
    const runtime = await startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      authorityAndSource: adapter,
      target: unusedTarget,
      startupSignal: controller.signal,
    });

    expect(adapter.verify.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(adapter.captureHighWater.mock.calls[0]?.[1]).toBe(controller.signal);
    await runtime.dispose();
  });

  it("fails closed instead of silently rebinding a durable inbox to another provider", async () => {
    const userDataPath = await temporaryDirectory();
    const store = new AgentWakeFileStore({ userDataPath });
    const adapter = new FakeAuthorityAndSource();
    const first = await startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      store,
      authorityAndSource: adapter,
      target: unusedTarget,
    });
    await first.dispose();

    const changed = configuration();
    changed.target.targetHandle = "another-agent-runtime";
    await expect(
      startAgentWakeRuntime({
        configuration: changed,
        userDataPath,
        store,
        authorityAndSource: adapter,
        target: unusedTarget,
      }),
    ).rejects.toEqual(new AgentWakeRuntimeError("persisted-enrollment-conflict"));
    expect(adapter.captureHighWater).toHaveBeenCalledOnce();
  });

  it("retries transient verification and high-water failures with bounded backoff", async () => {
    const userDataPath = await temporaryDirectory();
    const store = new AgentWakeFileStore({ userDataPath });
    const adapter = new FakeAuthorityAndSource();
    const scheduler = new ManualStartupScheduler();
    const retries: Array<{ readonly attempt: number; readonly delayMs: number }> = [];
    adapter.verify.mockRejectedValueOnce(new AgentWakeSourceFailure("source-unavailable", true));
    adapter.captureHighWater.mockRejectedValueOnce(
      new AgentWakeSourceFailure("source-unavailable", true),
    );

    const starting = startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      store,
      authorityAndSource: adapter,
      target: unusedTarget,
      scheduler,
      startupRetryBaseMs: 100,
      startupRetryMaxMs: 150,
      onStartupRetry: ({ attempt, delayMs }) => retries.push({ attempt, delayMs }),
    });

    await vi.waitFor(() => expect(retries).toEqual([{ attempt: 1, delayMs: 100 }]));
    scheduler.runNext();
    await vi.waitFor(() =>
      expect(retries).toEqual([
        { attempt: 1, delayMs: 100 },
        { attempt: 2, delayMs: 150 },
      ]),
    );
    scheduler.runNext();

    const runtime = await starting;
    expect(runtime.initialStatus).toMatchObject({ phase: "running", cursor: "12" });
    expect(adapter.verify).toHaveBeenCalledTimes(3);
    expect(adapter.captureHighWater).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it("enters a terminal startup state after the configured retry limit", async () => {
    const userDataPath = await temporaryDirectory();
    const adapter = new FakeAuthorityAndSource();
    const scheduler = new ManualStartupScheduler();
    const controller = new AbortController();
    adapter.verify.mockRejectedValue(new AgentWakeSourceFailure("source-unavailable", true));

    const starting = startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      authorityAndSource: adapter,
      target: unusedTarget,
      scheduler,
      startupSignal: controller.signal,
      startupRetryLimit: 2,
    });
    const outcome = starting.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await vi.waitFor(() => expect(scheduler.pending).toHaveLength(1));
      scheduler.runNext();
      await vi.waitFor(() => expect(scheduler.pending).toHaveLength(1));
      scheduler.runNext();
      await vi.waitFor(() => expect(adapter.verify).toHaveBeenCalledTimes(3));

      const terminal = await Promise.race([
        outcome,
        new Promise<null>((resolve) => setImmediate(() => resolve(null))),
      ]);
      expect(terminal).toEqual(new AgentWakeRuntimeError("startup-retry-exhausted"));
      expect(scheduler.pending).toEqual([]);
    } finally {
      controller.abort();
      await starting.catch(() => undefined);
    }
  });

  it("retries transient startup store reads and commits before establishing enrollment", async () => {
    const userDataPath = await temporaryDirectory();
    const durableStore = new AgentWakeFileStore({ userDataPath });
    let failRead = true;
    let failTransaction = true;
    const store: AgentWakeInboxStore = {
      async read(enrollmentId: string): Promise<StoredAgentWakeEnrollment | null> {
        if (failRead) {
          failRead = false;
          throw new AgentWakeFileStoreError("store-unavailable");
        }
        return durableStore.read(enrollmentId);
      },
      async transaction<T>(
        enrollmentId: string,
        mutate: (current: StoredAgentWakeEnrollment | null) => AgentWakeStoreMutation<T>,
      ): Promise<T> {
        if (failTransaction) {
          failTransaction = false;
          throw new AgentWakeFileStoreError("store-unavailable");
        }
        return durableStore.transaction(enrollmentId, mutate);
      },
    };
    const adapter = new FakeAuthorityAndSource();
    const scheduler = new ManualStartupScheduler();

    const starting = startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      store,
      authorityAndSource: adapter,
      target: unusedTarget,
      scheduler,
      startupRetryBaseMs: 25,
    });
    await vi.waitFor(() => expect(scheduler.pending.map((entry) => entry.delayMs)).toEqual([25]));
    scheduler.runNext();
    await vi.waitFor(() => expect(scheduler.pending.map((entry) => entry.delayMs)).toEqual([50]));
    scheduler.runNext();

    const runtime = await starting;
    expect(runtime.initialStatus).toMatchObject({ phase: "running", cursor: "12" });
    expect(adapter.captureHighWater).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it("does not retry a nonretryable enrollment authentication failure", async () => {
    const userDataPath = await temporaryDirectory();
    const adapter = new FakeAuthorityAndSource();
    const scheduler = new ManualStartupScheduler();
    adapter.verify.mockRejectedValueOnce(
      new AgentWakeSourceFailure("source-authentication-required", false),
    );

    await expect(
      startAgentWakeRuntime({
        configuration: configuration(),
        userDataPath,
        authorityAndSource: adapter,
        target: unusedTarget,
        scheduler,
      }),
    ).rejects.toMatchObject({ code: "enrollment-verification-failed", retryable: false });
    expect(scheduler.pending).toEqual([]);
    expect(adapter.verify).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled startup retry when its supervisor is disposed", async () => {
    const userDataPath = await temporaryDirectory();
    const adapter = new FakeAuthorityAndSource();
    const scheduler = new ManualStartupScheduler();
    const controller = new AbortController();
    adapter.verify.mockRejectedValueOnce(new AgentWakeSourceFailure("source-unavailable", true));

    const starting = startAgentWakeRuntime({
      configuration: configuration(),
      userDataPath,
      authorityAndSource: adapter,
      target: unusedTarget,
      scheduler,
      startupSignal: controller.signal,
    });
    const rejected = expect(starting).rejects.toEqual(
      new AgentWakeRuntimeError("startup-disposed"),
    );
    await vi.waitFor(() => expect(scheduler.pending).toHaveLength(1));

    controller.abort();

    await rejected;
    expect(scheduler.pending).toEqual([]);
    expect(adapter.verify).toHaveBeenCalledOnce();
  });
});
