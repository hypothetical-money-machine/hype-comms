import {
  agentWakeStreamRecordSchema,
  type AgentWakeSignal,
  type AgentWakeStreamRecord,
} from "@hype-comms/contracts";
import { deriveAgentWakeId } from "@hype-comms/contracts/wake-node";
import {
  agentWakeBackoffDelay,
  agentWakePositiveInteger,
  isAgentWakeOpaqueHandle,
  isAgentWakeSha256Digest,
} from "./agent-wake-validation";

const DEFAULT_MAX_QUEUE_DEPTH = 100;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 1_000;
const DEFAULT_PROVIDER_RETRY_MAX_MS = 60_000;
const DEFAULT_SOURCE_RETRY_BASE_MS = 1_000;
const DEFAULT_SOURCE_RETRY_MAX_MS = 30_000;
const DEFAULT_MAX_PROVIDER_ATTEMPTS = 8;
const DEFAULT_MAX_COMPLETION_RECORDS = 2_048;

export type AgentWakeCompletionDisposition = "accepted" | "duplicate" | "coalesced";

export type AgentWakeProviderRetryCode =
  "provider-overloaded" | "provider-rate-limited" | "provider-unavailable";

export type AgentWakeSourceRetryCode = "source-unavailable";

export type AgentWakeRepairCode =
  | "provider-authentication-required"
  | "provider-contract-invalid"
  | "provider-outcome-ambiguous"
  | "provider-rejected"
  | "provider-retry-exhausted"
  | "source-authentication-required"
  | "source-client-replay-overflow"
  | "source-cursor-expired"
  | "source-record-invalid"
  | "source-scope-invalid"
  | "source-server-reset";

export type AgentWakeProviderRepairCode = Extract<AgentWakeRepairCode, `provider-${string}`>;
export type AgentWakeSourceRepairCode = Extract<AgentWakeRepairCode, `source-${string}`>;

export type AgentWakeNoticeCode =
  | AgentWakeProviderRetryCode
  | AgentWakeSourceRetryCode
  | AgentWakeRepairCode
  | "durable-store-unavailable"
  | "source-stop-failed";

export interface AgentWakeIdentity {
  readonly apiOrigin: string;
  readonly workspaceId: string;
  readonly agentUserId: string;
}

export interface AgentWakeProviderBinding {
  readonly adapterId: string;
  /** Opaque lookup handle. It must not contain a provider credential. */
  readonly targetHandle: string;
}

export interface AgentWakeEnrollmentRequest {
  readonly enrollmentId: string;
  readonly expectedAgentUserId: string;
  /** Cancels credential verification and future-boundary capture during supervised startup. */
  readonly signal?: AbortSignal;
  /** Opaque main-process lookup handle. It must not contain the credential itself. */
  readonly credentialHandle: string;
  readonly provider: AgentWakeProviderBinding;
}

export interface AgentWakeEnrollmentAuthority {
  verify(input: {
    readonly credentialHandle: string;
    readonly expectedAgentUserId: string;
    readonly signal?: AbortSignal;
  }): Promise<AgentWakeIdentity>;
}

export interface AgentWakeSourceAccess extends AgentWakeIdentity {
  readonly credentialHandle: string;
}

export interface AgentWakeSourceSession {
  /** Returns one validated-line candidate without committing source progress. */
  next(): Promise<unknown>;
  /** Commits progress only after the broker has durably handled that record. */
  acknowledge(cursor: string): Promise<void>;
  stop(): Promise<void> | void;
}

export interface AgentWakeSource {
  /** Captures the future-only enrollment boundary before any subscription is opened. */
  captureHighWater(access: AgentWakeSourceAccess, signal?: AbortSignal): Promise<string>;
  open(input: AgentWakeSourceAccess & { readonly after: string }): Promise<AgentWakeSourceSession>;
}

export interface AgentWakeClock {
  now(): number;
}

export interface AgentWakeScheduledTask {
  cancel(): void;
}

export interface AgentWakeScheduler {
  schedule(delayMs: number, task: () => void): AgentWakeScheduledTask;
}

export type AgentWakeTargetResult =
  /** Terminal outcomes require a non-secret receipt that can be used for reconciliation. */
  | { readonly status: "accepted"; readonly providerReceiptId: string }
  | { readonly status: "duplicate"; readonly providerReceiptId: string }
  | { readonly status: "coalesced"; readonly providerReceiptId: string }
  | {
      readonly status: "retry";
      readonly code: AgentWakeProviderRetryCode;
      readonly retryAfterMs?: number;
    }
  | {
      readonly status: "blocked";
      readonly code:
        "provider-authentication-required" | "provider-contract-invalid" | "provider-rejected";
    };

export interface AgentWakeTarget {
  /**
   * `retry` is valid only when the adapter knows the provider did not accept the wake. If
   * acceptance is unknown, the adapter must throw so the broker enters explicit repair.
   */
  accept(input: {
    readonly provider: AgentWakeProviderBinding;
    readonly wake: AgentWakeSignal;
    readonly attempt: number;
    readonly signal: AbortSignal;
  }): Promise<AgentWakeTargetResult>;
}

export interface AgentWakeStoreMutation<T> {
  /** The store must durably commit this value before resolving `transaction`. */
  readonly state: StoredAgentWakeEnrollment | null;
  readonly result: T;
}

export interface AgentWakeInboxStore {
  read(enrollmentId: string): Promise<StoredAgentWakeEnrollment | null>;
  /** The callback must run exclusively for this enrollment. */
  transaction<T>(
    enrollmentId: string,
    mutate: (current: StoredAgentWakeEnrollment | null) => AgentWakeStoreMutation<T>,
  ): Promise<T>;
}

export interface StoredAgentWakeItem {
  readonly wake: AgentWakeSignal;
  readonly sourceCursor: string;
  /** Local durable-enqueue timestamp used only for body-free rollout evidence. */
  readonly enqueuedAt: number;
  readonly phase: "queued" | "delivering" | "retry-wait" | "blocked";
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastRetryCode: AgentWakeProviderRetryCode | null;
}

export interface StoredAgentWakeCompletion {
  readonly wakeId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly reason: AgentWakeSignal["reason"];
  readonly occurredAt: string;
  readonly sourceCursor: string;
  readonly attempt: number;
  readonly brokerDurableAt: number;
  readonly disposition: AgentWakeCompletionDisposition;
  readonly providerReceiptId: string;
  readonly completedAt: number;
}

export type AgentWakeOperatorActionCode =
  | "confirm-accepted"
  | "confirm-coalesced"
  | "confirm-duplicate"
  | "provider-retry"
  | "resume"
  | "source-reset-from-now";

export interface StoredAgentWakeOperatorAction {
  readonly actionId: string;
  readonly action: AgentWakeOperatorActionCode;
  readonly repairCode: AgentWakeRepairCode | null;
  readonly repairOccurredAt: number | null;
  readonly wakeId: string | null;
  /** Non-secret ticket, provider activity, or change-record reference supplied by the operator. */
  readonly evidenceReference: string;
  readonly occurredAt: number;
}

export interface StoredAgentWakeRepair {
  readonly code: AgentWakeRepairCode;
  readonly wakeId: string | null;
  readonly occurredAt: number;
  /** Preserves an independently actionable source failure while provider receipt is reconciled. */
  readonly deferredSourceRepair: {
    readonly code: AgentWakeSourceRepairCode;
    readonly wakeId: string | null;
    readonly occurredAt: number;
  } | null;
}

export interface StoredAgentWakeSourceRetry {
  readonly code: AgentWakeSourceRetryCode;
  readonly attempt: number;
  readonly nextAttemptAt: number;
}

