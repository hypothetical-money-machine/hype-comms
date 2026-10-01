#!/usr/bin/env node

import { homedir } from "node:os";

import { executeCli } from "./cli.js";
import { EventWriter } from "./output.js";

const exitCode = await executeCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  // os.homedir() resolves USERPROFILE on Windows and falls back to the passwd entry when HOME
  // is unset, so the CLI starts on every supported platform.
  homeDirectory: homedir(),
  fetch: globalThis.fetch,
  io: {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTty: process.stdin.isTTY === true,
  },
  now: Date.now,
  random: Math.random,
});

process.exitCode = exitCode;
if (EventWriter.isOutputAbandoned(process.stdout)) {
  // Node's process stdout cannot cancel an active OS pipe write. Watch disposal marks that
  // blocked output as abandoned; flush the diagnostic stream before forcing bounded shutdown.
  const deadline = setTimeout(() => process.exit(exitCode), 1_000);
  process.stderr.write("", () => {
    clearTimeout(deadline);
    process.exit(exitCode);
  });
}
