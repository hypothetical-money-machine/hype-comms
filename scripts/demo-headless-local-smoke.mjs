import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DEMO_CDP_BASE_PORT,
  DEMO_POSTGRES_MODE_MANAGED,
  DEMO_POSTGRES_MODE_SERVICE,
  parseCdpBasePort,
} from "./demo-environment.mjs";
import {
  DEFAULT_MANIFEST_RELATIVE_PATH,
  DEFAULT_SMOKE_MESSAGE,
  HEADLESS_DEMO_MANIFEST_VERSION,
  HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
  HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
  readHeadlessDemoManifest,
  runHeadlessSmoke,
  runParticipatedThreadNotificationSmoke,
} from "./demo-headless-smoke.mjs";
import { signalProcessTree } from "./process-tree.mjs";

export const DEFAULT_LOCAL_SMOKE_TIMEOUT_MS = 60_000;
const MAX_READY_OUTPUT_BUFFER_BYTES = 1_048_576;

function parsePositiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

/** Parse the intentionally small surface for a self-contained local demo smoke run. */
export function parseLocalHeadlessSmokeArguments(arguments_) {
  let cdpBasePort;
  let messagePrefix = DEFAULT_SMOKE_MESSAGE;
  let timeoutMs = DEFAULT_LOCAL_SMOKE_TIMEOUT_MS;
  let flow = HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE;
  let postgresMode = DEMO_POSTGRES_MODE_MANAGED;
  let receivedMessage = false;
  let receivedTimeout = false;
  let receivedFlow = false;
  let receivedPostgresMode = false;

  for (const argument of arguments_) {
    if (argument.startsWith("--cdp-base-port=")) {
      if (cdpBasePort !== undefined) throw new Error("--cdp-base-port may only be supplied once");
      cdpBasePort = parseCdpBasePort(argument.slice("--cdp-base-port=".length));
    } else if (argument.startsWith("--message=")) {
      if (receivedMessage) throw new Error("--message may only be supplied once");
      messagePrefix = argument.slice("--message=".length);
      receivedMessage = true;
    } else if (argument.startsWith("--timeout-ms=")) {
      if (receivedTimeout) throw new Error("--timeout-ms may only be supplied once");
      timeoutMs = parsePositiveInteger(argument.slice("--timeout-ms=".length), "--timeout-ms");
      receivedTimeout = true;
    } else if (argument.startsWith("--flow=")) {
      if (receivedFlow) throw new Error("--flow may only be supplied once");
      flow = argument.slice("--flow=".length);
      if (
        flow !== HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE &&
        flow !== HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD
      ) {
        throw new Error("--flow must be direct-message or participated-thread");
      }
      receivedFlow = true;
    } else if (argument.startsWith("--postgres=")) {
      if (receivedPostgresMode) throw new Error("--postgres may only be supplied once");
      postgresMode = argument.slice("--postgres=".length);
      if (
        postgresMode !== DEMO_POSTGRES_MODE_MANAGED &&
        postgresMode !== DEMO_POSTGRES_MODE_SERVICE
      ) {
        throw new Error("--postgres must be managed or service");
      }
      receivedPostgresMode = true;
    } else {
      throw new Error(
        "Usage: test:demo:headless [--cdp-base-port=<port>] [--message=<prefix>] " +
          "[--timeout-ms=<ms>] [--flow=<direct-message|participated-thread>] " +
          "[--postgres=<managed|service>]",
      );
    }
  }

  if (messagePrefix.trim() === "") throw new Error("--message must not be empty");
  return {
    cdpBasePort: cdpBasePort ?? DEFAULT_DEMO_CDP_BASE_PORT,
    messagePrefix,
    timeoutMs,
    flow,
    postgresMode,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestPathFromReadyRecord(line, expectedManifestPath) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record) || record.event !== "ready") return null;
  if (record.version !== HEADLESS_DEMO_MANIFEST_VERSION) {
    throw new Error("Headless demo readiness record has an unsupported version");
  }
  if (typeof record.manifestPath !== "string" || record.manifestPath === "") {
    throw new Error("Headless demo readiness record is missing its manifest path");
  }
  const manifestPath = path.resolve(record.manifestPath);
  if (manifestPath !== expectedManifestPath) {
    throw new Error("Headless demo readiness record named an unexpected manifest path");
  }
  return manifestPath;
}

function launcherCloseError(code, signal) {
  const detail = signal === null ? `code ${String(code)}` : `signal ${String(signal)}`;
  return new Error(`Headless demo launcher exited before becoming ready (${detail})`);
}

/**
 * Consume launcher output until its versioned ready record names the expected private manifest.
 * Non-JSON development logs remain visible through writeOutput but are never treated as readiness.
 */
