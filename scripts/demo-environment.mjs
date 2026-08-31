import { constants } from "node:fs";
import { once } from "node:events";
import { chmod, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const DEMO_COMPOSE_PROJECT = "hype-comms-demo";
export const DEFAULT_DEMO_POSTGRES_BIND_PORT = 54330;
export const DEFAULT_DEMO_CDP_BASE_PORT = 9222;
export const DEMO_RENDERER_PORT = 5173;
export const HEADLESS_DEMO_MANIFEST_VERSION = 1;
export const HEADLESS_DEMO_MANIFEST_KIND = "hype-comms-headless-demo";
export const HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV =
  "HYPE_COMMS_DESKTOP_HEADLESS_NOTIFICATION_ARTIFACT_DIRECTORY";
export const DEMO_POSTGRES_MODE_MANAGED = "managed";
export const DEMO_POSTGRES_MODE_SERVICE = "service";

const HEADLESS_DEMO_CLIENT_PROFILES = ["claire", "woots"];
const TCP_PORT_MAX = 65_535;

function resolveDemoApiPort() {
  const raw = process.env.HYPE_COMMS_DEMO_API_PORT?.trim() ?? "";
  if (raw === "") return 3_000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > TCP_PORT_MAX) {
    throw new Error("HYPE_COMMS_DEMO_API_PORT must be a TCP port");
  }
  return port;
}

export const DEMO_API_PORT = resolveDemoApiPort();

/**
 * Chromium/Electron flags that keep the headless demo renderer alive inside a sandboxed/CI
 * environment. The separate GPU and Network Service utility processes otherwise crash from
 * seccomp restrictions, /dev/shm exhaustion, or missing graphics drivers before the renderer
 * reaches its readiness marker.
 */
const HEADLESS_ELECTRON_STABILITY_FLAGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--enable-features=NetworkServiceInProcess",
  "--disable-features=IsolateOrigins,site-per-process",
];

function assertTcpPort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > TCP_PORT_MAX) {
    throw new Error(`${label} must be a TCP port`);
  }
  return port;
}

function assertHeadlessCdpBasePort(port) {
  assertTcpPort(port, "The CDP base port");
  if (port === TCP_PORT_MAX) {
    throw new Error("The CDP base port must leave room for the second client");
  }
  if ([port, port + 1].includes(DEMO_API_PORT) || [port, port + 1].includes(DEMO_RENDERER_PORT)) {
    throw new Error("The CDP base port conflicts with a fixed demo service port");
  }
  return port;
}

function assertIsoTimestamp(value) {
  if (typeof value !== "string") {
    throw new Error("Headless demo timestamps must be ISO-8601 UTC strings");
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error("Headless demo timestamps must be ISO-8601 UTC strings");
  }
  return value;
}

function isWithinDirectory(directory, candidate) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(`${resolvedDirectory}${path.sep}`);
}

function normalizeHeadlessCdpUrl(value, expectedPort) {
  if (typeof value !== "string") throw new Error("Headless demo CDP URLs must be strings");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Headless demo CDP URLs must be valid URLs");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== String(expectedPort)
  ) {
    throw new Error("Headless demo CDP URLs must target the expected loopback endpoint");
  }
  return `http://127.0.0.1:${String(expectedPort)}`;
}

function normalizeHeadlessDemoManifest(manifest) {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("Headless demo manifest must be an object");
  }
  if (manifest.version !== HEADLESS_DEMO_MANIFEST_VERSION) {
    throw new Error("Headless demo manifest version is unsupported");
  }
  if (manifest.kind !== HEADLESS_DEMO_MANIFEST_KIND) {
    throw new Error("Headless demo manifest kind is invalid");
  }
  const startedAt = assertIsoTimestamp(manifest.startedAt);
  if (
    typeof manifest.artifactsDirectory !== "string" ||
    !path.isAbsolute(manifest.artifactsDirectory)
  ) {
    throw new Error("Headless demo manifest artifactsDirectory must be an absolute path");
  }
  if (
    !Array.isArray(manifest.clients) ||
    manifest.clients.length !== HEADLESS_DEMO_CLIENT_PROFILES.length
  ) {
    throw new Error("Headless demo manifest must describe both demo clients");
  }

  const firstClient = manifest.clients[0];
  if (
    firstClient === null ||
    typeof firstClient !== "object" ||
    typeof firstClient.cdpUrl !== "string"
  ) {
    throw new Error("Headless demo manifest Claire client is invalid");
  }
  let firstUrl;
  try {
    firstUrl = new URL(firstClient.cdpUrl);
  } catch {
    throw new Error("Headless demo manifest Claire CDP URL is invalid");
  }
  const cdpBasePort = assertHeadlessCdpBasePort(Number(firstUrl.port));
  const clients = HEADLESS_DEMO_CLIENT_PROFILES.map((profile, index) => {
    const client = manifest.clients[index];
    if (client === null || typeof client !== "object" || client.profile !== profile) {
      throw new Error(`Headless demo manifest ${profile} client is invalid`);
    }
    return {
      profile,
      cdpUrl: normalizeHeadlessCdpUrl(client.cdpUrl, cdpBasePort + index),
    };
  });

  return {
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    kind: HEADLESS_DEMO_MANIFEST_KIND,
    startedAt,
    artifactsDirectory: path.resolve(manifest.artifactsDirectory),
    clients,
  };
}

