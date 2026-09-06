/* global document, requestAnimationFrame */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { timelineCount, scrollTimelineEdge, inspectTimeline } from "./performance-timeline.mjs";

// Run after all timing cycles. Measure the user actions needed to get beyond restored pages;
// a control may require several clicks, while every request must retain the server cursor chain.
export async function measureOlderHistory(
  page,
  channel,
  directory,
  { cdp, captureProfile, getRequests },
) {
  await page.evaluate((name) => {
    [...document.querySelectorAll('nav[aria-label="Conversations"] button')]
      .find((button) => button.querySelector(".conversation-label-text")?.textContent === name)
      .click();
  }, channel.name);
  await scrollTimelineEdge(page, "start");
  const before = await timelineCount(page);
  const initialIds = (await inspectTimeline(page)).renderedIds;
  await scrollTimelineEdge(page, "start");
  const beforeMetrics = (await cdp.send("Performance.getMetrics")).metrics;
  if (captureProfile) await cdp.send("Profiler.start");
  const requestStart = getRequests().length;
  const started = performance.now();
  const clicks = [];
  while ((await timelineCount(page)) <= before && clicks.length < 30) {
    const clickStarted = performance.now();
    await page.locator(".load-older").evaluate((button) => button.click());
    await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await page.waitForFunction(() => !document.querySelector(".load-older")?.disabled);
    const error = await page
      .locator(".message-list")
      .evaluate((list) => list.querySelector("[role=alert]")?.textContent);
    if (error) throw new Error(`Older history failed: ${error}`);
    clicks.push({ ms: performance.now() - clickStarted, rows: await timelineCount(page) });
  }
  const ms = performance.now() - started;
  const afterMetrics = (await cdp.send("Performance.getMetrics")).metrics;
  const requests = getRequests().slice(requestStart);
  if (captureProfile) {
    const { profile } = await cdp.send("Profiler.stop");
    await writeFile(path.join(directory, "older-history.cpuprofile"), JSON.stringify(profile));
  }
  const renderer = {};
  for (const name of [
    "ScriptDuration",
    "TaskDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "LayoutCount",
    "RecalcStyleCount",
  ]) {
    const start = beforeMetrics.find((metric) => metric.name === name)?.value;
    const end = afterMetrics.find((metric) => metric.name === name)?.value;
    if (start === undefined || end === undefined || end < start)
      throw new Error(`Invalid renderer metric ${name}`);
    renderer[name] = (end - start) * (name.endsWith("Duration") ? 1000 : 1);
  }
  if ((await timelineCount(page)) <= before) throw new Error("Older history never added messages");
  const traversal = await inspectTimeline(page);
  const retained = new Set(traversal.renderedIds);
  if (initialIds.some((id) => !retained.has(id))) throw new Error("Older history lost loaded rows");
  const newIds = traversal.renderedIds.filter((id) => !initialIds.includes(id));
  await scrollTimelineEdge(page, "start");
  await page.screenshot({ path: path.join(directory, "older-history.png") });
  return {
    name: channel.name,
    before,
    after: traversal.loadedRows,
    clicks,
    ms,
    renderer,
    requests,
    newIds,
    traversal,
  };
}
