import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as agentCapture from "./agent-capture.mjs";

export const HEADLESS_DEMO_MANIFEST_VERSION = 1;
export const HEADLESS_DEMO_MANIFEST_KIND = "hype-comms-headless-demo";
export const DEFAULT_MANIFEST_RELATIVE_PATH = path.join(
  ".dev-data",
  "demo",
  "headless-session.json",
);
export const DEFAULT_SMOKE_MESSAGE = "Hype Comms headless automation smoke";
export const HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE = "direct-message";
export const HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD = "participated-thread";
export const HEADLESS_NOTIFICATION_CAPTURE_KEYS = ["captureId", "reason", "version"];
export const HEADLESS_NOTIFICATION_CAPTURE_POLL_MS = 100;

const NOTIFICATION_CAPTURE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function manifestClient(value) {
  if (!isRecord(value)) throw new Error("Each manifest client must be an object");
  const profile = requiredString(value.profile, "Manifest client profile");
  if (profile !== "claire" && profile !== "woots") {
    throw new Error("Manifest clients must be Claire and Woots");
  }
  return {
    profile,
    cdpUrl: agentCapture.normalizeLocalCdpUrl(
      requiredString(value.cdpUrl, "Manifest client CDP URL"),
    ),
  };
}

/** Parse only the non-secret fields the smoke script is allowed to consume. */
export function parseHeadlessDemoManifest(value) {
  if (!isRecord(value)) throw new Error("Headless demo manifest must be an object");
  if (value.version !== HEADLESS_DEMO_MANIFEST_VERSION) {
    throw new Error(
      `Headless demo manifest version must be ${String(HEADLESS_DEMO_MANIFEST_VERSION)}`,
    );
  }
  if (value.kind !== HEADLESS_DEMO_MANIFEST_KIND) {
    throw new Error(`Headless demo manifest kind must be ${HEADLESS_DEMO_MANIFEST_KIND}`);
  }

  const artifactsDirectory = requiredString(
    value.artifactsDirectory,
    "Manifest artifactsDirectory",
  );
  if (!path.isAbsolute(artifactsDirectory)) {
    throw new Error("Manifest artifactsDirectory must be an absolute path");
  }
  if (!Array.isArray(value.clients) || value.clients.length !== 2) {
    throw new Error("Headless demo manifest must contain exactly two clients");
  }
  const clients = value.clients.map(manifestClient);
  if (new Set(clients.map((client) => client.profile)).size !== 2) {
    throw new Error("Headless demo manifest must contain one Claire and one Woots client");
  }

  return {
    version: HEADLESS_DEMO_MANIFEST_VERSION,
    kind: HEADLESS_DEMO_MANIFEST_KIND,
    startedAt: requiredString(value.startedAt, "Manifest startedAt"),
    artifactsDirectory: path.resolve(artifactsDirectory),
    clients,
  };
}

export async function readHeadlessDemoManifest(manifestPath) {
  const contents = await readFile(manifestPath, "utf8");
  try {
    return parseHeadlessDemoManifest(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Headless demo manifest is not valid JSON", { cause: error });
    }
    throw error;
  }
}

function parsePositiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

/** Parse the intentionally small opt-in smoke command surface. */
export function parseSmokeArguments(arguments_, environment, projectRoot) {
  let manifestPath = environment.HYPE_COMMS_HEADLESS_DEMO_MANIFEST;
  let messagePrefix = DEFAULT_SMOKE_MESSAGE;
  let timeoutMs = agentCapture.DEFAULT_TIMEOUT_MS;
  let flow = HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE;
  let receivedFlow = false;
  for (const argument of arguments_) {
    if (argument.startsWith("--manifest=")) {
      if (manifestPath !== undefined) throw new Error("Headless demo manifest was specified twice");
      manifestPath = argument.slice("--manifest=".length);
    } else if (argument.startsWith("--message=")) {
      messagePrefix = argument.slice("--message=".length);
    } else if (argument.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(argument.slice("--timeout-ms=".length), "--timeout-ms");
    } else if (argument.startsWith("--flow=")) {
      if (receivedFlow) throw new Error("--flow may only be supplied once");
      const selected = argument.slice("--flow=".length);
      if (
        selected !== HEADLESS_SMOKE_FLOW_DIRECT_MESSAGE &&
        selected !== HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD
      ) {
        throw new Error("--flow must be direct-message or participated-thread");
      }
      flow = selected;
      receivedFlow = true;
    } else {
      throw new Error(
        "Usage: demo:headless:smoke [--manifest=<path>] [--message=<prefix>] " +
          "[--timeout-ms=<ms>] [--flow=<direct-message|participated-thread>]",
      );
    }
  }
  const selectedManifest = manifestPath ?? path.join(projectRoot, DEFAULT_MANIFEST_RELATIVE_PATH);
  if (selectedManifest.trim() === "") throw new Error("A headless demo manifest path is required");
  if (messagePrefix.trim() === "") throw new Error("--message must not be empty");
  return {
    manifestPath: path.resolve(projectRoot, selectedManifest),
    messagePrefix,
    timeoutMs,
    flow,
  };
}

