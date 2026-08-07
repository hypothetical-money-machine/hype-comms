import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as agentCapture from "./agent-capture.mjs";

export const HEADLESS_DEMO_MANIFEST_VERSION = 1;
export const HEADLESS_DEMO_MANIFEST_KIND = "hmm-chat-headless-demo";
export const DEFAULT_MANIFEST_RELATIVE_PATH = path.join(
  ".dev-data",
  "demo",
  "headless-session.json",
);
export const DEFAULT_SMOKE_MESSAGE = "HMM headless automation smoke";

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
  let manifestPath = environment.HMM_HEADLESS_DEMO_MANIFEST;
  let messagePrefix = DEFAULT_SMOKE_MESSAGE;
  let timeoutMs = agentCapture.DEFAULT_TIMEOUT_MS;
  for (const argument of arguments_) {
    if (argument.startsWith("--manifest=")) {
      if (manifestPath !== undefined) throw new Error("Headless demo manifest was specified twice");
      manifestPath = argument.slice("--manifest=".length);
    } else if (argument.startsWith("--message=")) {
      messagePrefix = argument.slice("--message=".length);
    } else if (argument.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(argument.slice("--timeout-ms=".length), "--timeout-ms");
    } else {
      throw new Error(
        "Usage: demo:headless:smoke [--manifest=<path>] [--message=<prefix>] [--timeout-ms=<ms>]",
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
      await globalThis.hmmChat.advanceReadCursor(
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
  let claireConnection;
  let wootsConnection;
  let recording;
  let smokeResult;
  let smokeError;
  let hasSmokeError = false;

  try {
    const connections = await Promise.allSettled([
      (async () => {
        claireConnection = await capture.connectToCdp(claire.cdpUrl, { timeoutMs });
      })(),
      (async () => {
        wootsConnection = await capture.connectToCdp(woots.cdpUrl, { timeoutMs });
      })(),
    ]);
    const failedConnection = connections.find((connection) => connection.status === "rejected");
    if (failedConnection !== undefined && failedConnection.status === "rejected") {
      throw failedConnection.reason;
    }
    await Promise.all([
      capture.waitForWorkspaceReady(claireConnection.page, { timeoutMs }),
      capture.waitForWorkspaceReady(wootsConnection.page, { timeoutMs }),
    ]);
    await assertHeadlessReadCursorIsBlocked(claireConnection.page);

    recording = await capture.startWebmScreencast(claireConnection.page, videoPath, {
      size: capture.DEFAULT_CAPTURE_SIZE,
    });
    await selectDirectConversation(claireConnection.page, "Woots");
    await selectDirectConversation(wootsConnection.page, "Claire");
    await claireConnection.page.getByLabel("Message", { exact: true }).fill(message);
    await claireConnection.page.getByRole("button", { name: "Send", exact: true }).click();
    await wootsConnection.page
      .getByText(message, { exact: true })
      .waitFor({ state: "visible", timeout: timeoutMs });
    await capture.capturePng(wootsConnection.page, screenshotPath);

    smokeResult = {
      version: HEADLESS_DEMO_MANIFEST_VERSION,
      event: "passed",
      artifacts: {
        screenshotPath,
        videoPath,
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
  const result = await runHeadlessSmoke({
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
