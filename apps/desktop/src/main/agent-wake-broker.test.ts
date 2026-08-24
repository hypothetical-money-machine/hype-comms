import { createHash } from "node:crypto";

import {
  agentWakeSignalSchema,
  encodeAgentWakeKeyInput,
  getAgentWakeKeyInput,
  type AgentWakeSignal,
  type AgentWakeStreamRecord,
} from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AgentWakeBroker,
  AgentWakeBrokerError,
  AgentWakeSourceFailure,
  type AgentWakeBrokerStatus,
  type AgentWakeClock,
  type AgentWakeInboxStore,
  type AgentWakeNotice,
  type AgentWakeScheduledTask,
  type AgentWakeScheduler,
  type AgentWakeSource,
  type AgentWakeSourceAccess,
  type AgentWakeSourceSession,
  type AgentWakeStoreMutation,
  type AgentWakeTarget,
  type AgentWakeTargetResult,
  type StoredAgentWakeEnrollment,
} from "./agent-wake-broker";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const AUTHOR_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_IDS = [
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
] as const;
const MESSAGE_IDS = [
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
  "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
] as const;
const ENROLLMENT_ID = "enrollment-1";
const CREDENTIAL_HANDLE = "credential-ref-1";
const TARGET_HANDLE = "provider-target-1";
const START_TIME = 1_800_000_000_000;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryWakeStore implements AgentWakeInboxStore {
  readonly states = new Map<string, StoredAgentWakeEnrollment>();
  readonly commits: StoredAgentWakeEnrollment[] = [];
  readCount = 0;
  failTransactions = 0;
  failAfterCommitTransactions = 0;
  delayPausedTransactionResult = false;
  onCommit: ((state: StoredAgentWakeEnrollment) => void) | null = null;
  #nextReadBarrier: Promise<void> | null = null;
  #nextReadStarted: (() => void) | null = null;
  #numberedReadBarrier: { readonly call: number; readonly barrier: Promise<void> } | null = null;
  #numberedReadStarted: (() => void) | null = null;
  #resumePausedTransaction: (() => void) | null = null;
  #tail: Promise<void> = Promise.resolve();

  async read(enrollmentId: string): Promise<StoredAgentWakeEnrollment | null> {
    this.readCount += 1;
    const numberedBarrier = this.#numberedReadBarrier;
    if (numberedBarrier?.call === this.readCount) {
      this.#numberedReadBarrier = null;
      const started = this.#numberedReadStarted;
      this.#numberedReadStarted = null;
      started?.();
      await numberedBarrier.barrier;
    }
    const barrier = this.#nextReadBarrier;
    if (barrier !== null) {
      this.#nextReadBarrier = null;
      const started = this.#nextReadStarted;
      this.#nextReadStarted = null;
      started?.();
      await barrier;
    }
    const state = this.states.get(enrollmentId);
    return state === undefined ? null : clone(state);
  }

  async transaction<T>(
    enrollmentId: string,
    mutate: (current: StoredAgentWakeEnrollment | null) => AgentWakeStoreMutation<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let released = false;
    try {
      if (this.failTransactions > 0) {
        this.failTransactions -= 1;
        throw new Error("credential=must-not-escape store failure");
      }
      const current = this.states.get(enrollmentId);
      const mutation = mutate(current === undefined ? null : clone(current));
      if (mutation.state === null) {
        this.states.delete(enrollmentId);
      } else {
        const next = clone(mutation.state);
        this.states.set(enrollmentId, next);
        this.commits.push(next);
        this.onCommit?.(clone(next));
        if (this.failAfterCommitTransactions > 0) {
          this.failAfterCommitTransactions -= 1;
          throw new Error("credential=must-not-escape post-commit store failure");
        }
        if (this.delayPausedTransactionResult && next.runState === "paused-capacity") {
          release?.();
          released = true;
          await new Promise<void>((resolve) => {
            this.#resumePausedTransaction = resolve;
          });
        }
      }
      return mutation.result;
    } finally {
      if (!released) release?.();
    }
  }

  seed(state: StoredAgentWakeEnrollment): void {
    this.states.set(state.enrollmentId, clone(state));
  }

  resumePausedTransaction(): void {
    const resume = this.#resumePausedTransaction;
    this.#resumePausedTransaction = null;
    resume?.();
  }

  pauseNextReadUntil(barrier: Promise<void>): Promise<void> {
    if (this.#nextReadBarrier !== null) throw new Error("A read is already paused");
    this.#nextReadBarrier = barrier;
    return new Promise<void>((resolve) => {
      this.#nextReadStarted = resolve;
    });
  }

  pauseReadCallUntil(call: number, barrier: Promise<void>): Promise<void> {
    if (this.#numberedReadBarrier !== null || call <= this.readCount) {
      throw new Error("A numbered read is already paused or has passed");
    }
    this.#numberedReadBarrier = { call, barrier };
    return new Promise<void>((resolve) => {
      this.#numberedReadStarted = resolve;
    });
  }
}

class ManualClock implements AgentWakeClock {
  value = START_TIME;

  now(): number {
    return this.value;
  }
}

interface ScheduledEntry {
  readonly dueAt: number;
  readonly task: () => void;
  cancelled: boolean;
}

class ManualScheduler implements AgentWakeScheduler {
  readonly entries: ScheduledEntry[] = [];

  constructor(readonly clock: ManualClock) {}

  schedule(delayMs: number, task: () => void): AgentWakeScheduledTask {
    const entry = { dueAt: this.clock.now() + delayMs, task, cancelled: false };
    this.entries.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  }

  advance(milliseconds: number): void {
    this.clock.value += milliseconds;
    for (const entry of this.entries) {
      if (!entry.cancelled && entry.dueAt <= this.clock.now()) {
        entry.cancelled = true;
        entry.task();
      }
    }
  }

  get pending(): readonly ScheduledEntry[] {
    return this.entries.filter((entry) => !entry.cancelled);
  }
}

class ManualSourceSession implements AgentWakeSourceSession {
  readonly acknowledgements: string[] = [];
  readonly pending: unknown[] = [];
  readonly waiters: Array<ReturnType<typeof deferred<unknown>>> = [];
  stopBarrier: Promise<void> | null = null;
  stopped = false;

  next(): Promise<unknown> {
    const record = this.pending.shift();
    if (record !== undefined) return Promise.resolve(record);
    if (this.stopped) {
      return Promise.reject(new AgentWakeSourceFailure("source-unavailable", true));
    }
    const waiter = deferred<unknown>();
    this.waiters.push(waiter);
    return waiter.promise;
  }

  async acknowledge(cursor: string): Promise<void> {
    this.acknowledgements.push(cursor);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new AgentWakeSourceFailure("source-unavailable", true));
    }
    await this.stopBarrier;
  }

  emit(record: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.pending.push(record);
    else waiter.resolve(record);
  }

  fail(error: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.pending.push(Promise.reject(error));
    else waiter.reject(error);
  }
}

class ManualSource implements AgentWakeSource {
  highWater = "10";
  readonly captures: AgentWakeSourceAccess[] = [];
  readonly opens: Array<AgentWakeSourceAccess & { readonly after: string }> = [];
  readonly sessions: ManualSourceSession[] = [];

  async captureHighWater(access: AgentWakeSourceAccess): Promise<string> {
    this.captures.push(clone(access));
    return this.highWater;
  }

  async open(
    input: AgentWakeSourceAccess & { readonly after: string },
  ): Promise<AgentWakeSourceSession> {
    this.opens.push(clone(input));
    const session = new ManualSourceSession();
    this.sessions.push(session);
    return session;
  }
}

