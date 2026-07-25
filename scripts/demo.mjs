import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import {
  demoComposeArguments,
  deriveDemoEnvironment,
  ensurePrivateDemoDirectories,
  removeOwnedRunMarker,
  waitForChildClose,
  writeRunMarker,
} from "./demo-environment.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const managedChildren = new Set();
let shuttingDown = false;
let activeRunMarker = null;

function spawnManaged(command, arguments_, options = {}) {
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

function signalChild(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function stopChildren(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  const children = [...managedChildren];
  for (const child of children) signalChild(child, signal);
  await Promise.race([
    Promise.allSettled(children.map((child) => once(child, "close"))),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  for (const child of children) signalChild(child, "SIGKILL");
}

async function seed(demo) {
  await runChecked(npmCommand, ["run", "build", "--workspace", "@hmm-chat/contracts"], {
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
  const demo = deriveDemoEnvironment(process.env, projectRoot);
  await ensurePrivateDemoDirectories(demo.paths);
  await writeRunMarker(demo.paths.runMarker);
  activeRunMarker = demo.paths.runMarker;
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
  if (process.argv.includes("--seed-only")) {
    process.stdout.write(`Callback files: ${claire.callbackFile}, ${woots.callbackFile}\n`);
    return;
  }

  await assertPortAvailable(3000, "chat API");
  await assertPortAvailable(5173, "renderer");
  const server = spawnManaged(npmCommand, ["run", "dev:server"], { env: demo.env });
  await waitForHttp("http://127.0.0.1:3000/readyz", "chat API", server);

  const desktopEnvironment = {
    ...demo.env,
    HMM_DEVELOPMENT_USER_DATA_ROOT: demo.paths.desktopUserDataRoot,
  };
  const claireDesktop = spawnManaged(npmCommand, ["run", "dev:desktop"], {
    env: {
      ...desktopEnvironment,
      HMM_DESKTOP_PROFILE: "claire",
      HMM_DEVELOPMENT_AUTH_CALLBACK_FILE: claire.callbackFile,
    },
  });
  await waitForHttp("http://127.0.0.1:5173/", "desktop renderer", claireDesktop);
  const wootsDesktop = spawnManaged(process.execPath, ["scripts/dev-join.mjs", "--profile=woots"], {
    env: {
      ...desktopEnvironment,
      HMM_DEVELOPMENT_AUTH_CALLBACK_FILE: woots.callbackFile,
    },
  });

  const clientClosed = (child, label) =>
    once(child, "close").then(() => {
      if (!shuttingDown) process.stderr.write(`${label} client closed.\n`);
    });
  const bothClientsClosed = Promise.all([
    clientClosed(claireDesktop, "Claire"),
    clientClosed(wootsDesktop, "Woots"),
  ]).then(() => "clients");
  const serverClosed = once(server, "close").then(() => "server");
  const interrupted = Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]).then(
    () => "signal",
  );

  process.stdout.write("Demo ready: Claire and Woots are signed in on isolated clients.\n");
  const stop = await Promise.race([bothClientsClosed, serverClosed, interrupted]);
  if (stop === "server") throw new Error("The demo API stopped while a client was still open");
}

void main()
  .catch((error) => {
    process.stderr.write(
      `Could not start demo: ${error instanceof Error ? error.message : "Unknown error"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopChildren();
    if (activeRunMarker !== null) await removeOwnedRunMarker(activeRunMarker);
  });
