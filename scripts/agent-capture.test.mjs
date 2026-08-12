import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CAPTURE_SIZE,
  WORKSPACE_READY_SELECTOR,
  capturePng,
  connectToCdp,
  loadPlaywright,
  normalizeLocalCdpUrl,
  startWebmScreencast,
  stopWebmScreencast,
  waitForHeadlessClients,
  waitForWorkspaceReady,
} from "./agent-capture.mjs";

function fakeConnection(page) {
  let closeCalls = 0;
  let connectOptions;
  const context = {
    pages: () => [{ url: () => "devtools://devtools/bundled/inspector.html" }, page],
  };
  const browser = {
    close: async () => {
      closeCalls += 1;
    },
    contexts: () => [context],
  };
  return {
    browser,
    closed: () => closeCalls,
    playwright: {
      chromium: {
        connectOverCDP: async (_endpoint, options) => {
          connectOptions = options;
          return browser;
        },
      },
    },
    connectOptions: () => connectOptions,
  };
}

test("loads Playwright only through an injectable dynamic-import seam", async () => {
  const fake = {
    chromium: {
      connectOverCDP: async () => undefined,
    },
  };
  assert.equal(await loadPlaywright(async () => ({ default: fake })), fake);
  await assert.rejects(
    loadPlaywright(async () => {
      throw new Error("module not found");
    }),
    /Playwright 1\.59 or newer is required/u,
  );
});

test("only accepts secret-free loopback CDP URLs", () => {
  assert.equal(normalizeLocalCdpUrl("http://127.0.0.1:9222"), "http://127.0.0.1:9222/");
  assert.equal(
    normalizeLocalCdpUrl("ws://[::1]:9223/devtools/browser/id"),
    "ws://[::1]:9223/devtools/browser/id",
  );
  for (const value of [
    "https://127.0.0.1:9222",
    "http://example.test:9222",
    "http://token@127.0.0.1:9222",
    "http://127.0.0.1:9222/?token=secret",
    "not a URL",
  ]) {
    assert.throws(() => normalizeLocalCdpUrl(value));
  }
});

test("attaches to the Electron renderer and waits for its workspace marker", async () => {
  const waits = [];
  const page = {
    url: () => "http://127.0.0.1:5173/",
    waitForSelector: async (...arguments_) => {
      waits.push(arguments_);
    },
  };
  const fake = fakeConnection(page);
  const connection = await connectToCdp("http://127.0.0.1:9222", {
    playwright: fake.playwright,
    timeoutMs: 123,
  });

  assert.equal(connection.page, page);
  assert.deepEqual(fake.connectOptions(), {
    isLocal: true,
    noDefaults: true,
    timeout: 123,
  });
  await waitForWorkspaceReady(connection.page, { timeoutMs: 456 });
  assert.deepEqual(waits, [[WORKSPACE_READY_SELECTOR, { state: "visible", timeout: 456 }]]);
  await connection.disconnect();
  assert.equal(fake.closed(), 1);
});

test("closes CDP attachments after all manifest clients are ready", async () => {
  const seenUrls = [];
  const closed = [];
  const playwright = {
    chromium: {
      connectOverCDP: async (url) => {
        seenUrls.push(url);
        const page = {
          url: () => "http://127.0.0.1:5173/",
          waitForSelector: async () => undefined,
        };
        return {
          close: async () => {
            closed.push(url);
          },
          contexts: () => [
            {
              pages: () => [page],
            },
          ],
        };
      },
    },
  };

  const ready = await waitForHeadlessClients(
    {
      clients: [
        { profile: "claire", cdpUrl: "http://127.0.0.1:9222" },
        { profile: "woots", cdpUrl: "http://127.0.0.1:9223" },
      ],
    },
    { playwright, timeoutMs: 1_000 },
  );

  assert.deepEqual(seenUrls, ["http://127.0.0.1:9222/", "http://127.0.0.1:9223/"]);
  assert.deepEqual(closed, seenUrls);
  assert.deepEqual(ready, [
    { profile: "claire", cdpUrl: "http://127.0.0.1:9222/" },
    { profile: "woots", cdpUrl: "http://127.0.0.1:9223/" },
  ]);
});

test("polls an Electron CDP endpoint while the development client is still starting", async () => {
  let attempts = 0;
  let closed = 0;
  const page = {
    url: () => "http://127.0.0.1:5173/",
    waitForSelector: async () => undefined,
  };
  const playwright = {
    chromium: {
      connectOverCDP: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("ECONNREFUSED");
        return {
          close: async () => {
            closed += 1;
          },
          contexts: () => [
            {
              pages: () => [page],
            },
          ],
        };
      },
    },
  };

  const ready = await waitForHeadlessClients(
    [{ profile: "claire", cdpUrl: "http://127.0.0.1:9222" }],
    { playwright, timeoutMs: 1_000 },
  );

  assert.equal(attempts, 2);
  assert.equal(closed, 1);
  assert.deepEqual(ready, [{ profile: "claire", cdpUrl: "http://127.0.0.1:9222/" }]);
});

