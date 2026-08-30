import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEMO_COMPOSE_PROJECT,
  HEADLESS_DEMO_MANIFEST_KIND,
  HEADLESS_DEMO_MANIFEST_VERSION,
  HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV,
  assertDemoCanReset,
  createHeadlessDemoManifest,
  createHeadlessDemoReadyRecord,
  createHeadlessDemoRunId,
  demoComposeArguments,
  demoPaths,
  deriveDemoEnvironment,
  deriveHeadlessDesktopEnvironment,
  ensurePrivateDemoDirectories,
  ensurePrivateHeadlessArtifactDirectory,
  ensurePrivateHeadlessProfileDirectories,
  headlessDevToolsActivePortFiles,
  headlessElectronArguments,
  headlessElectronViteArguments,
  parseCdpBasePort,
  parseDemoArguments,
  removeHeadlessDevToolsActivePortFiles,
  removeHeadlessDemoManifest,
  serializeHeadlessDemoManifest,
  waitForChildClose,
  writeHeadlessDemoManifest,
  writePrivateFile,
} from "./demo-environment.mjs";

test("derives an isolated loopback database and never inherits the normal database", () => {
  const root = path.resolve("/tmp/hype-comms");
  const result = deriveDemoEnvironment(
    {
      HYPE_COMMS_POSTGRES_PASSWORD: "demo p@ss",
      HYPE_COMMS_DATABASE_URL: "postgres://production.example/important",
      HYPE_COMMS_DESKTOP_HEADLESS: "1",
      HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED: "1",
      [HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]: "/tmp/untrusted-capture-directory",
      ELECTRON_CLI_ARGS: "--remote-debugging-address=0.0.0.0",
      REMOTE_DEBUGGING_PORT: "9222",
      HYPE_COMMS_OWNER_EMAIL: "owner@example.com",
    },
    root,
  );
  const url = new URL(result.databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "54330");
  assert.equal(url.password, "demo%20p%40ss");
  assert.equal(result.env.HYPE_COMMS_OWNER_EMAIL, undefined);
  assert.equal(result.env.HYPE_COMMS_DESKTOP_HEADLESS, undefined);
  assert.equal(result.env.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED, undefined);
  assert.equal(result.env[HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV], undefined);
  assert.equal(result.env.ELECTRON_CLI_ARGS, undefined);
  assert.equal(result.env.REMOTE_DEBUGGING_PORT, undefined);
  assert.equal(result.env.HYPE_COMMS_PORT, "3000");
  assert.equal(result.env.HYPE_COMMS_API_ORIGIN, "http://127.0.0.1:3000");
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

test("parses the headless demo mode and validates the paired CDP ports", () => {
  assert.deepEqual(parseDemoArguments([]), {
    headless: false,
    seedOnly: false,
    cdpBasePort: 9222,
  });
  assert.deepEqual(parseDemoArguments(["--headless", "--cdp-base-port=9410"]), {
    headless: true,
    seedOnly: false,
    cdpBasePort: 9410,
  });
  assert.equal(parseCdpBasePort("65534"), 65534);
  assert.throws(() => parseCdpBasePort("65535"), /leave room/);
  for (const port of ["2999", "3000", "5172", "5173"]) {
    assert.throws(() => parseCdpBasePort(port), /conflicts with a fixed demo service port/);
  }
  assert.throws(() => parseDemoArguments(["--cdp-base-port=9222"]), /requires --headless/);
  assert.throws(() => parseDemoArguments(["--headless", "--seed-only"]), /cannot be combined/);
  assert.throws(() => parseDemoArguments(["--headless", "--cdp-base-port=abc"]), /TCP port/);
});

test("creates private state and credential files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hype-comms-demo-env-"));
  const paths = demoPaths(root);
  await ensurePrivateDemoDirectories(paths);
  const callback = path.join(paths.callbackDirectory, "claire.callback");
  await writePrivateFile(callback, "hype-comms://auth/callback?token=secret\n");
  assert.equal((await stat(paths.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(callback)).mode & 0o777, 0o600);
  assert.match(await readFile(callback, "utf8"), /token=secret/);
  await rm(root, { recursive: true, force: true });
});

