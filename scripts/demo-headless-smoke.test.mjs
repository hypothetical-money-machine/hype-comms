import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MANIFEST_RELATIVE_PATH,
  HEADLESS_DEMO_MANIFEST_KIND,
  HEADLESS_DEMO_MANIFEST_VERSION,
  assertHeadlessReadCursorIsBlocked,
  parseHeadlessDemoManifest,
  parseSmokeArguments,
  runHeadlessSmoke,
} from "./demo-headless-smoke.mjs";

const artifactDirectory = path.resolve("/tmp/hmm-headless-demo-artifacts");

function manifest() {
  return {
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    kind: HEADLESS_DEMO_MANIFEST_KIND,
    startedAt: "2026-08-07T00:00:00.000Z",
    artifactsDirectory: artifactDirectory,
    clients: [
      { profile: "claire", cdpUrl: "http://127.0.0.1:9222" },
      { profile: "woots", cdpUrl: "http://127.0.0.1:9223" },
    ],
  };
}

test("accepts the versioned, secret-free headless manifest shape", () => {
  const parsed = parseHeadlessDemoManifest({
    ...manifest(),
    unexpectedCredential: "not carried forward",
  });
  assert.deepEqual(parsed, {
    version: 1,
    kind: "hmm-chat-headless-demo",
    startedAt: "2026-08-07T00:00:00.000Z",
    artifactsDirectory: artifactDirectory,
    clients: [
      { profile: "claire", cdpUrl: "http://127.0.0.1:9222/" },
      { profile: "woots", cdpUrl: "http://127.0.0.1:9223/" },
    ],
  });
  assert.throws(
    () =>
      parseHeadlessDemoManifest({
        ...manifest(),
        clients: [{ profile: "claire", cdpUrl: "http://127.0.0.1:9222" }],
      }),
    /exactly two clients/u,
  );
  assert.throws(
    () =>
      parseHeadlessDemoManifest({
        ...manifest(),
        artifactsDirectory: ".dev-data/demo/artifacts",
      }),
    /absolute path/u,
  );
  assert.throws(
    () =>
      parseHeadlessDemoManifest({
        ...manifest(),
        clients: [
          { profile: "claire", cdpUrl: "http://127.0.0.1:9222/?token=secret" },
          { profile: "woots", cdpUrl: "http://127.0.0.1:9223" },
        ],
      }),
    /credentials, a query, or a fragment/u,
  );
});

test("reads the local manifest default and constrains smoke CLI options", () => {
  const root = path.resolve("/repo/hmm-chat");
  assert.deepEqual(parseSmokeArguments([], {}, root), {
    manifestPath: path.join(root, DEFAULT_MANIFEST_RELATIVE_PATH),
    messagePrefix: "HMM headless automation smoke",
    timeoutMs: 30_000,
  });
  assert.deepEqual(
    parseSmokeArguments(
      ["--message=Visible receipt", "--timeout-ms=5000"],
      { HMM_HEADLESS_DEMO_MANIFEST: "/tmp/session.json" },
      root,
    ),
    {
      manifestPath: "/tmp/session.json",
      messagePrefix: "Visible receipt",
      timeoutMs: 5_000,
    },
  );
  assert.throws(() => parseSmokeArguments(["--unknown"], {}, root), /Usage:/u);
  assert.throws(() => parseSmokeArguments(["--timeout-ms=0"], {}, root), /positive integer/u);
});

function page(name, receivedMessages) {
  const events = [];
  const dialog = {
    getByLabel: (label, options) => ({
      fill: async (value) => {
        events.push(["search", label, options, value]);
      },
    }),
    getByRole: (role, options) => ({
      click: async () => {
        events.push(["choose", role, String(options.name)]);
      },
    }),
  };
  return {
    events,
    evaluate: async () => {
      events.push(["read-cursor-guard"]);
      return "Read cursors are disabled for headless automation clients";
    },
    getByLabel: (label, options) => ({
      fill: async (value) => {
        events.push(["composer", label, options, value]);
        receivedMessages.push(value);
      },
    }),
    getByRole: (role, options) => {
      if (role === "dialog") return dialog;
      return {
        click: async () => {
          events.push(["click", role, options.name]);
        },
      };
    },
    getByText: (value, options) => ({
      waitFor: async (waitOptions) => {
        assert.ok(receivedMessages.includes(value), "the sent body is visible to Woots");
        events.push(["receipt", value, options, waitOptions]);
      },
    }),
    name,
  };
}