export function waitForHeadlessDemoReady(
  launcher,
  {
    expectedManifestPath,
    timeoutMs = DEFAULT_LOCAL_SMOKE_TIMEOUT_MS,
    writeOutput = (chunk) => process.stdout.write(chunk),
  },
) {
  if (!path.isAbsolute(expectedManifestPath)) {
    throw new Error("The expected headless demo manifest path must be absolute");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("The headless demo readiness timeout must be a positive integer");
  }
  if (launcher.stdout === null || launcher.stdout === undefined) {
    throw new Error("Headless demo launcher stdout must be piped");
  }
  if (launcher.exitCode !== null && launcher.exitCode !== undefined) {
    throw launcherCloseError(launcher.exitCode, launcher.signalCode ?? null);
  }

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      launcher.stdout.off("data", onData);
      launcher.stdout.off("end", onEnd);
      launcher.off("close", onClose);
      launcher.off("error", onError);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => settle(reject, error);
    const processLine = (line) => {
      const manifestPath = manifestPathFromReadyRecord(line, expectedManifestPath);
      if (manifestPath === null) return;
      settled = true;
      cleanup();
      // Keep draining launcher stdout after readiness. The demo API logs every request, and an
      // undrained pipe eventually fills and blocks the demo children mid-smoke.
      launcher.stdout.on("data", writeOutput);
      resolve({ manifestPath });
    };
    const processBuffer = () => {
      let newlineIndex = buffer.indexOf("\n");
      while (!settled && newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
        buffer = buffer.slice(newlineIndex + 1);
        try {
          processLine(line);
        } catch (error) {
          fail(error);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    const onData = (chunk) => {
      const text = String(chunk);
      writeOutput(text);
      buffer += text;
      if (buffer.length > MAX_READY_OUTPUT_BUFFER_BYTES) {
        fail(new Error("Headless demo launcher emitted too much output without a ready record"));
        return;
      }
      processBuffer();
    };
    const onEnd = () => {
      if (settled) return;
      try {
        if (buffer !== "") processLine(buffer.replace(/\r$/u, ""));
      } catch (error) {
        fail(error);
        return;
      }
      if (!settled) fail(new Error("Headless demo launcher closed stdout before becoming ready"));
    };
    const onClose = (code, signal) => fail(launcherCloseError(code, signal));
    const onError = (error) => fail(error);

    launcher.stdout.setEncoding("utf8");
    launcher.stdout.on("data", onData);
    launcher.stdout.once("end", onEnd);
    launcher.once("close", onClose);
    launcher.once("error", onError);
    timer = setTimeout(() => {
      fail(new Error("Timed out waiting for the headless demo readiness record"));
    }, timeoutMs);
  });
}

function waitForLauncherClose(launcher, timeoutMs) {
  if (launcher.exitCode !== null && launcher.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      launcher.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    launcher.once("close", onClose);
    if (launcher.exitCode !== null && launcher.exitCode !== undefined) finish(true);
  });
}

/** Send the launcher SIGTERM first, escalating only if it does not exit promptly. */
export async function stopHeadlessDemoLauncher(launcher, { timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("The headless demo shutdown timeout must be a positive integer");
  }
  if (launcher.exitCode !== null && launcher.exitCode !== undefined) return;
  await signalProcessTree(launcher, "SIGTERM");
  if (await waitForLauncherClose(launcher, timeoutMs)) return;
  await signalProcessTree(launcher, "SIGKILL");
  await waitForLauncherClose(launcher, timeoutMs);
}

/**
 * Start a throwaway headless demo, wait for its authenticated renderer readiness record, then run
 * the existing Claire-to-Woots smoke capture before stopping the demo launcher.
 */
export async function runLocalHeadlessSmoke({
  projectRoot,
  environment = process.env,
  cdpBasePort = DEFAULT_DEMO_CDP_BASE_PORT,
  messagePrefix = DEFAULT_SMOKE_MESSAGE,
  timeoutMs = DEFAULT_LOCAL_SMOKE_TIMEOUT_MS,
  flow = HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
  postgresMode = DEMO_POSTGRES_MODE_MANAGED,
  nodeCommand = process.execPath,
  spawnProcess = spawn,
  readManifest = readHeadlessDemoManifest,
  runSmoke,
  runDirectMessageSmoke = runHeadlessSmoke,
  runParticipatedThreadSmoke = runParticipatedThreadNotificationSmoke,
  waitForReady = waitForHeadlessDemoReady,
  stopLauncher = stopHeadlessDemoLauncher,
  writeOutput,
}) {
  if (
    flow !== HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE &&
    flow !== HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD
  ) {
    throw new Error("Headless smoke flow must be direct-message or participated-thread");
  }
  if (postgresMode !== DEMO_POSTGRES_MODE_MANAGED && postgresMode !== DEMO_POSTGRES_MODE_SERVICE) {
    throw new Error("Headless smoke PostgreSQL mode must be managed or service");
  }
  const manifestPath = path.join(projectRoot, DEFAULT_MANIFEST_RELATIVE_PATH);
  const launcherArguments = ["scripts/demo.mjs", "--headless"];
  if (postgresMode === DEMO_POSTGRES_MODE_SERVICE) {
    launcherArguments.push("--postgres=service");
  }
  launcherArguments.push(`--cdp-base-port=${String(parseCdpBasePort(String(cdpBasePort)))}`);
  let launcher;

  try {
    // Run the launcher directly so shutdown signals reach its cleanup handler rather than being
    // absorbed by an intermediate package-manager process.
    launcher = spawnProcess(nodeCommand, launcherArguments, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const ready = await waitForReady(launcher, {
      expectedManifestPath: manifestPath,
      timeoutMs,
      ...(writeOutput === undefined ? {} : { writeOutput }),
    });
    const manifest = await readManifest(ready.manifestPath);
    const selectedSmoke =
      runSmoke ??
      (flow === HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD
        ? runParticipatedThreadSmoke
        : runDirectMessageSmoke);
    const result = await selectedSmoke({ manifest, messagePrefix, timeoutMs });
    return { ...result, manifestPath: ready.manifestPath };
  } finally {
    if (launcher !== undefined) await stopLauncher(launcher);
  }
}

async function main() {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const options = parseLocalHeadlessSmokeArguments(process.argv.slice(2));
  const result = await runLocalHeadlessSmoke({ projectRoot, ...options });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const executedPath = process.argv[1];
if (executedPath !== undefined && path.resolve(executedPath) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `Local headless demo smoke failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
