import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import {
  createHeadlessDemoManifest,
  createHeadlessDemoReadyRecord,
  createHeadlessDemoRunId,
  DEMO_API_PORT,
  DEMO_RENDERER_PORT,
  demoComposeArguments,
  deriveDemoEnvironment,
  deriveHeadlessDesktopEnvironment,
  ensurePrivateDemoDirectories,
  ensurePrivateHeadlessArtifactDirectory,
  ensurePrivateHeadlessProfileDirectories,
  headlessCdpClients,
  headlessElectronArguments,
  headlessElectronViteArguments,
  parseDemoArguments,
  removeHeadlessDevToolsActivePortFiles,
  removeHeadlessDemoManifest,
  removeOwnedRunMarker,
  waitForChildClose,
  writeHeadlessDemoManifest,
  writeRunMarker,
} from "./demo-environment.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const rendererUrl = `http://127.0.0.1:${String(DEMO_RENDERER_PORT)}`;
const managedChildren = new Set();
let shuttingDown = false;
let stopChildrenPromise = null;
let shutdownSignal = null;
let activeRunMarker = null;
let activeHeadlessDemoPaths = null;
let resolveInterruption;
const interrupted = new Promise((resolve) => {
  resolveInterruption = resolve;
});

function shutdownError() {
  return new Error(`Demo interrupted by ${shutdownSignal ?? "a shutdown signal"}`);
}

function throwIfShutdownRequested() {
  if (shutdownSignal !== null) throw shutdownError();
}

function spawnManaged(command, arguments_, options = {}) {
  throwIfShutdownRequested();
  const child = spawn(command, arguments_, {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: options.capture === true ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  managedChildren.add(child);
  child.once("close", () => managedChildren.delete(child));
  return child;
}

async function assertPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      const detail =
        error instanceof Error && "code" in error && error.code === "EADDRINUSE"
          ? `${label} port ${String(port)} is already in use`
          : `Could not reserve ${label} port ${String(port)}`;
      reject(new Error(detail));
    });
    probe.listen({ host: "127.0.0.1", port }, () => probe.close(resolve));
  });
}

async function assertHeadlessCdpPortsAvailable(cdpBasePort) {
  await Promise.all(
    headlessCdpClients(cdpBasePort).map(async ({ profile, cdpUrl }) => {
      const port = Number(new URL(cdpUrl).port);
      await assertPortAvailable(port, `${profile} CDP`);
    }),
  );
}

async function runChecked(command, arguments_, options = {}) {
  const child = spawnManaged(command, arguments_, options);
  let stdout = "";
  if (options.capture === true) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
  }
  const { code, signal } = await waitForChildClose(child);
  if (code !== 0) {
    const detail = signal === null ? `code ${String(code)}` : `signal ${String(signal)}`;
    throw new Error(`${command} ${arguments_.join(" ")} exited with ${detail}`);
  }
  return stdout;
}

async function waitForHttp(url, label, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} process exited before becoming ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function resolveElectronExecutable() {
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const electronPath = require("electron");
  if (typeof electronPath !== "string") {
    throw new TypeError("Electron executable path is unavailable");
  }
  return electronPath;
}

async function waitForHeadlessWorkspace(manifest) {
  const { waitForHeadlessClients } = await import("./agent-capture.mjs");
  const readinessController = new AbortController();
  void interrupted.then(() => readinessController.abort(shutdownError()));
  try {
    await waitForHeadlessClients(manifest, {
      signal: readinessController.signal,
      timeoutMs: 30_000,
    });
  } finally {
    readinessController.abort();
  }
  throwIfShutdownRequested();
}

function demoClient(seed, profile) {
  const client = seed.clients?.find((candidate) => candidate.profile === profile);
  if (
    client === undefined ||
    typeof client.displayName !== "string" ||
    typeof client.callbackFile !== "string"
  ) {
    throw new Error(`Demo seed did not return the ${profile} client`);
  }
  return client;
}