class PendingOpenSource extends ManualSource {
  readonly opening = deferred<AgentWakeSourceSession>();
  openSignal: AbortSignal | undefined;

  override async open(
    input: AgentWakeSourceAccess & { readonly after: string },
    signal?: AbortSignal,
  ): Promise<AgentWakeSourceSession> {
    this.opens.push(clone(input));
    this.openSignal = signal;
    return this.opening.promise;
  }
}

interface TargetCall {
  readonly wake: AgentWakeSignal;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

function makeSignal(
  workspaceSequence: string,
  index = 0,
  overrides: Partial<AgentWakeSignal> = {},
): AgentWakeSignal {
  const withoutId = {
    version: 1,
    type: "agent.wake",
    delivery: "at_least_once",
    eventId: EVENT_IDS[index] ?? EVENT_IDS[0],
    workspaceSequence,
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_IDS[index] ?? MESSAGE_IDS[0],
    threadRootId: null,
    occurredAt: "2027-01-15T12:00:00.000Z",
    reason: "direct_message",
    ...overrides,
  } as const;
  const wakeId = createHash("sha256")
    .update(encodeAgentWakeKeyInput(getAgentWakeKeyInput(withoutId)), "utf8")
    .digest("hex");
  return agentWakeSignalSchema.parse({ ...withoutId, wakeId });
}

function checkpoint(cursor: string): AgentWakeStreamRecord {
  return {
    version: 1,
    type: "agent.wake.checkpoint",
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_ID,
    cursor,
  };
}

async function eventually(assertion: () => void, iterations = 200): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < iterations; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

interface Harness {
  readonly broker: AgentWakeBroker;
  readonly store: MemoryWakeStore;
  readonly source: ManualSource;
  readonly clock: ManualClock;
  readonly scheduler: ManualScheduler;
  readonly notices: AgentWakeNotice[];
  readonly targetCalls: TargetCall[];
  readonly verify: ReturnType<typeof vi.fn>;
}

function createHarness(options?: {
  readonly store?: MemoryWakeStore;
  readonly source?: ManualSource;
  readonly target?: (call: TargetCall) => Promise<AgentWakeTargetResult>;
  readonly maxQueueDepth?: number;
  readonly maxProviderAttempts?: number;
  readonly maxCompletionRecords?: number;
}): Harness {
  const store = options?.store ?? new MemoryWakeStore();
  const source = options?.source ?? new ManualSource();
  const clock = new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const notices: AgentWakeNotice[] = [];
  const targetCalls: TargetCall[] = [];
  const verify = vi.fn(async () => ({
    apiOrigin: "https://api.example.test",
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_ID,
  }));
  const target: AgentWakeTarget = {
    accept: async (input) => {
      const call = { wake: input.wake, attempt: input.attempt, signal: input.signal };
      targetCalls.push(call);
      return (
        options?.target?.(call) ??
        Promise.resolve({ status: "accepted", providerReceiptId: `receipt-${input.wake.wakeId}` })
      );
    },
  };
  const broker = new AgentWakeBroker({
    authority: { verify },
    source,
    store,
    clock,
    scheduler,
    target,
    maxQueueDepth: options?.maxQueueDepth,
    maxProviderAttempts: options?.maxProviderAttempts,
    maxCompletionRecords: options?.maxCompletionRecords,
    providerRetryBaseMs: 100,
    providerRetryMaxMs: 1_000,
    sourceRetryBaseMs: 100,
    sourceRetryMaxMs: 1_000,
    onNotice: (notice) => notices.push(notice),
  });
  return { broker, store, source, clock, scheduler, notices, targetCalls, verify };
}

async function enroll(harness: Harness): Promise<AgentWakeBrokerStatus> {
  return harness.broker.enrollNow({
    enrollmentId: ENROLLMENT_ID,
    expectedAgentUserId: AGENT_ID,
    credentialHandle: CREDENTIAL_HANDLE,
    provider: { adapterId: "agent-runtime-test", targetHandle: TARGET_HANDLE },
  });
}

async function start(harness: Harness): Promise<ManualSourceSession> {
  await enroll(harness);
  await harness.broker.start(ENROLLMENT_ID);
  await eventually(() => expect(harness.source.sessions).toHaveLength(1));
  const session = harness.source.sessions[0];
  if (session === undefined) throw new Error("Expected source session");
  return session;
}

describe("AgentWakeBroker enrollment and source commit boundary", () => {
  it("durably establishes a future-only high-water before opening the source", async () => {
    const harness = createHarness();

    const enrolled = await enroll(harness);

    expect(enrolled).toMatchObject({ cursor: "10", phase: "stopped", queueDepth: 0 });
    expect(harness.source.opens).toEqual([]);
    expect(harness.store.states.get(ENROLLMENT_ID)).toMatchObject({
      cursor: "10",
      credentialHandle: CREDENTIAL_HANDLE,
      runState: "stopped",
    });

    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.source.opens).toHaveLength(1));
    expect(harness.source.opens[0]).toMatchObject({ after: "10", agentUserId: AGENT_ID });
  });

  it("gates a persisted wake on fresh authorization and a valid source handshake", async () => {
    const harness = createHarness();
    await enroll(harness);
    const signal = makeSignal("11");
    const enrolled = harness.store.states.get(ENROLLMENT_ID);
    if (enrolled === undefined) throw new Error("Expected enrollment");
    harness.store.seed({
      ...enrolled,
      cursor: "11",
      queue: [
        {
          wake: signal,
          sourceCursor: "11",
          enqueuedAt: START_TIME,
          phase: "queued",
          attempts: 0,
          nextAttemptAt: null,
          lastRetryCode: null,
        },
      ],
    });
    const verification = deferred<{
      readonly apiOrigin: string;
      readonly workspaceId: string;
      readonly agentUserId: string;
    }>();
    harness.verify.mockImplementationOnce(() => verification.promise);

    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.verify).toHaveBeenCalledTimes(2));
    expect(harness.source.opens).toEqual([]);
    expect(harness.targetCalls).toEqual([]);

    verification.resolve({
      apiOrigin: "https://api.example.test",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_ID,
    });
    await eventually(() => expect(harness.source.sessions).toHaveLength(1));
    expect(harness.targetCalls).toEqual([]);

