import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AnyMessage,
  client as acpSdkClient,
  ClientConnection,
  LoadSessionResponse,
  methods as acpSdkMethods,
  NewSessionResponse,
  PromptResponse,
  PROTOCOL_VERSION as acpSdkProtocolVersion,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  Stream,
} from "@agentclientprotocol/sdk";
import { utilityProcess, type UtilityProcess } from "electron";

interface AcpSdkRuntime {
  readonly client: typeof acpSdkClient;
  readonly methods: typeof acpSdkMethods;
  readonly PROTOCOL_VERSION: typeof acpSdkProtocolVersion;
}

const MAX_ACP_MESSAGE_BYTES = 8 * 1_024 * 1_024;
const MAX_QUEUED_ACP_BYTES = 8 * 1_024 * 1_024;
const MIN_QUEUED_MESSAGE_COST_BYTES = 1_024;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MODE_ID = "default";
const WORKER_SERVICE_NAME = "Hype Comms Claude ACP";

const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "APPDATA",
  "AWS_ACCESS_KEY_ID",
  "AWS_CONFIG_FILE",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CLOUD_ML_REGION",
  "COMSPEC",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

interface AcpEnvelope {
  readonly type: "acp";
  readonly message: AnyMessage;
}

export type ClaudeAcpHostExit =
  | { readonly reason: "exited"; readonly exitCode: number }
  | { readonly reason: "launch-failed"; readonly exitCode: null }
  | { readonly reason: "transport-failed"; readonly exitCode: number | null };

export interface ClaudeAcpHostCallbacks {
  readonly onSessionUpdate: (notification: SessionNotification) => void | Promise<void>;
  readonly requestPermission: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  readonly onExit: (event: ClaudeAcpHostExit) => void;
}

export interface ClaudeAcpHost {
  newSession(cwd: string): Promise<NewSessionResponse>;
  loadSession(cwd: string, sessionId: string): Promise<LoadSessionResponse>;
  prompt(sessionId: string, prompt: string): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export type CreateClaudeAcpHost = (callbacks: ClaudeAcpHostCallbacks) => Promise<ClaudeAcpHost>;

export type ClaudeAcpHostErrorCode =
  | "claude-not-found"
  | "connection-failed"
  | "invalid-workspace"
  | "session-operation-failed"
  | "worker-launch-failed";

export class ClaudeAcpHostError extends Error {
  constructor(readonly code: ClaudeAcpHostErrorCode) {
    super(
      {
        "claude-not-found": "A user-installed Claude Code executable was not found",
        "connection-failed": "The Claude ACP connection failed",
        "invalid-workspace": "The Claude workspace must be an absolute path",
        "session-operation-failed": "The Claude ACP session operation failed",
        "worker-launch-failed": "The Claude ACP worker could not start",
      }[code],
    );
    this.name = "ClaudeAcpHostError";
  }
}

export interface ClaudeAcpWorkerLaunch {
  readonly modulePath: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ClaudeAcpWorker {
  readonly spawned: Promise<void>;
  postMessage(message: unknown): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  onFatalError(listener: () => void): void;
}

export interface ClaudeAcpHostDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly workerPath?: string;
  readonly isExecutable?: (candidate: string) => Promise<boolean>;
  readonly forkWorker?: (launch: ClaudeAcpWorkerLaunch) => ClaudeAcpWorker;
  readonly startupSignal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
}

function boundedAcpEnvelopeBytes(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.type !== "acp" ||
    typeof candidate.message !== "object" ||
    candidate.message === null ||
    Array.isArray(candidate.message)
  ) {
    return null;
  }
  try {
    const bytes = Buffer.byteLength(JSON.stringify(candidate.message), "utf8");
    return bytes <= MAX_ACP_MESSAGE_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function isBoundedAcpEnvelope(value: unknown): value is AcpEnvelope {
  return boundedAcpEnvelopeBytes(value) !== null;
}

function timeoutOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

interface BoundedOperationOptions {
  readonly deadline: number;
  readonly errorCode: ClaudeAcpHostErrorCode;
  readonly externalSignal?: AbortSignal;
  readonly onAbort?: () => void;
}

/** Races cooperative ACP cancellation with a hard local deadline. Late settlement is consumed. */
function runBoundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: BoundedOperationOptions,
): Promise<T> {
  const error = new ClaudeAcpHostError(options.errorCode);
  if (options.externalSignal?.aborted === true || Date.now() >= options.deadline) {
    try {
      options.onAbort?.();
    } catch {
      // Abort cleanup is best effort; callers receive only the stable error.
    }
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const timeout = setTimeout(abort, Math.max(1, options.deadline - Date.now()));

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.externalSignal?.removeEventListener("abort", abort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    function abort(): void {
      if (settled) return;
      controller.abort();
      try {
        options.onAbort?.();
      } catch {
        // Abort cleanup is best effort; callers receive only the stable error.
      }
      settle(() => reject(error));
    }

    options.externalSignal?.addEventListener("abort", abort, { once: true });
    if (options.externalSignal?.aborted === true) {
      abort();
      return;
    }

    let pending: Promise<T>;
    try {
      pending = operation(controller.signal);
    } catch (operationError) {
      settle(() => reject(operationError));
      return;
    }
    pending.then(
      (value) => settle(() => resolve(value)),
      (operationError: unknown) => settle(() => reject(operationError)),
    );
  });
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  return (environment.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, "").trim())
    .filter((entry) => entry.length > 0 && pathImplementation.isAbsolute(entry));
}

