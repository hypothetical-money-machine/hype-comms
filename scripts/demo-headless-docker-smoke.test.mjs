import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDockerHeadlessRunId,
  dockerHeadlessComposeArguments,
  dockerHeadlessProjectName,
  parseDockerHeadlessSmokeArguments,
  runCommand,
  runDockerHeadlessFlow,
} from "./demo-headless-docker-smoke.mjs";
import {
  HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
  HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
} from "./demo-headless-smoke.mjs";

test("runs both Linux headless flows by default and accepts one explicit flow", () => {
  assert.deepEqual(parseDockerHeadlessSmokeArguments([]), {
    flows: [HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE, HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD],
  });
  assert.deepEqual(parseDockerHeadlessSmokeArguments(["--flow=direct-message"]), {
    flows: [HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE],
  });
  assert.throws(
    () => parseDockerHeadlessSmokeArguments(["--flow=unknown"]),
    /all, direct-message, or participated-thread/u,
  );
  assert.throws(
    () => parseDockerHeadlessSmokeArguments(["--flow=all", "--flow=direct-message"]),
    /only be supplied once/u,
  );
});

test("creates bounded unique Compose project names and exact file arguments", () => {
  const runId = createDockerHeadlessRunId(new Date("2026-08-30T20:00:00.000Z"), 4321);
  assert.equal(runId, "20260830t200000000z-4321");
  assert.equal(
    dockerHeadlessProjectName(runId, HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE),
    "hype-comms-headless-20260830t200000000z-4321-dm",
  );
  assert.deepEqual(dockerHeadlessComposeArguments("/repo", "headless-1", "down"), [
    "compose",
    "--file",
    path.join("/repo", "docker-compose.headless.yml"),
    "--project-name",
    "headless-1",
    "down",
  ]);
});

test("terminates the active Docker command and preserves the abort reason", async () => {
  const controller = new AbortController();
  const abortReason = new Error("test interruption");
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };

  const command = runCommand("docker", ["compose", "up"], {
    signal: controller.signal,
    spawnProcess: () => child,
  });
  controller.abort(abortReason);

  await assert.rejects(command, (error) => error === abortReason);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("always tears down the exact Compose project after a smoke failure", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "hype-comms-headless-docker-"));
  const calls = [];
  const execute = async (_command, arguments_, options) => {
    calls.push({ arguments_, options });
    if (arguments_.includes("up")) throw new Error("smoke failed");
    if (arguments_.includes("cp")) throw new Error("no artifacts yet");
  };

  await assert.rejects(
    runDockerHeadlessFlow({
      projectRoot,
      runId: "run-123",
      flow: HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
      execute,
      writeOutput: () => undefined,
    }),
    /smoke failed/u,
  );
  assert.equal(
    calls.some(({ arguments_ }) => arguments_.includes("down")),
    true,
  );
  const downCall = calls.find(({ arguments_ }) => arguments_.includes("down"));
  assert.notEqual(downCall, undefined);
  assert.deepEqual(downCall.arguments_.slice(-7), [
    "down",
    "--volumes",
    "--remove-orphans",
    "--rmi",
    "local",
    "--timeout",
    "10",
  ]);
  const projects = calls.map(
    ({ arguments_ }) => arguments_[arguments_.indexOf("--project-name") + 1],
  );
  assert.deepEqual(new Set(projects), new Set(["hype-comms-headless-run-123-dm"]));
  await rm(projectRoot, { recursive: true, force: true });
});

test("keeps the Docker smoke internal and disposable with a restricted application service", async () => {
  const [compose, dockerfile, dockerignore, packageJson] = await Promise.all([
    readFile(new URL("../docker-compose.headless.yml", import.meta.url), "utf8"),
    readFile(new URL("./headless-linux.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("./headless-linux.Dockerfile.dockerignore", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const smokeService = compose.split(/^ {2}smoke:\n/mu)[1]?.split(/^\S/mu)[0];

  assert.ok(smokeService);
  assert.match(compose, /hype_comms_demo_test/u);
  assert.match(compose, /tmpfs:\n\s+- \/var\/lib\/postgresql\/data/u);
  assert.match(compose, /condition: service_healthy/u);
  assert.match(smokeService, /user: node/u);
  assert.match(smokeService, /cap_drop:\n\s+- ALL/u);
  assert.match(smokeService, /no-new-privileges:true/u);
  assert.match(compose, /internal: true/u);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock|privileged:|^\s+ports:/mu);
  assert.doesNotMatch(compose, /^\s+image: hype-comms-headless-smoke:/mu);

  assert.match(dockerfile, /FROM node:24\.18\.0-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.match(dockerfile, /dbus-run-session/u);
  assert.match(dockerfile, /xvfb-run/u);
  assert.match(dockerfile, /install-electron --no/u);
  assert.match(dockerfile, /playwright install ffmpeg/u);
  assert.match(dockerfile, /^USER node$/mu);
  assert.match(dockerignore, /^\.env\.\*$/mu);
  assert.match(dockerignore, /^\.audit$/mu);
  assert.doesNotMatch(dockerignore, /^scripts$|^apps\/desktop\/src$/mu);
  assert.equal(
    JSON.parse(packageJson).scripts["test:demo:headless:linux"],
    "node scripts/demo-headless-docker-smoke.mjs",
  );
});
