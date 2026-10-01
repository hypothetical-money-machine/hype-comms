import { verifyTimelineBehavior } from "./performance-timeline-behavior.mjs";
/* global document, indexedDB, requestAnimationFrame */
import path from "node:path";
import { startCacheReadProbe, stopCacheReadProbe } from "./performance-cache-reads.mjs";
import { measureOlderHistory } from "./performance-history.mjs";
import { writeFile } from "node:fs/promises";
import { summarize } from "./performance-statistics.mjs";
import {
  inspectTimeline,
  scrollTimelineEdge,
  scrollTimelineToMessage,
  measureTimelineViewport,
} from "./performance-timeline.mjs";

async function measureBacklogTyping(receiver, iterations, screenshotPath) {
  const { page, cdp } = receiver;
  const composer = page.locator("form.composer textarea");
  await composer.fill("");
  await composer.focus();
  const rows = await page.locator(".message-list article[data-message-id]").count();
  const samples = [];
  let before;
  for (let index = 0; index <= iterations; index++) {
    // The first character warms this interaction and is excluded from both measurements.
    if (index === 1) before = (await cdp.send("Performance.getMetrics")).metrics;
    const start = performance.now();
    await page.keyboard.insertText("x");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    if (index > 0) samples.push(performance.now() - start);
  }
  const after = (await cdp.send("Performance.getMetrics")).metrics;
  if ((await composer.inputValue()) !== "x".repeat(iterations + 1))
    throw new Error("Growing-history typing lost or changed input");
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  await composer.fill("");
  const durationMs = (name) => {
    const start = before.find((metric) => metric.name === name)?.value;
    const end = after.find((metric) => metric.name === name)?.value;
    if (start === undefined || end === undefined || end < start)
      throw new Error(`Missing or invalid renderer metric: ${name}`);
    return (end - start) * 1000;
  };
  return {
    rows,
    charactersVerified: iterations + 1,
    toFrame: summarize(samples),
    scriptMs: durationMs("ScriptDuration"),
    taskMs: durationMs("TaskDuration"),
  };
}

// Read the real persistent projection without decrypting histories or changing app state.
export async function readPerformanceCache(page, expectedIds = []) {
  return page.evaluate(async (expectedIds) => {
    const databases = (await indexedDB.databases()).filter(({ name }) =>
      name.startsWith("hype-comms-cache-v1-"),
    );
    if (databases.length !== 1) throw new Error("Expected one synthetic workspace cache");
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(databases[0].name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const transaction = db.transaction(["metadata", "messages"]);
      const read = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const messages = transaction.objectStore("messages");
      const [metadata, rows, ...matches] = await Promise.all([
        read(transaction.objectStore("metadata").get("state")),
        read(messages.count()),
        ...expectedIds.map((id) => read(messages.get(id))),
      ]);
      if (!metadata?.syncCursor) throw new Error("Cache has no durable cursor");
      return {
        rows,
        cursor: metadata.syncCursor,
        matchedMessages: matches.filter((row, index) => row?.id === expectedIds[index]).length,
      };
    } finally {
      db.close();
    }
  }, expectedIds);
}