export function demoPaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const stateDirectory = path.join(root, ".dev-data", "demo");
  return {
    projectRoot: root,
    stateDirectory,
    callbackDirectory: path.join(stateDirectory, "auth"),
    desktopUserDataRoot: path.join(stateDirectory, "desktop"),
    artifactRootDirectory: path.join(stateDirectory, "artifacts"),
    headlessSessionManifest: path.join(stateDirectory, "headless-session.json"),
    runMarker: path.join(stateDirectory, "launcher.json"),
  };
}

export function parseCdpBasePort(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("--cdp-base-port must be a TCP port");
  }
  return assertHeadlessCdpBasePort(Number(value));
}

export function parseDemoArguments(arguments_) {
  let headless = false;
  let seedOnly = false;
  let cdpBasePort;
  let postgresMode = DEMO_POSTGRES_MODE_MANAGED;
  let receivedPostgresMode = false;

  for (const argument of arguments_) {
    if (argument === "--headless") {
      if (headless) throw new Error("--headless may only be supplied once");
      headless = true;
      continue;
    }
    if (argument === "--seed-only") {
      if (seedOnly) throw new Error("--seed-only may only be supplied once");
      seedOnly = true;
      continue;
    }
    if (argument.startsWith("--cdp-base-port=")) {
      if (cdpBasePort !== undefined) throw new Error("--cdp-base-port may only be supplied once");
      cdpBasePort = parseCdpBasePort(argument.slice("--cdp-base-port=".length));
      continue;
    }
    if (argument.startsWith("--postgres=")) {
      if (receivedPostgresMode) throw new Error("--postgres may only be supplied once");
      postgresMode = argument.slice("--postgres=".length);
      if (
        postgresMode !== DEMO_POSTGRES_MODE_MANAGED &&
        postgresMode !== DEMO_POSTGRES_MODE_SERVICE
      ) {
        throw new Error("--postgres must be managed or service");
      }
      receivedPostgresMode = true;
      continue;
    }
    throw new Error(`Unknown demo argument: ${argument}`);
  }

  if (headless && seedOnly) {
    throw new Error("--headless cannot be combined with --seed-only");
  }
  if (!headless && cdpBasePort !== undefined) {
    throw new Error("--cdp-base-port requires --headless");
  }

  return {
    headless,
    seedOnly,
    cdpBasePort: cdpBasePort ?? DEFAULT_DEMO_CDP_BASE_PORT,
    postgresMode,
  };
}

export function headlessCdpClients(cdpBasePort = DEFAULT_DEMO_CDP_BASE_PORT) {
  const port = assertHeadlessCdpBasePort(cdpBasePort);
  return HEADLESS_DEMO_CLIENT_PROFILES.map((profile, index) => ({
    profile,
    cdpUrl: `http://127.0.0.1:${String(port + index)}`,
  }));
}

