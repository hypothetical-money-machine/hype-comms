import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { measureOlderHistory } from "./performance-history.mjs";

const continuation = "More history remains. Load older messages again to continue.";

function historyPage(onClick) {
  let clicks = 0;
  let alert = null;
  const rows = [
    { dataset: { messageId: "current" }, querySelector: () => ({ textContent: "current" }) },
  ];
  const list = {
    dataset: {},
    scrollTop: 0,
    scrollHeight: 500,
    clientHeight: 500,
    querySelector: (selector) =>
      selector === "[role=alert]" && alert ? { textContent: alert } : null,
    querySelectorAll: () => rows,
  };
  const older = {
    disabled: false,
    click: () => {
      clicks += 1;
      const result = onClick(clicks);
      alert = result.alert ?? null;
      if (result.addRow)
        rows.unshift({
          dataset: { messageId: "older" },
          querySelector: () => ({ textContent: "older" }),
        });
    },
  };
  const document = {
    querySelectorAll: () => [{ querySelector: () => ({ textContent: "Design" }), click: () => {} }],
    querySelector: (selector) => (selector === ".load-older" ? older : list),
  };
  const context = createContext({
    document,
    performance,
    requestAnimationFrame: (callback) => callback(),
  });
  const evaluate = async (callback, argument, element) => {
    context.argument = argument;
    context.element = element;
    return await runInContext(
      element === undefined ? `(${callback})(argument)` : `(${callback})(element, argument)`,
      context,
    );
  };
  let screenshot;
  return {
    page: {
      evaluate,
      locator: (selector) => ({
        evaluate: (callback, argument) =>
          evaluate(callback, argument, document.querySelector(selector)),
      }),
      waitForFunction: async (callback) => assert.equal(await evaluate(callback), true),
      screenshot: async (options) => {
        screenshot = options.path;
      },
    },
    options: {
      cdp: {
        send: async () => ({
          metrics: [
            "ScriptDuration",
            "TaskDuration",
            "LayoutDuration",
            "RecalcStyleDuration",
            "LayoutCount",
            "RecalcStyleCount",
          ].map((name) => ({ name, value: 0 })),
        }),
      },
      captureProfile: false,
      getRequests: () => [],
    },
    clicks: () => clicks,
    screenshot: () => screenshot,
  };
}

test("retries the bounded overlap notice and retains rendered history", async () => {
  const harness = historyPage((click) =>
    click === 1 ? { alert: continuation } : { addRow: true },
  );
  const result = await measureOlderHistory(
    harness.page,
    { name: "Design" },
    "/evidence",
    harness.options,
  );
  assert.equal(harness.clicks(), 2);
  assert.equal(result.before, 1);
  assert.equal(result.after, 2);
  assert.deepEqual(Array.from(result.newIds), ["older"]);
  assert.deepEqual(
    result.clicks.map((click) => click.rows),
    [1, 2],
  );
  assert.equal(harness.screenshot(), path.join("/evidence", "older-history.png"));
});

test("does not retry an actual older-history error", async () => {
  const harness = historyPage(() => ({ alert: "Could not load conversation history" }));
  await assert.rejects(
    measureOlderHistory(harness.page, { name: "Design" }, "/evidence", harness.options),
    /Older history failed: Could not load conversation history/,
  );
  assert.equal(harness.clicks(), 1);
  assert.equal(harness.screenshot(), undefined);
});

test("fails after 30 continuation actions that never add history", async () => {
  const harness = historyPage(() => ({ alert: continuation }));
  await assert.rejects(
    measureOlderHistory(harness.page, { name: "Design" }, "/evidence", harness.options),
    /Older history never added messages/,
  );
  assert.equal(harness.clicks(), 30);
});