function clientForProfile(manifest, profile) {
  const client = manifest.clients.find((candidate) => candidate.profile === profile);
  if (client === undefined) throw new Error(`Manifest does not include ${profile}`);
  return client;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function notificationArtifactPath(manifest, profile) {
  return path.join(manifest.artifactsDirectory, `notifications-${profile}.jsonl`);
}

function notificationCaptureRecord(value) {
  if (!isRecord(value)) throw new Error("Headless notification capture record must be an object");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== HEADLESS_NOTIFICATION_CAPTURE_KEYS.length ||
    !HEADLESS_NOTIFICATION_CAPTURE_KEYS.every((key, index) => keys[index] === key)
  ) {
    throw new Error("Headless notification capture record contains unexpected fields");
  }
  if (value.version !== 1) {
    throw new Error("Headless notification capture record has an unsupported version");
  }
  if (
    typeof value.captureId !== "string" ||
    !NOTIFICATION_CAPTURE_ID_PATTERN.test(value.captureId)
  ) {
    throw new Error("Headless notification capture record has an invalid opaque ID");
  }
  if (
    value.reason !== "direct_message" &&
    value.reason !== "verified_mention" &&
    value.reason !== "participated_thread_reply"
  ) {
    throw new Error("Headless notification capture record has an invalid reason");
  }
  return {
    version: 1,
    captureId: value.captureId,
    reason: value.reason,
  };
}

/** Strictly parse the deliberately body- and target-free headless notification artifact. */
export function parseHeadlessNotificationCaptureArtifact(contents, forbiddenValues = []) {
  if (typeof contents !== "string") {
    throw new Error("Headless notification capture artifact must be UTF-8 text");
  }
  for (const value of forbiddenValues) {
    if (typeof value !== "string" || value === "") {
      throw new Error("Headless notification capture forbidden values must be non-empty strings");
    }
    if (contents.includes(value)) {
      throw new Error("Headless notification capture artifact leaked message or target data");
    }
  }
  if (contents === "") return [];
  if (!contents.endsWith("\n")) {
    throw new Error("Headless notification capture artifact contains an incomplete record");
  }
  return contents
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      try {
        return notificationCaptureRecord(JSON.parse(line));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error("Headless notification capture artifact is not valid JSON", {
            cause: error,
          });
        }
        throw error;
      }
    });
}