export interface StoredAgentWakeEnrollment {
  readonly version: 1;
  readonly revision: number;
  readonly enrollmentId: string;
  readonly identity: AgentWakeIdentity;
  readonly credentialHandle: string;
  readonly provider: AgentWakeProviderBinding;
  readonly cursor: string;
  readonly runState: "stopped" | "running" | "paused-capacity";
  readonly queue: readonly StoredAgentWakeItem[];
  readonly completions: readonly StoredAgentWakeCompletion[];
  readonly operatorActions: readonly StoredAgentWakeOperatorAction[];
  readonly repair: StoredAgentWakeRepair | null;
  readonly sourceRetry: StoredAgentWakeSourceRetry | null;
}

export type AgentWakeBrokerPhase =
  "stopped" | "running" | "paused-capacity" | "retry-wait" | "blocked-repair";

/** Safe for UI projection and structured logs: it contains neither handles nor message bodies. */
export interface AgentWakeBrokerStatus {
  readonly enrollmentId: string;
  readonly workspaceId: string;
  readonly agentUserId: string;
  readonly adapterId: string;
  readonly cursor: string;
  readonly phase: AgentWakeBrokerPhase;
  readonly queueDepth: number;
  readonly activeWakeId: string | null;
  readonly retry: {
    readonly code: AgentWakeProviderRetryCode | AgentWakeSourceRetryCode;
    readonly attempt: number;
    readonly nextAttemptAt: number;
  } | null;
  readonly repair: StoredAgentWakeRepair | null;
  readonly lastCompletion: StoredAgentWakeCompletion | null;
}

/** Body-free durable evidence available to the privileged local operator surface. */
export interface AgentWakeBrokerEvidence {
  readonly version: 1;
  readonly type: "agent.wake.broker_evidence";
  readonly enrollmentId: string;
  readonly workspaceId: string;
  readonly agentUserId: string;
  readonly adapterId: string;
  readonly cursor: string;
  readonly completions: readonly StoredAgentWakeCompletion[];
  readonly operatorActions: readonly StoredAgentWakeOperatorAction[];
}

export interface AgentWakeNotice {
  readonly enrollmentId: string;
  readonly code: AgentWakeNoticeCode;
  readonly wakeId: string | null;
  readonly occurredAt: number;
}

export type AgentWakeBrokerErrorCode =
  | "broker-disposed"
  | "durable-store-failed"
  | "enrollment-already-exists"
  | "enrollment-high-water-failed"
  | "enrollment-identity-mismatch"
  | "enrollment-invalid"
  | "enrollment-not-found"
  | "enrollment-verification-failed"
  | "repair-action-invalid"
  | "repair-not-required";

/** Deliberately contains only a stable machine code, never a caught error or credential. */
export class AgentWakeBrokerError extends Error {
  constructor(
    readonly code: AgentWakeBrokerErrorCode,
    readonly retryable = false,
  ) {
    super(`Agent wake broker failed: ${code}`);
    this.name = "AgentWakeBrokerError";
  }
}

export class AgentWakeSourceFailure extends Error {
  constructor(
    readonly code:
      | AgentWakeSourceRetryCode
      | "source-authentication-required"
      | "source-client-replay-overflow"
      | "source-cursor-expired"
      | "source-record-invalid"
      | "source-scope-invalid"
      | "source-server-reset",
    readonly retryable: boolean,
  ) {
    super(`Agent wake source failed: ${code}`);
    this.name = "AgentWakeSourceFailure";
  }
}

interface Runtime {
  readonly enrollmentId: string;
  readonly epoch: number;
  active: boolean;
  sourceBusy: boolean;
  sourceQuiescing: boolean;
  sourceReady: boolean;
  deliveryBusy: boolean;
  deliveryKickPending: boolean;
  deliveryTask: Promise<void> | null;
  sourceSession: AgentWakeSourceSession | null;
  sourceAbort: AbortController | null;
  sourceTimer: AgentWakeScheduledTask | null;
  deliveryTimer: AgentWakeScheduledTask | null;
  providerAbort: AbortController | null;
  pendingProviderAmbiguity: {
    readonly item: StoredAgentWakeItem;
    attempt: number;
  } | null;
  capacityWaiter: { readonly promise: Promise<void>; readonly resolve: () => void } | null;
}

export interface AgentWakeBrokerOptions {
  readonly authority: AgentWakeEnrollmentAuthority;
  readonly source: AgentWakeSource;
  readonly store: AgentWakeInboxStore;
  readonly clock: AgentWakeClock;
  readonly scheduler: AgentWakeScheduler;
  readonly target: AgentWakeTarget;
  readonly maxQueueDepth?: number;
  readonly maxCompletionRecords?: number;
  readonly maxProviderAttempts?: number;
  readonly providerRetryBaseMs?: number;
  readonly providerRetryMaxMs?: number;
  readonly sourceRetryBaseMs?: number;
  readonly sourceRetryMaxMs?: number;
  readonly onNotice?: (notice: AgentWakeNotice) => void;
}

function isRetryableFailure(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}

function validCursor(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value);
}

function newerCursor(candidate: string, current: string): boolean {
  return BigInt(candidate) > BigInt(current);
}

function nextRevision(state: StoredAgentWakeEnrollment): number {
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    throw new AgentWakeBrokerError("durable-store-failed");
  }
  return state.revision + 1;
}

function sourceRepairCode(
  record: Extract<AgentWakeStreamRecord, { type: "agent.wake.repair_required" }>,
): AgentWakeSourceRepairCode {
  switch (record.reason) {
    case "client_replay_overflow":
      return "source-client-replay-overflow";
    case "cursor_expired":
      return "source-cursor-expired";
    case "server_reset":
      return "source-server-reset";
  }
}

function isSourceRepairCode(code: AgentWakeRepairCode): code is AgentWakeSourceRepairCode {
  return code.startsWith("source-");
}

function repairAfterProviderResolution(
  repair: StoredAgentWakeRepair,
): StoredAgentWakeRepair | null {
  const deferred = repair.deferredSourceRepair;
  return deferred === null ? null : { ...deferred, deferredSourceRepair: null };
}

function completionStatus(
  state: StoredAgentWakeEnrollment,
): AgentWakeBrokerStatus["lastCompletion"] {
  return state.completions.at(-1) ?? null;
}

function projectStatus(state: StoredAgentWakeEnrollment): AgentWakeBrokerStatus {
  const head = state.queue[0];
  const phase: AgentWakeBrokerPhase =
    state.repair !== null
      ? "blocked-repair"
      : state.runState === "stopped"
        ? "stopped"
        : state.runState === "paused-capacity"
          ? "paused-capacity"
          : state.sourceRetry !== null || head?.phase === "retry-wait"
            ? "retry-wait"
            : "running";
  const retry =
    state.sourceRetry !== null
      ? state.sourceRetry
      : head?.phase === "retry-wait" && head.lastRetryCode !== null && head.nextAttemptAt !== null
        ? {
            code: head.lastRetryCode,
            attempt: head.attempts,
            nextAttemptAt: head.nextAttemptAt,
          }
        : null;
  return {
    enrollmentId: state.enrollmentId,
    workspaceId: state.identity.workspaceId,
    agentUserId: state.identity.agentUserId,
    adapterId: state.provider.adapterId,
    cursor: state.cursor,
    phase,
    queueDepth: state.queue.length,
    activeWakeId: head?.wake.wakeId ?? null,
    retry,
    repair: state.repair,
    lastCompletion: completionStatus(state),
  };
}