    harness.source.sessions[0]!.emit(checkpoint("11"));
    await eventually(() => expect(harness.targetCalls).toHaveLength(1));
    expect(harness.targetCalls[0]?.wake.wakeId).toBe(signal.wakeId);
  });

  it("blocks a persisted wake when fresh resume authorization is revoked", async () => {
    const harness = createHarness();
    await enroll(harness);
    const signal = makeSignal("11");
    const enrolled = harness.store.states.get(ENROLLMENT_ID);
    if (enrolled === undefined) throw new Error("Expected enrollment");
    harness.store.seed({
      ...enrolled,
      cursor: "11",
      queue: [
        {
          wake: signal,
          sourceCursor: "11",
          enqueuedAt: START_TIME,
          phase: "queued",
          attempts: 0,
          nextAttemptAt: null,
          lastRetryCode: null,
        },
      ],
    });
    harness.verify.mockRejectedValueOnce(
      new AgentWakeSourceFailure("source-authentication-required", false),
    );

    await harness.broker.resume({
      enrollmentId: ENROLLMENT_ID,
      actionId: "8".repeat(64),
      evidenceReference: "resume-auth-check",
    });

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair).toMatchObject({
        code: "source-authentication-required",
        wakeId: null,
      }),
    );
    expect(harness.source.opens).toEqual([]);
    expect(harness.targetCalls).toEqual([]);
  });

  it("keeps a persisted queue inert when the source fails before its readiness record", async () => {
    const harness = createHarness();
    await enroll(harness);
    const signal = makeSignal("11");
    const enrolled = harness.store.states.get(ENROLLMENT_ID);
    if (enrolled === undefined) throw new Error("Expected enrollment");
    harness.store.seed({
      ...enrolled,
      cursor: "11",
      queue: [
        {
          wake: signal,
          sourceCursor: "11",
          enqueuedAt: START_TIME,
          phase: "queued",
          attempts: 0,
          nextAttemptAt: null,
          lastRetryCode: null,
        },
      ],
    });

    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.source.sessions).toHaveLength(1));
    harness.source.sessions[0]!.fail(
      new AgentWakeSourceFailure("source-authentication-required", false),
    );

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair).toMatchObject({
        code: "source-authentication-required",
        wakeId: null,
      }),
    );
    expect(harness.targetCalls).toEqual([]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]).toMatchObject({
      phase: "queued",
      wake: { wakeId: signal.wakeId },
    });
  });

  it.each(["start", "resume"] as const)(
    "forces fresh authorization before an active %s can release a provider retry",
    async (operation) => {
      const target = vi
        .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
        .mockResolvedValueOnce({
          status: "retry",
          code: "provider-unavailable",
          retryAfterMs: 100,
        })
        .mockResolvedValueOnce({ status: "accepted", providerReceiptId: "must-not-run" });
      const harness = createHarness({ target });
      const session = await start(harness);
      session.emit(makeSignal("11"));
      await eventually(() =>
        expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]?.phase).toBe("retry-wait"),
      );
      harness.verify.mockRejectedValueOnce(
        new AgentWakeSourceFailure("source-authentication-required", false),
      );

      if (operation === "start") {
        await harness.broker.start(ENROLLMENT_ID);
      } else {
        await harness.broker.resume({
          enrollmentId: ENROLLMENT_ID,
          actionId: "9".repeat(64),
          evidenceReference: "active-resume-auth-check",
        });
      }

      await eventually(() =>
        expect(harness.store.states.get(ENROLLMENT_ID)?.repair).toMatchObject({
          code: "source-authentication-required",
          wakeId: null,
        }),
      );
      harness.scheduler.advance(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(target).toHaveBeenCalledOnce();
      expect(harness.verify).toHaveBeenCalledTimes(3);
      expect(harness.source.opens).toHaveLength(1);
    },
  );

  it("quiesces a delivery read already in progress until active restart is freshly ready", async () => {
    const harness = createHarness();
    const session = await start(harness);
    const signal = makeSignal("11");
    const releaseDeliveryRead = deferred<void>();
    let deliveryReadStarted: Promise<void> | undefined;
    harness.store.onCommit = (state) => {
      if (state.queue[0]?.phase !== "queued") return;
      harness.store.onCommit = null;
      deliveryReadStarted = harness.store.pauseNextReadUntil(releaseDeliveryRead.promise);
    };

    session.emit(signal);
    await eventually(() => expect(deliveryReadStarted).toBeDefined());
    await deliveryReadStarted;
    expect(harness.targetCalls).toEqual([]);

    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));
    releaseDeliveryRead.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.targetCalls).toEqual([]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]).toMatchObject({
      phase: "queued",
      wake: { wakeId: signal.wakeId },
    });

    const restartedSession = harness.source.sessions[1]!;
    restartedSession.emit(checkpoint("11"));
    await eventually(() => expect(harness.targetCalls).toHaveLength(1));
    expect(harness.targetCalls[0]?.wake.wakeId).toBe(signal.wakeId);
  });

  it("rejects an identity mismatch and never captures a cursor", async () => {
    const harness = createHarness();
    harness.verify.mockResolvedValueOnce({
      apiOrigin: "https://api.example.test",
      workspaceId: WORKSPACE_ID,
      agentUserId: AUTHOR_ID,
    });

    await expect(enroll(harness)).rejects.toMatchObject({
      code: "enrollment-identity-mismatch",
    });
    expect(harness.source.captures).toEqual([]);
    expect(await harness.store.read(ENROLLMENT_ID)).toBeNull();
  });

  it("commits a suppressed checkpoint before acknowledging it", async () => {
    const harness = createHarness();
    const session = await start(harness);

    session.emit(checkpoint("11"));

    await eventually(() => expect(session.acknowledgements).toEqual(["11"]));
    expect(harness.store.states.get(ENROLLMENT_ID)?.cursor).toBe("11");
    const committed = harness.store.commits.find((state) => state.cursor === "11");
    expect(committed).toBeDefined();
  });

  it("does not acknowledge when durable enqueue fails", async () => {
    const harness = createHarness();
    const session = await start(harness);
    harness.store.failTransactions = 1;

    session.emit(makeSignal("11"));

    await eventually(() =>
      expect(harness.notices.some((notice) => notice.code === "source-unavailable")).toBe(true),
    );
    expect(session.acknowledgements).toEqual([]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.cursor).toBe("10");
    expect(harness.targetCalls).toEqual([]);
  });

  it("treats malformed strict records as repair-required without retry or acknowledgement", async () => {
    const harness = createHarness();
    const session = await start(harness);

    session.emit({ ...checkpoint("11"), body: "must never cross" });

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe("source-record-invalid"),
    );
    expect(session.acknowledgements).toEqual([]);
    expect(harness.scheduler.pending).toEqual([]);
    expect(harness.targetCalls).toEqual([]);
  });

  it("retires instead of restarting the source task for a non-runnable durable state", async () => {
    const harness = createHarness();
    const session = await start(harness);
    const releaseSecondRead = deferred<void>();
    const secondReadStarted = harness.store.pauseReadCallUntil(
      harness.store.readCount + 2,
      releaseSecondRead.promise,
    );
    harness.store.failAfterCommitTransactions = 1;

    session.emit({ ...checkpoint("11"), body: "must never cross" });
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe("source-record-invalid"),
    );

    try {
      const reranSourceTwice = await Promise.race([
        secondReadStarted.then(() => true),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      expect(reranSourceTwice).toBe(false);
    } finally {
      releaseSecondRead.resolve();
      await harness.broker.dispose().catch(() => undefined);
    }
  });

  it("rejects a valid-looking but non-deterministic wake ID before enqueue", async () => {
    const harness = createHarness();
    const session = await start(harness);
    session.emit({ ...makeSignal("11"), wakeId: "0".repeat(64) });

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe("source-record-invalid"),
    );
    expect(session.acknowledgements).toEqual([]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue).toEqual([]);
    expect(harness.targetCalls).toEqual([]);
  });

  it("retains the source repair when provider ambiguity interrupts its resolution", async () => {
    const delivery = deferred<AgentWakeTargetResult>();
    const harness = createHarness({ target: () => delivery.promise });
    const session = await start(harness);
    const existing = makeSignal("11");
    session.emit(existing);
    await eventually(() => expect(harness.targetCalls).toHaveLength(1));

    session.emit({ ...makeSignal("12", 1), wakeId: existing.wakeId });

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair).toMatchObject({
        code: "provider-outcome-ambiguous",
        wakeId: existing.wakeId,
        deferredSourceRepair: {
          code: "source-record-invalid",
          wakeId: existing.wakeId,
        },
      }),
    );
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]?.phase).toBe("blocked");
    expect(harness.scheduler.pending).toEqual([]);
    delivery.resolve({ status: "accepted", providerReceiptId: "ignored-after-source-repair" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const providerResolved = await harness.broker.resolveProviderRepair({
      enrollmentId: ENROLLMENT_ID,
      action: "retry",
      actionId: "a".repeat(64),
      evidenceReference: "provider-proved-not-accepted-after-source-repair",
      expectedRepairCode: "provider-outcome-ambiguous",
      expectedRepairOccurredAt: START_TIME,
      expectedWakeId: existing.wakeId,
    });
    expect(providerResolved).toMatchObject({
      phase: "blocked-repair",
      repair: {
        code: "source-record-invalid",
        wakeId: existing.wakeId,
        deferredSourceRepair: null,
      },
    });
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]?.phase).toBe("queued");
  });

  it("merges a source failure queued behind an existing provider repair", async () => {
    const harness = createHarness({
      target: async () => {
        throw new Error("provider outcome unknown");
      },
    });
    const session = await start(harness);
    const signal = makeSignal("11");
    harness.store.onCommit = (state) => {
      if (
        state.repair?.code === "provider-outcome-ambiguous" &&
        state.repair.deferredSourceRepair === null
      ) {
        harness.store.onCommit = null;
        session.fail(new AgentWakeSourceFailure("source-authentication-required", false));
      }
    };

    session.emit(signal);

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair).toMatchObject({
        code: "provider-outcome-ambiguous",
        wakeId: signal.wakeId,
        deferredSourceRepair: {
          code: "source-authentication-required",
          wakeId: null,
        },
      }),
    );
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]).toMatchObject({
      phase: "blocked",
      wake: { wakeId: signal.wakeId },
    });
  });

  it("records exact provider ambiguity when source authorization fails during delivery", async () => {
    const delivery = deferred<AgentWakeTargetResult>();
    const harness = createHarness({ target: () => delivery.promise });
    const session = await start(harness);
    const signal = makeSignal("11");
    session.emit(signal);
    await eventually(() => expect(harness.targetCalls).toHaveLength(1));

    session.fail(new AgentWakeSourceFailure("source-authentication-required", false));

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)).toMatchObject({
        runState: "stopped",
        queue: [{ phase: "blocked", wake: { wakeId: signal.wakeId } }],
        repair: { code: "provider-outcome-ambiguous", wakeId: signal.wakeId },
      }),
    );
    expect(harness.targetCalls[0]?.signal.aborted).toBe(true);
    delivery.resolve({ status: "accepted", providerReceiptId: "accepted-during-source-failure" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.store.states.get(ENROLLMENT_ID)?.repair).toMatchObject({
      code: "provider-outcome-ambiguous",
      wakeId: signal.wakeId,
    });
  });

  it("blocks a cross-identity record without advancing its cursor", async () => {
    const harness = createHarness();
    const session = await start(harness);
    session.emit({ ...checkpoint("11"), agentUserId: AUTHOR_ID });

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe("source-scope-invalid"),
    );
    expect(harness.store.states.get(ENROLLMENT_ID)?.cursor).toBe("10");
    expect(session.acknowledgements).toEqual([]);
  });

  it("maps cursor-expired control to visible repair and can reset explicitly from now", async () => {
    const harness = createHarness();
    const session = await start(harness);
    session.emit({
      version: 1,
      type: "agent.wake.repair_required",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_ID,
      cursor: "11",
      reason: "cursor_expired",
    });
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe("source-cursor-expired"),
    );
    expect(session.acknowledgements).toEqual([]);

    harness.source.highWater = "25";
    const repaired = await harness.broker.resetSourceFromNow({
      enrollmentId: ENROLLMENT_ID,
      actionId: "1".repeat(64),
      evidenceReference: "incident-source-cursor-1",
      expectedRepairCode: "source-cursor-expired",
      expectedRepairOccurredAt: START_TIME,
      expectedWakeId: null,
    });
    expect(repaired).toMatchObject({ cursor: "25", phase: "stopped", repair: null });
    expect((await harness.broker.evidence(ENROLLMENT_ID))?.operatorActions).toMatchObject([
      {
        action: "source-reset-from-now",
        repairCode: "source-cursor-expired",
        evidenceReference: "incident-source-cursor-1",
      },
    ]);
  });

  it("retries a classified transient source failure from the durable cursor", async () => {
    const harness = createHarness();
    const session = await start(harness);
    session.emit(checkpoint("11"));
    await eventually(() => expect(session.acknowledgements).toEqual(["11"]));

    session.fail(new AgentWakeSourceFailure("source-unavailable", true));
    await eventually(() => expect(harness.scheduler.pending).toHaveLength(1));
    expect((await harness.broker.status(ENROLLMENT_ID))?.retry).toMatchObject({
      code: "source-unavailable",
      attempt: 1,
    });

    harness.scheduler.advance(100);
    await eventually(() => expect(harness.source.opens).toHaveLength(2));
    expect(harness.source.opens[1]?.after).toBe("11");
  });

  it("keeps increasing source backoff until a reopened source produces a valid record", async () => {
    const harness = createHarness();
    const firstSession = await start(harness);

    firstSession.fail(new AgentWakeSourceFailure("source-unavailable", true));
    await eventually(() => expect(harness.scheduler.pending).toHaveLength(1));
    expect((await harness.broker.status(ENROLLMENT_ID))?.retry).toMatchObject({ attempt: 1 });

    harness.scheduler.advance(100);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));
    const secondSession = harness.source.sessions[1];
    if (secondSession === undefined) throw new Error("Expected second source session");
    secondSession.fail(new AgentWakeSourceFailure("source-unavailable", true));

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.sourceRetry).toMatchObject({ attempt: 2 }),
    );
    expect(harness.scheduler.pending).toHaveLength(1);
    expect(harness.scheduler.pending[0]?.dueAt).toBe(START_TIME + 300);

    harness.scheduler.advance(200);
    await eventually(() => expect(harness.source.sessions).toHaveLength(3));
    const healthySession = harness.source.sessions[2];
    if (healthySession === undefined) throw new Error("Expected healthy source session");
    healthySession.emit(checkpoint("10"));

    await eventually(() => expect(healthySession.acknowledgements).toEqual(["10"]));
    expect(harness.store.states.get(ENROLLMENT_ID)?.sourceRetry).toBeNull();
  });

  it("does not retry a classified credential revocation", async () => {
    const harness = createHarness();
    const session = await start(harness);
    session.fail(new AgentWakeSourceFailure("source-authentication-required", false));

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe(
        "source-authentication-required",
      ),
    );
    expect(harness.scheduler.pending).toEqual([]);
    expect(harness.source.opens).toHaveLength(1);
  });
});

