import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_LOCAL_SMOKE_TIMEOUT_MS,
  parseLocalHeadlessSmokeArguments,
  runLocalHeadlessSmoke,
  stopHeadlessDemoLauncher,
  waitForHeadlessDemoReady,
} from "./demo-headless-local-smoke.mjs";
import {
  DEFAULT_MANIFEST_RELATIVE_PATH,
  HEADLESS_DEMO_MANIFEST_VERSION,
  HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
  HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
} from "./demo-headless-smoke.mjs";

function launcher() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = undefined;
  child.stdout = new PassThrough();
  child.kill = () => true;
  return child;
}

test("parses the self-contained local smoke command options", () => {
  assert.deepEqual(parseLocalHeadlessSmokeArguments([]), {
    cdpBasePort: 9222,
    messagePrefix: "Hype Comms headless automation smoke",
    timeoutMs: DEFAULT_LOCAL_SMOKE_TIMEOUT_MS,
    flow: HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
  });
  assert.deepEqual(
    parseLocalHeadlessSmokeArguments([
      "--cdp-base-port=9410",
      "--message=Round trip",
      "--timeout-ms=5000",
    ]),
    {
      cdpBasePort: 9410,
      messagePrefix: "Round trip",
      timeoutMs: 5000,
      flow: HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
    },
  );
  assert.throws(
    () => parseLocalHeadlessSmokeArguments(["--manifest=/tmp/session.json"]),
    /Usage:/u,
  );
  assert.throws(() => parseLocalHeadlessSmokeArguments(["--timeout-ms=0"]), /positive integer/u);
  assert.equal(
    parseLocalHeadlessSmokeArguments(["--flow=participated-thread"]).flow,
    HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
  );
});

test("waits for the versioned ready record and ignores normal launcher output", async () => {
  const child = launcher();
  const manifestPath = path.resolve("/tmp/hype-comms-headless-session.json");
  const output = [];
  const ready = waitForHeadlessDemoReady(child, {
    expectedManifestPath: manifestPath,
    timeoutMs: 100,
    writeOutput: (chunk) => output.push(chunk),
  });

  child.stdout.write("Starting the isolated demo PostgreSQL container…\n");
  child.stdout.write(
    `${JSON.stringify({
      version: HEADLESS_DEMO_MANIFEST_VERSION,
      event: "ready",
      manifestPath,
      clients: [],
    })}\n`,
  );

  assert.deepEqual(await ready, { manifestPath });
  assert.equal(output[0], "Starting the isolated demo PostgreSQL container…\n");
  assert.match(output[1], /"event":"ready"/u);
});

test("launches, attaches through the ready manifest, runs the smoke, and always stops the launcher", async () => {
  const projectRoot = path.resolve("/repo/hype-comms");
  const manifestPath = path.join(projectRoot, DEFAULT_MANIFEST_RELATIVE_PATH);
  const child = launcher();
  const calls = [];
  const manifest = { private: "manifest-only" };

  const resultPromise = runLocalHeadlessSmoke({
    projectRoot,
    environment: { HYPE_COMMS_POSTGRES_PASSWORD: "local-only" },
    cdpBasePort: 9410,
    messagePrefix: "Round trip",
    timeoutMs: 5000,
    nodeCommand: "node-test",
    spawnProcess: (command, arguments_, options) => {
      calls.push(["spawn", command, arguments_, options]);
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            version: HEADLESS_DEMO_MANIFEST_VERSION,
            event: "ready",
            manifestPath,
          })}\n`,
        );
      });
      return child;
    },
    readManifest: async (receivedPath) => {
      calls.push(["read", receivedPath]);
      return manifest;
    },
    runSmoke: async (options) => {
      calls.push(["smoke", options]);
      return { version: 1, event: "passed", artifacts: { screenshotPath: "/tmp/a.png" } };
    },
    stopLauncher: async (receivedLauncher) => {
      calls.push(["stop", receivedLauncher]);
    },
    writeOutput: () => {},
  });

  assert.deepEqual(await resultPromise, {
    version: 1,
    event: "passed",
    artifacts: { screenshotPath: "/tmp/a.png" },
    manifestPath,
  });
  assert.deepEqual(calls, [
    [
      "spawn",
      "node-test",
      ["scripts/demo.mjs", "--headless", "--cdp-base-port=9410"],
      {
        cwd: projectRoot,
        detached: process.platform !== "win32",
        env: { HYPE_COMMS_POSTGRES_PASSWORD: "local-only" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    ],
    ["read", manifestPath],
    [
      "smoke",
      {
        manifest,
        messagePrefix: "Round trip",
        timeoutMs: 5000,
      },
    ],
    ["stop", child],
  ]);
});

test("selects the isolated participated-thread smoke without changing the default flow", async () => {
  const projectRoot = path.resolve("/repo/hype-comms");
  const manifestPath = path.join(projectRoot, DEFAULT_MANIFEST_RELATIVE_PATH);
  const child = launcher();
  const selected = [];

  const result = await runLocalHeadlessSmoke({
    projectRoot,
    flow: HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
    spawnProcess: () => child,
    waitForReady: async () => ({ manifestPath }),
    readManifest: async () => ({ private: "manifest-only" }),
    runDirectMessageSmoke: async () => {
      throw new Error("default smoke must not run");
    },
    runParticipatedThreadSmoke: async (options) => {
      selected.push(options);
      return { version: 1, event: "passed", flow: HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD };
    },
    stopLauncher: async () => undefined,
  });

  assert.deepEqual(selected, [
    {
      manifest: { private: "manifest-only" },
      messagePrefix: "Hype Comms headless automation smoke",
      timeoutMs: DEFAULT_LOCAL_SMOKE_TIMEOUT_MS,
    },
  ]);
  assert.equal(result.flow, HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD);
  await assert.rejects(
    runLocalHeadlessSmoke({ projectRoot, flow: "locally-inferred-thread" }),
    /Headless smoke flow must be/u,
  );
});

test("stops the launcher when the attached smoke fails", async () => {
  const projectRoot = path.resolve("/repo/hype-comms");
  const child = launcher();
  let stopped = false;

  await assert.rejects(
    runLocalHeadlessSmoke({
      projectRoot,
      spawnProcess: () => child,
      waitForReady: async () => ({
        manifestPath: path.join(projectRoot, DEFAULT_MANIFEST_RELATIVE_PATH),
      }),
      readManifest: async () => ({ private: "manifest-only" }),
      runSmoke: async () => {
        throw new Error("renderer assertion failed");
      },
      stopLauncher: async () => {
        stopped = true;
      },
      writeOutput: () => {},
    }),
    /renderer assertion failed/u,
  );
  assert.equal(stopped, true);
});

test("sends the local demo launcher SIGTERM before returning", async () => {
  const child = launcher();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.exitCode = 0;
    return true;
  };

  await stopHeadlessDemoLauncher(child, { timeoutMs: 10 });
  assert.deepEqual(signals, ["SIGTERM"]);
});
