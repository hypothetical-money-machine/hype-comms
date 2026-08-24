import {
  AgentWakeBroker,
  type AgentWakeBrokerErrorCode,
  type AgentWakeBrokerStatus,
  type AgentWakeClock,
  type AgentWakeEnrollmentAuthority,
  type AgentWakeInboxStore,
  type AgentWakeNotice,
  type AgentWakeScheduler,
  type AgentWakeSource,
  type AgentWakeTarget,
  type StoredAgentWakeEnrollment,
} from "./agent-wake-broker";
import { AgentWakeCliSourceAdapter, type AgentWakeCliBinding } from "./agent-wake-cli-source";
import type { AgentWakeConfiguration } from "./agent-wake-configuration";
import { AgentWakeFileStore } from "./agent-wake-file-store";
import {
  AgentWakeProviderProcessTarget,
  type AgentWakeProviderExecutableConfig,
} from "./agent-wake-provider-process";
import { agentWakeBackoffDelay, agentWakePositiveInteger } from "./agent-wake-validation";

const DEFAULT_STARTUP_RETRY_BASE_MS = 1_000;
const DEFAULT_STARTUP_RETRY_MAX_MS = 30_000;

const systemClock: AgentWakeClock = { now: Date.now };
const systemScheduler: AgentWakeScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

type AgentWakeAuthorityAndSource = AgentWakeEnrollmentAuthority & AgentWakeSource;

export interface AgentWakeRuntimeOptions {
  readonly configuration: AgentWakeConfiguration;
  readonly userDataPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authorityAndSource?: AgentWakeAuthorityAndSource;
  readonly store?: AgentWakeInboxStore;
  readonly target?: AgentWakeTarget;
  readonly clock?: AgentWakeClock;
  readonly scheduler?: AgentWakeScheduler;
  readonly onNotice?: (notice: AgentWakeNotice) => void;
  readonly startupSignal?: AbortSignal;
  readonly startupRetryBaseMs?: number;
  readonly startupRetryMaxMs?: number;
  readonly onStartupRetry?: (notice: AgentWakeStartupRetryNotice) => void;
}

export interface AgentWakeStartupRetryNotice {
  readonly enrollmentId: string;
  readonly code:
    "durable-store-failed" | "enrollment-high-water-failed" | "enrollment-verification-failed";
  readonly attempt: number;
  readonly delayMs: number;
}

export interface AgentWakeRuntimeSession {
  readonly broker: AgentWakeBroker;
  readonly initialStatus: AgentWakeBrokerStatus;
  dispose(): Promise<void>;
}

export class AgentWakeRuntimeError extends Error {
  constructor(
    readonly code:
      "executable-integrity-invalid" | "persisted-enrollment-conflict" | "startup-disposed",
  ) {
    super(`Agent wake runtime failed: ${code}`);
    this.name = "AgentWakeRuntimeError";
  }
}

function startupRetryCode(error: unknown): AgentWakeStartupRetryNotice["code"] | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryable" in error) ||
    error.retryable !== true
  ) {
    return null;
  }
  if (!("code" in error) || typeof error.code !== "string") {
    return "durable-store-failed";
  }
  const code = error.code as AgentWakeBrokerErrorCode | "store-unavailable";
  switch (code) {
    case "enrollment-high-water-failed":
    case "enrollment-verification-failed":
      return code;
    case "durable-store-failed":
    case "store-unavailable":
      return "durable-store-failed";
    default:
      return null;
  }
}

function startupDisposed(): AgentWakeRuntimeError {
  return new AgentWakeRuntimeError("startup-disposed");
}

function startupWasDisposed(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function waitForStartupRetry(input: {
  readonly scheduler: AgentWakeScheduler;
  readonly signal: AbortSignal | undefined;
  readonly delayMs: number;
}): Promise<void> {
  if (input.signal?.aborted === true) return Promise.reject(startupDisposed());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let scheduled: ReturnType<AgentWakeScheduler["schedule"]> | null = null;
    const finish = (error?: AgentWakeRuntimeError): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      scheduled?.cancel();
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void => finish(startupDisposed());
    input.signal?.addEventListener("abort", abort, { once: true });
    scheduled = input.scheduler.schedule(input.delayMs, () => finish());
    if (settled) scheduled.cancel();
  });
}

