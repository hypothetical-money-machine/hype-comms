import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MANIFEST_RELATIVE_PATH,
  HEADLESS_DEMO_MANIFEST_KIND,
  HEADLESS_DEMO_MANIFEST_VERSION,
  HEADLESS_NOTIFICATION_CAPTURE_KEYS,
  assertHeadlessReadCursorIsBlocked,
  enableHeadlessNotificationCapture,
  parseHeadlessNotificationCaptureArtifact,
  parseHeadlessDemoManifest,
  parseSmokeArguments,
  runHeadlessSmoke,
  waitForNewHeadlessNotificationCapture,
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

test("strictly accepts only body-free, target-free notification capture records", () => {
  const captureId = "capture_0123456789abcdef";
  const contents = `${JSON.stringify({
    version: 1,
    captureId,
    reason: "direct_message",
  })}\n`;
  assert.deepEqual(parseHeadlessNotificationCaptureArtifact(contents, ["canary body"]), [
    { version: 1, captureId, reason: "direct_message" },
  ]);
  assert.deepEqual(HEADLESS_NOTIFICATION_CAPTURE_KEYS, ["captureId", "reason", "version"]);
  assert.throws(
    () =>
      parseHeadlessNotificationCaptureArtifact(
        `${JSON.stringify({
          version: 1,
          captureId,
          reason: "direct_message",
          messageId: "30000000-0000-4000-8000-000000000001",
        })}\n`,
      ),
    /unexpected fields/u,
  );
  assert.throws(
    () => parseHeadlessNotificationCaptureArtifact(contents, [captureId]),
    /leaked message or target data/u,
  );
  assert.throws(
    () => parseHeadlessNotificationCaptureArtifact(contents.slice(0, -1)),
    /incomplete record/u,
  );
});

test("waits for one new capture and rejects duplicate presentation", async () => {
  const existing = `${JSON.stringify({
    version: 1,
    captureId: "capture_existing_1234",
    reason: "verified_mention",
  })}\n`;
  const incoming = `${JSON.stringify({
    version: 1,
    captureId: "capture_incoming_1234",
    reason: "direct_message",
  })}\n`;
  const reads = [existing, `${existing}${incoming}`, `${existing}${incoming}`];
  let currentTime = 0;
  const result = await waitForNewHeadlessNotificationCapture({
    filePath: "/tmp/notifications-woots.jsonl",
    knownCaptureIds: new Set(["capture_existing_1234"]),
    forbiddenValues: ["private canary"],
    timeoutMs: 1_000,
    readArtifact: async () => reads.shift() ?? `${existing}${incoming}`,
    pause: async (milliseconds) => {
      currentTime += milliseconds;
    },
    now: () => currentTime,
  });
  assert.deepEqual(result, {
    version: 1,
    captureId: "capture_incoming_1234",
    reason: "direct_message",
  });

  const duplicate = `${incoming}${JSON.stringify({
    version: 1,
    captureId: "capture_duplicate_1234",
    reason: "direct_message",
  })}\n`;
  await assert.rejects(
    waitForNewHeadlessNotificationCapture({
      filePath: "/tmp/notifications-woots.jsonl",
      knownCaptureIds: new Set(),
      forbiddenValues: [],
      timeoutMs: 1,
      readArtifact: async () => duplicate,
    }),
    /more than one/u,
  );
});

test("enables only metadata notification capture on a headless client", async () => {
  await enableHeadlessNotificationCapture({
    evaluate: async () => ({
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
      nativeSupport: "supported",
      osPermission: "unknown",
    }),
  });
  await assert.rejects(
    enableHeadlessNotificationCapture({
      evaluate: async () => ({
        version: 1,
        devicePreference: "enabled",
        contentPreviewPreference: "enabled",
        nativeSupport: "supported",
        osPermission: "unknown",
      }),
    }),
    /metadata-only supported state/u,
  );
});

function page(name, receivedMessages) {
  const events = [];
  const messageId = "30000000-0000-4000-8000-000000000001";
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
    evaluate: async (callback, argument) => {
      const source = String(callback);
      if (source.includes("advanceReadCursor")) {
        events.push(["read-cursor-guard"]);
        return "Read cursors are disabled for headless automation clients";
      }
      if (source.includes("setNotificationPreference")) {
        events.push(["enable-notifications"]);
        return {
          version: 1,
          devicePreference: "enabled",
          contentPreviewPreference: "disabled",
          nativeSupport: "supported",
          osPermission: "unknown",
        };
      }
      if (source.includes("activateCapturedNotification")) {
        events.push(["activate-notification", argument]);
        return true;
      }
      throw new Error("Unexpected page evaluation");
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
      locator: (selector) => ({
        getAttribute: async (attribute) => {
          events.push(["target-id", value, options, selector, attribute]);
          return messageId;
        },
      }),
      waitFor: async (waitOptions) => {
        assert.ok(receivedMessages.includes(value), "the sent body is visible to Woots");
        events.push(["receipt", value, options, waitOptions]);
      },
    }),
    locator: (selector) => ({
      getByText: (value, options) => ({
        waitFor: async (waitOptions) => {
          events.push(["highlighted-body", selector, value, options, waitOptions]);
        },
      }),
      waitFor: async (waitOptions) => {
        events.push(["highlighted-target", selector, waitOptions]);
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
    readArtifact: async () => "",
    waitForNotificationCapture: async (options) => {
      calls.push([
        "notification",
        options.filePath,
        [...options.knownCaptureIds],
        options.forbiddenValues,
        options.timeoutMs,
        typeof options.readArtifact,
      ]);
      return {
        version: 1,
        captureId: "capture_0123456789abcdef",
        reason: "direct_message",
      };
    },
  });

  assert.deepEqual(result, {
    version: 1,
    event: "passed",
    artifacts: {
      screenshotPath: path.join(artifactDirectory, "smoke-fixed-run-woots.png"),
      videoPath: path.join(artifactDirectory, "smoke-fixed-run-claire.webm"),
      notificationCapturePath: path.join(artifactDirectory, "notifications-woots.jsonl"),
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
    [
      "notification",
      path.join(artifactDirectory, "notifications-woots.jsonl"),
      [],
      ["Round trip [fixed-run]", "30000000-0000-4000-8000-000000000001"],
      30_000,
      "function",
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
  assert.equal(
    wootsPage.events.some((event) => event[0] === "enable-notifications"),
    true,
  );
  assert.deepEqual(
    wootsPage.events.find((event) => event[0] === "activate-notification"),
    ["activate-notification", "capture_0123456789abcdef"],
  );
  assert.equal(
    wootsPage.events.some((event) => event[0] === "highlighted-target"),
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
      readArtifact: async () => "",
      waitForNotificationCapture: async () => ({
        version: 1,
        captureId: "capture_0123456789abcdef",
        reason: "direct_message",
      }),
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
      readArtifact: async () => "",
      waitForNotificationCapture: async () => ({
        version: 1,
        captureId: "capture_0123456789abcdef",
        reason: "direct_message",
      }),
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
