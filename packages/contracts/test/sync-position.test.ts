import { describe, expect, it } from "vitest";

import {
  compareSyncPositions,
  encodeSyncPosition,
  sameSyncPosition,
  syncPositionQuerySchema,
  syncPositionSchema,
} from "../src/sync-position.js";

const epoch = "10000000-0000-4000-8000-000000000001";
const nextEpoch = "10000000-0000-4000-8000-000000000002";

describe("durable sync positions", () => {
  it("rejects old scalar cursors, unknown fields, and unbounded query input", () => {
    for (const value of ["10", { sequence: "10" }, { epoch, sequence: "10", extra: true }]) {
      expect(syncPositionSchema.safeParse(value).success).toBe(false);
    }
    expect(syncPositionQuerySchema.safeParse(" ".repeat(129)).success).toBe(false);
    expect(syncPositionQuerySchema.safeParse("not JSON").success).toBe(false);
  });

  it("roundtrips positions without losing bigint precision", () => {
    const position = { epoch, sequence: "9007199254740993" };
    expect(syncPositionQuerySchema.parse(encodeSyncPosition(position))).toEqual(position);
    expect(compareSyncPositions(position, { epoch, sequence: "9007199254740992" })).toBe(1);
    expect(compareSyncPositions(position, position)).toBe(0);
  });

  it("refuses to order positions across epochs even when their sequences match", () => {
    const previous = { epoch, sequence: "10" };
    const current = { epoch: nextEpoch, sequence: "10" };
    expect(sameSyncPosition(previous, current)).toBe(false);
    expect(() => compareSyncPositions(previous, current)).toThrow("different epochs");
  });
});