export function headlessElectronArguments(cdpPort) {
  const port = assertTcpPort(cdpPort, "The CDP port");
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${String(port)}`,
    ...HEADLESS_ELECTRON_STABILITY_FLAGS,
  ];
}

export function headlessElectronViteArguments(cdpPort) {
  const port = assertTcpPort(cdpPort, "The CDP port");
  return [
    `--remoteDebuggingPort=${String(port)}`,
    "--",
    "--remote-debugging-address=127.0.0.1",
    ...HEADLESS_ELECTRON_STABILITY_FLAGS,
  ];
}

export function deriveHeadlessDesktopEnvironment(
  baseEnv,
  { profile, callbackFile, cdpPort, artifactsDirectory },
) {
  if (!HEADLESS_DEMO_CLIENT_PROFILES.includes(profile)) {
    throw new Error("Headless demo desktop profile is invalid");
  }
  if (typeof callbackFile !== "string" || callbackFile === "") {
    throw new Error("Headless demo auth callback file is required");
  }
  if (typeof artifactsDirectory !== "string" || !path.isAbsolute(artifactsDirectory)) {
    throw new Error("Headless demo artifacts directory must be absolute");
  }
  assertTcpPort(cdpPort, "The CDP port");
  const environment = { ...baseEnv };
  delete environment.ELECTRON_CLI_ARGS;
  delete environment.REMOTE_DEBUGGING_PORT;
  return {
    ...environment,
    HYPE_COMMS_DESKTOP_HEADLESS: "1",
    HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED: "1",
    HYPE_COMMS_DESKTOP_PROFILE: profile,
    HYPE_COMMS_DEVELOPMENT_AUTH_CALLBACK_FILE: callbackFile,
    [HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]: path.resolve(artifactsDirectory),
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1",
  };
}

export function createHeadlessDemoRunId(startedAt, pid) {
  const timestamp = assertIsoTimestamp(startedAt);
  if (!Number.isInteger(pid) || pid < 1) throw new Error("Headless demo PID is invalid");
  return `${timestamp.replace(/[:.]/g, "-")}-${String(pid)}`;
}

export function headlessArtifactDirectory(paths, runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error("Headless demo run ID is invalid");
  }
  const directory = path.join(paths.artifactRootDirectory, runId);
  if (!isWithinDirectory(paths.artifactRootDirectory, directory)) {
    throw new Error("Headless demo artifacts must remain under the demo artifact directory");
  }
  return directory;
}

function headlessProfileDirectory(paths, profile) {
  const directory = path.join(paths.desktopUserDataRoot, profile);
  if (!isWithinDirectory(paths.desktopUserDataRoot, directory)) {
    throw new Error("Headless demo profile must remain under the demo desktop data directory");
  }
  return directory;
}

/**
 * Electron writes DevToolsActivePort beside each development profile while CDP is live. Keep
 * those files under the already-private profile directories and remove them on every run edge so
 * a stopped demo never leaves a reusable endpoint reference behind.
 */
export function headlessDevToolsActivePortFiles(paths) {
  return HEADLESS_DEMO_CLIENT_PROFILES.map((profile) =>
    path.join(headlessProfileDirectory(paths, profile), "DevToolsActivePort"),
  );
}

export async function ensurePrivateHeadlessProfileDirectories(paths) {
  for (const profile of HEADLESS_DEMO_CLIENT_PROFILES) {
    const directory = headlessProfileDirectory(paths, profile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function removeHeadlessDevToolsActivePortFiles(paths) {
  await Promise.all(
    headlessDevToolsActivePortFiles(paths).map(async (file) => {
      await unlink(file).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }),
  );
}

export function createHeadlessDemoManifest(paths, { cdpBasePort, startedAt, artifactsDirectory }) {
  if (typeof artifactsDirectory !== "string") {
    throw new Error("Headless demo artifacts directory is invalid");
  }
  const directory = path.resolve(artifactsDirectory);
  if (!isWithinDirectory(paths.artifactRootDirectory, directory)) {
    throw new Error("Headless demo artifacts must remain under the demo artifact directory");
  }
  return normalizeHeadlessDemoManifest({
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    kind: HEADLESS_DEMO_MANIFEST_KIND,
    startedAt,
    artifactsDirectory: directory,
    clients: headlessCdpClients(cdpBasePort),
  });
}

export function serializeHeadlessDemoManifest(manifest) {
  return `${JSON.stringify(normalizeHeadlessDemoManifest(manifest))}\n`;
}

export function createHeadlessDemoReadyRecord(paths, manifest) {
  const normalizedManifest = normalizeHeadlessDemoManifest(manifest);
  return {
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    event: "ready",
    manifestPath: path.resolve(paths.headlessSessionManifest),
    clients: normalizedManifest.clients,
  };
}

export function deriveDemoEnvironment(
  baseEnv,
  projectRoot,
  postgresMode = DEMO_POSTGRES_MODE_MANAGED,
) {
  if (postgresMode !== DEMO_POSTGRES_MODE_MANAGED && postgresMode !== DEMO_POSTGRES_MODE_SERVICE) {
    throw new Error("Demo PostgreSQL mode must be managed or service");
  }
  const password = baseEnv.HYPE_COMMS_POSTGRES_PASSWORD?.trim() ?? "";
  if (password === "") throw new Error("HYPE_COMMS_POSTGRES_PASSWORD is required for the demo");
  const portText =
    postgresMode === DEMO_POSTGRES_MODE_SERVICE
      ? "5432"
      : (baseEnv.HYPE_COMMS_DEMO_POSTGRES_BIND_PORT?.trim() ??
        String(DEFAULT_DEMO_POSTGRES_BIND_PORT));
  if (!/^[0-9]+$/.test(portText)) {
    throw new Error("HYPE_COMMS_DEMO_POSTGRES_BIND_PORT must be a TCP port");
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HYPE_COMMS_DEMO_POSTGRES_BIND_PORT must be a TCP port");
  }

  const databaseUrl = new URL(
    postgresMode === DEMO_POSTGRES_MODE_SERVICE
      ? "postgres://postgres:5432/hype_comms_demo_test"
      : `postgres://127.0.0.1:${String(port)}/hype_comms`,
  );
  databaseUrl.username = "hype_comms";
  databaseUrl.password = password;
  const paths = demoPaths(projectRoot);
  const env = {
    ...baseEnv,
    NODE_ENV: "development",
    HYPE_COMMS_DATABASE_URL: databaseUrl.toString(),
    HYPE_COMMS_API_ORIGIN: `http://127.0.0.1:${String(DEMO_API_PORT)}`,
    HYPE_COMMS_PORT: String(DEMO_API_PORT),
    HYPE_COMMS_POSTGRES_BIND_PORT: String(port),
    HYPE_COMMS_DEMO_POSTGRES_BIND_PORT: String(port),
    HYPE_COMMS_DEMO_CALLBACK_DIRECTORY: paths.callbackDirectory,
  };
  delete env.HYPE_COMMS_OWNER_EMAIL;
  delete env.HYPE_COMMS_WORKSPACE_NAME;
  delete env.HYPE_COMMS_WORKSPACE_SLUG;
  // A normal demo must remain interactive even when a caller's shell has automation settings.
  // The headless launcher adds its own pinned CDP configuration after this normalization.
  delete env.HYPE_COMMS_DESKTOP_HEADLESS;
  delete env.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED;
  delete env[HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV];
  delete env.ELECTRON_CLI_ARGS;
  delete env.REMOTE_DEBUGGING_PORT;
  return {
    env,
    port,
    databaseUrl: databaseUrl.toString(),
    managesPostgres: postgresMode === DEMO_POSTGRES_MODE_MANAGED,
    paths,
  };
}