describe("AgentWakeBroker delivery, dedupe, and FIFO", () => {
  it("durably enqueues before acknowledgement and persists an auditable acceptance", async () => {
    const delivery = deferred<AgentWakeTargetResult>();
    const harness = createHarness({ target: () => delivery.promise });
    const session = await start(harness);
    const signal = makeSignal("11");

    session.emit(signal);

    await eventually(() => expect(harness.targetCalls).toHaveLength(1));
    expect(session.acknowledgements).toEqual(["11"]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]).toMatchObject({
      wake: signal,
      phase: "delivering",
    });
    delivery.resolve({ status: "accepted", providerReceiptId: "runtime-receipt-1" });

    await eventually(() => expect(harness.store.states.get(ENROLLMENT_ID)?.queue).toHaveLength(0));
    expect((await harness.broker.status(ENROLLMENT_ID))?.lastCompletion).toEqual({
      wakeId: signal.wakeId,
      conversationId: signal.conversationId,
      messageId: signal.messageId,
      reason: signal.reason,
      occurredAt: signal.occurredAt,
      sourceCursor: signal.workspaceSequence,
      attempt: 1,
      brokerDurableAt: START_TIME,
      disposition: "accepted",
      providerReceiptId: "runtime-receipt-1",
      completedAt: START_TIME,
    });
    expect(await harness.broker.evidence(ENROLLMENT_ID)).toMatchObject({
      version: 1,
      type: "agent.wake.broker_evidence",
      completions: [
        {
          wakeId: signal.wakeId,
          messageId: signal.messageId,
          brokerDurableAt: START_TIME,
          completedAt: START_TIME,
        },
      ],
    });
  });

  it.each(["accepted", "duplicate", "coalesced"] as const)(
    "preserves the provider %s disposition",
    async (disposition) => {
      const harness = createHarness({
        target: async () => ({ status: disposition, providerReceiptId: `receipt-${disposition}` }),
      });
      const session = await start(harness);
      session.emit(makeSignal("11"));

      await eventually(() =>
        expect(harness.store.states.get(ENROLLMENT_ID)?.completions).toHaveLength(1),
      );
      expect(harness.store.states.get(ENROLLMENT_ID)?.completions[0]).toMatchObject({
        disposition,
        providerReceiptId: `receipt-${disposition}`,
      });
    },
  );

  it("deduplicates replayed wake IDs while the first delivery is concurrent", async () => {
    const delivery = deferred<AgentWakeTargetResult>();
    const harness = createHarness({ target: () => delivery.promise });
    const session = await start(harness);
    const signal = makeSignal("11");

    session.emit(signal);
    session.emit(signal);

    await eventually(() => expect(session.acknowledgements).toEqual(["11", "11"]));
    expect(harness.targetCalls).toHaveLength(1);
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue).toHaveLength(1);
    delivery.resolve({ status: "duplicate", providerReceiptId: signal.wakeId });
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.completions).toHaveLength(1),
    );
    expect(harness.targetCalls).toHaveLength(1);
  });

  it("delivers distinct wakes in per-enrollment FIFO order", async () => {
    const first = deferred<AgentWakeTargetResult>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ status: "accepted", providerReceiptId: "receipt-2" });
    const harness = createHarness({ target });
    const session = await start(harness);
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);

    session.emit(one);
    session.emit(two);
    await eventually(() => expect(session.acknowledgements).toEqual(["11", "12"]));
    expect(target).toHaveBeenCalledTimes(1);
    expect(target.mock.calls[0]?.[0].wake.wakeId).toBe(one.wakeId);

    first.resolve({ status: "accepted", providerReceiptId: "receipt-1" });
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    expect(target.mock.calls[1]?.[0].wake.wakeId).toBe(two.wakeId);
  });

  it("pauses a full queue without acknowledging or dropping the held wake", async () => {
    const first = deferred<AgentWakeTargetResult>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ status: "accepted", providerReceiptId: "receipt-2" });
    const harness = createHarness({ target, maxQueueDepth: 1 });
    const session = await start(harness);
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);

    session.emit(one);
    session.emit(two);
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.runState).toBe("paused-capacity"),
    );
    expect(session.acknowledgements).toEqual(["11"]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.cursor).toBe("11");
    expect(target).toHaveBeenCalledTimes(1);

    first.resolve({ status: "accepted", providerReceiptId: "receipt-1" });
    await eventually(() => expect(session.acknowledgements).toEqual(["11", "12"]));
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    expect(target.mock.calls[1]?.[0].wake.wakeId).toBe(two.wakeId);
  });

  it("does not lose a capacity wake-up when the FIFO head completes before waiting", async () => {
    const first = deferred<AgentWakeTargetResult>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ status: "accepted", providerReceiptId: "receipt-2" });
    const harness = createHarness({ target, maxQueueDepth: 1 });
    const session = await start(harness);
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);
    harness.store.delayPausedTransactionResult = true;
    harness.store.onCommit = (committed) => {
      if (committed.runState !== "paused-capacity") return;
      harness.store.onCommit = null;
      first.resolve({ status: "accepted", providerReceiptId: "receipt-1" });
    };

    session.emit(one);
    session.emit(two);

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.completions).toHaveLength(1),
    );
    expect(session.acknowledgements).toEqual(["11"]);
    harness.store.resumePausedTransaction();
    await eventually(() => expect(session.acknowledgements).toEqual(["11", "12"]));
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    expect(target.mock.calls.map(([call]) => call.wake.wakeId)).toEqual([one.wakeId, two.wakeId]);
  });

  it("drains a persisted full queue after its first authenticated source record", async () => {
    const first = deferred<AgentWakeTargetResult>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ status: "accepted", providerReceiptId: "receipt-2" });
    const harness = createHarness({ target, maxQueueDepth: 1 });
    await enroll(harness);
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);
    const enrolled = harness.store.states.get(ENROLLMENT_ID);
    if (enrolled === undefined) throw new Error("Expected enrollment");
    harness.store.seed({
      ...enrolled,
      cursor: "11",
      queue: [
        {
          wake: one,
          sourceCursor: "11",
          enqueuedAt: START_TIME,
          phase: "queued",
          attempts: 0,
          nextAttemptAt: null,
          lastRetryCode: null,
        },
      ],
    });

    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.source.sessions).toHaveLength(1));
    const session = harness.source.sessions[0]!;
    session.emit(two);

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.runState).toBe("paused-capacity"),
    );
    expect(target).toHaveBeenCalledOnce();
    expect(target.mock.calls[0]?.[0].wake.wakeId).toBe(one.wakeId);
    expect(session.acknowledgements).toEqual([]);

    first.resolve({ status: "accepted", providerReceiptId: "receipt-1" });
    await eventually(() => expect(session.acknowledgements).toEqual(["12"]));
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    expect(target.mock.calls.map(([call]) => call.wake.wakeId)).toEqual([one.wakeId, two.wakeId]);
  });

  it("bounds completion history while the cursor still suppresses old replay", async () => {
    const harness = createHarness({ maxCompletionRecords: 2 });
    const session = await start(harness);
    const signals = [makeSignal("11", 0), makeSignal("12", 1), makeSignal("13", 2)];
    for (const signal of signals) {
      session.emit(signal);
      await eventually(() =>
        expect(harness.store.states.get(ENROLLMENT_ID)?.cursor).toBe(signal.workspaceSequence),
      );
      await eventually(() =>
        expect(harness.store.states.get(ENROLLMENT_ID)?.queue).toHaveLength(0),
      );
    }

    const completions = harness.store.states.get(ENROLLMENT_ID)?.completions;
    expect(completions?.map((completion) => completion.wakeId)).toEqual([
      signals[1]?.wakeId,
      signals[2]?.wakeId,
    ]);
    session.emit(signals[0]);
    await eventually(() => expect(session.acknowledgements).toHaveLength(4));
    expect(harness.targetCalls).toHaveLength(3);
  });
});

