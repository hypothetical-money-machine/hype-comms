import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertDemoCanReset,
  demoComposeArguments,
  deriveDemoEnvironment,
} from "./demo-environment.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function runDocker(arguments_, env) {
  const child = spawn("docker", arguments_, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "close");
  if (code !== 0) {
    const detail = signal === null ? `code ${String(code)}` : `signal ${String(signal)}`;
    throw new Error(`docker ${arguments_.join(" ")} exited with ${detail}`);
  }
}

async function main() {
  const demo = deriveDemoEnvironment(process.env, projectRoot);
  await assertDemoCanReset(demo.paths);
  await runDocker(demoComposeArguments("down", "--volumes", "--remove-orphans"), demo.env);
  await rm(demo.paths.stateDirectory, { recursive: true, force: true });
  process.stdout.write("Removed the isolated demo database and Electron profiles.\n");
}

void main().catch((error) => {
  process.stderr.write(
    `Could not reset demo: ${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exitCode = 1;
});