function conventionalClaudePaths(
  platform: NodeJS.Platform,
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    return [
      path.win32.join(homeDirectory, ".local", "bin", "claude.exe"),
      path.win32.join(homeDirectory, ".claude", "local", "claude.exe"),
      ...(localAppData === undefined
        ? []
        : [path.win32.join(localAppData, "Programs", "Claude", "claude.exe")]),
    ];
  }

  return [
    path.join(homeDirectory, ".local", "bin", "claude"),
    path.join(homeDirectory, ".claude", "local", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/bin/claude",
  ];
}

/** Resolves only explicit executable paths. It never invokes a shell or the SDK's bundled CLI. */
export async function resolveClaudeCodeExecutable(
  dependencies: ClaudeAcpHostDependencies = {},
): Promise<string> {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const pathImplementation = platform === "win32" ? path.win32 : path.posix;
  const isExecutable = dependencies.isExecutable ?? executableFile;
  const configured = environment.CLAUDE_CODE_EXECUTABLE?.trim();

  if (configured !== undefined && configured.length > 0) {
    if (
      !pathImplementation.isAbsolute(configured) ||
      configured.includes("\0") ||
      !(await isExecutable(configured))
    ) {
      throw new ClaudeAcpHostError("claude-not-found");
    }
    return configured;
  }

  const executableName = platform === "win32" ? "claude.exe" : "claude";
  const homeDirectory =
    dependencies.homeDirectory ?? environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const candidates = [
    ...pathEntries(environment, platform).map((entry) =>
      pathImplementation.join(entry, executableName),
    ),
    ...conventionalClaudePaths(platform, homeDirectory, environment),
  ];

  for (const candidate of new Set(candidates)) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new ClaudeAcpHostError("claude-not-found");
}

export function buildClaudeAcpEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  executable: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }

  environment.CLAUDE_CODE_EXECUTABLE = executable;
  environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  environment.DISABLE_AUTOUPDATER = "1";
  return environment;
}