// Exercise scroll geometry after all latency measurements. In particular, estimated offscreen
// row sizes must not strand the viewport above the latest message or hide a jump target.
export async function verifyPerformanceTimelineLayout(page, channels, directory) {
  const observations = [];
  for (const channel of channels) {
    await page.evaluate((name) => {
      [...document.querySelectorAll('nav[aria-label="Conversations"] button')]
        .find((button) => button.querySelector(".conversation-label-text")?.textContent === name)
        .click();
    }, channel.name);
    const history = await inspectTimeline(page);
    await scrollTimelineEdge(page, "end");
    const tail = await page.locator(".message-list").evaluate((list) => {
      const viewport = list.getBoundingClientRect();
      const last = [...list.querySelectorAll("article[data-message-id]")]
        .at(-1)
        .getBoundingClientRect();
      return {
        tailGap: list.scrollHeight - list.scrollTop - list.clientHeight,
        lastVisible: last.top < viewport.bottom && last.bottom > viewport.top,
      };
    });
    const targetId = history.renderedIds[Math.floor(history.renderedIds.length / 2)];
    await scrollTimelineToMessage(page, targetId);
    const details = await page
      .locator(`.message-list article[data-message-id="${targetId}"]`)
      .evaluate(async (target) => {
        const list = target.closest(".message-list");
        const action = target.querySelector('button[aria-label="Add reaction"]');
        action.focus();
        for (let frame = 0; frame < 8; frame++)
          await new Promise((resolve) => requestAnimationFrame(resolve));
        const viewport = list.getBoundingClientRect();
        const bounds = target.getBoundingClientRect();
        const actionBounds = action.getBoundingClientRect();
        const hit = document.elementFromPoint(
          actionBounds.left + actionBounds.width / 2,
          actionBounds.bottom - 2,
        );
        const result = {
          targetVisible: bounds.top < viewport.bottom && bounds.bottom > viewport.top,
          targetHeight: bounds.height,
          mountedRows: list.querySelectorAll("article[data-message-id]").length,
          actionFullyClickable: hit !== null && action.contains(hit),
          actionBottom: actionBounds.bottom,
          rowBottom: bounds.bottom,
          actionBottomHit: hit?.closest("article")?.dataset.messageId ?? null,
        };
        action.blur();
        return result;
      });
    observations.push({
      name: channel.name,
      rows: history.loadedRows,
      targetId,
      ...tail,
      ...details,
    });
  }
  const failure = observations.find(
    (item) =>
      item.tailGap > 48 || !item.lastVisible || !item.targetVisible || !item.actionFullyClickable,
  );
  if (failure) {
    await page.screenshot({ path: path.join(directory, "layout-failure.png") });
    throw new Error(`Timeline scroll geometry failed: ${JSON.stringify(failure)}`);
  }
  const final = observations.at(-1);
  const row = page.locator(`.message-list article[data-message-id="${final.targetId}"]`);
  await row.hover();
  const hoverFullyClickable = await row.evaluate((row) => {
    const action = row.querySelector('button[aria-label="Add reaction"]');
    const bounds = action.getBoundingClientRect();
    return action.contains(
      document.elementFromPoint(bounds.left + bounds.width / 2, bounds.bottom - 2),
    );
  });
  if (!hoverFullyClickable) throw new Error("Hovered reaction action is clipped");
  const action = row.getByRole("button", { name: "Add reaction", exact: true });
  await action.click();
  const menu = page.getByRole("menu", { name: "Choose a reaction" });
  await menu.waitFor();
  await page.screenshot({ path: path.join(directory, "layout-actions.png") });
  await page.keyboard.press("Escape");
  if (!(await action.evaluate((button) => document.activeElement === button)))
    throw new Error("Closing reaction picker did not restore keyboard focus");
  await action.click();
  await menu.getByRole("menuitemcheckbox", { name: "Add 👍 reaction", exact: true }).click();
  const reaction = row.getByRole("button", {
    name: "👍 1 reaction; remove your reaction",
    exact: true,
  });
  await reaction.waitFor();
  final.hoverFullyClickable = true;
  final.reactionAdded = true;
  return observations;
}

