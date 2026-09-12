import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { _electron as electron } from "playwright";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "hype-native-cache-"));
const buildDirectory = path.join(directory, "build");
const evidenceFile = path.join(repository, ".dev-data/rehearsal/native-cache.json");
await mkdir(path.dirname(evidenceFile), { recursive: true });
// A previous successful run must not stand in for a failed fresh run.
await rm(evidenceFile, { force: true });

async function protectedFiles() {
  const profile = path.join(directory, "profile");
  const files = (await readdir(path.join(profile, "cache"))).sort();
  assert.ok(files.length > 0, "No protected cache key was created");
  files.push("../hype-comms-settings/device-preferences.json");
  return Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(path.join(profile, "cache", name)))
          .digest("hex"),
      ]),
    ),
  );
}

async function withApp(stage, body) {
  const app = await electron.launch({
    executablePath: path.join(
      repository,
      "node_modules/electron/dist",
      process.platform === "darwin"
        ? "Electron.app/Contents/MacOS/Electron"
        : process.platform === "win32"
          ? "electron.exe"
          : "electron",
    ),
    args: [
      ...(process.env.HYPE_COMMS_REHEARSAL_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ...(process.platform === "linux" ? ["--password-store=gnome-libsecret"] : []),
      path.join(buildDirectory, "desktop-main.cjs"),
    ],
    env: {
      ...process.env,
      HYPE_COMMS_REHEARSAL_DIRECTORY: directory,
      HYPE_COMMS_REHEARSAL_STAGE: stage,
    },
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await page.exposeFunction("encryptCacheRecords", (input) =>
      app.evaluate((_electron, request) => globalThis.rehearsalMain.cipher.encrypt(request), input),
    );
    await page.exposeFunction("decryptCacheRecords", (input) =>
      app.evaluate((_electron, request) => globalThis.rehearsalMain.cipher.decrypt(request), input),
    );
    await page.waitForFunction(() => globalThis.rehearsalCache !== undefined);
    return await body(app, page);
  } finally {
    await app.close();
  }
}

try {
  await build({
    entryPoints: [path.join(repository, "scripts/rehearsal/desktop-main.ts")],
    outfile: path.join(buildDirectory, "desktop-main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await build({
    entryPoints: [path.join(repository, "scripts/rehearsal/cache-renderer.ts")],
    outfile: path.join(buildDirectory, "cache-renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
  });
  await writeFile(
    path.join(buildDirectory, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><title>Native cache rehearsal</title><script src="./cache-renderer.js"></script>',
  );
  let backend;
  const original = await withApp("seed", async (app, page) => {
    backend = await app.evaluate(() => globalThis.rehearsalMain.backend);
    return page.evaluate(() => globalThis.rehearsalCache.seed());
  });
  assert.equal(original.version, 5);
  const filesBefore = await protectedFiles();
  const migrated = await withApp("upgrade", async (app, page) => {
    assert.deepEqual(
      await page.evaluate(() => globalThis.rehearsalCache.interruptedUpgrade()),
      original,
    );
    const preferences = await app.evaluate(() => globalThis.rehearsalMain.preferences.load());
    assert.equal(preferences.spellCheck, false);
    assert.equal(preferences.sendMessageShortcut, "mod-enter");
    return page.evaluate(() => globalThis.rehearsalCache.migrate());
  });
  assert.deepEqual(
    migrated.loaded.outbox.map((row) => row.operation),
    [migrated.operation],
  );
  assert.equal(migrated.loaded.outbox[0].status, "pending");
  assert.equal(migrated.loaded.bootstrap, null);
  assert.equal(migrated.loaded.syncCursor, null);
  assert.deepEqual(migrated.loaded.messages, []);
  assert.deepEqual(migrated.reset.outbox, migrated.loaded.outbox);
  assert.equal(migrated.stored.version, 6);
  assert.deepEqual(migrated.stored.tables.outbox, original.tables.outbox);
  assert.deepEqual(await protectedFiles(), filesBefore);
  const reopened = await withApp("reopen", (_app, page) =>
    page.evaluate(() => globalThis.rehearsalCache.migrate()),
  );
  assert.deepEqual(reopened.loaded.outbox, migrated.loaded.outbox);
  assert.deepEqual(reopened.stored.tables.outbox, original.tables.outbox);
  assert.deepEqual(await protectedFiles(), filesBefore);
  const evidence = {
    platform: process.platform,
    architecture: process.arch,
    backend,
    completedAt: new Date().toISOString(),
    passed: [
      "real Chromium IndexedDB",
      "native OS wrapping",
      "interrupted upgrade rollback",
      "original ciphertext and key bytes",
      "pending work after two process restarts",
      "idempotent replica reset",
      "preferences",
    ],
    limits:
      "Synthetic version-5 database in a private development Electron profile. This does not install a previous production app or exercise its updater or signing identity.",
  };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Native cache rehearsal passed (${process.platform}/${process.arch}, ${backend}).`);
} finally {
  // Only the temporary synthetic profile created by this invocation is removed.
  await rm(directory, { recursive: true, force: true });
}