async function readNotificationCaptureArtifact(filePath, readArtifact) {
  try {
    return await readArtifact(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

/** Wait for exactly one new capture and re-read once to catch duplicate presentation. */
export async function waitForNewHeadlessNotificationCapture({
  filePath,
  knownCaptureIds,
  forbiddenValues,
  timeoutMs,
  readArtifact = readFile,
  pause = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = Date.now,
}) {
  if (!(knownCaptureIds instanceof Set)) {
    throw new Error("Known notification capture IDs must be a Set");
  }
  const deadline = now() + timeoutMs;
  while (true) {
    const contents = await readNotificationCaptureArtifact(filePath, readArtifact);
    const records = parseHeadlessNotificationCaptureArtifact(contents, forbiddenValues);
    const newRecords = records.filter((record) => !knownCaptureIds.has(record.captureId));
    if (newRecords.length > 1) {
      throw new Error("One message produced more than one headless notification capture");
    }
    if (newRecords.length === 1) {
      await pause(HEADLESS_NOTIFICATION_CAPTURE_POLL_MS);
      const settledContents = await readNotificationCaptureArtifact(filePath, readArtifact);
      const settledRecords = parseHeadlessNotificationCaptureArtifact(
        settledContents,
        forbiddenValues,
      );
      const settledNewRecords = settledRecords.filter(
        (record) => !knownCaptureIds.has(record.captureId),
      );
      if (settledNewRecords.length !== 1) {
        throw new Error("One message must produce exactly one headless notification capture");
      }
      return settledNewRecords[0];
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error("Timed out waiting for the headless notification capture");
    }
    await pause(Math.min(HEADLESS_NOTIFICATION_CAPTURE_POLL_MS, remainingMs));
  }
}

/** Enable the device-local, metadata-only preference through the real frozen preload API. */
export async function enableHeadlessNotificationCapture(page) {
  if (typeof page?.evaluate !== "function") {
    throw new Error("A Playwright Page is required to enable headless notification capture");
  }
  const state = await page.evaluate(async () => {
    if (globalThis.hypeComms.isHeadless !== true) {
      throw new Error("Notification capture proof requires a headless desktop client");
    }
    if (typeof globalThis.hypeComms.setNotificationPreference !== "function") {
      throw new Error("Notification preferences are unavailable");
    }
    return globalThis.hypeComms.setNotificationPreference({
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
    });
  });
  if (
    !isRecord(state) ||
    state.devicePreference !== "enabled" ||
    state.contentPreviewPreference !== "disabled" ||
    state.nativeSupport !== "supported"
  ) {
    throw new Error("Headless notification capture did not enter metadata-only supported state");
  }
}

function messageRowLocator(page, message) {
  // The message body may also appear in the unreads preview, so scope the search to the
  // conversation timeline's article rows rather than matching text anywhere on the page.
  return page.locator("article[data-message-id]").filter({ hasText: message }).first();
}

async function messageIdForVisibleBody(page, message) {
  const row = messageRowLocator(page, message);
  const messageId = await row.getAttribute("data-message-id");
  if (messageId === null || !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error("The received smoke message has no canonical message target ID");
  }
  return messageId;
}

async function openThreadForVisibleMessage(page, message, timeoutMs) {
  const row = messageRowLocator(page, message);
  await row.hover();
  await row
    .getByRole("button", {
      name: /^(?:Reply in thread|Open thread with [0-9]+ replies?)$/u,
    })
    .click();
  const thread = page.locator('aside[aria-label="Thread"]');
  await thread.waitFor({ state: "visible", timeout: timeoutMs });
  return thread;
}

async function sendThreadReply(thread, message) {
  await thread.getByLabel("Reply", { exact: true }).fill(message);
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
}

async function assertExactThreadTarget(page, message, messageId, timeoutMs) {
  const thread = page.locator('aside[aria-label="Thread"]');
  await thread.waitFor({ state: "visible", timeout: timeoutMs });
  const highlighted = thread.locator(`[data-message-id="${messageId}"].search-target`);
  await highlighted.waitFor({ state: "visible", timeout: timeoutMs });
  await highlighted
    .getByText(message, { exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function activateCapturedNotification(page, captureId) {
  const activated = await page.evaluate(
    async (opaqueId) => globalThis.hypeComms.activateCapturedNotification(opaqueId),
    captureId,
  );
  if (activated !== true) {
    throw new Error("The opaque headless notification capture could not be activated");
  }
}

/** Select the known seeded direct-message conversation through the app's accessible switcher. */
export async function selectDirectConversation(page, otherMemberName) {
  await page.getByRole("button", { name: /Jump to/u }).click();
  const dialog = page.getByRole("dialog", { name: "Jump to a conversation" });
  await dialog.getByLabel("Jump to a conversation", { exact: true }).fill(otherMemberName);
  await dialog
    .getByRole("button", { name: new RegExp(`\\b${escapeRegExp(otherMemberName)}\\b`, "u") })
    .click();
}

/**
 * Verify that the privileged main-process guard still prevents an automation renderer from
 * advancing human read state, even when an agent directly invokes the exposed bridge API.
 */
export async function assertHeadlessReadCursorIsBlocked(page) {
  if (typeof page?.evaluate !== "function") {
    throw new Error("A Playwright Page is required to verify the headless read-cursor guard");
  }
  const result = await page.evaluate(async () => {
    try {
      await globalThis.hypeComms.advanceReadCursor(
        "00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000000",
      );
      return "read cursor advanced";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  if (result !== "Read cursors are disabled for headless automation clients") {
    throw new Error(`Headless read-cursor guard failed: ${String(result)}`);
  }
}

function uniqueSmokeMessage(prefix, captureId) {
  const suffix = ` [${captureId}]`;
  if (prefix.length + suffix.length > 4_000) {
    throw new Error("Smoke message prefix leaves no room for its unique verification marker");
  }
  return `${prefix}${suffix}`;
}

function normalizeCaptureId(captureId) {
  if (typeof captureId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(captureId)) {
    throw new Error("Smoke capture ID must be a safe filename segment");
  }
  return captureId;
}

/**
 * Send one Claire-to-Woots direct message through the visible renderer controls, then preserve
 * Woots's realtime receipt and Claire's explicit screencast in the manifest artifact directory.
 */
export async function runHeadlessSmoke({
  manifest,
  messagePrefix = DEFAULT_SMOKE_MESSAGE,
  timeoutMs = agentCapture.DEFAULT_TIMEOUT_MS,
  captureId = randomUUID(),
  capture = agentCapture,
  readArtifact = readFile,
  waitForNotificationCapture = waitForNewHeadlessNotificationCapture,
}) {
  const normalizedManifest = parseHeadlessDemoManifest(manifest);
  const normalizedCaptureId = normalizeCaptureId(captureId);
  const claire = clientForProfile(normalizedManifest, "claire");
  const woots = clientForProfile(normalizedManifest, "woots");
  const message = uniqueSmokeMessage(messagePrefix, normalizedCaptureId);
  const screenshotPath = path.join(
    normalizedManifest.artifactsDirectory,
    `smoke-${normalizedCaptureId}-woots.png`,
  );
  const videoPath = path.join(
    normalizedManifest.artifactsDirectory,
    `smoke-${normalizedCaptureId}-claire.webm`,
  );
  const notificationCapturePath = notificationArtifactPath(normalizedManifest, "woots");
  let claireConnection;
  let wootsConnection;
  let recording;
  let smokeResult;
  let smokeError;
  let hasSmokeError = false;

  try {
    // Connect sequentially. Electron's loopback CDP server can deadlock when two Playwright
    // attach requests race on the same renderer process, especially after a previous attach/detach
    // cycle validated readiness.
    claireConnection = await capture.connectToCdp(claire.cdpUrl, { timeoutMs });
    wootsConnection = await capture.connectToCdp(woots.cdpUrl, { timeoutMs });
    await Promise.all([
      capture.waitForWorkspaceReady(claireConnection.page, { timeoutMs }),
      capture.waitForWorkspaceReady(wootsConnection.page, { timeoutMs }),
    ]);
    await assertHeadlessReadCursorIsBlocked(claireConnection.page);
    await enableHeadlessNotificationCapture(wootsConnection.page);
    const captureBaseline = parseHeadlessNotificationCaptureArtifact(
      await readNotificationCaptureArtifact(notificationCapturePath, readArtifact),
    );
    const knownCaptureIds = new Set(captureBaseline.map((record) => record.captureId));

    recording = await capture.startWebmScreencast(claireConnection.page, videoPath, {
      size: capture.DEFAULT_CAPTURE_SIZE,
    });
    await selectDirectConversation(claireConnection.page, "Woots");
    await selectDirectConversation(wootsConnection.page, "Claire");
    await claireConnection.page.getByLabel("Message", { exact: true }).fill(message);
    await claireConnection.page.getByRole("button", { name: "Send", exact: true }).click();
    await messageRowLocator(wootsConnection.page, message).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    const messageId = await messageIdForVisibleBody(wootsConnection.page, message);
    const notificationCapture = await waitForNotificationCapture({
      filePath: notificationCapturePath,
      knownCaptureIds,
      forbiddenValues: [message, messageId],
      timeoutMs,
      readArtifact,
    });
    if (notificationCapture.reason !== "direct_message") {
      throw new Error("The incoming direct message produced the wrong notification reason");
    }

    // Leave the target so the activation must navigate back through the production action path.
    await selectDirectConversation(wootsConnection.page, "General");
    await activateCapturedNotification(wootsConnection.page, notificationCapture.captureId);
    const highlightedMessage = wootsConnection.page.locator(
      `[data-message-id="${messageId}"].search-target`,
    );
    await highlightedMessage.waitFor({ state: "visible", timeout: timeoutMs });
    await highlightedMessage
      .getByText(message, { exact: true })
      .waitFor({ state: "visible", timeout: timeoutMs });
    await capture.capturePng(wootsConnection.page, screenshotPath);

    smokeResult = {
      version: HEADLESS_DEMO_MANIFEST_VERSION,
      event: "passed",
      artifacts: {
        screenshotPath,
        videoPath,
        notificationCapturePath,
      },
    };
  } catch (error) {
    hasSmokeError = true;
    smokeError = error;
  }

  try {
    if (recording !== undefined) await capture.stopWebmScreencast(recording);
  } catch (error) {
    if (!hasSmokeError) {
      hasSmokeError = true;
      smokeError = error;
    }
  } finally {
    await Promise.allSettled(
      [claireConnection, wootsConnection]
        .filter((connection) => connection !== undefined)
        .map(async (connection) => connection.disconnect()),
    );
  }

  if (hasSmokeError) throw smokeError;
  return smokeResult;
}

/**
 * Prove the recipient-specific participated-thread reason without relying on a hydrated local
 * thread-participation cache. Woots authors a root, leaves the channel without opening its thread,
 * and receives Claire's reply while another conversation is selected. A second reply verifies
 * that a server-verified mention still wins precedence over the participation reason.
 */
export async function runParticipatedThreadNotificationSmoke({
  manifest,
  messagePrefix = DEFAULT_SMOKE_MESSAGE,
  timeoutMs = agentCapture.DEFAULT_TIMEOUT_MS,
  captureId = randomUUID(),
  capture = agentCapture,
  readArtifact = readFile,
  waitForNotificationCapture = waitForNewHeadlessNotificationCapture,
}) {
  const normalizedManifest = parseHeadlessDemoManifest(manifest);
  const normalizedCaptureId = normalizeCaptureId(captureId);
  const claire = clientForProfile(normalizedManifest, "claire");
  const woots = clientForProfile(normalizedManifest, "woots");
  const rootMessage = uniqueSmokeMessage(`${messagePrefix} thread root`, normalizedCaptureId);
  const replyMessage = uniqueSmokeMessage(
    `${messagePrefix} participated reply`,
    normalizedCaptureId,
  );
  const mentionMessage = uniqueSmokeMessage(
    `@woots ${messagePrefix} mention precedence`,
    normalizedCaptureId,
  );
  const screenshotPath = path.join(
    normalizedManifest.artifactsDirectory,
    `smoke-${normalizedCaptureId}-participated-thread-woots.png`,
  );
  const precedenceScreenshotPath = path.join(
    normalizedManifest.artifactsDirectory,
    `smoke-${normalizedCaptureId}-mention-precedence-woots.png`,
  );
  const videoPath = path.join(
    normalizedManifest.artifactsDirectory,
    `smoke-${normalizedCaptureId}-participated-thread-claire.webm`,
  );
  const notificationCapturePath = notificationArtifactPath(normalizedManifest, "woots");
  let claireConnection;
  let wootsConnection;
  let recording;
  let smokeResult;
  let smokeError;
  let hasSmokeError = false;

  try {
    // Connect sequentially. Electron's loopback CDP server can deadlock when two Playwright
    // attach requests race on the same renderer process, especially after a previous attach/detach
    // cycle validated readiness.
    claireConnection = await capture.connectToCdp(claire.cdpUrl, { timeoutMs });
    wootsConnection = await capture.connectToCdp(woots.cdpUrl, { timeoutMs });
    await Promise.all([
      capture.waitForWorkspaceReady(claireConnection.page, { timeoutMs }),
      capture.waitForWorkspaceReady(wootsConnection.page, { timeoutMs }),
    ]);
    await assertHeadlessReadCursorIsBlocked(claireConnection.page);
    await enableHeadlessNotificationCapture(wootsConnection.page);
    const captureBaseline = parseHeadlessNotificationCaptureArtifact(
      await readNotificationCaptureArtifact(notificationCapturePath, readArtifact),
    );
    const knownCaptureIds = new Set(captureBaseline.map((record) => record.captureId));

    recording = await capture.startWebmScreencast(claireConnection.page, videoPath, {
      size: capture.DEFAULT_CAPTURE_SIZE,
    });
    await selectDirectConversation(claireConnection.page, "General");
    await selectDirectConversation(wootsConnection.page, "General");

    // Root authorship is committed on the server, but Woots never opens or hydrates its thread.
    await wootsConnection.page.getByLabel("Message", { exact: true }).fill(rootMessage);
    await wootsConnection.page.getByRole("button", { name: "Send", exact: true }).click();
    await messageRowLocator(claireConnection.page, rootMessage).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    const rootMessageId = await messageIdForVisibleBody(claireConnection.page, rootMessage);

    await selectDirectConversation(wootsConnection.page, "Design");
    const claireThread = await openThreadForVisibleMessage(
      claireConnection.page,
      rootMessage,
      timeoutMs,
    );
    await sendThreadReply(claireThread, replyMessage);
    await messageRowLocator(claireConnection.page, replyMessage).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    const replyMessageId = await messageIdForVisibleBody(claireConnection.page, replyMessage);
    const participatedCapture = await waitForNotificationCapture({
      filePath: notificationCapturePath,
      knownCaptureIds,
      forbiddenValues: [rootMessage, replyMessage, rootMessageId, replyMessageId],
      timeoutMs,
      readArtifact,
    });
    if (participatedCapture.reason !== "participated_thread_reply") {
      throw new Error("The participated-thread reply produced the wrong notification reason");
    }
    knownCaptureIds.add(participatedCapture.captureId);

    await activateCapturedNotification(wootsConnection.page, participatedCapture.captureId);
    await assertExactThreadTarget(wootsConnection.page, replyMessage, replyMessageId, timeoutMs);
    await capture.capturePng(wootsConnection.page, screenshotPath);

    // Move away again so visibility suppression cannot hide the precedence assertion.
    await selectDirectConversation(wootsConnection.page, "Design");
    await sendThreadReply(claireThread, mentionMessage);
    await messageRowLocator(claireConnection.page, mentionMessage).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    const mentionMessageId = await messageIdForVisibleBody(claireConnection.page, mentionMessage);
    const mentionCapture = await waitForNotificationCapture({
      filePath: notificationCapturePath,
      knownCaptureIds,
      forbiddenValues: [
        rootMessage,
        replyMessage,
        mentionMessage,
        rootMessageId,
        replyMessageId,
        mentionMessageId,
      ],
      timeoutMs,
      readArtifact,
    });
    if (mentionCapture.reason !== "verified_mention") {
      throw new Error("A verified mention did not win participated-thread precedence");
    }

    await activateCapturedNotification(wootsConnection.page, mentionCapture.captureId);
    await assertExactThreadTarget(
      wootsConnection.page,
      mentionMessage,
      mentionMessageId,
      timeoutMs,
    );
    await capture.capturePng(wootsConnection.page, precedenceScreenshotPath);

    smokeResult = {
      version: HEADLESS_DEMO_MANIFEST_VERSION,
      event: "passed",
      flow: HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD,
      assertions: {
        participatedThreadReason: "participated_thread_reply",
        mentionPrecedenceReason: "verified_mention",
        exactThreadClickThrough: true,
        bodyAndTargetFreeCapture: true,
      },
      artifacts: {
        screenshotPath,
        precedenceScreenshotPath,
        videoPath,
        notificationCapturePath,
      },
    };
  } catch (error) {
    hasSmokeError = true;
    smokeError = error;
  }

  try {
    if (recording !== undefined) await capture.stopWebmScreencast(recording);
  } catch (error) {
    if (!hasSmokeError) {
      hasSmokeError = true;
      smokeError = error;
    }
  } finally {
    await Promise.allSettled(
      [claireConnection, wootsConnection]
        .filter((connection) => connection !== undefined)
        .map(async (connection) => connection.disconnect()),
    );
  }

  if (hasSmokeError) throw smokeError;
  return smokeResult;
}

async function main() {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const options = parseSmokeArguments(process.argv.slice(2), process.env, projectRoot);
  const manifest = await readHeadlessDemoManifest(options.manifestPath);
  const runSmoke =
    options.flow === HEADLESS_SMOKE_FLOW_PARTICIPATED_THREAD
      ? runParticipatedThreadNotificationSmoke
      : runHeadlessSmoke;
  const result = await runSmoke({
    manifest,
    messagePrefix: options.messagePrefix,
    timeoutMs: options.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify({ ...result, manifestPath: options.manifestPath })}\n`);
}

const executedPath = process.argv[1];
if (executedPath !== undefined && path.resolve(executedPath) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(
      `Headless demo smoke failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
