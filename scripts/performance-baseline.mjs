/* global document, requestAnimationFrame, indexedDB, MutationObserver */
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import electron from "electron";
import { _electron } from "playwright";
import { removePerformanceRuntimeData } from "./performance-cleanup.mjs";
import { startCacheReadProbe, stopCacheReadProbe } from "./performance-cache-reads.mjs";
import {
  verifyVisibleReadTracking,
  visibleWindowState,
  watchVisibleWindow,
} from "./performance-visible.mjs";
import { summarize } from "./performance-statistics.mjs";
import { timelineCount, scrollTimelineEdge, inspectTimeline } from "./performance-timeline.mjs";
import { measureOfflineBacklog, readPerformanceCache } from "./performance-backlog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let interrupted = false;
const options = {
  channels: 5,
  messages: 200,
  samples: 3,
  iterations: 20,
  delay: 0,
  backlog: 0,
  label: "small",
  profile: false,
  keepRuntimeData: false,
  explainSearch: false,
  restoreCache: "opening",
  presentation: "hidden",
};
let pgBin = process.env.PERF_PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
for (const arg of process.argv.slice(2)) {
  const match =
    /^--(channels|messages|samples|iterations|delay|backlog|label|pg-bin|profile|restore-cache|explain-search|presentation|keep-runtime-data)=(.+)$/.exec(
      arg,
    );
  if (!match) throw new Error(`Unknown option: ${arg}`);
  const [, key, value] = match;
  if (key === "pg-bin") pgBin = value;
  else if (key === "presentation") {
    if (value !== "hidden" && value !== "visible")
      throw new Error("Presentation must be hidden or visible");
    options.presentation = value;
  } else if (key === "restore-cache") {
    if (value !== "opening" && value !== "all")
      throw new Error("Restore cache must be opening or all");
    options.restoreCache = value;
  } else if (key === "keep-runtime-data") {
    if (value !== "true" && value !== "false")
      throw new Error("keep-runtime-data must be true or false");
    options.keepRuntimeData = value === "true";
  } else if (key === "profile" || key === "explain-search") {
    if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
    options[key === "profile" ? "profile" : "explainSearch"] = value === "true";
  } else if (key === "label") {
    if (!/^[a-z0-9-]+$/.test(value)) throw new Error("Label must be a lowercase slug");
    options.label = value;
  } else {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`Invalid ${key}`);
    options[key] = Number(value);
  }
}
if (
  options.channels < 5 ||
  options.channels > 200 ||
  options.messages < 200 ||
  options.messages > 1000 ||
  options.samples < 1 ||
  options.samples > 10 ||
  options.iterations < 1 ||
  options.iterations > 100 ||
  options.delay > 100 ||
  (options.backlog !== 0 && (options.backlog < 3 || options.backlog > 1000))
) {
  throw new Error(
    "Bounds: channels 5..200, messages 200..1000, samples 1..10, iterations 1..100, delay 0..100 ms, backlog 0 or 3..1000",
  );
}

