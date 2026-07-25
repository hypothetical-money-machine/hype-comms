import { constants } from "node:fs";
import { once } from "node:events";
import { chmod, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const DEMO_COMPOSE_PROJECT = "hmm-chat-demo";
export const DEFAULT_DEMO_POSTGRES_BIND_PORT = 54330;

export function demoPaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const stateDirectory = path.join(root, ".dev-data", "demo");
  return {
    projectRoot: root,
    stateDirectory,
    callbackDirectory: path.join(stateDirectory, "auth"),
    desktopUserDataRoot: path.join(stateDirectory, "desktop"),
    runMarker: path.join(stateDirectory, "launcher.json"),
  };
}

export function deriveDemoEnvironment(baseEnv, projectRoot) {
  const password = baseEnv.HMM_POSTGRES_PASSWORD?.trim() ?? "";
  if (password === "") throw new Error("HMM_POSTGRES_PASSWORD is required for the demo");
  const portText =
    baseEnv.HMM_DEMO_POSTGRES_BIND_PORT?.trim() ?? String(DEFAULT_DEMO_POSTGRES_BIND_PORT);
  if (!/^[0-9]+$/.test(portText)) {
    throw new Error("HMM_DEMO_POSTGRES_BIND_PORT must be a TCP port");
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HMM_DEMO_POSTGRES_BIND_PORT must be a TCP port");
  }

  const databaseUrl = new URL(`postgres://127.0.0.1:${String(port)}/hmm_chat`);
  databaseUrl.username = "hmm";
  databaseUrl.password = password;
  const paths = demoPaths(projectRoot);
  const env = {
    ...baseEnv,
    NODE_ENV: "development",
    HMM_DATABASE_URL: databaseUrl.toString(),
    HMM_POSTGRES_BIND_PORT: String(port),
    HMM_DEMO_POSTGRES_BIND_PORT: String(port),
    HMM_DEMO_CALLBACK_DIRECTORY: paths.callbackDirectory,
  };
  delete env.HMM_OWNER_EMAIL;
  delete env.HMM_WORKSPACE_NAME;
  delete env.HMM_WORKSPACE_SLUG;
  return { env, port, databaseUrl: databaseUrl.toString(), paths };
}

export function demoComposeArguments(...arguments_) {
  return ["compose", "--project-name", DEMO_COMPOSE_PROJECT, ...arguments_];
}

export async function ensurePrivateDemoDirectories(paths) {
  for (const directory of [
    paths.stateDirectory,
    paths.callbackDirectory,
    paths.desktopUserDataRoot,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
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
