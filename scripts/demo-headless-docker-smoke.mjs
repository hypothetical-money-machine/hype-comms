import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE,
  HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
} from "./demo-headless-smoke.mjs";

export const HEADLESS_DOCKER_SMOKE_FLOW_ALL = "all";
const COMPOSE_FILE = "docker-compose.headless.yml";
const CONTAINER_ARTIFACT_DIRECTORY = "/workspace/.dev-data/demo/artifacts/.";

export function parseDockerHeadlessSmokeArguments(arguments_) {
  let flow = HEADLESS_DOCKER_SMOKE_FLOW_ALL;
  let receivedFlow = false;

  for (const argument of arguments_) {
    if (!argument.startsWith("--flow=")) {
      throw new Error(
        "Usage: test:demo:headless:linux [--flow=<all|direct-message|participated-thread>]",
      );
    }
    if (receivedFlow) throw new Error("--flow may only be supplied once");
    flow = argument.slice("--flow=".length);
    if (
      flow !== HEADLESS_DOCKER_SMOKE_FLOW_ALL &&
      flow !== HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE &&
      flow !== HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD
    ) {
      throw new Error("--flow must be all, direct-message, or participated-thread");
    }
    receivedFlow = true;
  }

  return {
    flows:
      flow === HEADLESS_DOCKER_SMOKE_FLOW_ALL
        ? [HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE, HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD]
        : [flow],
  };
}

export function createDockerHeadlessRunId(date, pid) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new Error("Docker headless smoke date must be valid");
  }
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error("Docker headless smoke PID must be positive");
  }
  return `${date
    .toISOString()
    .replace(/[^0-9A-Za-z]/gu, "")
    .toLowerCase()}-${String(pid)}`;
}

export function dockerHeadlessProjectName(runId, flow) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(runId)) {
    throw new Error("Docker headless smoke run ID is invalid");
  }
  const suffix = flow === HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE ? "dm" : "thread";
  return `hype-comms-headless-${runId}-${suffix}`;
}

export function dockerHeadlessComposeArguments(projectRoot, projectName, ...arguments_) {
  return [
    "compose",
    "--file",
    path.join(projectRoot, COMPOSE_FILE),
    "--project-name",
    projectName,
    ...arguments_,
  ];
}

export async function runCommand(
  command,
  arguments_,
  { cwd, environment = process.env, signal, stdio = "inherit", spawnProcess = spawn } = {},
) {
  if (signal?.aborted === true) throw signal.reason ?? new Error("Command interrupted");
  const child = spawnProcess(command, arguments_, { cwd, env: environment, stdio });
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [code, terminationSignal] = await once(child, "close");
    if (signal?.aborted === true) throw signal.reason ?? new Error("Command interrupted");
    if (code !== 0) {
      const detail =
        terminationSignal === null ? `code ${String(code)}` : `signal ${String(terminationSignal)}`;
      throw new Error(`${command} ${arguments_.join(" ")} exited with ${detail}`);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function flowArtifactDirectory(projectRoot, runId, flow) {
  return path.join(projectRoot, ".dev-data", "demo", "docker-headless", runId, flow);
}

async function prepareArtifactDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function runDockerHeadlessFlow({
  projectRoot,
  runId,
  flow,
  environment = process.env,
  signal,
  execute = runCommand,
  writeOutput = (message) => process.stdout.write(message),
}) {
  const projectName = dockerHeadlessProjectName(runId, flow);
  const compose = (...arguments_) =>
    dockerHeadlessComposeArguments(projectRoot, projectName, ...arguments_);
  const flowEnvironment = { ...environment, HYPE_COMMS_HEADLESS_SMOKE_FLOW: flow };
  const artifactsDirectory = flowArtifactDirectory(projectRoot, runId, flow);
  let failure;

  writeOutput(`==> running ${flow} in ${projectName}\n`);
  try {
    await execute(
      "docker",
      compose("up", "--build", "--abort-on-container-exit", "--exit-code-from", "smoke"),
      { cwd: projectRoot, environment: flowEnvironment, signal },
    );
  } catch (error) {
    failure = error;
  }

  try {
    await prepareArtifactDirectory(artifactsDirectory);
    await execute(
      "docker",
      compose("cp", `smoke:${CONTAINER_ARTIFACT_DIRECTORY}`, artifactsDirectory),
      {
        cwd: projectRoot,
        environment: flowEnvironment,
        stdio: failure === undefined ? "inherit" : "ignore",
      },
    );
  } catch (error) {
    if (failure === undefined) failure = error;
  }

  try {
    await execute(
      "docker",
      compose("down", "--volumes", "--remove-orphans", "--rmi", "local", "--timeout", "10"),
      {
        cwd: projectRoot,
        environment: flowEnvironment,
      },
    );
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], `${flow} failed and Compose cleanup also failed`);
  }

  if (failure !== undefined) throw failure;
  writeOutput(`==> saved ${flow} artifacts to ${artifactsDirectory}\n`);
  return { flow, artifactsDirectory, projectName };
}

export async function runDockerHeadlessSmokes({
  projectRoot,
  flows,
  runId = createDockerHeadlessRunId(new Date(), process.pid),
  environment = process.env,
  signal,
  platform = process.platform,
  execute = runCommand,
  writeOutput,
}) {
  if (platform !== "linux") {
    throw new Error("The display-server-free smoke is supported only on Linux");
  }
  await execute("docker", ["info"], {
    cwd: projectRoot,
    environment,
    signal,
    stdio: "ignore",
  });
  await execute("docker", ["compose", "version"], {
    cwd: projectRoot,
    environment,
    signal,
    stdio: "ignore",
  });

  const results = [];
  for (const flow of flows) {
    results.push(
      await runDockerHeadlessFlow({
        projectRoot,
        runId,
        flow,
        environment,
        signal,
        execute,
        ...(writeOutput === undefined ? {} : { writeOutput }),
      }),
    );
  }
  return results;
}

async function main() {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const options = parseDockerHeadlessSmokeArguments(process.argv.slice(2));
  const controller = new AbortController();
  let receivedSignal;
  const interrupt = (signal) => {
    if (receivedSignal !== undefined) return;
    receivedSignal = signal;
    controller.abort(new Error(`Docker headless smoke interrupted by ${signal}`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await runDockerHeadlessSmokes({
      projectRoot,
      flows: options.flows,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (receivedSignal === "SIGINT") process.exitCode = 130;
    if (receivedSignal === "SIGTERM") process.exitCode = 143;
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && path.resolve(executedPath) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `Docker headless demo smoke failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
    );
    if (process.exitCode === undefined) process.exitCode = 1;
  });
}