function waitForChildrenToClose(children) {
  const activeChildren = children.filter((child) => child.exitCode === null);
  if (activeChildren.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.allSettled(activeChildren.map((child) => once(child, "close"))),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

function stopChildren(signal = "SIGTERM") {
  if (stopChildrenPromise !== null) return stopChildrenPromise;
  stopChildrenPromise = (async () => {
    shuttingDown = true;
    const children = [...managedChildren];
    await Promise.all(children.map((child) => signalProcessTree(child, signal)));
    await waitForChildrenToClose(children);
    await Promise.all(children.map((child) => signalProcessTree(child, "SIGKILL")));
    await waitForChildrenToClose(children);
  })();
  return stopChildrenPromise;
}

function requestShutdown(signal) {
  if (shutdownSignal !== null) return;
  shutdownSignal = signal;
  resolveInterruption("signal");
  void stopChildren();
}

async function seed(demo) {
  await runChecked(npmCommand, ["run", "build", "--workspace", "@hype-comms/contracts"], {
    env: demo.env,
  });
  const seedOutput = await runChecked(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "apps/server/src/dev-seed.ts"],
    { capture: true, env: demo.env },
  );
  try {
    return JSON.parse(seedOutput);
  } catch {
    throw new Error("Demo seed returned an invalid response");
  }
}

async function main() {
  const options = parseDemoArguments(process.argv.slice(2));
  const demo = deriveDemoEnvironment(process.env, projectRoot);
  await ensurePrivateDemoDirectories(demo.paths);
  await writeRunMarker(demo.paths.runMarker);
  activeRunMarker = demo.paths.runMarker;
  if (options.headless) {
    activeHeadlessDemoPaths = demo.paths;
    await ensurePrivateHeadlessProfileDirectories(demo.paths);
    await Promise.all([
      removeHeadlessDemoManifest(demo.paths),
      removeHeadlessDevToolsActivePortFiles(demo.paths),
    ]);
  }
  process.stdout.write("Starting the isolated demo PostgreSQL container…\n");
  await runChecked("docker", demoComposeArguments("up", "-d", "--wait", "postgres"), {
    env: demo.env,
  });

  const seeded = await seed(demo);
  const claire = demoClient(seeded, "claire");
  const woots = demoClient(seeded, "woots");
  process.stdout.write(
    `Seeded ${String(seeded.messageCount)} messages across ${String(seeded.channels?.length)} channels.\n`,
  );
  if (options.seedOnly) {
    process.stdout.write(`Callback files: ${claire.callbackFile}, ${woots.callbackFile}\n`);
    return;
  }

  await assertPortAvailable(DEMO_API_PORT, "chat API");
  await assertPortAvailable(DEMO_RENDERER_PORT, "renderer");
  if (options.headless) await assertHeadlessCdpPortsAvailable(options.cdpBasePort);
  const server = spawnManaged(npmCommand, ["run", "dev:server"], { env: demo.env });
  await waitForHttp(`http://127.0.0.1:${String(DEMO_API_PORT)}/readyz`, "chat API", server);

  const desktopEnvironment = {
    ...demo.env,
    HMM_DEVELOPMENT_USER_DATA_ROOT: demo.paths.desktopUserDataRoot,
    ...(options.headless ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
  };
  let headlessManifest = null;
  if (options.headless) {
    const startedAt = new Date().toISOString();
    headlessManifest = createHeadlessDemoManifest(demo.paths, {
      cdpBasePort: options.cdpBasePort,
      startedAt,
      artifactsDirectory: await ensurePrivateHeadlessArtifactDirectory(
        demo.paths,
        createHeadlessDemoRunId(startedAt, process.pid),
      ),
    });
  }
  const claireDesktop = spawnManaged(
    npmCommand,
    headlessManifest === null
      ? ["run", "dev:desktop"]
      : [
          "run",
          "dev",
          "--workspace",
          "@hype-comms/desktop",
          "--",
          ...headlessElectronViteArguments(options.cdpBasePort),
        ],
    {
      env:
        headlessManifest === null
          ? {
              ...desktopEnvironment,
              HMM_DESKTOP_PROFILE: "claire",
              HMM_DEVELOPMENT_AUTH_CALLBACK_FILE: claire.callbackFile,
            }
          : deriveHeadlessDesktopEnvironment(desktopEnvironment, {
              profile: "claire",
              callbackFile: claire.callbackFile,
              cdpPort: options.cdpBasePort,
              artifactsDirectory: headlessManifest.artifactsDirectory,
            }),
    },
  );
  await waitForHttp(`${rendererUrl}/`, "desktop renderer", claireDesktop);
  const wootsDesktop =
    headlessManifest === null
      ? spawnManaged(process.execPath, ["scripts/dev-join.mjs", "--profile=woots"], {
          env: {
            ...desktopEnvironment,
            HMM_DEVELOPMENT_AUTH_CALLBACK_FILE: woots.callbackFile,
          },
        })
      : spawnManaged(
          resolveElectronExecutable(),
          ["apps/desktop", ...headlessElectronArguments(options.cdpBasePort + 1)],
          {
            env: deriveHeadlessDesktopEnvironment(desktopEnvironment, {
              profile: "woots",
              callbackFile: woots.callbackFile,
              cdpPort: options.cdpBasePort + 1,
              artifactsDirectory: headlessManifest.artifactsDirectory,
            }),
          },
        );

  const clientClosed = (child, label) =>
    once(child, "close").then(() => {
      if (!shuttingDown) process.stderr.write(`${label} client closed.\n`);
    });
  const bothClientsClosed = Promise.all([
    clientClosed(claireDesktop, "Claire"),
    clientClosed(wootsDesktop, "Woots"),
  ]).then(() => "clients");
  const serverClosed = once(server, "close").then(() => "server");

  if (headlessManifest === null) {
    process.stdout.write("Demo ready: Claire and Woots are signed in on isolated clients.\n");
  } else {
    await waitForHeadlessWorkspace(headlessManifest);
    await writeHeadlessDemoManifest(demo.paths, headlessManifest);
    process.stdout.write(
      `${JSON.stringify(createHeadlessDemoReadyRecord(demo.paths, headlessManifest))}\n`,
    );
  }
  const stop = await Promise.race([bothClientsClosed, serverClosed, interrupted]);
  if (stop === "server") throw new Error("The demo API stopped while a client was still open");
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

void main()
  .catch((error) => {
    process.stderr.write(
      `Could not start demo: ${error instanceof Error ? error.message : "Unknown error"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopChildren();
    if (activeHeadlessDemoPaths !== null) {
      await Promise.all([
        removeHeadlessDemoManifest(activeHeadlessDemoPaths),
        removeHeadlessDevToolsActivePortFiles(activeHeadlessDemoPaths),
      ]);
    }
    if (activeRunMarker !== null) await removeOwnedRunMarker(activeRunMarker);
  });