describe("AgentWakeBroker retries, repair, and crash recovery", () => {
  it("persists a classified retry and invokes again only after its scheduled time", async () => {
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockResolvedValueOnce({
        status: "retry",
        code: "provider-rate-limited",
        retryAfterMs: 250,
      })
      .mockResolvedValueOnce({ status: "accepted", providerReceiptId: "receipt-final" });
    const harness = createHarness({ target });
    const session = await start(harness);
    session.emit(makeSignal("11"));

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]?.phase).toBe("retry-wait"),
    );
    expect(await harness.broker.status(ENROLLMENT_ID)).toMatchObject({
      phase: "retry-wait",
      retry: { code: "provider-rate-limited", attempt: 1, nextAttemptAt: START_TIME + 250 },
    });
    expect(target).toHaveBeenCalledTimes(1);

    harness.scheduler.advance(249);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(target).toHaveBeenCalledTimes(1);
    harness.scheduler.advance(1);
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    expect(target.mock.calls.map(([call]) => call.attempt)).toEqual([1, 2]);
  });

  it("blocks after the configured retry limit", async () => {
    const harness = createHarness({
      maxProviderAttempts: 1,
      target: async () => ({ status: "retry", code: "provider-unavailable", retryAfterMs: 0 }),
    });
    const session = await start(harness);
    const signal = makeSignal("11");
    session.emit(signal);

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe(
        "provider-retry-exhausted",
      ),
    );
    expect(harness.targetCalls).toHaveLength(1);
    expect(harness.scheduler.pending).toEqual([]);
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]).toMatchObject({
      phase: "blocked",
      wake: { wakeId: signal.wakeId },
    });
  });

  it("never blindly retries an ambiguous thrown outcome and requires explicit repair", async () => {
    const harness = createHarness({
      target: async () => {
        throw new Error("token=must-not-escape ambiguous provider error");
      },
    });
    const session = await start(harness);
    const signal = makeSignal("11");
    session.emit(signal);

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe(
        "provider-outcome-ambiguous",
      ),
    );
    expect(harness.targetCalls).toHaveLength(1);
    expect(harness.scheduler.pending).toEqual([]);
    await harness.broker.start(ENROLLMENT_ID);
    expect(harness.targetCalls).toHaveLength(1);

    const repaired = await harness.broker.resolveProviderRepair({
      enrollmentId: ENROLLMENT_ID,
      action: "confirm-accepted",
      actionId: "2".repeat(64),
      providerReceiptId: "operator-confirmed-receipt",
      evidenceReference: "runtime-activity-42",
      expectedRepairCode: "provider-outcome-ambiguous",
      expectedRepairOccurredAt: START_TIME,
      expectedWakeId: signal.wakeId,
    });
    expect(repaired).toMatchObject({
      phase: "stopped",
      queueDepth: 0,
      repair: null,
      lastCompletion: {
        disposition: "accepted",
        providerReceiptId: "operator-confirmed-receipt",
      },
    });
    await expect(
      harness.broker.resolveProviderRepair({
        enrollmentId: ENROLLMENT_ID,
        action: "confirm-accepted",
        actionId: "2".repeat(64),
        providerReceiptId: "operator-confirmed-receipt",
        evidenceReference: "runtime-activity-42",
        expectedRepairCode: "provider-outcome-ambiguous",
        expectedRepairOccurredAt: START_TIME,
        expectedWakeId: signal.wakeId,
      }),
    ).resolves.toMatchObject({ repair: null, queueDepth: 0 });

    const resumed = await harness.broker.resume({
      enrollmentId: ENROLLMENT_ID,
      actionId: "4".repeat(64),
      evidenceReference: "runtime-activity-42",
    });
    expect(resumed.phase).toBe("running");
    await harness.broker.resume({
      enrollmentId: ENROLLMENT_ID,
      actionId: "4".repeat(64),
      evidenceReference: "runtime-activity-42",
    });
    expect((await harness.broker.evidence(ENROLLMENT_ID))?.operatorActions).toMatchObject([
      { actionId: "2".repeat(64), action: "confirm-accepted" },
      { actionId: "4".repeat(64), action: "resume" },
    ]);
  });

  it("allows an explicit operator retry after ambiguity but never an automatic one", async () => {
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockRejectedValueOnce(new Error("acceptance unknown"))
      .mockResolvedValueOnce({ status: "duplicate", providerReceiptId: "reconciled-receipt" });
    const harness = createHarness({ target });
    const session = await start(harness);
    session.emit(makeSignal("11"));
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe(
        "provider-outcome-ambiguous",
      ),
    );
    expect(target).toHaveBeenCalledTimes(1);

    await harness.broker.resolveProviderRepair({
      enrollmentId: ENROLLMENT_ID,
      action: "retry",
      actionId: "3".repeat(64),
      evidenceReference: "provider-proved-not-accepted-1",
      expectedRepairCode: "provider-outcome-ambiguous",
      expectedRepairOccurredAt: START_TIME,
      expectedWakeId: makeSignal("11").wakeId,
    });
    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));
    harness.source.sessions[1]!.emit(checkpoint("11"));
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.completions[0]).toMatchObject({
        disposition: "duplicate",
        providerReceiptId: "reconciled-receipt",
      }),
    );
  });

  it("cannot let a replayed or stale repair command interrupt a newer active delivery", async () => {
    const newerDelivery = deferred<AgentWakeTargetResult>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockRejectedValueOnce(new Error("first outcome unknown"))
      .mockImplementationOnce(() => newerDelivery.promise);
    const harness = createHarness({ target });
    const firstSession = await start(harness);
    const firstWake = makeSignal("11", 0);
    firstSession.emit(firstWake);
    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe(
        "provider-outcome-ambiguous",
      ),
    );

    const repairActionId = "5".repeat(64);
    await harness.broker.resolveProviderRepair({
      enrollmentId: ENROLLMENT_ID,
      action: "confirm-accepted",
      actionId: repairActionId,
      providerReceiptId: "first-provider-receipt",
      evidenceReference: "first-provider-activity",
      expectedRepairCode: "provider-outcome-ambiguous",
      expectedRepairOccurredAt: START_TIME,
      expectedWakeId: firstWake.wakeId,
    });
    await harness.broker.resume({
      enrollmentId: ENROLLMENT_ID,
      actionId: "6".repeat(64),
      evidenceReference: "first-provider-activity",
    });
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));

    const secondWake = makeSignal("12", 1);
    harness.source.sessions[1]!.emit(secondWake);
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));

    await harness.broker.resolveProviderRepair({
      enrollmentId: ENROLLMENT_ID,
      action: "confirm-accepted",
      actionId: repairActionId,
      providerReceiptId: "first-provider-receipt",
      evidenceReference: "first-provider-activity",
      expectedRepairCode: "provider-outcome-ambiguous",
      expectedRepairOccurredAt: START_TIME,
      expectedWakeId: firstWake.wakeId,
    });
    await expect(
      harness.broker.resolveProviderRepair({
        enrollmentId: ENROLLMENT_ID,
        action: "confirm-accepted",
        actionId: "7".repeat(64),
        providerReceiptId: "stale-receipt",
        evidenceReference: "stale-evidence",
        expectedRepairCode: "provider-outcome-ambiguous",
        expectedRepairOccurredAt: START_TIME,
        expectedWakeId: firstWake.wakeId,
      }),
    ).rejects.toMatchObject({ code: "repair-action-invalid" });
    expect(harness.store.states.get(ENROLLMENT_ID)).toMatchObject({
      repair: null,
      queue: [{ wake: { wakeId: secondWake.wakeId }, phase: "delivering" }],
    });

    newerDelivery.resolve({ status: "accepted", providerReceiptId: "second-provider-receipt" });
    await eventually(() => expect(harness.store.states.get(ENROLLMENT_ID)?.queue).toHaveLength(0));
  });

  it("blocks a terminal response with no bounded provider receipt", async () => {
    const harness = createHarness({
      target: async () =>
        ({ status: "accepted", providerReceiptId: "bad\nreceipt" }) as AgentWakeTargetResult,
    });
    const session = await start(harness);
    session.emit(makeSignal("11"));

    await eventually(() =>
      expect(harness.store.states.get(ENROLLMENT_ID)?.repair?.code).toBe(
        "provider-contract-invalid",
      ),
    );
    expect(harness.store.states.get(ENROLLMENT_ID)?.completions).toEqual([]);
    expect(harness.scheduler.pending).toEqual([]);
  });

  it("turns a crash-restored delivering claim into ambiguous repair without invocation", async () => {
    const harness = createHarness();
    await enroll(harness);
    const signal = makeSignal("11");
    const enrolled = harness.store.states.get(ENROLLMENT_ID);
    if (enrolled === undefined) throw new Error("Expected enrollment");
    harness.store.seed({
      ...enrolled,
      cursor: "11",
      runState: "running",
      queue: [
        {
          wake: signal,
          sourceCursor: "11",
          enqueuedAt: START_TIME,
          phase: "delivering",
          attempts: 1,
          nextAttemptAt: null,
          lastRetryCode: null,
        },
      ],
    });

    const status = await harness.broker.start(ENROLLMENT_ID);
    expect(status).toMatchObject({
      phase: "blocked-repair",
      repair: { code: "provider-outcome-ambiguous", wakeId: signal.wakeId },
    });
    expect(harness.targetCalls).toEqual([]);
    expect(harness.source.opens).toEqual([]);
  });

  it("supervises receipt-store failure to exact ambiguity after recovery without restart", async () => {
    const store = new MemoryWakeStore();
    const first = createHarness({
      store,
      target: async () => {
        store.failTransactions = 2;
        return { status: "accepted", providerReceiptId: "accepted-before-crash" };
      },
    });
    const session = await start(first);
    const signal = makeSignal("11");
    session.emit(signal);
    await eventually(() =>
      expect(first.notices.some((notice) => notice.code === "durable-store-unavailable")).toBe(
        true,
      ),
    );
    expect(store.states.get(ENROLLMENT_ID)?.queue[0]).toMatchObject({
      phase: "delivering",
      wake: { wakeId: signal.wakeId },
    });
    expect(first.targetCalls).toHaveLength(1);
    expect(first.scheduler.pending).toHaveLength(1);

    first.scheduler.advance(100);
    await eventually(() => expect(first.scheduler.pending).toHaveLength(1));
    expect(store.states.get(ENROLLMENT_ID)?.queue[0]?.phase).toBe("delivering");

    first.scheduler.advance(200);
    await eventually(() =>
      expect(store.states.get(ENROLLMENT_ID)).toMatchObject({
        runState: "stopped",
        queue: [{ phase: "blocked", wake: { wakeId: signal.wakeId } }],
        repair: { code: "provider-outcome-ambiguous", wakeId: signal.wakeId },
      }),
    );
    expect(first.targetCalls).toHaveLength(1);
    expect(first.scheduler.pending).toEqual([]);
  });

  it("reconciles a completion that committed before its store transaction threw", async () => {
    const store = new MemoryWakeStore();
    const harness = createHarness({
      store,
      target: async () => {
        store.failAfterCommitTransactions = 1;
        return { status: "accepted", providerReceiptId: "durable-before-error" };
      },
    });
    const session = await start(harness);
    const signal = makeSignal("11");
    session.emit(signal);

    await eventually(() =>
      expect(harness.notices.some((notice) => notice.code === "durable-store-unavailable")).toBe(
        true,
      ),
    );
    expect(store.states.get(ENROLLMENT_ID)).toMatchObject({
      queue: [],
      repair: null,
      completions: [{ wakeId: signal.wakeId, providerReceiptId: "durable-before-error" }],
    });
    expect(harness.scheduler.pending).toHaveLength(1);

    harness.scheduler.advance(100);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));
    harness.source.sessions[1]!.emit(checkpoint("11"));
    await eventually(() => expect(harness.source.sessions[1]?.acknowledgements).toEqual(["11"]));

    expect(store.states.get(ENROLLMENT_ID)?.repair).toBeNull();
    expect(harness.targetCalls).toHaveLength(1);
    expect(harness.scheduler.pending).toEqual([]);
  });

  it("replays a missed delivery kick when reconciliation beats a slow source stop", async () => {
    const store = new MemoryWakeStore();
    const first = deferred<AgentWakeTargetResult>();
    const slowStop = deferred<void>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ status: "accepted", providerReceiptId: "second-receipt" });
    const harness = createHarness({ store, target });
    const firstSession = await start(harness);
    firstSession.stopBarrier = slowStop.promise;
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);
    firstSession.emit(one);
    firstSession.emit(two);
    await eventually(() => expect(firstSession.acknowledgements).toEqual(["11", "12"]));
    expect(target).toHaveBeenCalledOnce();

    store.failAfterCommitTransactions = 1;
    first.resolve({ status: "accepted", providerReceiptId: "first-receipt" });
    await eventually(() => expect(harness.scheduler.pending).toHaveLength(1));
    expect(store.states.get(ENROLLMENT_ID)).toMatchObject({
      queue: [{ wake: { wakeId: two.wakeId }, phase: "queued" }],
      completions: [{ wakeId: one.wakeId }],
    });

    harness.scheduler.advance(100);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));
    const reopened = harness.source.sessions[1]!;
    reopened.emit(checkpoint("12"));
    await eventually(() => expect(reopened.acknowledgements).toEqual(["12"]));
    expect(target).toHaveBeenCalledOnce();

    slowStop.resolve(undefined);
    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    expect(target.mock.calls.map(([call]) => call.wake.wakeId)).toEqual([one.wakeId, two.wakeId]);
    await eventually(() => expect(store.states.get(ENROLLMENT_ID)?.queue).toEqual([]));
  });

  it("reopens from the durable cursor after post-commit failure at capacity", async () => {
    const store = new MemoryWakeStore();
    const first = deferred<AgentWakeTargetResult>();
    const target = vi
      .fn<(call: TargetCall) => Promise<AgentWakeTargetResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ status: "accepted", providerReceiptId: "second-receipt" });
    const harness = createHarness({ store, target, maxQueueDepth: 1 });
    const firstSession = await start(harness);
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);
    firstSession.emit(one);
    firstSession.emit(two);
    await eventually(() =>
      expect(store.states.get(ENROLLMENT_ID)?.runState).toBe("paused-capacity"),
    );

    store.failAfterCommitTransactions = 1;
    first.resolve({ status: "accepted", providerReceiptId: "first-receipt" });
    await eventually(() => expect(harness.scheduler.pending).toHaveLength(1));
    expect(firstSession.acknowledgements).toEqual(["11"]);
    expect(store.states.get(ENROLLMENT_ID)).toMatchObject({
      cursor: "11",
      queue: [],
      completions: [{ wakeId: one.wakeId }],
    });

    harness.scheduler.advance(100);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));
    const replaySession = harness.source.sessions[1]!;
    replaySession.emit(two);

    await eventually(() => expect(target).toHaveBeenCalledTimes(2));
    await eventually(() => expect(replaySession.acknowledgements).toEqual(["12"]));
    expect(target.mock.calls.map(([call]) => call.wake.wakeId)).toEqual([one.wakeId, two.wakeId]);
    expect(store.states.get(ENROLLMENT_ID)?.repair).toBeNull();
  });

  it("resumes a crash-restored queued wake and a due retry-wait wake", async () => {
    const harness = createHarness();
    await enroll(harness);
    const one = makeSignal("11", 0);
    const two = makeSignal("12", 1);
    const enrolled = harness.store.states.get(ENROLLMENT_ID);
    if (enrolled === undefined) throw new Error("Expected enrollment");
    harness.store.seed({
      ...enrolled,
      cursor: "12",
      queue: [
        {
          wake: one,
          sourceCursor: "11",
          enqueuedAt: START_TIME,
          phase: "queued",
          attempts: 0,
          nextAttemptAt: null,
          lastRetryCode: null,
        },
        {
          wake: two,
          sourceCursor: "12",
          enqueuedAt: START_TIME,
          phase: "retry-wait",
          attempts: 1,
          nextAttemptAt: START_TIME,
          lastRetryCode: "provider-unavailable",
        },
      ],
    });

    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(harness.source.sessions).toHaveLength(1));
    harness.source.sessions[0]!.emit(checkpoint("12"));
    await eventually(() => expect(harness.targetCalls).toHaveLength(2));
    expect(harness.targetCalls.map((call) => [call.wake.wakeId, call.attempt])).toEqual([
      [one.wakeId, 1],
      [two.wakeId, 2],
    ]);
  });

  it("stopping an in-flight delivery aborts it and records ambiguous repair", async () => {
    const pending = deferred<AgentWakeTargetResult>();
    const harness = createHarness({ target: () => pending.promise });
    const session = await start(harness);
    session.emit(makeSignal("11"));
    await eventually(() => expect(harness.targetCalls).toHaveLength(1));

    let stopSettled = false;
    const stopping = harness.broker.stop(ENROLLMENT_ID);
    void stopping.then(
      () => (stopSettled = true),
      () => (stopSettled = true),
    );
    await eventually(() => expect(harness.targetCalls[0]?.signal.aborted).toBe(true));
    expect(stopSettled).toBe(false);
    pending.reject(new Error("target closed after abort"));
    const stopped = await stopping;

    expect(stopped).toMatchObject({
      phase: "blocked-repair",
      repair: { code: "provider-outcome-ambiguous" },
    });
    expect(harness.targetCalls[0]?.signal.aborted).toBe(true);
    expect(session.stopped).toBe(true);
  });

  it("retires a claimed delivery before stop can let it invoke the provider", async () => {
    const harness = createHarness();
    const session = await start(harness);
    let stopping: Promise<AgentWakeBrokerStatus> | null = null;
    harness.store.onCommit = (state) => {
      if (stopping === null && state.queue[0]?.phase === "delivering") {
        stopping = harness.broker.stop(ENROLLMENT_ID);
      }
    };

    session.emit(makeSignal("11"));
    await eventually(() => expect(stopping).not.toBeNull());
    const stopped = await stopping;

    expect(harness.targetCalls).toEqual([]);
    expect(stopped).toMatchObject({
      phase: "stopped",
      repair: null,
      queueDepth: 1,
    });
    expect(harness.store.states.get(ENROLLMENT_ID)?.queue[0]?.phase).toBe("queued");
  });
});