function productionWorker(launch: ClaudeAcpWorkerLaunch): ClaudeAcpWorker {
  let processHandle: UtilityProcess;
  try {
    processHandle = utilityProcess.fork(launch.modulePath, [], {
      env: { ...launch.environment },
      serviceName: WORKER_SERVICE_NAME,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new ClaudeAcpHostError("worker-launch-failed");
  }

  const spawned = new Promise<void>((resolve, reject) => {
    processHandle.once("spawn", resolve);
    processHandle.once("exit", () => reject(new ClaudeAcpHostError("worker-launch-failed")));
    processHandle.once("error", () => reject(new ClaudeAcpHostError("worker-launch-failed")));
  });

  return {
    spawned,
    postMessage(message) {
      processHandle.postMessage(message);
    },
    kill() {
      processHandle.kill();
    },
    onMessage(listener) {
      processHandle.on("message", listener);
    },
    onExit(listener) {
      processHandle.on("exit", listener);
    },
    onFatalError(listener) {
      processHandle.on("error", listener);
    },
  };
}

interface WorkerStream {
  readonly stream: Stream;
  close(error?: unknown): void;
}

function createWorkerStream(worker: ClaudeAcpWorker, onTransportFailure: () => void): WorkerStream {
  let inputController: ReadableStreamDefaultController<AnyMessage> | null = null;
  let closed = false;

  const fail = (): void => {
    if (closed) return;
    closed = true;
    inputController?.error(new ClaudeAcpHostError("connection-failed"));
    onTransportFailure();
  };

  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>(
      {
        start(controller) {
          inputController = controller;
        },
        cancel() {
          closed = true;
        },
      },
      {
        highWaterMark: MAX_QUEUED_ACP_BYTES,
        size: (message) =>
          Math.max(
            Buffer.byteLength(JSON.stringify(message), "utf8"),
            MIN_QUEUED_MESSAGE_COST_BYTES,
          ),
      },
    ),
    writable: new WritableStream<AnyMessage>({
      write(message) {
        if (closed) throw new ClaudeAcpHostError("connection-failed");
        const envelope: AcpEnvelope = { type: "acp", message };
        if (!isBoundedAcpEnvelope(envelope)) {
          fail();
          throw new ClaudeAcpHostError("connection-failed");
        }
        try {
          worker.postMessage(envelope);
        } catch {
          fail();
          throw new ClaudeAcpHostError("connection-failed");
        }
      },
    }),
  };

  worker.onMessage((message) => {
    if (closed) return;
    const messageBytes = boundedAcpEnvelopeBytes(message);
    const queuedCost = Math.max(messageBytes ?? 0, MIN_QUEUED_MESSAGE_COST_BYTES);
    const desiredSize = inputController?.desiredSize;
    if (
      messageBytes === null ||
      inputController === null ||
      desiredSize === null ||
      desiredSize === undefined ||
      queuedCost > desiredSize
    ) {
      fail();
      return;
    }
    inputController.enqueue((message as AcpEnvelope).message);
  });

  return {
    stream,
    close(error) {
      if (closed) return;
      closed = true;
      try {
        if (error === undefined) inputController?.close();
        else inputController?.error(error);
      } catch {
        // The ACP connection may have cancelled the readable side first.
      }
    },
  };
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function validPermissionResponse(
  request: RequestPermissionRequest,
  response: RequestPermissionResponse,
): RequestPermissionResponse {
  if (response.outcome.outcome === "cancelled") return response;
  const selectedOptionId = response.outcome.optionId;
  return request.options.some((option) => option.optionId === selectedOptionId)
    ? response
    : cancelledPermission();
}

function assertWorkspace(cwd: string): void {
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new ClaudeAcpHostError("invalid-workspace");
  }
}

function modeConfig(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find(
    (option) =>
      option.type === "select" &&
      (option.category === "mode" || option.id === "mode") &&
      option.options.some((candidate) =>
        "value" in candidate
          ? candidate.value === DEFAULT_MODE_ID
          : candidate.options.some((nested) => nested.value === DEFAULT_MODE_ID),
      ),
  );
}

class ClaudeAcpHostImplementation implements ClaudeAcpHost {
  #disposed = false;

  constructor(
    private readonly connection: ClientConnection,
    private readonly worker: ClaudeAcpWorker,
    private readonly workerStream: WorkerStream,
    private readonly sdk: AcpSdkRuntime,
    private readonly markExpectedExit: () => void,
    private readonly failConnection: () => void,
    private readonly operationTimeoutMs: number,
    private readonly teardownTimeoutMs: number,
  ) {}

  #runOperation<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    return runBoundedOperation(operation, {
      deadline: Date.now() + timeoutMs,
      errorCode: "session-operation-failed",
      onAbort: this.failConnection,
    });
  }

  async #normalizeDefaultMode(
    sessionId: string,
    response: {
      readonly modes?: SessionModeState | null;
      readonly configOptions?: SessionConfigOption[] | null;
    },
  ): Promise<void> {
    const configuration = modeConfig(response.configOptions ?? []);
    if (configuration !== undefined) {
      await this.#runOperation(
        (signal) =>
          this.connection.agent.request(
            this.sdk.methods.agent.session.setConfigOption,
            {
              sessionId,
              configId: configuration.id,
              value: DEFAULT_MODE_ID,
            },
            { cancellationSignal: signal },
          ),
        this.operationTimeoutMs,
      );
      return;
    }

    if (response.modes?.availableModes.some((mode) => mode.id === DEFAULT_MODE_ID) === true) {
      await this.#runOperation(
        (signal) =>
          this.connection.agent.request(
            this.sdk.methods.agent.session.setMode,
            {
              sessionId,
              modeId: DEFAULT_MODE_ID,
            },
            { cancellationSignal: signal },
          ),
        this.operationTimeoutMs,
      );
      return;
    }

    throw new ClaudeAcpHostError("session-operation-failed");
  }

  #assertConnected(): void {
    if (this.#disposed || this.connection.signal.aborted) {
      throw new ClaudeAcpHostError("connection-failed");
    }
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    this.#assertConnected();
    assertWorkspace(cwd);
    try {
      const response = await this.#runOperation(
        (signal) =>
          this.connection.agent.request(
            this.sdk.methods.agent.session.new,
            { cwd, mcpServers: [] },
            { cancellationSignal: signal },
          ),
        this.operationTimeoutMs,
      );
      await this.#normalizeDefaultMode(response.sessionId, response);
      return response;
    } catch {
      throw new ClaudeAcpHostError("session-operation-failed");
    }
  }

  async loadSession(cwd: string, sessionId: string): Promise<LoadSessionResponse> {
    this.#assertConnected();
    assertWorkspace(cwd);
    try {
      const response = await this.#runOperation(
        (signal) =>
          this.connection.agent.request(
            this.sdk.methods.agent.session.load,
            { cwd, sessionId, mcpServers: [] },
            { cancellationSignal: signal },
          ),
        this.operationTimeoutMs,
      );
      await this.#normalizeDefaultMode(sessionId, response);
      return response;
    } catch {
      throw new ClaudeAcpHostError("session-operation-failed");
    }
  }

  async prompt(sessionId: string, prompt: string): Promise<PromptResponse> {
    this.#assertConnected();
    try {
      return await this.connection.agent.request(this.sdk.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
    } catch {
      throw new ClaudeAcpHostError("session-operation-failed");
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.#assertConnected();
    try {
      await this.#runOperation(
        () => this.connection.agent.notify(this.sdk.methods.agent.session.cancel, { sessionId }),
        this.teardownTimeoutMs,
      );
    } catch {
      throw new ClaudeAcpHostError("session-operation-failed");
    }
  }

  async close(sessionId: string): Promise<void> {
    this.#assertConnected();
    try {
      await this.#runOperation(
        (signal) =>
          this.connection.agent.request(
            this.sdk.methods.agent.session.close,
            { sessionId },
            { cancellationSignal: signal },
          ),
        this.teardownTimeoutMs,
      );
    } catch {
      throw new ClaudeAcpHostError("session-operation-failed");
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.markExpectedExit();
    this.connection.close();
    this.workerStream.close();
    try {
      this.worker.kill();
    } catch {
      // The worker may already have exited. There is no process output to surface here.
    }
  }
}