async function verifyTallMessageLayout(page, conversationId, directory) {
  await page.mouse.move(0, 0);
  await page.locator("textarea").focus();
  const expected = await page.evaluate(async (conversationId) => {
    const list = document.querySelector(".message-list");
    list.scrollTop = list.scrollHeight;
    for (let frame = 0; frame < 8; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    const paragraphs = [
      `Tall Markdown layout ${crypto.randomUUID()}`,
      ...Array.from({ length: 80 }, (_, index) => `Paragraph ${index} checks message height.`),
    ];
    const clientMessageId = crypto.randomUUID();
    const sent = await globalThis.hypeComms.sendConversationMessage({
      conversationId,
      idempotencyKey: clientMessageId,
      message: {
        clientMessageId,
        body: paragraphs.map((text, index) => (index === 0 ? text : `**${text}**`)).join("\n\n"),
        bodyFormat: "hype_comms_markdown_v1",
        threadRootId: null,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    if (sent.status !== "accepted") throw new Error("Tall layout message was not accepted");
    return { id: sent.response.message.id, paragraphs };
  }, conversationId);
  const row = page.locator(`.message-list article[data-message-id="${expected.id}"]`);
  await row.waitFor();
  const observation = await row.evaluate(async (row, expected) => {
    const frames = async () => {
      for (let frame = 0; frame < 8; frame++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    await frames();
    const list = row.closest(".message-list");
    const paragraphs = [...row.querySelectorAll(".message-body p")];
    const actualText = paragraphs.map((paragraph) => paragraph.textContent);
    if (JSON.stringify(actualText) !== JSON.stringify(expected.paragraphs))
      throw new Error("Tall Markdown paragraphs differ from the expected rendered body");
    const appendedTailGap = list.scrollHeight - list.scrollTop - list.clientHeight;
    row.scrollIntoView({ block: "start" });
    await frames();
    const bounds = row.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    const first = paragraphs[0].getBoundingClientRect();
    const firstVisible = first.top < viewport.bottom && first.bottom > viewport.top;
    paragraphs.at(-1).scrollIntoView({ block: "end" });
    await frames();
    const last = paragraphs.at(-1).getBoundingClientRect();
    const lastVisible = last.top < viewport.bottom && last.bottom > viewport.top;
    return {
      messageId: expected.id,
      paragraphs: actualText.length,
      height: bounds.height,
      viewportHeight: list.clientHeight,
      appendedTailGap,
      firstVisible,
      lastVisible,
    };
  }, expected);
  await page.screenshot({ path: path.join(directory, "layout-tall-tail.png") });
  if (
    observation.height <= observation.viewportHeight ||
    observation.appendedTailGap > 48 ||
    !observation.firstVisible ||
    !observation.lastVisible
  )
    throw new Error(`Tall message layout failed: ${JSON.stringify(observation)}`);
  const firstParagraph = row.locator(".message-body p").first();
  await firstParagraph.scrollIntoViewIfNeeded();
  await firstParagraph.evaluate(async () => {
    for (let frame = 0; frame < 8; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const previousCount = await page
    .locator(".message-list")
    .evaluate((list) =>
      Number(list.dataset.messageCount ?? list.querySelectorAll("article[data-message-id]").length),
    );
  const { markerId, before, geometryBefore } = await page.evaluate(
    async ({ conversationId, messageId }) => {
      const row = document.querySelector(`.message-list article[data-message-id="${messageId}"]`);
      const list = row.closest(".message-list");
      // Capture the reading position at the send boundary. Measuring it in an earlier driver
      // call can attribute an outstanding scroll/layout update to the incoming message.
      const before = row.querySelector(".message-body p").getBoundingClientRect().top;
      const geometryBefore = {
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        row: row.getBoundingClientRect().toJSON(),
      };
      const clientMessageId = crypto.randomUUID();
      const sent = await globalThis.hypeComms.sendConversationMessage({
        conversationId,
        idempotencyKey: clientMessageId,
        message: {
          clientMessageId,
          body: `Off-tail layout marker ${crypto.randomUUID()}`,
          bodyFormat: "hype_comms_markdown_v1",
          threadRootId: null,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      });
      if (sent.status !== "accepted") throw new Error("Off-tail marker was not accepted");
      return { markerId: sent.response.message.id, before, geometryBefore };
    },
    { conversationId, messageId: expected.id },
  );
  await page.waitForFunction((before) => {
    const list = document.querySelector(".message-list");
    return (
      Number(
        list.dataset.messageCount ?? list.querySelectorAll("article[data-message-id]").length,
      ) > before
    );
  }, previousCount);
  const after = await firstParagraph.evaluate(async (paragraph) => {
    for (let frame = 0; frame < 8; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    const list = paragraph.closest(".message-list");
    return {
      top: paragraph.getBoundingClientRect().top,
      tailGap: list.scrollHeight - list.scrollTop - list.clientHeight,
    };
  });
  const geometryAfter = await firstParagraph.evaluate((paragraph) => {
    const list = paragraph.closest(".message-list");
    return {
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      row: paragraph.closest("article").getBoundingClientRect().toJSON(),
      mounted: [...list.querySelectorAll("article[data-message-id]")].map((row) => ({
        id: row.dataset.messageId,
        top: row.getBoundingClientRect().top,
        height: row.getBoundingClientRect().height,
        known: row.closest(".timeline-item")?.dataset.knownSize,
      })),
    };
  });
  await writeFile(
    path.join(directory, "layout-anchor-trace.json"),
    JSON.stringify({ before: geometryBefore, after: geometryAfter }, null, 2),
  );
  await page.screenshot({ path: path.join(directory, "layout-reading.png") });
  if (Math.abs(after.top - before) > 1 || after.tailGap <= 48)
    throw new Error(
      `Incoming message moved the reading position: ${JSON.stringify({ before, after })}`,
    );
  const durable = await readPerformanceCache(page, [expected.id, markerId]);
  if (durable.matchedMessages !== 2) throw new Error("Layout messages were not durable");
  await scrollTimelineToMessage(page, markerId);
  return {
    ...observation,
    readingAnchorShift: after.top - before,
    readingTailGap: after.tailGap,
    offTailMessageId: markerId,
    durable: true,
  };
}

// The receiving process is closed before any backlog writes. All writes go through another
// signed-in desktop's real preload/HTTP path; no historical events are fabricated in SQL.
export async function measureOfflineBacklog({
  launch,
  close,
  profile,
  senderProfile,
  initialCache,
  channels,
  count,
  samples,
  iterations,
  directory,
  captureProfiles = false,
  getRequests,
  holdMessageWrites,
  advanceReadCursor,
}) {
  const results = [];
  const cumulative = [];
  let before = { rows: initialCache.rows, cursor: initialCache.cursor };
  for (let sample = 0; sample < samples; sample++) {
    const sender = await launch(senderProfile);
    const expected = await sender.page.evaluate(
      async ({ count, channels, sample }) => {
        const messages = [];
        const prefix = `Performance backlog ${sample} ${crypto.randomUUID()}`;
        for (let index = 0; index < count; index++) {
          const channel = channels[index % channels.length];
          const clientMessageId = crypto.randomUUID();
          const body = `${prefix} item ${index}`;
          const result = await globalThis.hypeComms.sendConversationMessage({
            conversationId: channel.id,
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
          if (result.status !== "accepted")
            throw new Error(`Backlog send failed: ${result.status}`);
          messages.push({
            id: result.response.message.id,
            conversationId: channel.id,
            body,
            cursor: result.response.syncCursor,
          });
        }
        return messages;
      },
      { count, channels, sample },
    );
    await close(sender);
    cumulative.push(...expected);
    if (BigInt(expected[0].cursor) <= BigInt(before.cursor))
      throw new Error("Backlog did not advance beyond the closed receiver's cursor");
    const expectedCursor = expected.at(-1).cursor;
    const receiver = await launch(
      profile,
      undefined,
      captureProfiles
        ? path.join(directory, `backlog-startup-${sample + 1}.cpuprofile`)
        : undefined,
    );
    const cache = await readPerformanceCache(
      receiver.page,
      cumulative.map((message) => message.id),
    );
    if (
      cache.matchedMessages !== cumulative.length ||
      BigInt(cache.cursor) < BigInt(expectedCursor)
    )
      throw new Error("Receiver reached live without durably retaining the complete backlog");
    const visits = [];
    if (captureProfiles) await receiver.cdp.send("Profiler.start");
    for (const channel of channels) {
      const known = cumulative.filter((message) => message.conversationId === channel.id);
      if (captureProfiles) await startCacheReadProbe(receiver.page);
      const beforeMetrics = (await receiver.cdp.send("Performance.getMetrics")).metrics;
      const viewportMs = await measureTimelineViewport(receiver.page, channel, known);
      const afterMetrics = (await receiver.cdp.send("Performance.getMetrics")).metrics;
      const cacheReads = captureProfiles ? await stopCacheReadProbe(receiver.page) : undefined;
      const renderer = {};
      for (const name of [
        "ScriptDuration",
        "TaskDuration",
        "LayoutDuration",
        "RecalcStyleDuration",
      ]) {
        const before = beforeMetrics.find((metric) => metric.name === name)?.value;
        const after = afterMetrics.find((metric) => metric.name === name)?.value;
        if (before === undefined || after === undefined || after < before)
          throw new Error(`Invalid conversation-visit metric ${name}`);
        renderer[name] = (after - before) * 1000;
      }
      visits.push({
        conversationId: channel.id,
        name: channel.name,
        viewportMs,
        renderer,
        cacheReads,
      });
    }
    if (captureProfiles) {
      const { profile: visitProfile } = await receiver.cdp.send("Profiler.stop");
      await writeFile(
        path.join(directory, `backlog-visits-${sample + 1}.cpuprofile`),
        JSON.stringify(visitProfile),
      );
    }
    // Full-body verification is separate from navigation timing and traverses unmounted rows.
    for (const [index, channel] of channels.entries()) {
      const known = cumulative.filter((message) => message.conversationId === channel.id);
      await measureTimelineViewport(receiver.page, channel, known);
      visits[index].traversal = await inspectTimeline(receiver.page, known);
    }
    const typing = await measureBacklogTyping(
      receiver,
      iterations,
      sample === samples - 1 ? path.join(directory, "backlog-typing.png") : undefined,
    );
    const result = {
      sample,
      messages: count,
      before,
      expectedCursor,
      cache,
      readyMs: receiver.readyMs,
      connectedMs: receiver.connectedMs,
      startupProfileStartMs: receiver.startupProfileStartMs,
      cacheReads: receiver.cacheReads,
      requests: receiver.startupRequests,
      longTasks: receiver.longTasks,
      crypto: receiver.crypto,
      visits,
      typing,
    };
    results.push(result);
    // Preserve completed timing cycles even if a later behavior assertion rejects the candidate.
    // This checkpoint is explicitly partial; only the final results.json can declare completion.
    await writeFile(
      path.join(directory, "backlog-progress.json"),
      JSON.stringify(
        {
          status: "partial",
          completedTimingCycles: results.length,
          samples: results,
        },
        null,
        2,
      ),
    );
    console.log(
      `Backlog ${sample + 1}: ${count} messages; content ${result.readyMs.toFixed(0)} ms; live ${result.connectedMs.toFixed(0)} ms; all cache entries and bodies verified`,
    );
    await receiver.page.screenshot({ path: path.join(directory, `backlog-${sample + 1}.png`) });
    if (sample === samples - 1) {
      result.layout = await verifyPerformanceTimelineLayout(receiver.page, channels, directory);
      // Evidence only, after the final timed visit: show a newly received body in the viewport.
      const latest = expected.findLast((message) => message.conversationId === channels.at(-1).id);
      await scrollTimelineToMessage(receiver.page, latest.id);
      await receiver.page.screenshot({ path: path.join(directory, "backlog-latest.png") });
      result.olderHistory = await measureOlderHistory(receiver.page, channels[1], directory, {
        cdp: receiver.cdp,
        captureProfile: captureProfiles,
        getRequests,
      });
      await receiver.page.evaluate((name) => {
        [...document.querySelectorAll('nav[aria-label="Conversations"] button')]
          .find((button) => button.querySelector(".conversation-label-text")?.textContent === name)
          .click();
      }, channels.at(-1).name);
      result.tallLayout = await verifyTallMessageLayout(
        receiver.page,
        channels.at(-1).id,
        directory,
      );
      try {
        result.behavior = await verifyTimelineBehavior(
          receiver.page,
          channels,
          cumulative,
          directory,
          holdMessageWrites,
          advanceReadCursor,
        );
      } catch (error) {
        await receiver.page.screenshot({
          path: path.join(directory, "window-behavior-failure.png"),
        });
        const geometry = await receiver.page.locator(".message-list").evaluate((list) => ({
          loaded: list.dataset.messageCount,
          mounted: list.querySelectorAll("article[data-message-id]").length,
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          viewportHeight: list.clientHeight,
        }));
        await writeFile(
          path.join(directory, "window-behavior-failure.json"),
          JSON.stringify({ error: String(error), geometry }, null, 2),
        );
        throw error;
      }
    }
    const finalIds = [
      ...cumulative.map((message) => message.id),
      ...(result.olderHistory?.newIds ?? []),
      ...(result.behavior?.pending.map((item) => item.messageId) ?? []),
      ...(result.behavior?.newIds ?? []),
      ...(result.tallLayout
        ? [result.tallLayout.messageId, result.tallLayout.offTailMessageId]
        : []),
    ];
    const finalCache = await readPerformanceCache(receiver.page, finalIds);
    if (finalCache.matchedMessages !== finalIds.length)
      throw new Error("Final cache lost a previously verified message");
    result.finalCache = finalCache;
    await close(receiver);
    before = { rows: finalCache.rows, cursor: finalCache.cursor };
  }
  return results;
}