test("creates isolated headless artifacts and Electron launch configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hype-comms-demo-headless-"));
  const paths = demoPaths(root);
  const startedAt = "2026-08-07T01:02:03.456Z";
  const runId = createHeadlessDemoRunId(startedAt, 4321);
  await ensurePrivateDemoDirectories(paths);
  const artifactsDirectory = await ensurePrivateHeadlessArtifactDirectory(paths, runId);
  const desktopEnvironment = deriveHeadlessDesktopEnvironment(
    {
      HYPE_COMMS_DATABASE_URL: "postgres://127.0.0.1/demo",
      ELECTRON_CLI_ARGS: "--unexpected-switch",
      REMOTE_DEBUGGING_PORT: "9999",
      HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED: "0",
      [HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]: "/tmp/inherited-artifacts",
    },
    {
      profile: "claire",
      callbackFile: path.join(paths.callbackDirectory, "claire.callback"),
      cdpPort: 9410,
      artifactsDirectory,
    },
  );

  assert.equal(artifactsDirectory, path.join(paths.artifactRootDirectory, runId));
  assert.equal((await stat(paths.artifactRootDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(artifactsDirectory)).mode & 0o777, 0o700);
  assert.equal(desktopEnvironment.HYPE_COMMS_DESKTOP_HEADLESS, "1");
  assert.equal(desktopEnvironment.HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED, "1");
  assert.equal(desktopEnvironment.HYPE_COMMS_DESKTOP_PROFILE, "claire");
  assert.equal(desktopEnvironment[HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV], artifactsDirectory);
  assert.equal(desktopEnvironment.ELECTRON_CLI_ARGS, undefined);
  assert.equal(desktopEnvironment.REMOTE_DEBUGGING_PORT, undefined);
  assert.equal(desktopEnvironment.ELECTRON_ENABLE_LOGGING, "1");
  assert.equal(desktopEnvironment.ELECTRON_ENABLE_STACK_DUMPING, "1");
  assert.deepEqual(headlessElectronViteArguments(9410), [
    "--remoteDebuggingPort=9410",
    "--",
    "--remote-debugging-address=127.0.0.1",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--enable-features=NetworkServiceInProcess",
    "--disable-features=IsolateOrigins,site-per-process",
  ]);
  assert.deepEqual(headlessElectronArguments(9411), [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9411",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--enable-features=NetworkServiceInProcess",
    "--disable-features=IsolateOrigins,site-per-process",
  ]);
  assert.throws(
    () =>
      deriveHeadlessDesktopEnvironment(
        {},
        {
          profile: "claire",
          callbackFile: path.join(paths.callbackDirectory, "claire.callback"),
          cdpPort: 9410,
          artifactsDirectory: "relative/artifacts",
        },
      ),
    /artifacts directory must be absolute/,
  );
  await rm(root, { recursive: true, force: true });
});

test("keeps CDP endpoint metadata private while active and removes it on cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hype-comms-demo-cdp-metadata-"));
  const paths = demoPaths(root);
  await ensurePrivateDemoDirectories(paths);
  await ensurePrivateHeadlessProfileDirectories(paths);
  const metadataFiles = headlessDevToolsActivePortFiles(paths);

  assert.deepEqual(metadataFiles, [
    path.join(paths.desktopUserDataRoot, "claire", "DevToolsActivePort"),
    path.join(paths.desktopUserDataRoot, "woots", "DevToolsActivePort"),
  ]);
  for (const file of metadataFiles) {
    await writeFile(file, "9222\n/devtools/browser/example\n");
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  }

  await removeHeadlessDevToolsActivePortFiles(paths);
  await Promise.all(
    metadataFiles.map(async (file) => {
      await assert.rejects(stat(file), { code: "ENOENT" });
    }),
  );
  await removeHeadlessDevToolsActivePortFiles(paths);
  await rm(root, { recursive: true, force: true });
});

test("serializes a versioned, secret-free headless session manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hype-comms-demo-manifest-"));
  const paths = demoPaths(root);
  const startedAt = "2026-08-07T01:02:03.456Z";
  await ensurePrivateDemoDirectories(paths);
  const artifactsDirectory = await ensurePrivateHeadlessArtifactDirectory(
    paths,
    createHeadlessDemoRunId(startedAt, 4321),
  );
  const manifest = createHeadlessDemoManifest(paths, {
    cdpBasePort: 9410,
    startedAt,
    artifactsDirectory,
  });
  manifest.callbackUrl = "hype-comms://auth/callback?token=secret";
  manifest.clients[0].cookie = "secret";

  const serialized = serializeHeadlessDemoManifest(manifest);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, {
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    kind: HEADLESS_DEMO_MANIFEST_KIND,
    startedAt,
    artifactsDirectory,
    clients: [
      { profile: "claire", cdpUrl: "http://127.0.0.1:9410" },
      { profile: "woots", cdpUrl: "http://127.0.0.1:9411" },
    ],
  });
  assert.doesNotMatch(serialized, /secret|callback/i);

  const readyRecord = createHeadlessDemoReadyRecord(paths, manifest);
  assert.deepEqual(readyRecord, {
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    event: "ready",
    manifestPath: paths.headlessSessionManifest,
    clients: parsed.clients,
  });

  await writeHeadlessDemoManifest(paths, manifest);
  assert.equal((await stat(paths.headlessSessionManifest)).mode & 0o777, 0o600);
  assert.equal(await readFile(paths.headlessSessionManifest, "utf8"), serialized);
  await removeHeadlessDemoManifest(paths);
  await assert.rejects(stat(paths.headlessSessionManifest), { code: "ENOENT" });
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
  const root = await mkdtemp(path.join(os.tmpdir(), "hype-comms-demo-reset-"));
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

test("HYPE_COMMS_DEMO_API_PORT overrides the demo API port passed to the server", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "import('./demo-environment.mjs').then((m) => { " +
        "const result = m.deriveDemoEnvironment({ HYPE_COMMS_POSTGRES_PASSWORD: 'pw' }, '/tmp'); " +
        "console.log(JSON.stringify({ " +
        "port: m.DEMO_API_PORT, " +
        "serverPort: result.env.HYPE_COMMS_PORT, " +
        "apiOrigin: result.env.HYPE_COMMS_API_ORIGIN " +
        "})); " +
        "});",
    ],
    {
      cwd: new URL(".", import.meta.url).pathname,
      env: { ...process.env, HYPE_COMMS_DEMO_API_PORT: "3001" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const { code } = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code_, signal) => resolve({ code: code_, signal }));
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(output.trim());
  assert.equal(parsed.port, 3001);
  assert.equal(parsed.serverPort, "3001");
  assert.equal(parsed.apiOrigin, "http://127.0.0.1:3001");
});
