#!/usr/bin/env node

import { homedir } from "node:os";

import { executeCli } from "./cli.js";

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
