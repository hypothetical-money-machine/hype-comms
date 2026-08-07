import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

/** The renderer marks this element once an authenticated workspace has rendered. */
export const WORKSPACE_READY_SELECTOR = '[data-testid="workspace-ready"]';
export const DEFAULT_CAPTURE_SIZE = Object.freeze({ width: 1280, height: 800 });
export const DEFAULT_TIMEOUT_MS = 30_000;
const CDP_CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;
const CDP_RETRY_DELAY_MS = 250;

function assertPositiveTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }
  return timeoutMs;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Headless client readiness wait was aborted");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError(signal);
}

/** Await an operation until it settles or its cancellation signal is aborted. */
function waitForAbortableOperation(operation, signal, onLateResolve) {
  if (signal === undefined) return operation;
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => settle(reject, abortError(signal));
    const settle = (complete, value) => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete(value);
      return true;
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(operation).then(
      (value) => {
        if (!settle(resolve, value) && onLateResolve !== undefined) {
          void Promise.resolve(onLateResolve(value)).catch(() => undefined);
        }
      },
      (error) => settle(reject, error),
    );
  });
}

function waitForRetryDelay(delayMs, signal) {
  throwIfAborted(signal);
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, delayMs));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertCapturePath(targetPath, extension) {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new Error(`A ${extension} capture path is required`);
  }
  const resolved = path.resolve(targetPath);
  if (path.extname(resolved).toLowerCase() !== extension) {
    throw new Error(`Capture path must end with ${extension}`);
  }
  return resolved;
}

function assertCaptureSize(size) {
  if (
    size === null ||
    typeof size !== "object" ||
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1
  ) {
    throw new Error("Capture size must have positive integer width and height");
  }
  return size;
}