function createWaiter(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

/**
 * Durable, body-free wake orchestration for one Electron main process.
 *
 * The injected store is the commit boundary. A source record is acknowledged only after the same
 * transaction has either advanced a suppressed checkpoint or enqueued its wake. Provider delivery
 * is marked `delivering` before invocation; finding that phase after a crash is intentionally
 * treated as ambiguous and requires explicit repair.
 */
export class AgentWakeBroker {
  readonly #authority: AgentWakeEnrollmentAuthority;
  readonly #source: AgentWakeSource;
  readonly #store: AgentWakeInboxStore;
  readonly #clock: AgentWakeClock;
  readonly #scheduler: AgentWakeScheduler;
  readonly #target: AgentWakeTarget;
  readonly #maxQueueDepth: number;
  readonly #maxCompletionRecords: number;
  readonly #maxProviderAttempts: number;
  readonly #providerRetryBaseMs: number;
  readonly #providerRetryMaxMs: number;
  readonly #sourceRetryBaseMs: number;
  readonly #sourceRetryMaxMs: number;
  readonly #onNotice: (notice: AgentWakeNotice) => void;
  readonly #runtimes = new Map<string, Runtime>();
  readonly #controlTails = new Map<string, Promise<void>>();
  #nextEpoch = 0;
  #disposed = false;

  constructor(options: AgentWakeBrokerOptions) {
    this.#authority = options.authority;
    this.#source = options.source;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#scheduler = options.scheduler;
    this.#target = options.target;
    this.#maxQueueDepth = agentWakePositiveInteger(options.maxQueueDepth, DEFAULT_MAX_QUEUE_DEPTH);
    this.#maxCompletionRecords = agentWakePositiveInteger(
      options.maxCompletionRecords,
      DEFAULT_MAX_COMPLETION_RECORDS,
    );
    this.#maxProviderAttempts = agentWakePositiveInteger(
      options.maxProviderAttempts,
      DEFAULT_MAX_PROVIDER_ATTEMPTS,
    );
    this.#providerRetryBaseMs = agentWakePositiveInteger(
      options.providerRetryBaseMs,
      DEFAULT_PROVIDER_RETRY_BASE_MS,
    );
    this.#providerRetryMaxMs = agentWakePositiveInteger(
      options.providerRetryMaxMs,
      DEFAULT_PROVIDER_RETRY_MAX_MS,
    );
    this.#sourceRetryBaseMs = agentWakePositiveInteger(
      options.sourceRetryBaseMs,
      DEFAULT_SOURCE_RETRY_BASE_MS,
    );
    this.#sourceRetryMaxMs = agentWakePositiveInteger(
      options.sourceRetryMaxMs,
      DEFAULT_SOURCE_RETRY_MAX_MS,
    );
    this.#onNotice = options.onNotice ?? (() => undefined);
  }

  async enrollNow(request: AgentWakeEnrollmentRequest): Promise<AgentWakeBrokerStatus> {
    this.#assertActive();
    if (
      !isAgentWakeOpaqueHandle(request.enrollmentId) ||
      !isAgentWakeOpaqueHandle(request.expectedAgentUserId) ||
      !isAgentWakeOpaqueHandle(request.credentialHandle) ||
      !isAgentWakeOpaqueHandle(request.provider.adapterId) ||
      !isAgentWakeOpaqueHandle(request.provider.targetHandle)
    ) {
      throw new AgentWakeBrokerError("enrollment-invalid");
    }

    return this.#withControl(request.enrollmentId, async () => {
      let identity: AgentWakeIdentity;
      try {
        identity = await this.#authority.verify({
          credentialHandle: request.credentialHandle,
          expectedAgentUserId: request.expectedAgentUserId,
          signal: request.signal,
        });
      } catch (error) {
        throw new AgentWakeBrokerError("enrollment-verification-failed", isRetryableFailure(error));
      }
      if (identity.agentUserId !== request.expectedAgentUserId) {
        throw new AgentWakeBrokerError("enrollment-identity-mismatch");
      }

      let cursor: string;
      try {
        cursor = await this.#source.captureHighWater(
          {
            ...identity,
            credentialHandle: request.credentialHandle,
          },
          request.signal,
        );
      } catch (error) {
        throw new AgentWakeBrokerError("enrollment-high-water-failed", isRetryableFailure(error));
      }
      if (!validCursor(cursor)) throw new AgentWakeBrokerError("enrollment-high-water-failed");

      const state: StoredAgentWakeEnrollment = {
        version: 1,
        revision: 1,
        enrollmentId: request.enrollmentId,
        identity,
        credentialHandle: request.credentialHandle,
        provider: request.provider,
        cursor,
        runState: "stopped",
        queue: [],
        completions: [],
        operatorActions: [],
        repair: null,
        sourceRetry: null,
      };
      try {
        return await this.#store.transaction(request.enrollmentId, (current) => {
          if (current !== null) throw new AgentWakeBrokerError("enrollment-already-exists");
          return { state, result: projectStatus(state) };
        });
      } catch (error) {
        if (error instanceof AgentWakeBrokerError) throw error;
        throw new AgentWakeBrokerError("durable-store-failed", isRetryableFailure(error));
      }
    });
  }

  async start(enrollmentId: string): Promise<AgentWakeBrokerStatus> {
    this.#assertActive();
    return this.#withControl(enrollmentId, async () => {
      const existing = this.#runtimes.get(enrollmentId);
      if (existing?.active === true) {
        await this.#restartSourceAuthorization(existing);
        return this.#statusRequired(enrollmentId);
      }

      let recoveredAmbiguity = false;
      const state = await this.#transactRequired(enrollmentId, (current) => {
        if (current.repair !== null) return current;
        const delivering = current.queue.find((item) => item.phase === "delivering");
        if (delivering !== undefined) {
          recoveredAmbiguity = true;
          return {
            ...current,
            revision: nextRevision(current),
            runState: "stopped",
            queue: current.queue.map((item) =>
              item.wake.wakeId === delivering.wake.wakeId
                ? { ...item, phase: "blocked" as const }
                : item,
            ),
            repair: {
              code: "provider-outcome-ambiguous",
              wakeId: delivering.wake.wakeId,
              occurredAt: this.#clock.now(),
              deferredSourceRepair: null,
            },
          };
        }
        return {
          ...current,
          revision: nextRevision(current),
          runState: "running",
        };
      });
      if (recoveredAmbiguity) {
        this.#notice(enrollmentId, "provider-outcome-ambiguous", state.repair?.wakeId ?? null);
      }
      if (state.repair !== null) return projectStatus(state);

      const runtime: Runtime = {
        enrollmentId,
        epoch: ++this.#nextEpoch,
        active: true,
        sourceBusy: false,
        sourceQuiescing: false,
        sourceReady: false,
        deliveryBusy: false,
        deliveryKickPending: false,
        deliveryTask: null,
        sourceSession: null,
        sourceAbort: null,
        sourceTimer: null,
        deliveryTimer: null,
        providerAbort: null,
        pendingProviderAmbiguity: null,
        capacityWaiter: null,
      };
      this.#runtimes.set(enrollmentId, runtime);
      this.#kickSource(runtime);
      return projectStatus(state);
    });
  }

  async stop(enrollmentId: string): Promise<AgentWakeBrokerStatus> {
    return this.#withControl(enrollmentId, () => this.#stopInternal(enrollmentId));
  }

  async status(enrollmentId: string): Promise<AgentWakeBrokerStatus | null> {
    let state: StoredAgentWakeEnrollment | null;
    try {
      state = await this.#store.read(enrollmentId);
    } catch (error) {
      throw new AgentWakeBrokerError("durable-store-failed", isRetryableFailure(error));
    }
    return state === null ? null : projectStatus(state);
  }

  async evidence(enrollmentId: string): Promise<AgentWakeBrokerEvidence | null> {
    let state: StoredAgentWakeEnrollment | null;
    try {
      state = await this.#store.read(enrollmentId);
    } catch (error) {
      throw new AgentWakeBrokerError("durable-store-failed", isRetryableFailure(error));
    }
    if (state === null) return null;
    return {
      version: 1,
      type: "agent.wake.broker_evidence",
      enrollmentId: state.enrollmentId,
      workspaceId: state.identity.workspaceId,
      agentUserId: state.identity.agentUserId,
      adapterId: state.provider.adapterId,
      cursor: state.cursor,
      completions: state.completions,
      operatorActions: state.operatorActions,
    };
  }

  /** Records an explicit operator resume and starts only a repair-free durable enrollment. */
  async resume(input: {
    readonly enrollmentId: string;
    readonly actionId: string;
    readonly evidenceReference: string;
  }): Promise<AgentWakeBrokerStatus> {
    this.#assertActive();
    if (
      !isAgentWakeSha256Digest(input.actionId) ||
      !isAgentWakeOpaqueHandle(input.evidenceReference)
    ) {
      throw new AgentWakeBrokerError("repair-action-invalid");
    }
    await this.#withControl(input.enrollmentId, async () => {
      await this.#transactRequired(input.enrollmentId, (current) => {
        const existingAction = current.operatorActions.find(
          (action) => action.actionId === input.actionId,
        );
        if (existingAction !== undefined) {
          if (
            existingAction.action !== "resume" ||
            existingAction.repairCode !== null ||
            existingAction.repairOccurredAt !== null ||
            existingAction.wakeId !== null ||
            existingAction.evidenceReference !== input.evidenceReference
          ) {
            throw new AgentWakeBrokerError("repair-action-invalid");
          }
          return current;
        }
        if (current.repair !== null) throw new AgentWakeBrokerError("repair-action-invalid");
        const occurredAt = this.#clock.now();
        const action: StoredAgentWakeOperatorAction = {
          actionId: input.actionId,
          action: "resume",
          repairCode: null,
          repairOccurredAt: null,
          wakeId: null,
          evidenceReference: input.evidenceReference,
          occurredAt,
        };
        return {
          ...current,
          revision: nextRevision(current),
          operatorActions: [...current.operatorActions, action].slice(-this.#maxCompletionRecords),
        };
      });
    });
    return this.start(input.enrollmentId);
  }

  /** Explicit operator decision after an outcome that could not safely be retried. */
  async resolveProviderRepair(
    input:
      | {
          readonly enrollmentId: string;
          readonly action: "retry";
          readonly actionId: string;
          readonly evidenceReference: string;
          readonly expectedRepairCode: AgentWakeProviderRepairCode;
          readonly expectedRepairOccurredAt: number;
          readonly expectedWakeId: string;
        }
      | {
          readonly enrollmentId: string;
          readonly action: "confirm-accepted" | "confirm-duplicate" | "confirm-coalesced";
          readonly actionId: string;
          readonly providerReceiptId: string;
          readonly evidenceReference: string;
          readonly expectedRepairCode: AgentWakeProviderRepairCode;
          readonly expectedRepairOccurredAt: number;
          readonly expectedWakeId: string;
        },
  ): Promise<AgentWakeBrokerStatus> {
    this.#assertActive();
    if (
      !isAgentWakeSha256Digest(input.actionId) ||
      !isAgentWakeOpaqueHandle(input.evidenceReference) ||
      !isAgentWakeSha256Digest(input.expectedWakeId) ||
      !input.expectedRepairCode.startsWith("provider-") ||
      !Number.isSafeInteger(input.expectedRepairOccurredAt) ||
      input.expectedRepairOccurredAt < 0
    ) {
      throw new AgentWakeBrokerError("repair-action-invalid");
    }
    return this.#withControl(input.enrollmentId, async () => {
      const state = await this.#transactRequired(input.enrollmentId, (current) => {
        const expectedAction = input.action === "retry" ? "provider-retry" : input.action;
        const existingAction = current.operatorActions.find(
          (action) => action.actionId === input.actionId,
        );
        if (existingAction !== undefined) {
          if (
            existingAction.action !== expectedAction ||
            existingAction.evidenceReference !== input.evidenceReference ||
            existingAction.repairCode !== input.expectedRepairCode ||
            existingAction.repairOccurredAt !== input.expectedRepairOccurredAt ||
            existingAction.wakeId !== input.expectedWakeId
          ) {
            throw new AgentWakeBrokerError("repair-action-invalid");
          }
          if (input.action !== "retry") {
            const disposition = input.action.replace(
              "confirm-",
              "",
            ) as AgentWakeCompletionDisposition;
            const completion = current.completions.find(
              (candidate) => candidate.wakeId === input.expectedWakeId,
            );
            if (
              completion?.disposition !== disposition ||
              completion.providerReceiptId !== input.providerReceiptId
            ) {
              throw new AgentWakeBrokerError("repair-action-invalid");
            }
          }
          return current;
        }
        if (this.#runtimes.has(input.enrollmentId)) {
          throw new AgentWakeBrokerError("repair-action-invalid");
        }
        const repair = current.repair;
        const head = current.queue[0];
        if (repair === null) throw new AgentWakeBrokerError("repair-not-required");
        if (
          !repair.code.startsWith("provider-") ||
          repair.code !== input.expectedRepairCode ||
          repair.occurredAt !== input.expectedRepairOccurredAt ||
          repair.wakeId === null ||
          repair.wakeId !== input.expectedWakeId ||
          head === undefined ||
          head.wake.wakeId !== repair.wakeId ||
          head.phase !== "blocked"
        ) {
          throw new AgentWakeBrokerError("repair-action-invalid");
        }
        const occurredAt = this.#clock.now();
        const operatorAction: StoredAgentWakeOperatorAction = {
          actionId: input.actionId,
          action: input.action === "retry" ? "provider-retry" : input.action,
          repairCode: repair.code,
          repairOccurredAt: repair.occurredAt,
          wakeId: repair.wakeId,
          evidenceReference: input.evidenceReference,
          occurredAt,
        };
        if (input.action === "retry") {
          return {
            ...current,
            revision: nextRevision(current),
            queue: [{ ...head, phase: "queued", nextAttemptAt: null }, ...current.queue.slice(1)],
            operatorActions: [...current.operatorActions, operatorAction].slice(
              -this.#maxCompletionRecords,
            ),
            repair: repairAfterProviderResolution(repair),
          };
        }
        const disposition = input.action.replace("confirm-", "") as AgentWakeCompletionDisposition;
        if (!isAgentWakeOpaqueHandle(input.providerReceiptId)) {
          throw new AgentWakeBrokerError("repair-action-invalid");
        }
        const completion: StoredAgentWakeCompletion = {
          wakeId: head.wake.wakeId,
          conversationId: head.wake.conversationId,
          messageId: head.wake.messageId,
          reason: head.wake.reason,
          occurredAt: head.wake.occurredAt,
          sourceCursor: head.sourceCursor,
          attempt: head.attempts,
          brokerDurableAt: head.enqueuedAt,
          disposition,
          providerReceiptId: input.providerReceiptId,
          completedAt: occurredAt,
        };
        return {
          ...current,
          revision: nextRevision(current),
          queue: current.queue.slice(1),
          completions: [...current.completions, completion].slice(-this.#maxCompletionRecords),
          operatorActions: [...current.operatorActions, operatorAction].slice(
            -this.#maxCompletionRecords,
          ),
          repair: repairAfterProviderResolution(repair),
        };
      });
      return projectStatus(state);
    });
  }

  /** Explicitly abandons an expired source window and establishes a new future-only boundary. */
  async resetSourceFromNow(input: {
    readonly enrollmentId: string;
    readonly actionId: string;
    readonly evidenceReference: string;
    readonly expectedRepairCode: AgentWakeSourceRepairCode;
    readonly expectedRepairOccurredAt: number;
    readonly expectedWakeId: string | null;
  }): Promise<AgentWakeBrokerStatus> {
    this.#assertActive();
    const { enrollmentId } = input;
    if (
      !isAgentWakeSha256Digest(input.actionId) ||
      !isAgentWakeOpaqueHandle(input.evidenceReference) ||
      !input.expectedRepairCode.startsWith("source-") ||
      !Number.isSafeInteger(input.expectedRepairOccurredAt) ||
      input.expectedRepairOccurredAt < 0 ||
      (input.expectedWakeId !== null && !isAgentWakeSha256Digest(input.expectedWakeId))
    ) {
      throw new AgentWakeBrokerError("repair-action-invalid");
    }
    return this.#withControl(enrollmentId, async () => {
      const before = await this.#readRequired(enrollmentId);
      const existingAction = before.operatorActions.find(
        (action) => action.actionId === input.actionId,
      );
      if (existingAction !== undefined) {
        if (
          existingAction.action !== "source-reset-from-now" ||
          existingAction.evidenceReference !== input.evidenceReference ||
          existingAction.repairCode !== input.expectedRepairCode ||
          existingAction.repairOccurredAt !== input.expectedRepairOccurredAt ||
          existingAction.wakeId !== input.expectedWakeId
        ) {
          throw new AgentWakeBrokerError("repair-action-invalid");
        }
        return projectStatus(before);
      }
      if (this.#runtimes.has(enrollmentId)) {
        throw new AgentWakeBrokerError("repair-action-invalid");
      }
      if (before.repair === null) throw new AgentWakeBrokerError("repair-not-required");
      if (
        before.repair.code !== input.expectedRepairCode ||
        before.repair.occurredAt !== input.expectedRepairOccurredAt ||
        before.repair.wakeId !== input.expectedWakeId
      ) {
        throw new AgentWakeBrokerError("repair-action-invalid");
      }
      let cursor: string;
      try {
        cursor = await this.#source.captureHighWater({
          ...before.identity,
          credentialHandle: before.credentialHandle,
        });
      } catch {
        throw new AgentWakeBrokerError("enrollment-high-water-failed");
      }
      if (!validCursor(cursor)) throw new AgentWakeBrokerError("enrollment-high-water-failed");
      const state = await this.#transactRequired(enrollmentId, (current) => {
        if (
          current.repair === null ||
          current.repair.code !== input.expectedRepairCode ||
          current.repair.occurredAt !== input.expectedRepairOccurredAt ||
          current.repair.wakeId !== input.expectedWakeId
        ) {
          throw new AgentWakeBrokerError("repair-action-invalid");
        }
        const occurredAt = this.#clock.now();
        const operatorAction: StoredAgentWakeOperatorAction = {
          actionId: input.actionId,
          action: "source-reset-from-now",
          repairCode: current.repair.code,
          repairOccurredAt: current.repair.occurredAt,
          wakeId: current.repair.wakeId,
          evidenceReference: input.evidenceReference,
          occurredAt,
        };
        return {
          ...current,
          revision: nextRevision(current),
          cursor,
          runState: "stopped",
          operatorActions: [...current.operatorActions, operatorAction].slice(
            -this.#maxCompletionRecords,
          ),
          repair: null,
          sourceRetry: null,
        };
      });
      return projectStatus(state);
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const enrollmentIds = [...this.#runtimes.keys()];
    await Promise.all(
      enrollmentIds.map((id) => this.#withControl(id, () => this.#stopInternal(id))),
    );
  }

  #assertActive(): void {
    if (this.#disposed) throw new AgentWakeBrokerError("broker-disposed");
  }

  async #withControl<T>(enrollmentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#controlTails.get(enrollmentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#controlTails.set(enrollmentId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#controlTails.get(enrollmentId) === tail) this.#controlTails.delete(enrollmentId);
    }
  }

  async #readRequired(enrollmentId: string): Promise<StoredAgentWakeEnrollment> {
    let state: StoredAgentWakeEnrollment | null;
    try {
      state = await this.#store.read(enrollmentId);
    } catch {
      throw new AgentWakeBrokerError("durable-store-failed");
    }
    if (state === null) throw new AgentWakeBrokerError("enrollment-not-found");
    return state;
  }

  async #statusRequired(enrollmentId: string): Promise<AgentWakeBrokerStatus> {
    return projectStatus(await this.#readRequired(enrollmentId));
  }

  async #transactRequired(
    enrollmentId: string,
    mutate: (current: StoredAgentWakeEnrollment) => StoredAgentWakeEnrollment,
  ): Promise<StoredAgentWakeEnrollment> {
    try {
      return await this.#store.transaction(enrollmentId, (current) => {
        if (current === null) throw new AgentWakeBrokerError("enrollment-not-found");
        const state = mutate(current);
        return { state, result: state };
      });
    } catch (error) {
      if (error instanceof AgentWakeBrokerError) throw error;
      throw new AgentWakeBrokerError("durable-store-failed", isRetryableFailure(error));
    }
  }

  async #stopInternal(enrollmentId: string): Promise<AgentWakeBrokerStatus> {
    const runtime = this.#runtimes.get(enrollmentId);
    if (runtime !== undefined) {
      const deliveryTask = runtime.deliveryTask;
      await this.#retireRuntime(runtime);
      await deliveryTask;
    }
    const state = await this.#transactRequired(enrollmentId, (current) => {
      const delivering = current.queue.find((item) => item.phase === "delivering");
      if (delivering === undefined) {
        return {
          ...current,
          revision: nextRevision(current),
          runState: "stopped",
          sourceRetry: null,
        };
      }
      return {
        ...current,
        revision: nextRevision(current),
        runState: "stopped",
        sourceRetry: null,
        queue: current.queue.map((item) =>
          item.wake.wakeId === delivering.wake.wakeId
            ? { ...item, phase: "blocked" as const }
            : item,
        ),
        repair: {
          code: "provider-outcome-ambiguous",
          wakeId: delivering.wake.wakeId,
          occurredAt: this.#clock.now(),
          deferredSourceRepair: null,
        },
      };
    });
    if (state.repair?.code === "provider-outcome-ambiguous") {
      this.#notice(enrollmentId, state.repair.code, state.repair.wakeId);
    }
    return projectStatus(state);
  }

  #kickSource(runtime: Runtime): void {
    if (
      !this.#isCurrent(runtime) ||
      runtime.sourceBusy ||
      runtime.sourceQuiescing ||
      runtime.sourceTimer !== null ||
      runtime.pendingProviderAmbiguity !== null
    ) {
      return;
    }
    void this.#runSource(runtime);
  }

  async #runSource(runtime: Runtime): Promise<void> {
    if (!this.#isCurrent(runtime) || runtime.sourceBusy) return;
    runtime.sourceBusy = true;
    try {
      const initial = await this.#readRequired(runtime.enrollmentId);
      if (!this.#isRunnable(runtime, initial)) return;
      if (initial.sourceRetry !== null && initial.sourceRetry.nextAttemptAt > this.#clock.now()) {
        this.#scheduleSource(runtime, initial.sourceRetry.nextAttemptAt - this.#clock.now());
        return;
      }

      const sourceController = new AbortController();
      runtime.sourceAbort = sourceController;
      let verifiedIdentity: AgentWakeIdentity;
      try {
        verifiedIdentity = await this.#authority.verify({
          credentialHandle: initial.credentialHandle,
          expectedAgentUserId: initial.identity.agentUserId,
          signal: sourceController.signal,
        });
      } finally {
        if (runtime.sourceAbort === sourceController) runtime.sourceAbort = null;
      }
      if (!this.#isCurrent(runtime) || runtime.sourceQuiescing) return;
      if (
        verifiedIdentity.apiOrigin !== initial.identity.apiOrigin ||
        verifiedIdentity.workspaceId !== initial.identity.workspaceId ||
        verifiedIdentity.agentUserId !== initial.identity.agentUserId
      ) {
        throw new AgentWakeSourceFailure("source-scope-invalid", false);
      }

      const session = await this.#source.open({
        ...initial.identity,
        credentialHandle: initial.credentialHandle,
        after: initial.cursor,
      });
      if (!this.#isCurrent(runtime) || runtime.sourceQuiescing) {
        await this.#stopSession(runtime.enrollmentId, session);
        return;
      }
      runtime.sourceSession = session;

      let heldRecord: AgentWakeStreamRecord | null = null;
      while (
        this.#isCurrent(runtime) &&
        !runtime.sourceQuiescing &&
        runtime.pendingProviderAmbiguity === null
      ) {
        let record: AgentWakeStreamRecord | null = heldRecord;
        if (record === null) {
          const parsed = agentWakeStreamRecordSchema.safeParse(await session.next());
          if (!parsed.success) {
            await this.#enterRepair(runtime, "source-record-invalid", null);
            return;
          }
          record = parsed.data;
        }
        const outcome = await this.#ingest(runtime, record);
        if (runtime.sourceQuiescing || runtime.pendingProviderAmbiguity !== null) return;
        if (outcome === "stopped" || outcome === "repair") return;
        if (outcome === "capacity") {
          this.#markSourceReady(runtime);
          this.#kickDelivery(runtime);
          heldRecord = record;
          await this.#waitForCapacity(runtime);
          continue;
        }
        heldRecord = null;
        await session.acknowledge(outcome.cursor);
        this.#markSourceReady(runtime);
        this.#kickDelivery(runtime);
      }
    } catch (error) {
      if (this.#isCurrent(runtime)) {
        runtime.sourceReady = false;
        if (runtime.sourceQuiescing || runtime.pendingProviderAmbiguity !== null) return;
        try {
          await this.#handleSourceFailure(runtime, error);
        } catch {
          this.#notice(runtime.enrollmentId, "durable-store-unavailable", null);
          await this.#retireRuntime(runtime);
        }
      }
    } finally {
      const session = runtime.sourceSession;
      runtime.sourceSession = null;
      runtime.sourceReady = false;
      runtime.sourceBusy = false;
      runtime.sourceQuiescing = false;
      if (session !== null) await this.#stopSession(runtime.enrollmentId, session);
      if (
        this.#isCurrent(runtime) &&
        runtime.pendingProviderAmbiguity === null &&
        runtime.sourceTimer === null
      ) {
        this.#kickSource(runtime);
      }
    }
  }

  async #ingest(
    runtime: Runtime,
    record: AgentWakeStreamRecord,
  ): Promise<"capacity" | "repair" | "stopped" | { readonly cursor: string }> {
    const cursor = record.type === "agent.wake" ? record.workspaceSequence : record.cursor;
    const state = await this.#readRequired(runtime.enrollmentId);
    if (!this.#isRunnable(runtime, state)) return state.repair === null ? "stopped" : "repair";

    if (
      record.workspaceId !== state.identity.workspaceId ||
      record.agentUserId !== state.identity.agentUserId
    ) {
      await this.#enterRepair(runtime, "source-scope-invalid", null);
      return "repair";
    }
    if (record.type === "agent.wake.repair_required") {
      await this.#enterRepair(runtime, sourceRepairCode(record), null);
      return "repair";
    }
    if (!validCursor(cursor)) {
      await this.#enterRepair(runtime, "source-record-invalid", null);
      return "repair";
    }
    if (record.type === "agent.wake" && record.wakeId !== deriveAgentWakeId(record)) {
      await this.#enterRepair(runtime, "source-record-invalid", record.wakeId);
      return "repair";
    }

    const outcome = await this.#transactRequired(runtime.enrollmentId, (current) => {
      if (!this.#isRunnable(runtime, current)) return current;
      const healthySource = { ...current, sourceRetry: null };
      if (!newerCursor(cursor, current.cursor)) {
        return current.sourceRetry === null
          ? current
          : { ...healthySource, revision: nextRevision(current) };
      }
      if (record.type === "agent.wake.checkpoint") {
        return {
          ...healthySource,
          revision: nextRevision(current),
          cursor,
          runState: "running",
        };
      }
      const duplicate =
        current.queue.some((item) => item.wake.wakeId === record.wakeId) ||
        current.completions.some((item) => item.wakeId === record.wakeId);
      if (duplicate) {
        return {
          ...healthySource,
          revision: nextRevision(current),
          cursor,
          runState: "running",
        };
      }
      if (current.queue.length >= this.#maxQueueDepth) {
        return {
          ...healthySource,
          revision: nextRevision(current),
          runState: "paused-capacity",
        };
      }
      return {
        ...healthySource,
        revision: nextRevision(current),
        cursor,
        runState: "running",
        queue: [
          ...current.queue,
          {
            wake: record,
            sourceCursor: cursor,
            enqueuedAt: this.#clock.now(),
            phase: "queued",
            attempts: 0,
            nextAttemptAt: null,
            lastRetryCode: null,
          },
        ],
      };
    });
    if (!this.#isRunnable(runtime, outcome)) {
      return outcome.repair === null ? "stopped" : "repair";
    }
    if (newerCursor(cursor, outcome.cursor)) return "capacity";
    return { cursor };
  }

  async #handleSourceFailure(runtime: Runtime, error: unknown): Promise<void> {
    if (error instanceof AgentWakeSourceFailure && !error.retryable) {
      const code: AgentWakeRepairCode =
        error.code === "source-unavailable" ? "source-record-invalid" : error.code;
      await this.#enterRepair(runtime, code, null);
      return;
    }
    const code: AgentWakeSourceRetryCode = "source-unavailable";
    const state = await this.#transactRequired(runtime.enrollmentId, (current) => {
      if (!this.#isRunnable(runtime, current)) return current;
      const attempt = (current.sourceRetry?.attempt ?? 0) + 1;
      return {
        ...current,
        revision: nextRevision(current),
        sourceRetry: {
          code,
          attempt,
          nextAttemptAt:
            this.#clock.now() +
            agentWakeBackoffDelay(this.#sourceRetryBaseMs, this.#sourceRetryMaxMs, attempt),
        },
      };
    });
    if (state.sourceRetry !== null) {
      this.#notice(runtime.enrollmentId, code, null);
      this.#scheduleSource(runtime, state.sourceRetry.nextAttemptAt - this.#clock.now());
    }
  }

  #scheduleSource(runtime: Runtime, delayMs: number): void {
    if (!this.#isCurrent(runtime) || runtime.sourceTimer !== null) return;
    runtime.sourceTimer = this.#scheduler.schedule(Math.max(0, delayMs), () => {
      runtime.sourceTimer = null;
      this.#kickSource(runtime);
    });
  }

  #kickDelivery(runtime: Runtime): void {
    // `sourceReady` is an authorization-epoch gate, not merely source liveness. A persisted wake
    // may invoke its target only after this start/resume has produced an in-scope source record.
    if (
      !this.#isCurrent(runtime) ||
      !runtime.sourceReady ||
      runtime.deliveryTimer !== null ||
      runtime.pendingProviderAmbiguity !== null
    ) {
      return;
    }
    if (runtime.deliveryBusy) {
      runtime.deliveryKickPending = true;
      return;
    }
    runtime.deliveryKickPending = false;
    const task = this.#runDelivery(runtime);
    runtime.deliveryTask = task;
    void task.then(
      () => {
        if (runtime.deliveryTask === task) runtime.deliveryTask = null;
      },
      () => {
        if (runtime.deliveryTask === task) runtime.deliveryTask = null;
      },
    );
  }

  async #runDelivery(runtime: Runtime): Promise<void> {
    if (!this.#isCurrent(runtime) || !runtime.sourceReady || runtime.deliveryBusy) return;
    runtime.deliveryBusy = true;
    try {
      while (this.#isCurrent(runtime) && runtime.sourceReady && !runtime.sourceQuiescing) {
        const state = await this.#readRequired(runtime.enrollmentId);
        if (!this.#isCurrent(runtime) || !runtime.sourceReady || runtime.sourceQuiescing) return;
        if (!this.#isRunnable(runtime, state)) return;
        const head = state.queue[0];
        if (head === undefined) return;
        if (head.phase === "retry-wait") {
          const nextAttemptAt = head.nextAttemptAt;
          if (nextAttemptAt === null) {
            await this.#enterRepair(runtime, "provider-contract-invalid", head.wake.wakeId);
            return;
          }
          if (nextAttemptAt > this.#clock.now()) {
            this.#scheduleDelivery(runtime, nextAttemptAt - this.#clock.now());
            return;
          }
        }
        if (head.phase === "delivering" || head.phase === "blocked") {
          await this.#enterRepair(runtime, "provider-outcome-ambiguous", head.wake.wakeId);
          return;
        }

        const claimed = await this.#transactRequired(runtime.enrollmentId, (current) => {
          const candidate = current.queue[0];
          if (
            !this.#isRunnable(runtime, current) ||
            candidate === undefined ||
            candidate.wake.wakeId !== head.wake.wakeId ||
            (candidate.phase !== "queued" && candidate.phase !== "retry-wait")
          ) {
            return current;
          }
          return {
            ...current,
            revision: nextRevision(current),
            queue: [
              {
                ...candidate,
                phase: "delivering",
                attempts: candidate.attempts + 1,
                nextAttemptAt: null,
              },
              ...current.queue.slice(1),
            ],
          };
        });
        const item = claimed.queue[0];
        if (item === undefined || item.wake.wakeId !== head.wake.wakeId) continue;
        if (item.phase !== "delivering") return;
        if (!this.#isCurrent(runtime) || !runtime.sourceReady || runtime.sourceQuiescing) {
          await this.#restoreUninvokedClaim(runtime, item, head);
          return;
        }

        const controller = new AbortController();
        runtime.providerAbort = controller;
        let result: AgentWakeTargetResult;
        try {
          result = await this.#target.accept({
            provider: claimed.provider,
            wake: item.wake,
            attempt: item.attempts,
            signal: controller.signal,
          });
        } catch {
          if (this.#isCurrent(runtime)) {
            await this.#enterRepair(runtime, "provider-outcome-ambiguous", item.wake.wakeId);
          }
          return;
        } finally {
          if (runtime.providerAbort === controller) runtime.providerAbort = null;
        }
        if (!this.#isCurrent(runtime)) return;

        if (
          result.status === "accepted" ||
          result.status === "duplicate" ||
          result.status === "coalesced"
        ) {
          if (!isAgentWakeOpaqueHandle(result.providerReceiptId)) {
            await this.#enterRepair(runtime, "provider-contract-invalid", item.wake.wakeId);
            return;
          }
          try {
            await this.#complete(runtime, item, result.status, result.providerReceiptId);
          } catch {
            this.#notice(runtime.enrollmentId, "durable-store-unavailable", null);
            await this.#superviseProviderAmbiguity(runtime, item);
            return;
          }
          this.#signalCapacity(runtime);
          continue;
        }
        if (result.status === "retry") {
          await this.#retry(runtime, item, result);
          return;
        }
        if (result.status === "blocked") {
          await this.#enterRepair(runtime, result.code, item.wake.wakeId);
          return;
        }
        await this.#enterRepair(runtime, "provider-contract-invalid", item.wake.wakeId);
        return;
      }
    } catch {
      if (this.#isCurrent(runtime)) {
        this.#notice(runtime.enrollmentId, "durable-store-unavailable", null);
        await this.#retireRuntime(runtime);
      }
    } finally {
      runtime.deliveryBusy = false;
      if (runtime.deliveryKickPending) this.#kickDelivery(runtime);
    }
  }

  async #complete(
    runtime: Runtime,
    item: StoredAgentWakeItem,
    disposition: AgentWakeCompletionDisposition,
    providerReceiptId: string,
  ): Promise<void> {
    await this.#transactRequired(runtime.enrollmentId, (current) => {
      const head = current.queue[0];
      if (
        head === undefined ||
        head.wake.wakeId !== item.wake.wakeId ||
        head.phase !== "delivering" ||
        head.attempts !== item.attempts
      ) {
        return current;
      }
      const completion: StoredAgentWakeCompletion = {
        wakeId: item.wake.wakeId,
        conversationId: item.wake.conversationId,
        messageId: item.wake.messageId,
        reason: item.wake.reason,
        occurredAt: item.wake.occurredAt,
        sourceCursor: item.sourceCursor,
        attempt: item.attempts,
        brokerDurableAt: item.enqueuedAt,
        disposition,
        providerReceiptId,
        completedAt: this.#clock.now(),
      };
      return {
        ...current,
        revision: nextRevision(current),
        runState: "running",
        queue: current.queue.slice(1),
        completions: [...current.completions, completion].slice(-this.#maxCompletionRecords),
      };
    });
  }

  async #restoreUninvokedClaim(
    runtime: Runtime,
    claimed: StoredAgentWakeItem,
    previous: StoredAgentWakeItem,
  ): Promise<void> {
    await this.#transactRequired(runtime.enrollmentId, (current) => {
      const head = current.queue[0];
      if (
        current.runState === "stopped" ||
        current.repair !== null ||
        head === undefined ||
        head.wake.wakeId !== claimed.wake.wakeId ||
        head.phase !== "delivering" ||
        head.attempts !== claimed.attempts
      ) {
        return current;
      }
      return {
        ...current,
        revision: nextRevision(current),
        queue: [previous, ...current.queue.slice(1)],
      };
    });
  }

  async #retry(
    runtime: Runtime,
    item: StoredAgentWakeItem,
    result: Extract<AgentWakeTargetResult, { status: "retry" }>,
  ): Promise<void> {
    if (item.attempts >= this.#maxProviderAttempts) {
      await this.#enterRepair(runtime, "provider-retry-exhausted", item.wake.wakeId);
      return;
    }
    const requested = result.retryAfterMs;
    const delay =
      requested !== undefined && Number.isSafeInteger(requested) && requested >= 0
        ? Math.min(this.#providerRetryMaxMs, requested)
        : agentWakeBackoffDelay(this.#providerRetryBaseMs, this.#providerRetryMaxMs, item.attempts);
    const nextAttemptAt = this.#clock.now() + delay;
    await this.#transactRequired(runtime.enrollmentId, (current) => {
      const head = current.queue[0];
      if (
        head === undefined ||
        head.wake.wakeId !== item.wake.wakeId ||
        head.phase !== "delivering" ||
        head.attempts !== item.attempts
      ) {
        return current;
      }
      return {
        ...current,
        revision: nextRevision(current),
        queue: [
          {
            ...head,
            phase: "retry-wait",
            nextAttemptAt,
            lastRetryCode: result.code,
          },
          ...current.queue.slice(1),
        ],
      };
    });
    this.#notice(runtime.enrollmentId, result.code, item.wake.wakeId);
    this.#scheduleDelivery(runtime, delay);
  }

  #scheduleDelivery(runtime: Runtime, delayMs: number): void {
    if (!this.#isCurrent(runtime) || runtime.deliveryTimer !== null) return;
    runtime.deliveryTimer = this.#scheduler.schedule(Math.max(0, delayMs), () => {
      runtime.deliveryTimer = null;
      this.#kickDelivery(runtime);
    });
  }

  #markSourceReady(runtime: Runtime): void {
    if (
      !this.#isCurrent(runtime) ||
      runtime.sourceQuiescing ||
      runtime.pendingProviderAmbiguity !== null
    ) {
      return;
    }
    runtime.sourceReady = true;
  }

  async #restartSourceAuthorization(runtime: Runtime): Promise<void> {
    if (!this.#isCurrent(runtime) || runtime.pendingProviderAmbiguity !== null) return;
    runtime.sourceQuiescing = true;
    runtime.sourceReady = false;
    runtime.sourceTimer?.cancel();
    runtime.deliveryTimer?.cancel();
    runtime.sourceTimer = null;
    runtime.deliveryTimer = null;
    runtime.sourceAbort?.abort();
    this.#signalCapacity(runtime);
    const session = runtime.sourceSession;
    if (session !== null) await this.#stopSession(runtime.enrollmentId, session);
    if (!runtime.sourceBusy && this.#isCurrent(runtime)) {
      runtime.sourceQuiescing = false;
      this.#kickSource(runtime);
    }
  }

  async #superviseProviderAmbiguity(runtime: Runtime, item: StoredAgentWakeItem): Promise<void> {
    if (!this.#isCurrent(runtime)) return;
    runtime.pendingProviderAmbiguity = { item, attempt: 1 };
    runtime.sourceQuiescing = true;
    runtime.sourceReady = false;
    runtime.sourceTimer?.cancel();
    runtime.deliveryTimer?.cancel();
    runtime.sourceTimer = null;
    runtime.deliveryTimer = null;
    this.#signalCapacity(runtime);
    const session = runtime.sourceSession;
    runtime.sourceSession = null;
    this.#scheduleProviderAmbiguityRecovery(runtime);
    if (session !== null) await this.#stopSession(runtime.enrollmentId, session);
  }

  #scheduleProviderAmbiguityRecovery(runtime: Runtime): void {
    const pending = runtime.pendingProviderAmbiguity;
    if (!this.#isCurrent(runtime) || pending === null || runtime.deliveryTimer !== null) return;
    const delay = agentWakeBackoffDelay(
      this.#providerRetryBaseMs,
      this.#providerRetryMaxMs,
      pending.attempt,
    );
    runtime.deliveryTimer = this.#scheduler.schedule(delay, () => {
      runtime.deliveryTimer = null;
      void this.#recoverProviderAmbiguity(runtime);
    });
  }

  async #recoverProviderAmbiguity(runtime: Runtime): Promise<void> {
    const pending = runtime.pendingProviderAmbiguity;
    if (!this.#isCurrent(runtime) || pending === null) return;
    try {
      const current = await this.#readRequired(runtime.enrollmentId);
      const completion = current.completions.find(
        (candidate) => candidate.wakeId === pending.item.wake.wakeId,
      );
      if (completion !== undefined) {
        runtime.pendingProviderAmbiguity = null;
        this.#kickSource(runtime);
        return;
      }
      const head = current.queue[0];
      if (
        current.repair?.code === "provider-outcome-ambiguous" &&
        current.repair.wakeId === pending.item.wake.wakeId &&
        head?.wake.wakeId === pending.item.wake.wakeId &&
        head.phase === "blocked"
      ) {
        runtime.pendingProviderAmbiguity = null;
        this.#notice(runtime.enrollmentId, current.repair.code, current.repair.wakeId);
        await this.#retireRuntime(runtime);
        return;
      }
      if (
        head === undefined ||
        head.wake.wakeId !== pending.item.wake.wakeId ||
        head.phase !== "delivering" ||
        head.attempts !== pending.item.attempts
      ) {
        throw new AgentWakeBrokerError("durable-store-failed", true);
      }
      await this.#enterRepair(runtime, "provider-outcome-ambiguous", pending.item.wake.wakeId);
      runtime.pendingProviderAmbiguity = null;
    } catch {
      if (!this.#isCurrent(runtime) || runtime.pendingProviderAmbiguity !== pending) return;
      this.#notice(runtime.enrollmentId, "durable-store-unavailable", null);
      pending.attempt += 1;
      this.#scheduleProviderAmbiguityRecovery(runtime);
    }
  }

  async #enterRepair(
    runtime: Runtime,
    code: AgentWakeRepairCode,
    wakeId: string | null,
  ): Promise<void> {
    const state = await this.#transactRequired(runtime.enrollmentId, (current) => {
      if (current.repair !== null) {
        if (
          isSourceRepairCode(code) &&
          current.repair.code.startsWith("provider-") &&
          current.repair.deferredSourceRepair === null
        ) {
          return {
            ...current,
            revision: nextRevision(current),
            repair: {
              ...current.repair,
              deferredSourceRepair: { code, wakeId, occurredAt: this.#clock.now() },
            },
          };
        }
        return current;
      }
      const delivering = current.queue.find((item) => item.phase === "delivering");
      const occurredAt = this.#clock.now();
      const overlappingRepair =
        delivering !== undefined && isSourceRepairCode(code)
          ? {
              providerWakeId: delivering.wake.wakeId,
              sourceRepair: { code, wakeId, occurredAt },
            }
          : null;
      const providerOutcomeUnknown = overlappingRepair !== null;
      const repairCode = providerOutcomeUnknown ? "provider-outcome-ambiguous" : code;
      const repairWakeId = overlappingRepair?.providerWakeId ?? wakeId;
      const blockedWakeId = repairCode.startsWith("provider-") ? repairWakeId : null;
      return {
        ...current,
        revision: nextRevision(current),
        runState: "stopped",
        sourceRetry: null,
        queue:
          blockedWakeId === null
            ? current.queue
            : current.queue.map((item) =>
                item.wake.wakeId === blockedWakeId ? { ...item, phase: "blocked" as const } : item,
              ),
        repair: {
          code: repairCode,
          wakeId: repairWakeId,
          occurredAt,
          deferredSourceRepair: overlappingRepair?.sourceRepair ?? null,
        },
      };
    });
    if (state.repair !== null) {
      this.#notice(runtime.enrollmentId, state.repair.code, state.repair.wakeId);
      await this.#retireRuntime(runtime);
    }
  }

  async #waitForCapacity(runtime: Runtime): Promise<void> {
    if (!this.#isCurrent(runtime)) return;
    runtime.capacityWaiter ??= createWaiter();
    const waiter = runtime.capacityWaiter;
    try {
      const state = await this.#readRequired(runtime.enrollmentId);
      if (!this.#isCurrent(runtime) || state.queue.length < this.#maxQueueDepth) {
        this.#signalCapacity(runtime);
      }
      await waiter.promise;
    } catch (error) {
      if (runtime.capacityWaiter === waiter) this.#signalCapacity(runtime);
      throw error;
    }
  }

  #signalCapacity(runtime: Runtime): void {
    const waiter = runtime.capacityWaiter;
    runtime.capacityWaiter = null;
    waiter?.resolve();
  }

  #isCurrent(runtime: Runtime): boolean {
    return runtime.active && this.#runtimes.get(runtime.enrollmentId) === runtime;
  }

  #isRunnable(runtime: Runtime, state: StoredAgentWakeEnrollment): boolean {
    return this.#isCurrent(runtime) && state.runState !== "stopped" && state.repair === null;
  }

  async #retireRuntime(runtime: Runtime): Promise<void> {
    if (!runtime.active) return;
    runtime.active = false;
    if (this.#runtimes.get(runtime.enrollmentId) === runtime) {
      this.#runtimes.delete(runtime.enrollmentId);
    }
    runtime.sourceTimer?.cancel();
    runtime.deliveryTimer?.cancel();
    runtime.sourceTimer = null;
    runtime.deliveryTimer = null;
    runtime.sourceReady = false;
    runtime.sourceQuiescing = false;
    runtime.pendingProviderAmbiguity = null;
    runtime.deliveryKickPending = false;
    runtime.sourceAbort?.abort();
    runtime.sourceAbort = null;
    runtime.providerAbort?.abort();
    runtime.providerAbort = null;
    this.#signalCapacity(runtime);
    const session = runtime.sourceSession;
    runtime.sourceSession = null;
    if (session !== null) await this.#stopSession(runtime.enrollmentId, session);
  }

  async #stopSession(enrollmentId: string, session: AgentWakeSourceSession): Promise<void> {
    try {
      await session.stop();
    } catch {
      this.#notice(enrollmentId, "source-stop-failed", null);
    }
  }

  #notice(enrollmentId: string, code: AgentWakeNoticeCode, wakeId: string | null): void {
    try {
      this.#onNotice({ enrollmentId, code, wakeId, occurredAt: this.#clock.now() });
    } catch {
      // Diagnostics are intentionally best-effort and may not affect durable delivery state.
    }
  }
}
