import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "./performance-statistics.mjs";

test("performance summary preserves samples and uses arithmetic median and nearest-rank p95", () => {
  const samples = Array.from({ length: 20 }, (_, i) => 20 - i);
  const result = summarize(samples);
  assert.equal(result.median, 10.5);
  assert.equal(result.p95, 19);
  assert.equal(result.min, 1);
  assert.equal(result.max, 20);
  assert.equal(result.n, 20);
  assert.deepEqual(result.samples, samples);
  assert.equal(samples[0], 20);
});

test("performance summary handles one sample and rejects unusable measurements", () => {
  assert.deepEqual(summarize([0]), { n: 1, min: 0, median: 0, p95: 0, max: 0, samples: [0] });
  for (const values of [[], [NaN], [Infinity], [-1]]) assert.throws(() => summarize(values));
});
