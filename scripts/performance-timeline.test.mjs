import assert from "node:assert/strict";
import test from "node:test";

import { clickConversation } from "./performance-timeline.mjs";

test("clickConversation matches a slug without case sensitivity", async () => {
  let clicked = false;
  const button = {
    querySelector: (selector) =>
      selector === ".conversation-label-text" ? { textContent: "General" } : null,
    click: () => {
      clicked = true;
    },
  };
  const page = {
    evaluate: async (callback, match) => {
      const document = globalThis.document;
      globalThis.document = {
        querySelectorAll: () => [button],
      };
      try {
        await callback(match);
      } finally {
        globalThis.document = document;
      }
    },
  };

  await clickConversation(page, { slug: "GENERAL" });

  assert.equal(clicked, true);
});