export function demoComposeArguments(...arguments_) {
  return ["compose", "--project-name", DEMO_COMPOSE_PROJECT, ...arguments_];
}

export async function ensurePrivateDemoDirectories(paths) {
  for (const directory of [
    paths.stateDirectory,
    paths.callbackDirectory,
    paths.desktopUserDataRoot,
    paths.artifactRootDirectory,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

export async function ensurePrivateHeadlessArtifactDirectory(paths, runId) {
  const directory = headlessArtifactDirectory(paths, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

export async function writePrivateFile(file, contents) {
  await rm(file, { force: true });
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
}

export async function writeHeadlessDemoManifest(paths, manifest) {
  await writePrivateFile(paths.headlessSessionManifest, serializeHeadlessDemoManifest(manifest));
}

export async function removeHeadlessDemoManifest(paths) {
  await unlink(paths.headlessSessionManifest).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

export async function readRunMarker(marker) {
  try {
    const parsed = JSON.parse(await readFile(marker, "utf8"));
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export async function writeRunMarker(marker) {
  const existing = await readRunMarker(marker);
  if (existing !== null && processIsAlive(existing.pid)) {
    throw new Error(`A demo launcher is already running with PID ${String(existing.pid)}`);
  }
  await writePrivateFile(
    marker,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
}

export async function removeOwnedRunMarker(marker) {
  const current = await readRunMarker(marker);
  if (current?.pid === process.pid) await unlink(marker).catch(() => undefined);
}

export async function assertDemoCanReset(paths) {
  const marker = await readRunMarker(paths.runMarker);
  if (marker !== null && processIsAlive(marker.pid)) {
    throw new Error(`Refusing to reset while demo launcher PID ${String(marker.pid)} is active`);
  }
  const expected = path.join(paths.projectRoot, ".dev-data", "demo");
  if (path.resolve(paths.stateDirectory) !== expected) {
    throw new Error("Refusing to remove an unexpected demo state directory");
  }
  try {
    const details = await stat(paths.stateDirectory);
    if (!details.isDirectory()) throw new Error("Demo state target is not a directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/** `close`, unlike `exit`, guarantees that captured stdout and stderr have finished draining. */
export async function waitForChildClose(child) {
  const [code, signal] = await once(child, "close");
  return { code, signal };
}