test("cancels headless readiness retries when its abort signal fires", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let resolveFirstAttempt;
  const firstAttempt = new Promise((resolve) => {
    resolveFirstAttempt = resolve;
  });
  const playwright = {
    chromium: {
      connectOverCDP: async () => {
        attempts += 1;
        resolveFirstAttempt();
        throw new Error("ECONNREFUSED");
      },
    },
  };

  const waiting = waitForHeadlessClients([{ profile: "claire", cdpUrl: "http://127.0.0.1:9222" }], {
    playwright,
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  await firstAttempt;
  controller.abort(new Error("Demo interrupted"));

  let timeout;
  const outcome = await Promise.race([
    waiting.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve("timed out"), 100);
    }),
  ]);
  clearTimeout(timeout);

  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /Demo interrupted/u);
  assert.equal(attempts, 1);
});

test("disconnects an attached client when headless readiness is cancelled", async () => {
  const controller = new AbortController();
  let closed = 0;
  let resolveSelectorWait;
  const selectorWaitStarted = new Promise((resolve) => {
    resolveSelectorWait = resolve;
  });
  const page = {
    url: () => "http://127.0.0.1:5173/",
    waitForSelector: async () => {
      resolveSelectorWait();
      await new Promise(() => undefined);
    },
  };
  const playwright = {
    chromium: {
      connectOverCDP: async () => ({
        close: async () => {
          closed += 1;
        },
        contexts: () => [
          {
            pages: () => [page],
          },
        ],
      }),
    },
  };

  const waiting = waitForHeadlessClients([{ profile: "claire", cdpUrl: "http://127.0.0.1:9222" }], {
    playwright,
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  await selectorWaitStarted;
  controller.abort(new Error("Demo interrupted"));

  await assert.rejects(waiting, /Demo interrupted/u);
  assert.equal(closed, 1);
});

test("disconnects a CDP connection that resolves after readiness is cancelled", async () => {
  const controller = new AbortController();
  let resolveConnectStarted;
  let resolveBrowser;
  let resolveConnectionClosed;
  const connectStarted = new Promise((resolve) => {
    resolveConnectStarted = resolve;
  });
  const pendingBrowser = new Promise((resolve) => {
    resolveBrowser = resolve;
  });
  const connectionClosed = new Promise((resolve) => {
    resolveConnectionClosed = resolve;
  });
  let closed = 0;
  const browser = {
    close: async () => {
      closed += 1;
      resolveConnectionClosed();
    },
    contexts: () => [
      {
        pages: () => [{ url: () => "http://127.0.0.1:5173/" }],
      },
    ],
  };
  const playwright = {
    chromium: {
      connectOverCDP: async () => {
        resolveConnectStarted();
        return pendingBrowser;
      },
    },
  };

  const waiting = waitForHeadlessClients([{ profile: "claire", cdpUrl: "http://127.0.0.1:9222" }], {
    playwright,
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  await connectStarted;
  controller.abort(new Error("Demo interrupted"));

  let timeout;
  const outcome = await Promise.race([
    waiting.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve("timed out"), 100);
    }),
  ]);
  clearTimeout(timeout);

  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /Demo interrupted/u);
  resolveBrowser(browser);
  await connectionClosed;
  assert.equal(closed, 1);
});

test("writes deterministic private PNG and WebM artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-agent-capture-"));
  try {
    const pngPath = path.join(directory, "nested", "workspace.png");
    const webmPath = path.join(directory, "nested", "round-trip.webm");
    let screenshotOptions;
    let screencastOptions;
    let stopCalls = 0;
    const page = {
      screenshot: async (options) => {
        screenshotOptions = options;
        await writeFile(options.path, "png");
      },
      screencast: {
        start: async (options) => {
          screencastOptions = options;
        },
        stop: async () => {
          stopCalls += 1;
          await writeFile(webmPath, "webm");
        },
      },
    };

    assert.equal(await capturePng(page, pngPath), pngPath);
    assert.deepEqual(screenshotOptions, {
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      path: pngPath,
      scale: "css",
      type: "png",
    });
    assert.equal((await stat(pngPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(pngPath, "utf8"), "png");

    const recording = await startWebmScreencast(page, webmPath);
    assert.deepEqual(screencastOptions, {
      path: webmPath,
      size: DEFAULT_CAPTURE_SIZE,
    });
    assert.equal(await stopWebmScreencast(recording), webmPath);
    assert.equal(await stopWebmScreencast(recording), webmPath);
    assert.equal(stopCalls, 1);
    assert.equal((await stat(webmPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(webmPath, "utf8"), "webm");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
