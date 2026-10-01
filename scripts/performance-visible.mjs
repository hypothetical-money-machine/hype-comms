/* global document */
import { setTimeout as delay } from "node:timers/promises";
import { inspectTimeline } from "./performance-timeline.mjs";

// Inspect native and DOM state without replacing the application's visibility/focus guards.
export async function visibleWindowState(browser, page) {
  const native = await browser.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      shown: window.isVisible(),
      focused: window.isFocused(),
      contentSize: window.getContentSize(),
    };
  });
  const renderer = await page.evaluate(() => ({
    headless: globalThis.hypeComms.isHeadless,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    devicePixelRatio: globalThis.devicePixelRatio,
    interruptions: globalThis.performanceForegroundInterruptions ?? [],
  }));
  if (
    !native.shown ||
    !native.focused ||
    native.contentSize[0] !== 1280 ||
    native.contentSize[1] !== 800 ||
    renderer.headless !== false ||
    renderer.visibility !== "visible" ||
    !renderer.focused ||
    renderer.interruptions.length > 0 ||
    renderer.width !== 1280 ||
    renderer.height !== 800
  ) {
    throw new Error(
      `Visible benchmark lost its foreground window: ${JSON.stringify({ native, renderer })}`,
    );
  }
  return { mode: "visible", native, renderer };
}

export async function watchVisibleWindow(browser, page) {
  await visibleWindowState(browser, page);
  await page.evaluate(() => {
    globalThis.performanceForegroundInterruptions = [];
    const observe = () => {
      if (!document.hasFocus() || document.visibilityState !== "visible") {
        globalThis.performanceForegroundInterruptions.push({
          atMs: performance.now(),
          focused: document.hasFocus(),
          visibility: document.visibilityState,
        });
      }
    };
    globalThis.addEventListener("blur", observe);
    document.addEventListener("visibilitychange", observe);
    observe();
  });
  await visibleWindowState(browser, page);
}

// Excluded from timing samples. Deliver a message from the other signed-in client, traverse
// the real foreground history, then reread server state through the normal bootstrap IPC.
// No read-cursor write IPC, repository mutation, or synthetic focus event can satisfy this probe.
export async function verifyVisibleReadTracking(active, sender, conversationId) {
  const beforeWindow = await visibleWindowState(active.browser, active.page);
  const readCursor = () =>
    active.page.evaluate(async (conversationId) => {
      const bootstrap = await globalThis.hypeComms.getWorkspaceBootstrap();
      return bootstrap.conversations.find((summary) => summary.conversation.id === conversationId)
        .readCursor;
    }, conversationId);
  const before = await readCursor();
  const body = `Visible reading ${crypto.randomUUID()}`;
  const response = await sender.page.evaluate(
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
    { conversationId, body },
  );
  if (response.status !== "accepted") throw new Error("Visible read-tracking send failed");
  const row = active.page
    .locator(".message-list article[data-message-id]")
    .filter({ hasText: body });
  await row.waitFor({ state: "attached" });
  const message = await row.evaluate((row) => ({
    id: row.dataset.messageId,
    sequence: row.dataset.messageSequence,
  }));
  if (!message.id || !message.sequence)
    throw new Error("Visible reading row lacks canonical identity");
  if (BigInt(before?.lastReadConversationSequence ?? "0") >= BigInt(message.sequence))
    throw new Error("Visible reading marker does not advance the initial cursor");
  const traversal = await inspectTimeline(active.page, [{ id: message.id, body }]);
  const deadline = performance.now() + 15_000;
  let after;
  do {
    after = await readCursor();
    if (after?.lastReadMessageId === message.id) break;
    await delay(100);
  } while (performance.now() < deadline);
  if (after?.lastReadMessageId !== message.id)
    throw new Error(
      `Visible reading did not reach received message: ${JSON.stringify({ before, after, message })}`,
    );
  const afterWindow = await visibleWindowState(active.browser, active.page);
  return { before, after, message, traversal, beforeWindow, afterWindow };
}
