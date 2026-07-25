import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEMO_COMPOSE_PROJECT,
  assertDemoCanReset,
  demoComposeArguments,
  demoPaths,
  deriveDemoEnvironment,
  ensurePrivateDemoDirectories,
  waitForChildClose,
  writePrivateFile,
} from "./demo-environment.mjs";

test("derives an isolated loopback database and never inherits the normal database", () => {
  const root = path.resolve("/tmp/hmm-chat");
  const result = deriveDemoEnvironment(
    {
      HMM_POSTGRES_PASSWORD: "demo p@ss",
      HMM_DATABASE_URL: "postgres://production.example/important",
      HMM_OWNER_EMAIL: "owner@example.com",
    },
    root,
  );
  const url = new URL(result.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "54330");
  assert.equal(url.password, "demo%20p%40ss");
  assert.equal(result.env.HMM_OWNER_EMAIL, undefined);
  assert.equal(result.paths.stateDirectory, path.join(root, ".dev-data", "demo"));
});

test("uses the dedicated Compose project for every lifecycle command", () => {
  assert.deepEqual(demoComposeArguments("down", "--volumes"), [
    "compose",
    "--project-name",
    DEMO_COMPOSE_PROJECT,
    "down",
    "--volumes",
  ]);
});

test("creates private state and credential files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hmm-demo-env-"));
  const paths = demoPaths(root);
  await ensurePrivateDemoDirectories(paths);
  const callback = path.join(paths.callbackDirectory, "claire.callback");
  await writePrivateFile(callback, "hmm-chat://auth/callback?token=secret\n");
  assert.equal((await stat(paths.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(callback)).mode & 0o777, 0o600);
  assert.match(await readFile(callback, "utf8"), /token=secret/);
  await rm(root, { recursive: true, force: true });
});

test("waits for child close so captured stdout is complete", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('first'); setImmediate(() => process.stdout.write(' second'))"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const result = await waitForChildClose(child);
  assert.equal(result.code, 0);
  assert.equal(output, "first second");
});

test("reset refuses an active marker and validates only the exact demo target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hmm-demo-reset-"));
  const paths = demoPaths(root);
  await ensurePrivateDemoDirectories(paths);
  await writeFile(paths.runMarker, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await assert.rejects(assertDemoCanReset(paths), /Refusing to reset/);
  await rm(paths.runMarker, { force: true });
  await assert.rejects(
    assertDemoCanReset({ ...paths, stateDirectory: path.join(root, ".dev-data") }),
  );
  await rm(root, { recursive: true, force: true });
});
