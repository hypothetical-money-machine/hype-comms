/* global document, requestAnimationFrame, indexedDB */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import {
  timelineCount,
  inspectTimeline,
  scrollTimelineEdge,
  scrollTimelineToMessage,
} from "./performance-timeline.mjs";

async function frames(page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 12; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

async function select(page, channel) {
  await page.evaluate(
    (name) =>
      [...document.querySelectorAll('nav[aria-label="Conversations"] button')]
        .find((button) => button.querySelector(".conversation-label-text")?.textContent === name)
        .click(),
    channel.name,
  );
  await frames(page);
}

async function outboxCount(page) {
  return page.evaluate(async () => {
    const databases = (await indexedDB.databases()).filter(({ name }) =>
      name.startsWith("hype-comms-cache-v1-"),
    );
    if (databases.length !== 1) throw new Error("Expected one workspace cache");
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(databases[0].name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const count = db.transaction("outbox").objectStore("outbox").count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
    } finally {
      db.close();
    }
  });
}

async function anchor(page) {
  return page.locator(".message-list").evaluate((list) => {
    const viewport = list.getBoundingClientRect();
    const row = [...list.querySelectorAll("article[data-message-id]")].find((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    });
    if (!row) throw new Error("No fully visible reading anchor");
    return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
  });
}

async function anchorShift(page, before) {
  return page
    .locator(`.message-list article[data-message-id="${before.id}"]`)
    .evaluate((row, top) => row.getBoundingClientRect().top - top, before.top);
}

export async function verifyTimelineBehavior(
  page,
  channels,
  messages,
  directory,
  holdMessageWrites,
  advanceReadCursor,
) {
  page.setDefaultTimeout(10_000);
  const channel = channels[1];
  const known = messages.filter((message) => message.conversationId === channel.id);
  const target = known[Math.floor(known.length / 2)];
  await page.locator(".workspace-search-button").click();
  await page.locator("#workspace-search-query").fill(target.body);
  await page.locator(".workspace-search-dialog form").evaluate((form) => form.requestSubmit());
  await page.locator(".workspace-search-results button").filter({ hasText: target.body }).click();
  const targetRow = page.locator(`.message-list article[data-message-id="${target.id}"]`);
  await targetRow.waitFor();
  await frames(page);
  const jump = await targetRow.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const list = row.closest(".message-list");
    const viewport = list.getBoundingClientRect();
    const offset = (bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2;
    const maximumScroll = Math.max(0, list.scrollHeight - list.clientHeight);
    const desiredScroll = list.scrollTop + offset;
    // scrollIntoView cannot center a target near the first or last row without extra content.
    // Require the corresponding boundary, never excuse an off-center interior target.
    const boundaryClamped =
      (desiredScroll < 0 && Math.abs(list.scrollTop) <= 2) ||
      (desiredScroll > maximumScroll && Math.abs(list.scrollTop - maximumScroll) <= 2);
    return {
      visible: bounds.bottom > viewport.top && bounds.top < viewport.bottom,
      boundaryClamped,
      centerLineInside:
        bounds.top <= (viewport.top + viewport.bottom) / 2 &&
        bounds.bottom >= (viewport.top + viewport.bottom) / 2,
      centerError: Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2),
    };
  });
  await page.screenshot({ path: path.join(directory, "window-search-jump.png") });
  if (!jump.visible || (!jump.centerLineInside && !jump.boundaryClamped))
    throw new Error(`Search jump failed: ${JSON.stringify(jump)}`);

  const initialIds = (await inspectTimeline(page)).renderedIds;
  await scrollTimelineEdge(page, "start");
  const beforeOlder = await anchor(page);
  const count = await timelineCount(page);
  let olderPages = 0;
  // A restored history can already contain pages older than the server refresh's cursor.
  // Exercise those overlapping pages too, then require an actual prepend.
  while ((await timelineCount(page)) <= count && olderPages < 30) {
    await page.locator(".load-older").evaluate((button) => button.click());
    olderPages += 1;
    await frames(page);
    await page.waitForFunction(() => !document.querySelector(".load-older")?.disabled);
  }
  if ((await timelineCount(page)) <= count)
    throw new Error("Older history never grew beyond the cached pages");
  await frames(page);
  const prependShift = await anchorShift(page, beforeOlder);
  await page.screenshot({ path: path.join(directory, "window-older-anchor.png") });
  if (Math.abs(prependShift) > 2)
    throw new Error(`Older history moved the reading anchor: ${prependShift}`);

  await writeFile(
    path.join(directory, "window-behavior-progress.json"),
    JSON.stringify({ jump, prependShift, beforeOlder, olderPages }, null, 2),
  );
  const afterIds = (await inspectTimeline(page)).renderedIds;
  if (initialIds.some((id) => !afterIds.includes(id)))
    throw new Error("Behavior prepend lost a loaded message");
  const newIds = afterIds.filter((id) => !initialIds.includes(id));

  // Seed the read cursor through the production repository in the isolated benchmark cluster.
  // Headless read-cursor IPC remains disabled. This checks incoming read-state events and initial
  // placement, not normal visibility/focus-driven read tracking or HTTP authentication.
  await select(page, channels[0]);
  const targetIndex = initialIds.indexOf(target.id);
  if (targetIndex <= 0) throw new Error("Unread probe needs a loaded predecessor");
  await advanceReadCursor(channel.id, initialIds[targetIndex - 1]);
  const expectedUnread = known.length - Math.floor(known.length / 2);
  await page
    .getByRole("navigation", { name: "Conversations" })
    .locator("button")
    .filter({ hasText: channel.name })
    .getByLabel(`${expectedUnread} unread message${expectedUnread === 1 ? "" : "s"}`, {
      exact: true,
    })
    .waitFor();
  await select(page, channel);
  const divider = page.locator(`#unread-${channel.id}`);
  await divider.waitFor();
  await frames(page);
  const unread = await divider.evaluate((divider) => {
    const viewport = divider.closest(".message-list").getBoundingClientRect();
    const bounds = divider.getBoundingClientRect();
    return {
      visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      nextMessageId: (
        divider.closest(".timeline-item")?.querySelector("article") ?? divider.nextElementSibling
      )?.dataset.messageId,
    };
  });
  await page.screenshot({ path: path.join(directory, "window-unread.png") });
  if (!unread.visible || unread.nextMessageId !== target.id)
    throw new Error(`Unread landing failed: ${JSON.stringify(unread)}`);
  const latest = await page.evaluate(async (id) => {
    const history = await globalThis.hypeComms.getConversationMessages({
      conversationId: id,
      limit: 1,
    });
    return history.messages[0].id;
  }, channel.id);
  await select(page, channels[0]);
  await advanceReadCursor(channel.id, latest);
  await frames(page);
  await select(page, channel);
  await frames(page);
  const initialTail = await page.locator(".message-list").evaluate((list) => ({
    gap: list.scrollHeight - list.scrollTop - list.clientHeight,
    reported:
      list.dataset.atLiveTail === undefined
        ? list.scrollHeight - list.scrollTop - list.clientHeight <= 48
        : list.dataset.atLiveTail === "true",
  }));
  if (initialTail.gap > 48 || !initialTail.reported)
    throw new Error(`Initial tail state failed: ${JSON.stringify(initialTail)}`);
  const pending = [];
  for (const atTail of [true, false]) {
    if (atTail) await scrollTimelineEdge(page, "end");
    else await scrollTimelineToMessage(page, beforeOlder.id);
    const before = atTail ? null : await anchor(page);
    if ((await outboxCount(page)) !== 0) throw new Error("Pending probe needs an empty outbox");
    const body = `Queued window ${crypto.randomUUID()}`;
    await holdMessageWrites(true);
    try {
      await page.locator("form.composer textarea").fill(body);
      await page.locator("form.composer").evaluate((form) => form.requestSubmit());
      // The pending row must be visible at the tail. Away from it, the encrypted outbox
      // remains durable even though its row can be outside the mounted window.
      if (atTail) await page.locator(".pending-message").filter({ hasText: body }).waitFor();
      else
        await page.waitForFunction(
          () => document.querySelector("form.composer textarea").value === "",
        );
      await frames(page);
      if ((await outboxCount(page)) !== 1)
        throw new Error("Queued message was not retained in the durable outbox");
      const state = await page.locator(".message-list").evaluate((list, body) => {
        const viewport = list.getBoundingClientRect();
        const row = [...list.querySelectorAll(".pending-message")].find((row) =>
          row.textContent.includes(body),
        );
        const bounds = row?.getBoundingClientRect();
        return {
          pendingVisible: Boolean(
            bounds && bounds.bottom > viewport.top && bounds.top < viewport.bottom,
          ),
          tailGap: list.scrollHeight - list.scrollTop - list.clientHeight,
          reportedAtTail:
            list.dataset.atLiveTail === undefined
              ? list.scrollHeight - list.scrollTop - list.clientHeight <= 48
              : list.dataset.atLiveTail === "true",
        };
      }, body);
      const shift = before === null ? 0 : await anchorShift(page, before);
      await page.screenshot({
        path: path.join(
          directory,
          atTail ? "window-pending-tail.png" : "window-pending-reading.png",
        ),
      });
      if (
        atTail
          ? !state.pendingVisible || state.tailGap > 48 || !state.reportedAtTail
          : Math.abs(shift) > 2 || state.tailGap <= 48 || state.reportedAtTail
      )
        throw new Error(`Pending scroll failed: ${JSON.stringify({ atTail, state, shift })}`);
      pending.push({ atTail, ...state, anchorShift: shift });
    } finally {
      await holdMessageWrites(false);
    }
    for (let retry = 0; retry < 100 && (await outboxCount(page)) !== 0; retry++) await frames(page);
    if ((await outboxCount(page)) !== 0)
      throw new Error("Canonical acknowledgement did not drain the outbox");
    await frames(page);
    const canonicalShift = before === null ? 0 : await anchorShift(page, before);
    if (Math.abs(canonicalShift) > 2)
      throw new Error(`Canonical acknowledgement moved the reading anchor: ${canonicalShift}`);
    pending.at(-1).canonicalAnchorShift = canonicalShift;
    // Require a canonical row after release, then check the next case from a settled state.
    await scrollTimelineEdge(page, "end");
    await page
      .locator(".message-list article[data-message-id]")
      .filter({ hasText: body })
      .waitFor();
    pending.at(-1).messageId = await page
      .locator(".message-list article[data-message-id]")
      .filter({ hasText: body })
      .getAttribute("data-message-id");
    await frames(page);
  }

  return { jump, prependShift, beforeOlder, olderPages, newIds, pending, unread, initialTail };
}