if (options.presentation === "visible" && options.backlog > 0) {
  throw new Error(
    "Visible runs currently cover startup and interactions; backlog requires hidden presentation",
  );
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(command, args, extra = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...extra,
  }).trim();
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await Promise.race([closed, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function waitUntil(check, timeout = 120_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (interrupted) throw new Error("Benchmark interrupted");
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Timed out waiting for benchmark readiness");
}

async function paint(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

function requestSummary(requests) {
  const routes = {};
  for (const request of requests) {
    const key = `${request.method} ${request.route}`;
    (routes[key] ??= []).push(request);
  }
  return {
    count: requests.length,
    bytes: requests.reduce((sum, r) => sum + r.bytes, 0),
    errors: requests.filter((r) => r.status >= 400),
    routes: Object.fromEntries(
      Object.entries(routes).map(([route, rows]) => [
        route,
        {
          ...summarize(rows.map((r) => r.ms)),
          bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
        },
      ]),
    ),
  };
}

function processUsage(mainPid) {
  const rows = run("ps", ["-axo", "pid=,ppid=,rss=,time="])
    .split("\n")
    .map((line) => {
      const [pid, ppid, rss, time] = line.trim().split(/\s+/);
      const parts = time.split(":").map(Number);
      const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
      return { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rss), seconds };
    });
  const pids = new Set([mainPid]);
  for (let i = 0; i < rows.length; i++)
    for (const row of rows) if (pids.has(row.ppid)) pids.add(row.pid);
  const selected = rows.filter((row) => pids.has(row.pid));
  return {
    rssMiB: selected.reduce((sum, row) => sum + row.rssKiB, 0) / 1024,
    cpuSeconds: selected.reduce((sum, row) => sum + row.seconds, 0),
    processes: selected.length,
  };
}

async function main() {
  process.umask(0o077);
  const timestamp = new Date().toISOString();
  const directory = path.join(
    root,
    ".dev-data",
    "performance",
    `${timestamp.replace(/[:.]/g, "-")}-${options.label}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pgDirectory = path.join(directory, "postgres");
  const pgPort = await freePort();
  const apiPort = await freePort();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("HYPE_COMMS_") &&
        !key.startsWith("WORKOS_") &&
        !key.startsWith("ELECTRON_") &&
        key !== "REMOTE_DEBUGGING_PORT",
    ),
  );
  const databaseUrl = `postgres://perf@127.0.0.1:${pgPort}/postgres`;
  const serverEnv = {
    ...env,
    NODE_ENV: "development",
    HYPE_COMMS_DATABASE_URL: databaseUrl,
    HYPE_COMMS_PORT: String(apiPort),
    PERF_REQUEST_DELAY_MS: String(options.delay),
  };
  console.log("Building server and desktop for the isolated benchmark API (excluded from timings)");
  run("npm", ["run", "build", "--workspace", "@hype-comms/server"], { env });
  const {
    seedPerformanceFixture,
    explainPerformanceSearch,
    explainPerformanceSync,
    advancePerformanceReadCursor,
  } = await import("./performance-fixture.mjs");
  run(process.execPath, ["../../scripts/performance-build.mjs"], {
    cwd: path.join(root, "apps/desktop"),
    env: { ...env, PERF_API_ORIGIN: `http://127.0.0.1:${apiPort}` },
  });
  const clients = new Set();
  let server;
  let rendererServer;
  let postgresStarted = false;
  const interrupt = () => {
    interrupted = true;
    for (const child of clients) child.kill("SIGTERM");
    server?.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const requests = [];
  const result = {
    version: 1,
    timestamp,
    options,
    environment: {
      commit: run("git", ["rev-parse", "HEAD"]),
      branch: run("git", ["branch", "--show-current"]),
      workingTree: run("git", ["status", "--porcelain"]),
      node: process.version,
      npm: run("npm", ["--version"]),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length,
      memoryGiB: os.totalmem() / 1024 ** 3,
      loadAverage: os.loadavg(),
      postgres: run(path.join(pgBin, "postgres"), ["--version"]),
      mode: `production-built, unpackaged Electron, ${options.presentation} primary window, local PostgreSQL, two synthetic members`,
    },
    startup: [],
    metrics: {},
  };
  const assets = path.join(root, "apps/desktop/dist/renderer/assets");
  result.rendererAssets = await Promise.all(
    (await readdir(assets)).map(async (name) => {
      const bytes = await readFile(path.join(assets, name));
      return {
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  result.artifactHashes = {};
  for (const directoryName of [
    "apps/server/dist",
    "apps/desktop/dist",
    "packages/contracts/dist",
  ]) {
    for (const name of await readdir(path.join(root, directoryName), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!name.isFile()) continue;
      const file = path.join(name.parentPath, name.name);
      result.artifactHashes[path.relative(root, file)] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    }
  }
  for (const name of (await readdir(path.join(root, "scripts"))).filter((name) =>
    /^performance-.*\.mjs$/.test(name),
  )) {
    result.artifactHashes[`scripts/${name}`] = createHash("sha256")
      .update(await readFile(path.join(root, "scripts", name)))
      .digest("hex");
  }
  result.artifactHashes["package-lock.json"] = createHash("sha256")
    .update(await readFile(path.join(root, "package-lock.json")))
    .digest("hex");

  async function launch(profile, callbackFile, startupProfileFile) {
    const visible = options.presentation === "visible" && profile !== "woots";
    const startIndex = requests.length;
    const started = performance.now();
    const browser = await _electron.launch({
      executablePath: electron,
      args: ["apps/desktop", "--remote-debugging-address=127.0.0.1"],
      cwd: root,
      chromiumSandbox: true,
      colorScheme: null,
      env: {
        ...env,
        NODE_ENV: "development",
        HYPE_COMMS_DESKTOP_PROFILE: profile,
        ...(visible ? {} : { HYPE_COMMS_DESKTOP_HEADLESS: "1" }),
        ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
        HYPE_COMMS_DEVELOPMENT_USER_DATA_ROOT: path.join(directory, "profiles"),
        ...(callbackFile ? { HYPE_COMMS_DEVELOPMENT_AUTH_CALLBACK_FILE: callbackFile } : {}),
      },
    });
    const child = browser.process();
    clients.add(child);
    const log = createWriteStream(path.join(directory, `${profile}-${Math.round(started)}.log`));
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("close", () => log.end());
    const page = await browser.firstWindow();
    let foregroundObservationStartMs;
    if (visible) {
      await browser.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(1280, 800);
        window.show();
        window.focus();
      });
      await watchVisibleWindow(browser, page);
      foregroundObservationStartMs = performance.now() - started;
    }
    const startupCdp = startupProfileFile ? await page.context().newCDPSession(page) : null;
    let startupProfileStartMs;
    if (startupCdp) {
      await startupCdp.send("Profiler.enable");
      await startupCdp.send("Profiler.start");
      startupProfileStartMs = performance.now() - started;
      await startCacheReadProbe(page);
    }
    await page.evaluate(() => {
      globalThis.performanceLongTasks = [];
      new PerformanceObserver((list) => {
        globalThis.performanceLongTasks.push(
          ...list.getEntries().map((entry) => ({ start: entry.startTime, ms: entry.duration })),
        );
      }).observe({ type: "longtask", buffered: true });
    });
    page.setDefaultTimeout(120_000);
    await page.locator('[data-testid="workspace-ready"]').waitFor();
    await page.locator(".conversation-header h2").filter({ hasText: "General" }).waitFor();
    await page.locator(".message-list article[data-message-id]").first().waitFor();
    await paint(page);
    const readyMs = performance.now() - started;
    await waitUntil(() =>
      page.evaluate(async () => (await globalThis.hypeComms.getRealtimeState()) === "live"),
    );
    const connectedMs = performance.now() - started;
    const presentation = visible
      ? {
          ...(await visibleWindowState(browser, page)),
          foregroundObservationStartMs,
          foregroundReadyMs: readyMs - foregroundObservationStartMs,
        }
      : { mode: "hidden" };
    const cacheReads = startupCdp ? await stopCacheReadProbe(page) : undefined;
    if (startupCdp) {
      const { profile: startupProfile } = await startupCdp.send("Profiler.stop");
      await writeFile(startupProfileFile, JSON.stringify(startupProfile));
    }
    const crypto = await page.evaluate(async () => {
      const status = await globalThis.hypeComms.initializeCacheCrypto();
      return { mode: status.mode, reason: status.reason ?? null };
    });
    if (crypto.mode !== "persistent")
      throw new Error(`Persistent encrypted cache unavailable: ${crypto.reason}`);
    const startupRequests = requestSummary(requests.slice(startIndex));
    const longTasks = await page.evaluate(() => globalThis.performanceLongTasks);
    const cdp = startupCdp ?? (await page.context().newCDPSession(page));
    await cdp.send("Performance.enable");
    return {
      child,
      browser,
      page,
      cdp,
      readyMs,
      connectedMs,
      crypto,
      startupRequests,
      longTasks,
      startupProfileStartMs,
      cacheReads,
      presentation,
    };
  }
  async function close(client) {
    await client.browser.evaluate(async ({ session }) => {
      await session.defaultSession.cookies.flushStore();
      session.defaultSession.flushStorageData();
    });
    await client.browser.close();
    await stop(client.child);
    clients.delete(client.child);
  }
  try {
    console.log(`Preparing ${options.label}: ${directory}`);
    const rendererRoot = path.join(root, "apps/desktop/dist/renderer");
    const staticFiles = new Map([["/", path.join(rendererRoot, "index.html")]]);
    for (const name of await readdir(assets))
      staticFiles.set(`/assets/${name}`, path.join(assets, name));
    rendererServer = createHttpServer(async (request, response) => {
      const file = staticFiles.get(new URL(request.url, "http://127.0.0.1:5173").pathname);
      if (!file) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const type = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
        }[path.extname(file)];
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(await readFile(file));
      } catch {
        response.destroy();
      }
    });
    rendererServer.listen(5173, "127.0.0.1");
    await once(rendererServer, "listening");
    run(path.join(pgBin, "initdb"), [
      "-D",
      pgDirectory,
      "-U",
      "perf",
      "--auth=trust",
      "--locale=C",
      "-E",
      "UTF8",
    ]);
    run(path.join(pgBin, "pg_ctl"), [
      "-D",
      pgDirectory,
      "-l",
      path.join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${pgPort} -c unix_socket_directories=''`,
      "-w",
      "start",
    ]);
    postgresStarted = true;
    const fixture = await seedPerformanceFixture(
      databaseUrl,
      apiPort,
      options.channels,
      options.messages,
      path.join(directory, "callbacks"),
    );
    result.fixture = fixture.counts;
    server = fork(path.join(root, "scripts/performance-server.mjs"), [], {
      env: serverEnv,
      silent: true,
    });
    const serverLog = createWriteStream(path.join(directory, "server.log"));
    server.stdout.pipe(serverLog, { end: false });
    server.stderr.pipe(serverLog, { end: false });
    server.once("close", () => serverLog.end());
    let ready = false;
    server.on("message", (message) => {
      if (message.type === "ready") ready = true;
      else if (message.type === "request") requests.push(message);
    });
    await waitUntil(() => {
      if (server.exitCode !== null) throw new Error(`Server exited; see ${directory}`);
      return ready;
    });
    const holdMessageWrites = (hold) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.off("message", acknowledge);
          reject(new Error("Server hold acknowledgement timed out"));
        }, 5000);
        const acknowledge = (message) => {
          if (message.type !== "message-writes-held" || message.hold !== hold) return;
          clearTimeout(timeout);
          server.off("message", acknowledge);
          resolve();
        };
        server.on("message", acknowledge);
        server.send({ type: "hold-message-writes", hold });
      });
    // Warm the automation driver, binaries and database once. Measured launches still use
    // fresh processes; fresh-profile samples each get a new empty desktop profile.
    const warmup = await launch("warmup", path.join(directory, "callbacks/woots.callback"));
    result.startupWarmup = { readyMs: warmup.readyMs, excluded: true };
    await close(warmup);
    await refreshCallbacks(databaseUrl, apiPort, path.join(directory, "callbacks"));
    let active;
    for (let i = 0; i < options.samples; i++) {
      // Reissue callbacks without changing the measured fixture.
      if (i > 0) await refreshCallbacks(databaseUrl, apiPort, path.join(directory, "callbacks"));
      const profile = `claire-${i}`;
      const fresh = await launch(profile, path.join(directory, "callbacks/claire.callback"));
      result.startup.push({
        state: "fresh-profile",
        sample: i,
        readyMs: fresh.readyMs,
        connectedMs: fresh.connectedMs,
        crypto: fresh.crypto,
        presentation: fresh.presentation,
        longTasks: fresh.longTasks,
        requests: fresh.startupRequests,
      });
      console.log(
        `Fresh profile ${i + 1}: ${fresh.readyMs.toFixed(0)} ms; ${fresh.startupRequests.count} HTTP requests; cache ${fresh.crypto.mode}`,
      );
      if (options.restoreCache === "all") {
        console.log(
          `Visiting ${fixture.channels.length} channels before restart (excluded from startup timing)`,
        );
        for (const channel of fixture.channels) {
          await fresh.page.evaluate(async ({ name, slug }) => {
            const button = [
              ...document.querySelectorAll('nav[aria-label="Conversations"] button'),
            ].find(
              (candidate) =>
                candidate.querySelector(".conversation-label-text")?.textContent === name,
            );
            if (!button) throw new Error(`Missing channel ${name}`);
            button.click();
            await new Promise((resolve, reject) => {
              const deadline = performance.now() + 30_000;
              const check = () => {
                if (performance.now() > deadline)
                  return reject(new Error(`History did not load: ${slug}`));
                if (
                  [...document.querySelectorAll("article[data-message-id]")].some((row) =>
                    row.textContent.includes(`Benchmark ${slug} item`),
                  )
                ) {
                  requestAnimationFrame(() => requestAnimationFrame(resolve));
                } else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });
          }, channel);
        }
      }
      await close(fresh);
      const warm = await launch(profile);
      result.startup.push({
        state: "restored-profile",
        sample: i,
        readyMs: warm.readyMs,
        connectedMs: warm.connectedMs,
        crypto: warm.crypto,
        presentation: warm.presentation,
        longTasks: warm.longTasks,
        requests: warm.startupRequests,
      });
      console.log(`Restored profile ${i + 1}: ${warm.readyMs.toFixed(0)} ms`);
      if (i === options.samples - 1) active = warm;
      else await close(warm);
    }
    const { page, cdp } = active;
    result.environment.electron = await cdp.send("Browser.getVersion");
    await delay(2000);
    const usageStart = processUsage(active.child.pid);
    const idleStart = performance.now();
    await delay(5000);
    const usageEnd = processUsage(active.child.pid);
    result.idle = {
      ...usageEnd,
      intervalMs: performance.now() - idleStart,
      cpuPercentOneCore:
        ((usageEnd.cpuSeconds - usageStart.cpuSeconds) / ((performance.now() - idleStart) / 1000)) *
        100,
    };
    result.rendererBefore = (await cdp.send("Performance.getMetrics")).metrics;
    result.cacheMessageRows = await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      const counts = [];
      for (const { name } of databases) {
        const db = await new Promise((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        if (db.objectStoreNames.contains("messages"))
          counts.push(
            await new Promise((resolve, reject) => {
              const request = db.transaction("messages").objectStore("messages").count();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            }),
          );
        db.close();
      }
      return counts.reduce((sum, count) => sum + count, 0);
    });
    result.expectedCacheMessageRowsMinimum =
      options.restoreCache === "all" ? options.channels * 50 : 50;
    if (result.cacheMessageRows < result.expectedCacheMessageRowsMinimum) {
      throw new Error("The restored profile did not retain the required conversation histories");
    }
    const bootstrap = await page.evaluate(() => globalThis.hypeComms.getWorkspaceBootstrap());
    const general = bootstrap.conversations.find((s) => s.conversation.slug === "general")
      .conversation.id;
    const timings = result.metrics;
    async function measure(name, operation) {
      if (options.presentation === "visible") await visibleWindowState(active.browser, page);
      await operation(); // Discard one warmup.
      const startIndex = requests.length;
      const values = [];
      for (let i = 0; i < options.iterations; i++) values.push(await operation(i));
      if (options.presentation === "visible") await visibleWindowState(active.browser, page);
      timings[name] = {
        ...summarize(values),
        requests: requestSummary(requests.slice(startIndex)),
      };
      console.log(
        `${name}: median ${timings[name].median.toFixed(1)} ms, p95 ${timings[name].p95.toFixed(1)} ms`,
      );
    }
    for (const [name, method, input] of [
      ["bootstrapIpc", "getWorkspaceBootstrap", undefined],
      ["history50Ipc", "getConversationMessages", { conversationId: general, limit: 50 }],
      ["searchIpc", "searchMessages", { query: "searchneedle", limit: 50 }],
    ])
      await measure(name, () =>
        page.evaluate(
          async ({ method, input }) => {
            const start = performance.now();
            const response = await globalThis.hypeComms[method](input);
            if (method === "getConversationMessages" && response.messages.length !== 50)
              throw new Error("History fixture mismatch");
            if (method === "searchMessages" && response.results.length === 0)
              throw new Error("Search fixture mismatch");
            return performance.now() - start;
          },
          { method, input },
        ),
      );

    const switchConversation = (slug) =>
      page.evaluate(async (slug) => {
        const button = [
          ...document.querySelectorAll('nav[aria-label="Conversations"] button'),
        ].find(
          (b) => b.querySelector(".conversation-label-text")?.textContent.toLowerCase() === slug,
        );
        if (!button) throw new Error(`Missing channel button: ${slug}`);
        const start = performance.now();
        button.click();
        await new Promise((resolve, reject) => {
          const deadline = start + 30_000;
          const check = () => {
            if (performance.now() > deadline) {
              reject(new Error("Channel content did not change"));
              return;
            }
            if (
              [...document.querySelectorAll("article[data-message-id]")].some((row) =>
                row.textContent.includes(`Benchmark ${slug} item`),
              )
            ) {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            } else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        return performance.now() - start;
      }, slug);
    if (options.presentation === "visible") await visibleWindowState(active.browser, page);
    const firstVisitStart = requests.length;
    result.firstConversationVisit = {
      cachedAtLaunch: options.restoreCache === "all",
      ms: await switchConversation("design"),
      requests: requestSummary(requests.slice(firstVisitStart)),
    };
    if (options.presentation === "visible") await visibleWindowState(active.browser, page);
    let switchCount = 0;
    await measure("switchConversationDom", () =>
      switchConversation(switchCount++ % 2 === 0 ? "general" : "design"),
    );

    // A separate signed-in Electron client sends via the real preload/HTTP path. Observe the
    // receiver's canonical message row to include WebSocket, encrypted cache and React work.
    const receiver = await launch("woots", path.join(directory, "callbacks/woots.callback"));
    const receiverGeneral = general;
    await page.evaluate(() => {
      [...document.querySelectorAll('nav[aria-label="Conversations"] button')]
        .find(
          (b) =>
            b.querySelector(".conversation-label-text")?.textContent.toLowerCase() === "general",
        )
        .click();
    });
    await paint(page);
    await scrollTimelineEdge(page, "end");
    await scrollTimelineEdge(receiver.page, "end");
    await measure("sendToReceiverDom", async () => {
      const body = `Performance live ${crypto.randomUUID()}`;
      const start = performance.now();
      const response = await page.evaluate(
        async ({ conversationId, body }) => {
          const clientMessageId = crypto.randomUUID();
          return globalThis.hypeComms.sendConversationMessage({
            conversationId,
            idempotencyKey: clientMessageId,
            message: {
              clientMessageId,
              body,
              bodyFormat: "hype_comms_markdown_v1",
              threadRootId: null,
              mentionedUserIds: [],
              attachmentIds: [],
            },
          });
        },
        { conversationId: receiverGeneral, body },
      );
      if (response.status !== "accepted")
        throw new Error(`Send failed: ${JSON.stringify(response)}`);
      await receiver.page.waitForFunction(
        (body) =>
          [...document.querySelectorAll("article[data-message-id]")].some((row) =>
            row.textContent.includes(body),
          ),
        body,
        { polling: "raf" },
      );
      await paint(receiver.page);
      return performance.now() - start;
    });
    result.rendererAfter = (await cdp.send("Performance.getMetrics")).metrics;
    const localFeedback = [];
    if (options.profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    await measure("composerSendToReceiverDom", async () => {
      const body = `Performance composer ${crypto.randomUUID()}`;
      await page.locator("textarea").fill(body);
      const start = performance.now();
      await page.evaluate(() => document.querySelector("form.composer").requestSubmit());
      const received = async (target, selector) => {
        await target.waitForFunction(
          ({ body, selector }) =>
            [...document.querySelectorAll(selector)].some((row) => row.textContent.includes(body)),
          { body, selector },
          { polling: "raf" },
        );
        await paint(target);
        return performance.now() - start;
      };
      const [localMs, remoteMs] = await Promise.all([
        received(page, ".message-list article"),
        received(receiver.page, "article[data-message-id]"),
      ]);
      localFeedback.push(localMs);
      return remoteMs;
    });
    if (options.profile) {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(path.join(directory, "composer.cpuprofile"), JSON.stringify(profile));
    }
    result.composerLocalFeedback = summarize(localFeedback.slice(1));
    if (options.presentation === "visible") {
      const readStartIndex = requests.length;
      result.visibleReadTracking = await verifyVisibleReadTracking(active, receiver, general);
      result.visibleReadTracking.requests = requestSummary(requests.slice(readStartIndex));
      if (
        !requests
          .slice(readStartIndex)
          .some(
            (request) =>
              request.method === "PUT" &&
              request.route.endsWith("/read-cursor") &&
              request.status === 200,
          )
      )
        throw new Error("Visible reading did not produce a successful read-cursor HTTP request");
      await page.screenshot({ path: path.join(directory, "visible-reading.png") });
    }
    await close(receiver);
    await page.locator("textarea").fill("");
    await page.locator("textarea").focus();
    await measure("typingToFrame", async () => {
      const start = performance.now();
      await page.keyboard.insertText("x");
      await paint(page);
      return performance.now() - start;
    });
    if ((await page.locator("textarea").inputValue()).length !== options.iterations + 1)
      throw new Error("Typing measurement lost input");
    await page.locator("textarea").fill("");

    await page.evaluate(() => document.querySelector(".workspace-search-button").click());
    const searchBrowserSamples = [];
    if (options.profile) await cdp.send("Profiler.start");
    let searches = 0;
    await measure("searchSubmitToDom", async () => {
      await page
        .locator("#workspace-search-query")
        .fill(searches++ % 2 === 0 ? "searchneedle" : "markdown");
      await page.locator(".workspace-search-results").waitFor({ state: "hidden" });
      const start = performance.now();
      await page.evaluate(() => {
        const dialog = document.querySelector(".workspace-search-dialog");
        const start = performance.now();
        globalThis.performanceSearchTiming = { rowsMs: null, paintMs: null };
        const observer = new MutationObserver(() => {
          if (!dialog.querySelector(".workspace-search-results li")) return;
          observer.disconnect();
          globalThis.performanceSearchTiming.rowsMs = performance.now() - start;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              globalThis.performanceSearchTiming.paintMs = performance.now() - start;
            }),
          );
        });
        observer.observe(dialog, { childList: true, subtree: true });
        dialog.querySelector("form").requestSubmit();
      });
      await page.locator(".workspace-search-results li").first().waitFor();
      await paint(page);
      const elapsed = performance.now() - start;
      const browserTiming = await page.evaluate(() => globalThis.performanceSearchTiming);
      if (browserTiming.rowsMs === null || browserTiming.paintMs === null)
        throw new Error("Search browser timing did not observe rendered results");
      searchBrowserSamples.push(browserTiming);
      return elapsed;
    });
    result.searchBrowser = {
      rows: summarize(searchBrowserSamples.slice(1).map((sample) => sample.rowsMs)),
      paint: summarize(searchBrowserSamples.slice(1).map((sample) => sample.paintMs)),
    };
    if (options.profile) {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(path.join(directory, "search.cpuprofile"), JSON.stringify(profile));
    }
    await page.screenshot({ path: path.join(directory, "search.png") });
    await page.getByRole("button", { name: "Close search" }).click();

    result.historyGrowth = [];
    for (let i = 0; i < 3; i++) {
      await scrollTimelineEdge(page, "start");
      const before = await timelineCount(page);
      const start = performance.now();
      await page.evaluate(() => document.querySelector(".load-older").click());
      await page.waitForFunction(
        (count) => {
          const list = document.querySelector(".message-list");
          return (
            Number(
              list.dataset.messageCount ?? list.querySelectorAll("article[data-message-id]").length,
            ) > count
          );
        },
        before,
        { polling: "raf" },
      );
      await paint(page);
      result.historyGrowth.push({
        before,
        after: await timelineCount(page),
        ms: performance.now() - start,
      });
    }
    result.historyTraversal = await inspectTimeline(page);
    if (options.presentation === "visible")
      result.finalPresentation = await visibleWindowState(active.browser, page);
    result.longTasks = await page.evaluate(() => globalThis.performanceLongTasks);
    result.rendererAfterHistory = (await cdp.send("Performance.getMetrics")).metrics;
    result.afterInteractions = processUsage(active.child.pid);
    result.metrics = timings;
    await page.screenshot({ path: path.join(directory, "workspace.png") });
    if (options.delay > 0 && options.restoreCache === "opening") {
      await page.evaluate(() => {
        [...document.querySelectorAll('nav[aria-label="Conversations"] button')]
          .find(
            (button) =>
              button.querySelector(".conversation-label-text")?.textContent === "Launch Planning",
          )
          .click();
      });
      await page.screenshot({ path: path.join(directory, "first-visit.png") });
      await page.waitForFunction(() => document.querySelector(".load-older")?.disabled === false);
    }
    const backlogCache = options.backlog > 0 ? await readPerformanceCache(page) : null;
    await close(active);
    if (backlogCache) {
      result.backlog = await measureOfflineBacklog({
        launch,
        close,
        profile: `claire-${options.samples - 1}`,
        senderProfile: "woots",
        initialCache: backlogCache,
        channels: [
          fixture.channels.find((channel) => channel.slug === "general"),
          fixture.channels.find((channel) => channel.slug === "design"),
          fixture.channels.find((channel) => channel.slug.startsWith("perf-")),
        ],
        count: options.backlog,
        samples: options.samples,
        iterations: options.iterations,
        directory,
        captureProfiles: options.profile,
        getRequests: () => requests,
        holdMessageWrites,
        advanceReadCursor: (conversationId, messageId) =>
          advancePerformanceReadCursor(databaseUrl, conversationId, messageId),
      });
    }
    if (options.explainSearch) result.searchPlan = await explainPerformanceSearch(databaseUrl);
    if (result.backlog?.length)
      result.backlogPlan = await explainPerformanceSync(
        databaseUrl,
        result.backlog[0].before.cursor,
      );
    result.allRequests = requestSummary(requests);
    // A fresh profile probes /auth/me, then refresh, before consuming its one-shot callback.
    // Each returns 401 once. Restored profiles and measured operations must have no errors.
    result.expectedSignedOutProbes = 2 * (options.samples + 2);
    const expectedProbeRoutes = new Set(["/v1/auth/me", "/v1/auth/session/refresh"]);
    if (
      result.allRequests.errors.length !== result.expectedSignedOutProbes ||
      result.allRequests.errors.some(
        (r) => r.status !== 401 || !expectedProbeRoutes.has(r.route),
      ) ||
      result.startup.some(
        (s) => s.requests.errors.length !== (s.state === "fresh-profile" ? 2 : 0),
      ) ||
      Object.values(timings).some((metric) => metric.requests.errors.length)
    ) {
      throw new Error("Benchmark recorded unexpected HTTP errors");
    }
    result.status = "complete";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    for (const child of clients) await stop(child);
    await stop(server);
    if (rendererServer?.listening) await new Promise((resolve) => rendererServer.close(resolve));
    if (postgresStarted)
      run(path.join(pgBin, "pg_ctl"), ["-D", pgDirectory, "-m", "fast", "-w", "stop"]);
    await writeFile(path.join(directory, "results.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    if (!options.keepRuntimeData) await removePerformanceRuntimeData(directory);
    console.log(`Results: ${directory}/results.json`);
  }
}

async function refreshCallbacks(databaseUrl, apiPort, directory) {
  const { default: pg } = await import("pg");
  const { loadConfig } = await import("../apps/server/dist/config.js");
  const { seedDevelopmentDemo, writeDevelopmentDemoCallbacks } =
    await import("../apps/server/dist/dev-seed.js");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const demo = await seedDevelopmentDemo(
      pool,
      loadConfig({
        NODE_ENV: "development",
        HYPE_COMMS_DATABASE_URL: databaseUrl,
        HYPE_COMMS_PORT: String(apiPort),
      }),
    );
    await writeDevelopmentDemoCallbacks(demo, directory);
  } finally {
    await pool.end();
  }
}

const lockDirectory = path.join(root, ".dev-data/performance/active.lock");
await mkdir(path.dirname(lockDirectory), { recursive: true });
try {
  await mkdir(lockDirectory);
} catch (error) {
  if (error.code === "EEXIST")
    throw new Error(
      "Another benchmark holds .dev-data/performance/active.lock; run scenarios sequentially",
      { cause: error },
    );
  throw error;
}
try {
  await main();
} finally {
  await rm(lockDirectory, { recursive: true });
}