test("smoke drives accessible controls and leaves a screenshot plus screencast", async () => {
  const receivedMessages = [];
  const clairePage = page("claire", receivedMessages);
  const wootsPage = page("woots", receivedMessages);
  const calls = [];
  let stopCalls = 0;
  const capture = {
    DEFAULT_CAPTURE_SIZE: { width: 1280, height: 800 },
    capturePng: async (page_, outputPath) => {
      calls.push(["png", page_.name, outputPath]);
      return outputPath;
    },
    connectToCdp: async (cdpUrl) => ({
      page: cdpUrl.includes(":9222") ? clairePage : wootsPage,
      disconnect: async () => {
        calls.push(["disconnect", cdpUrl]);
      },
    }),
    startWebmScreencast: async (page_, outputPath, options) => {
      calls.push(["webm", page_.name, outputPath, options]);
      return { outputPath };
    },
    stopWebmScreencast: async (recording) => {
      stopCalls += 1;
      calls.push(["stop", recording.outputPath]);
    },
    waitForWorkspaceReady: async (page_) => {
      calls.push(["ready", page_.name]);
    },
  };

  const result = await runHeadlessSmoke({
    manifest: manifest(),
    messagePrefix: "Round trip",
    captureId: "fixed-run",
    capture,
  });

  assert.deepEqual(result, {
    version: 1,
    event: "passed",
    artifacts: {
      screenshotPath: path.join(artifactDirectory, "smoke-fixed-run-woots.png"),
      videoPath: path.join(artifactDirectory, "smoke-fixed-run-claire.webm"),
    },
  });
  assert.equal(receivedMessages[0], "Round trip [fixed-run]");
  assert.equal(stopCalls, 1);
  assert.deepEqual(calls, [
    ["ready", "claire"],
    ["ready", "woots"],
    [
      "webm",
      "claire",
      path.join(artifactDirectory, "smoke-fixed-run-claire.webm"),
      {
        size: { width: 1280, height: 800 },
      },
    ],
    ["png", "woots", path.join(artifactDirectory, "smoke-fixed-run-woots.png")],
    ["stop", path.join(artifactDirectory, "smoke-fixed-run-claire.webm")],
    ["disconnect", "http://127.0.0.1:9222/"],
    ["disconnect", "http://127.0.0.1:9223/"],
  ]);
  assert.equal(
    clairePage.events.some((event) => event[0] === "composer"),
    true,
  );
  assert.equal(
    wootsPage.events.some((event) => event[0] === "receipt"),
    true,
  );
  assert.equal(
    clairePage.events.some((event) => event[0] === "read-cursor-guard"),
    true,
  );
});

test("disconnects a CDP attachment that succeeds after its peer fails", async () => {
  const disconnects = [];
  let resolveClaireConnection;
  let rejectWootsConnection;
  let wootsRejected = false;
  const claireConnect = new Promise((resolve) => {
    resolveClaireConnection = resolve;
  });
  const wootsConnect = new Promise((_, reject) => {
    rejectWootsConnection = reject;
  });
  void wootsConnect.catch(() => {
    wootsRejected = true;
  });
  const capture = {
    connectToCdp: (cdpUrl) => (cdpUrl.includes(":9222") ? claireConnect : wootsConnect),
  };

  const smoke = runHeadlessSmoke({
    manifest: manifest(),
    capture,
  });
  const rejection = assert.rejects(smoke, /Woots CDP endpoint is unavailable/u);

  rejectWootsConnection(new Error("Woots CDP endpoint is unavailable"));
  await Promise.resolve();
  assert.equal(wootsRejected, true);
  resolveClaireConnection({
    disconnect: async () => {
      disconnects.push("http://127.0.0.1:9222/");
    },
  });

  await rejection;

  assert.deepEqual(disconnects, ["http://127.0.0.1:9222/"]);
});

test("disconnects both CDP clients when stopping the screencast fails", async () => {
  const receivedMessages = [];
  const clairePage = page("claire", receivedMessages);
  const wootsPage = page("woots", receivedMessages);
  const disconnects = [];
  const capture = {
    DEFAULT_CAPTURE_SIZE: { width: 1280, height: 800 },
    capturePng: async () => undefined,
    connectToCdp: async (cdpUrl) => ({
      page: cdpUrl.includes(":9222") ? clairePage : wootsPage,
      disconnect: async () => {
        disconnects.push(cdpUrl);
      },
    }),
    startWebmScreencast: async () => ({ recording: true }),
    stopWebmScreencast: async () => {
      throw new Error("Screencast shutdown failed");
    },
    waitForWorkspaceReady: async () => undefined,
  };

  await assert.rejects(
    runHeadlessSmoke({
      manifest: manifest(),
      captureId: "stop-failure",
      capture,
    }),
    /Screencast shutdown failed/u,
  );

  assert.deepEqual(disconnects, ["http://127.0.0.1:9222/", "http://127.0.0.1:9223/"]);
});

test("preserves a smoke failure when screencast shutdown also fails", async () => {
  const receivedMessages = [];
  const clairePage = page("claire", receivedMessages);
  const wootsPage = page("woots", receivedMessages);
  const disconnects = [];
  const capture = {
    DEFAULT_CAPTURE_SIZE: { width: 1280, height: 800 },
    capturePng: async () => {
      throw new Error("Screenshot capture failed");
    },
    connectToCdp: async (cdpUrl) => ({
      page: cdpUrl.includes(":9222") ? clairePage : wootsPage,
      disconnect: async () => {
        disconnects.push(cdpUrl);
      },
    }),
    startWebmScreencast: async () => ({ recording: true }),
    stopWebmScreencast: async () => {
      throw new Error("Screencast shutdown failed");
    },
    waitForWorkspaceReady: async () => undefined,
  };

  await assert.rejects(
    runHeadlessSmoke({
      manifest: manifest(),
      captureId: "capture-failure",
      capture,
    }),
    /Screenshot capture failed/u,
  );

  assert.deepEqual(disconnects, ["http://127.0.0.1:9222/", "http://127.0.0.1:9223/"]);
});

test("fails the smoke if the privileged headless read-cursor guard is missing", async () => {
  await assert.rejects(
    assertHeadlessReadCursorIsBlocked({ evaluate: async () => "read cursor advanced" }),
    /Headless read-cursor guard failed/u,
  );
});

test("rejects a capture ID that could escape the run artifact directory", async () => {
  await assert.rejects(
    runHeadlessSmoke({
      manifest: manifest(),
      captureId: "x/../../../outside",
      capture: {},
    }),
    /safe filename segment/,
  );
});
