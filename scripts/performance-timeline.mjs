/* global document, requestAnimationFrame, getComputedStyle */

export async function timelineCount(page) {
  return page
    .locator(".message-list")
    .evaluate((list) =>
      Number(list.dataset.messageCount ?? list.querySelectorAll("article[data-message-id]").length),
    );
}

export async function scrollTimelineEdge(page, edge) {
  await page.locator(".message-list").evaluate(async (list, edge) => {
    for (let frame = 0; frame < 8; frame++) {
      list.scrollTop = edge === "start" ? 0 : list.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, edge);
}

// Check real rendered bodies while traversing the whole history. No hidden text mirror or
// application-store read can satisfy this check when a row has not rendered correctly.
export async function inspectTimeline(page, expected = []) {
  // Finish post-history size/anchor updates before beginning the complete traversal. A single
  // scrollTop assignment can be superseded by an outstanding layout measurement.
  await scrollTimelineEdge(page, "start");
  return page.locator(".message-list").evaluate(async (list, expected) => {
    const rows = new Map();
    const started = performance.now();
    list.scrollTop = 0;
    for (let step = 0; step < 3000; step++) {
      for (let frame = 0; frame < 4; frame++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      for (const row of list.querySelectorAll("article[data-message-id]"))
        rows.set(row.dataset.messageId, row.querySelector(".message-body")?.textContent ?? "");
      const total = Number(list.dataset.messageCount ?? rows.size);
      if (list.scrollHeight - list.scrollTop - list.clientHeight <= 1 && rows.size === total) {
        for (const message of expected)
          if (!rows.get(message.id)?.includes(message.body))
            throw new Error(`Missing or incorrect rendered timeline body: ${message.id}`);
        return {
          loadedRows: total,
          renderedIds: [...rows.keys()],
          verifiedMessages: expected.length,
        };
      }
      if (performance.now() - started > 90_000) break;
      list.scrollTop += Math.max(1, list.clientHeight * 0.75);
    }
    throw new Error(`Timeline traversal incomplete: ${rows.size} distinct rows`);
  }, expected);
}

export async function scrollTimelineToMessage(page, messageId) {
  await page.locator(".message-list").evaluate(async (list, messageId) => {
    const frames = async () => {
      for (let frame = 0; frame < 4; frame++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    list.scrollTop = 0;
    for (let step = 0; step < 3000; step++) {
      await frames();
      const row = [...list.querySelectorAll("article[data-message-id]")].find(
        (row) => row.dataset.messageId === messageId,
      );
      if (row) {
        row.scrollIntoView({ block: "center" });
        await frames();
        return;
      }
      if (list.scrollHeight - list.scrollTop - list.clientHeight <= 1) break;
      list.scrollTop += Math.max(1, list.clientHeight * 0.75);
    }
    throw new Error(`Message navigation could not reach ${messageId}`);
  }, messageId);
}

export async function measureTimelineViewport(page, channel, knownMessages) {
  return page.evaluate(
    async ({ channel, knownMessages }) => {
      const ids = new Set(knownMessages.map((message) => message.id));
      const button = [...document.querySelectorAll('nav[aria-label="Conversations"] button')].find(
        (button) => button.querySelector(".conversation-label-text")?.textContent === channel.name,
      );
      if (!button) throw new Error(`Missing conversation: ${channel.name}`);
      const start = performance.now();
      button.click();
      await new Promise((resolve, reject) => {
        const check = () => {
          if (performance.now() - start > 30_000)
            return reject(new Error("No conversation viewport"));
          const list = document.querySelector(".message-list");
          const viewport = list?.getBoundingClientRect();
          const found =
            viewport &&
            [...list.querySelectorAll("article[data-message-id]")].some((row) => {
              const bounds = row.getBoundingClientRect();
              return (
                getComputedStyle(row).visibility === "visible" &&
                bounds.bottom > viewport.top &&
                bounds.top < viewport.bottom &&
                (ids.has(row.dataset.messageId) ||
                  row.textContent.includes(`Benchmark ${channel.slug} item`))
              );
            });
          if (found) requestAnimationFrame(() => requestAnimationFrame(resolve));
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      return performance.now() - start;
    },
    { channel, knownMessages },
  );
}