/** Starts the isolated adapter worker and completes ACP v1 initialization before returning. */
export async function createClaudeAcpHost(
  callbacks: ClaudeAcpHostCallbacks,
  dependencies: ClaudeAcpHostDependencies = {},
): Promise<ClaudeAcpHost> {
  const startupDeadline =
    Date.now() + timeoutOrDefault(dependencies.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const startupBoundary = {
    deadline: startupDeadline,
    externalSignal: dependencies.startupSignal,
  };
  const sdk = await (async () => {
    try {
      return await runBoundedOperation(() => import("@agentclientprotocol/sdk"), {
        ...startupBoundary,
        errorCode: "connection-failed",
      });
    } catch {
      throw new ClaudeAcpHostError("connection-failed");
    }
  })();
  const sdkRuntime: AcpSdkRuntime = {
    client: sdk.client,
    methods: sdk.methods,
    PROTOCOL_VERSION: sdk.PROTOCOL_VERSION,
  };
  const sourceEnvironment = dependencies.environment ?? process.env;
  const executable = await runBoundedOperation(() => resolveClaudeCodeExecutable(dependencies), {
    ...startupBoundary,
    errorCode: "connection-failed",
  });
  const launch: ClaudeAcpWorkerLaunch = {
    modulePath: dependencies.workerPath ?? path.join(__dirname, "claude-acp-worker.js"),
    environment: buildClaudeAcpEnvironment(sourceEnvironment, executable),
  };

  let worker: ClaudeAcpWorker;
  try {
    worker = (dependencies.forkWorker ?? productionWorker)(launch);
  } catch (error) {
    if (error instanceof ClaudeAcpHostError) throw error;
    throw new ClaudeAcpHostError("worker-launch-failed");
  }

  let expectedExit = false;
  let exitReported = false;
  let connection: ClientConnection | null = null;
  let workerStream: WorkerStream | null = null;

  const reportExit = (event: ClaudeAcpHostExit): void => {
    if (expectedExit || exitReported) return;
    exitReported = true;
    try {
      callbacks.onExit(event);
    } catch {
      // A host-exit consumer cannot be allowed to expose process diagnostics or re-enter teardown.
    }
  };

  const failTransport = (): void => {
    const failure = new ClaudeAcpHostError("connection-failed");
    workerStream?.close(failure);
    connection?.close(failure);
    try {
      worker.kill();
    } catch {
      // The exit callback below is intentionally the only process diagnostic exposed.
    }
    reportExit({ reason: "transport-failed", exitCode: null });
  };

  worker.onFatalError(failTransport);
  worker.onExit((exitCode) => {
    workerStream?.close(new ClaudeAcpHostError("connection-failed"));
    connection?.close(new ClaudeAcpHostError("connection-failed"));
    reportExit({ reason: "exited", exitCode });
  });

  try {
    await runBoundedOperation(() => worker.spawned, {
      ...startupBoundary,
      errorCode: "worker-launch-failed",
      onAbort: () => worker.kill(),
    });
  } catch {
    expectedExit = true;
    try {
      worker.kill();
    } catch {
      // Launch errors are deliberately reduced to the stable error below.
    }
    throw new ClaudeAcpHostError("worker-launch-failed");
  }

  workerStream = createWorkerStream(worker, failTransport);
  const app = sdkRuntime
    .client({ name: "hype-comms" })
    .onNotification(sdkRuntime.methods.client.session.update, async ({ params }) => {
      try {
        await callbacks.onSessionUpdate(params);
      } catch {
        // Renderer-facing state derivation must not break the protocol reader.
      }
    })
    .onRequest(sdkRuntime.methods.client.session.requestPermission, async ({ params, signal }) => {
      if (signal.aborted) return cancelledPermission();
      try {
        const response = await callbacks.requestPermission(params, signal);
        return signal.aborted ? cancelledPermission() : validPermissionResponse(params, response);
      } catch {
        return cancelledPermission();
      }
    });
  connection = app.connect(workerStream.stream);

  try {
    const initialized = await runBoundedOperation(
      (signal) =>
        connection?.agent.request(
          sdkRuntime.methods.agent.initialize,
          {
            protocolVersion: sdkRuntime.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "Hype Comms", version: "1" },
          },
          { cancellationSignal: signal },
        ) ?? Promise.reject(new ClaudeAcpHostError("connection-failed")),
      {
        ...startupBoundary,
        errorCode: "connection-failed",
      },
    );
    if (initialized.protocolVersion !== sdkRuntime.PROTOCOL_VERSION) {
      throw new ClaudeAcpHostError("connection-failed");
    }
  } catch {
    expectedExit = true;
    connection.close(new ClaudeAcpHostError("connection-failed"));
    workerStream.close(new ClaudeAcpHostError("connection-failed"));
    try {
      worker.kill();
    } catch {
      // Initialization errors expose only the stable error below.
    }
    throw new ClaudeAcpHostError("connection-failed");
  }

  return new ClaudeAcpHostImplementation(
    connection,
    worker,
    workerStream,
    sdkRuntime,
    () => {
      expectedExit = true;
    },
    failTransport,
    timeoutOrDefault(dependencies.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS),
    timeoutOrDefault(dependencies.teardownTimeoutMs, DEFAULT_TEARDOWN_TIMEOUT_MS),
  );
}