async function ensurePrivateCaptureDirectory(targetPath) {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function markPrivate(targetPath) {
  await chmod(targetPath, 0o600);
}

/**
 * Lazily load Playwright so repository unit tests and normal development do not require it.
 * `importer` is injectable for tests and other hosts that provide their own Playwright module.
 */
export async function loadPlaywright(importer = () => import("playwright")) {
  try {
    const imported = await importer();
    const playwright = imported.default ?? imported;
    if (typeof playwright?.chromium?.connectOverCDP !== "function") {
      throw new Error("the module does not expose chromium.connectOverCDP()");
    }
    return playwright;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown import failure";
    throw new Error(
      `Playwright 1.59 or newer is required for headless captures (${detail}). ` +
        "Install the repository development dependencies first.",
      { cause: error },
    );
  }
}

/**
 * Reject non-loopback or credential-bearing CDP endpoints before any connection is made.
 */
export function normalizeLocalCdpUrl(cdpUrl) {
  if (typeof cdpUrl !== "string" || cdpUrl.trim() === "") {
    throw new Error("A local CDP URL is required");
  }

  let parsed;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error("CDP URL must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") {
    throw new Error("CDP URL must use http or ws");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("CDP URL must use a loopback host");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("CDP URL must not include credentials, a query, or a fragment");
  }
  return parsed.toString();
}

function isLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function rendererPages(context) {
  return context.pages().filter((page) => {
    const url = page.url();
    return !url.startsWith("devtools://") && !url.startsWith("chrome-extension://");
  });
}

/**
 * Return the renderer page from a CDP-attached Electron browser connection.
 */
export function workspacePage(connection) {
  const pages = rendererPages(connection.context);
  if (pages.length === 0) {
    throw new Error("No Electron renderer page is available through the CDP endpoint");
  }
  return pages[0];
}

/**
 * Attach to one development-only, loopback CDP endpoint. Closing the returned connection
 * disconnects Playwright; it does not ask the Electron application to quit.
 */
export async function connectToCdp(
  cdpUrl,
  { playwright, importer, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const endpoint = normalizeLocalCdpUrl(cdpUrl);
  const timeout = assertPositiveTimeout(timeoutMs);
  const loadedPlaywright = playwright ?? (await loadPlaywright(importer));
  const browser = await loadedPlaywright.chromium.connectOverCDP(endpoint, {
    isLocal: true,
    // Do not install Playwright's focus/visibility emulation into a real renderer.
    // The headless renderer also excludes itself from read tracking.
    noDefaults: true,
    timeout,
  });
  const contexts = browser.contexts();
  const context = contexts[0];
  if (context === undefined) {
    await browser.close();
    throw new Error("The CDP endpoint does not expose an Electron browser context");
  }

  try {
    const page = workspacePage({ context });
    return {
      browser,
      context,
      page,
      disconnect: async () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Wait until the authenticated workspace shell is present and visible in the renderer. */
export async function waitForWorkspaceReady(page, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const timeout = assertPositiveTimeout(timeoutMs);
  if (typeof page?.waitForSelector !== "function") {
    throw new Error("A Playwright Page is required to wait for workspace readiness");
  }
  await page.waitForSelector(WORKSPACE_READY_SELECTOR, { state: "visible", timeout });
  return page;
}

/**
 * Attach to every client listed in a headless-demo manifest and close each attachment after it
 * reaches the ready marker. The accepted input is either the manifest or its `clients` array.
 */
export async function waitForHeadlessClients(
  manifestOrClients,
  { playwright, importer, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const clients = Array.isArray(manifestOrClients) ? manifestOrClients : manifestOrClients?.clients;
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error("Headless clients must be a non-empty array");
  }

  const timeout = assertPositiveTimeout(timeoutMs);
  throwIfAborted(signal);
  const deadline = Date.now() + timeout;
  const loadedPlaywright = playwright ?? (await loadPlaywright(importer));
  throwIfAborted(signal);
  const ready = [];
  for (const client of clients) {
    throwIfAborted(signal);
    if (client === null || typeof client !== "object" || typeof client.cdpUrl !== "string") {
      throw new Error("Each headless client must include a CDP URL");
    }
    ready.push(
      await waitForHeadlessClient(client, {
        deadline,
        playwright: loadedPlaywright,
        signal,
      }),
    );
  }
  return ready;
}

async function waitForHeadlessClient(client, { deadline, playwright, signal }) {
  const endpoint = normalizeLocalCdpUrl(client.cdpUrl);
  let lastError;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let connection;
    try {
      const remaining = deadline - Date.now();
      const pendingConnection = connectToCdp(endpoint, {
        playwright,
        timeoutMs: Math.min(remaining, CDP_CONNECT_ATTEMPT_TIMEOUT_MS),
      });
      connection = await waitForAbortableOperation(pendingConnection, signal, (lateConnection) =>
        lateConnection.disconnect().catch(() => undefined),
      );
      await waitForAbortableOperation(
        waitForWorkspaceReady(connection.page, {
          timeoutMs: Math.max(1, deadline - Date.now()),
        }),
        signal,
      );
      throwIfAborted(signal);
      return {
        ...(typeof client.profile === "string" ? { profile: client.profile } : {}),
        cdpUrl: endpoint,
      };
    } catch (error) {
      if (signal?.aborted === true) throw abortError(signal);
      lastError = error;
    } finally {
      if (connection !== undefined) await connection.disconnect().catch(() => undefined);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await waitForRetryDelay(Math.min(remaining, CDP_RETRY_DELAY_MS), signal);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  const profile = typeof client.profile === "string" ? ` for ${client.profile}` : "";
  throw new Error(`Timed out waiting for the headless client${profile} to become ready${detail}`);
}

/** Save a fixed-viewport, CSS-scale PNG without a caret or CSS animations. */
export async function capturePng(page, targetPath, options = {}) {
  if (typeof page?.screenshot !== "function") {
    throw new Error("A Playwright Page is required to capture a PNG");
  }
  const outputPath = assertCapturePath(targetPath, ".png");
  await ensurePrivateCaptureDirectory(outputPath);
  await page.screenshot({
    ...options,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: outputPath,
    scale: "css",
    type: "png",
  });
  await markPrivate(outputPath);
  return outputPath;
}

/** Start an explicit, fixed-size WebM screencast that the caller later stops. */
export async function startWebmScreencast(page, targetPath, options = {}) {
  if (typeof page?.screencast?.start !== "function" || typeof page.screencast.stop !== "function") {
    throw new Error("Playwright 1.59 or newer is required for WebM screencasts");
  }
  const outputPath = assertCapturePath(targetPath, ".webm");
  const size = assertCaptureSize(options.size ?? DEFAULT_CAPTURE_SIZE);
  await ensurePrivateCaptureDirectory(outputPath);
  await page.screencast.start({
    path: outputPath,
    size,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  });

  let stopped = false;
  return {
    path: outputPath,
    async stop() {
      if (stopped) return outputPath;
      stopped = true;
      await page.screencast.stop();
      await markPrivate(outputPath);
      return outputPath;
    },
  };
}

/** Stop a recording returned by `startWebmScreencast`. Safe to call more than once. */
export async function stopWebmScreencast(recording) {
  if (recording === null || typeof recording !== "object" || typeof recording.stop !== "function") {
    throw new Error("A recording returned by startWebmScreencast is required");
  }
  return recording.stop();
}
