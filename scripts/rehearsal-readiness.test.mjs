import assert from "node:assert/strict";
import test from "node:test";

import { waitForReadiness } from "./rehearsal/wait-for-readiness.mjs";

test("healthy cold startup after ten seconds remains inside the rehearsal deadline", async () => {
  let now = 0;
  await waitForReadiness(
    () => {
      if (now < 12_000) throw new Error("Connection not ready");
      return true;
    },
    {
      clock: () => now,
      pause: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(now, 12_000);
});

test("readiness stops at the elapsed deadline without accepting a later response", async () => {
  let now = 0;
  let checks = 0;
  await assert.rejects(
    waitForReadiness(
      () => {
        checks++;
        return now >= 500;
      },
      {
        timeoutMs: 500,
        clock: () => now,
        pause: async (ms) => {
          now += ms;
        },
      },
    ),
    /Readiness deadline expired/u,
  );
  assert.equal(now, 500);
  assert.equal(checks, 5);
});