function sourceAdapter(
  configuration: AgentWakeConfiguration,
  environment: NodeJS.ProcessEnv | undefined,
): AgentWakeAuthorityAndSource {
  const runtimeExecutablePin = configuration.source.runtimeExecutablePin;
  const cliEntrypointPin = configuration.source.cliEntrypointPin;
  if (runtimeExecutablePin === undefined || cliEntrypointPin === undefined) {
    throw new AgentWakeRuntimeError("executable-integrity-invalid");
  }
  const binding: AgentWakeCliBinding = {
    runtimeExecutablePath: configuration.source.runtimeExecutablePath,
    runtimeExecutablePin,
    cliEntrypointPath: configuration.source.cliEntrypointPath,
    cliEntrypointPin,
    profile: configuration.source.profile,
    apiOrigin: configuration.source.apiOrigin,
  };
  return new AgentWakeCliSourceAdapter({
    environment,
    resolveBinding: (credentialHandle) =>
      credentialHandle === configuration.source.credentialHandle ? binding : null,
  });
}

function providerTarget(
  configuration: AgentWakeConfiguration,
  environment: NodeJS.ProcessEnv | undefined,
): AgentWakeTarget {
  const executablePin = configuration.target.executablePin;
  if (executablePin === undefined) {
    throw new AgentWakeRuntimeError("executable-integrity-invalid");
  }
  const target: AgentWakeProviderExecutableConfig = {
    adapterId: configuration.target.adapterId,
    executablePath: configuration.target.executablePath,
    executablePin,
    arguments: configuration.target.arguments,
  };
  return new AgentWakeProviderProcessTarget({
    environment,
    resolveTarget: (targetHandle) =>
      targetHandle === configuration.target.targetHandle ? [target] : [],
  });
}

function enrollmentMatchesConfiguration(
  enrollment: StoredAgentWakeEnrollment,
  configuration: AgentWakeConfiguration,
): boolean {
  return (
    enrollment.enrollmentId === configuration.enrollmentId &&
    enrollment.identity.apiOrigin === configuration.source.apiOrigin &&
    enrollment.identity.agentUserId === configuration.expectedAgentUserId &&
    enrollment.credentialHandle === configuration.source.credentialHandle &&
    enrollment.provider.adapterId === configuration.target.adapterId &&
    enrollment.provider.targetHandle === configuration.target.targetHandle
  );
}

/**
 * Composes the privileged wake runtime and reconciles its durable enrollment before starting.
 * A changed agent/profile/provider binding is never silently applied to an existing inbox.
 */
export async function startAgentWakeRuntime(
  options: AgentWakeRuntimeOptions,
): Promise<AgentWakeRuntimeSession> {
  const store = options.store ?? new AgentWakeFileStore({ userDataPath: options.userDataPath });
  const authorityAndSource =
    options.authorityAndSource ?? sourceAdapter(options.configuration, options.environment);
  const target = options.target ?? providerTarget(options.configuration, options.environment);
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? systemScheduler;
  const retryBaseMs = agentWakePositiveInteger(
    options.startupRetryBaseMs,
    DEFAULT_STARTUP_RETRY_BASE_MS,
  );
  const retryMaxMs = agentWakePositiveInteger(
    options.startupRetryMaxMs,
    DEFAULT_STARTUP_RETRY_MAX_MS,
  );
  let retryAttempt = 0;

  while (true) {
    if (startupWasDisposed(options.startupSignal)) throw startupDisposed();
    const broker = new AgentWakeBroker({
      authority: authorityAndSource,
      source: authorityAndSource,
      store,
      target,
      clock,
      scheduler,
      onNotice: options.onNotice,
    });

    try {
      const current = await store.read(options.configuration.enrollmentId);
      if (current === null) {
        await broker.enrollNow({
          enrollmentId: options.configuration.enrollmentId,
          expectedAgentUserId: options.configuration.expectedAgentUserId,
          signal: options.startupSignal,
          credentialHandle: options.configuration.source.credentialHandle,
          provider: {
            adapterId: options.configuration.target.adapterId,
            targetHandle: options.configuration.target.targetHandle,
          },
        });
      } else if (!enrollmentMatchesConfiguration(current, options.configuration)) {
        throw new AgentWakeRuntimeError("persisted-enrollment-conflict");
      }
      const initialStatus = await broker.start(options.configuration.enrollmentId);
      if (startupWasDisposed(options.startupSignal)) {
        await broker.dispose();
        throw startupDisposed();
      }
      return {
        broker,
        initialStatus,
        dispose: () => broker.dispose(),
      };
    } catch (error) {
      await broker.dispose().catch(() => undefined);
      if (startupWasDisposed(options.startupSignal)) throw startupDisposed();
      const code = startupRetryCode(error);
      if (code === null) throw error;
      retryAttempt += 1;
      const delayMs = agentWakeBackoffDelay(retryBaseMs, retryMaxMs, retryAttempt);
      try {
        options.onStartupRetry?.({
          enrollmentId: options.configuration.enrollmentId,
          code,
          attempt: retryAttempt,
          delayMs,
        });
      } catch {
        // A best-effort diagnostic cannot change startup delivery behavior.
      }
      await waitForStartupRetry({
        scheduler,
        signal: options.startupSignal,
        delayMs,
      });
    }
  }
}