describe("AgentWakeBroker lifecycle and data minimization", () => {
  it("exposes no credential handle, target handle, message body, or caught error text", async () => {
    const harness = createHarness({
      target: async () => {
        throw new Error("secret-provider-token-and-body");
      },
    });
    const session = await start(harness);
    session.emit(makeSignal("11"));
    await eventually(() => expect(harness.store.states.get(ENROLLMENT_ID)?.repair).not.toBeNull());

    const publicJson = JSON.stringify(await harness.broker.status(ENROLLMENT_ID));
    const noticeJson = JSON.stringify(harness.notices);
    expect(publicJson).not.toContain(CREDENTIAL_HANDLE);
    expect(publicJson).not.toContain(TARGET_HANDLE);
    expect(publicJson).not.toContain("secret-provider-token-and-body");
    expect(noticeJson).not.toContain("secret-provider-token-and-body");
    expect(harness.targetCalls[0]?.wake).not.toHaveProperty("body");
  });

  it("dispose stops every active source and rejects new enrollment", async () => {
    const harness = createHarness();
    const session = await start(harness);

    await harness.broker.dispose();

    expect(session.stopped).toBe(true);
    expect(await harness.broker.status(ENROLLMENT_ID)).toMatchObject({ phase: "stopped" });
    await expect(
      harness.broker.enrollNow({
        enrollmentId: "another",
        expectedAgentUserId: AGENT_ID,
        credentialHandle: CREDENTIAL_HANDLE,
        provider: { adapterId: "agent-runtime-test", targetHandle: TARGET_HANDLE },
      }),
    ).rejects.toEqual(new AgentWakeBrokerError("broker-disposed"));
  });

  it("aborts and joins a source task while opening its CLI session", async () => {
    const source = new PendingOpenSource();
    const harness = createHarness({ source });
    await enroll(harness);
    await harness.broker.start(ENROLLMENT_ID);
    await eventually(() => expect(source.opens).toHaveLength(1));

    let disposeSettled = false;
    const disposing = harness.broker.dispose();
    void disposing.then(
      () => (disposeSettled = true),
      () => (disposeSettled = true),
    );
    const session = new ManualSourceSession();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(source.openSignal?.aborted).toBe(true);
      expect(disposeSettled).toBe(false);
    } finally {
      source.opening.resolve(session);
      await disposing.catch(() => undefined);
      await eventually(() => expect(session.stopped).toBe(true));
    }
  });

  it("waits for every enrollment teardown before surfacing a durable stop failure", async () => {
    const harness = createHarness();
    await start(harness);
    const secondEnrollmentId = "grok-bot-pilot-secondary";
    await harness.broker.enrollNow({
      enrollmentId: secondEnrollmentId,
      expectedAgentUserId: AGENT_ID,
      credentialHandle: CREDENTIAL_HANDLE,
      provider: { adapterId: "agent-runtime-test", targetHandle: TARGET_HANDLE },
    });
    await harness.broker.start(secondEnrollmentId);
    await eventually(() => expect(harness.source.sessions).toHaveLength(2));

    const releaseSecondStop = deferred<void>();
    harness.source.sessions[1]!.stopBarrier = releaseSecondStop.promise;
    harness.store.failTransactions = 1;
    let disposeSettled = false;
    const disposing = harness.broker.dispose();
    void disposing.then(
      () => (disposeSettled = true),
      () => (disposeSettled = true),
    );
    try {
      await eventually(() => expect(harness.source.sessions[1]?.stopped).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposeSettled).toBe(false);
    } finally {
      releaseSecondStop.resolve();
      await expect(disposing).rejects.toMatchObject({ code: "durable-store-failed" });
      await eventually(() =>
        expect(harness.store.states.get(secondEnrollmentId)?.runState).toBe("stopped"),
      );
    }
  });

  it("dispose retires source and provider children when its durable stop commit fails", async () => {
    const delivery = deferred<AgentWakeTargetResult>();
    const harness = createHarness({ target: () => delivery.promise });
    const session = await start(harness);
    session.emit(makeSignal("11"));
    await eventually(() => expect(harness.targetCalls).toHaveLength(1));
    harness.store.failTransactions = 1;

    let disposeSettled = false;
    const disposing = harness.broker.dispose();
    void disposing.then(
      () => (disposeSettled = true),
      () => (disposeSettled = true),
    );
    await eventually(() => expect(harness.targetCalls[0]?.signal.aborted).toBe(true));
    expect(disposeSettled).toBe(false);
    delivery.reject(new Error("target closed after abort"));

    await expect(disposing).rejects.toMatchObject({
      code: "durable-store-failed",
    });

    expect(session.stopped).toBe(true);
    expect(harness.targetCalls[0]?.signal.aborted).toBe(true);
  });
});
