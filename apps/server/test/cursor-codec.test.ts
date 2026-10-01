import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCursorCodec } from "../src/modules/workspace/cursor-codec.js";
import { decodeTaskCursor, taskFilterHash } from "../src/modules/workspace/pagination.js";

const codec = createCursorCodec("test", z.object({ text: z.string() }).strict());
describe("bounded opaque cursor decoding", () => {
  it("round-trips non-BMP text and distinguishes missing from malformed", () => {
    expect(codec.decode(undefined)).toBeNull();
    expect(codec.decode(codec.encode({ text: "hello 😀" }))).toEqual({ text: "hello 😀" });
    for (const cursor of [
      "",
      "!",
      "a".repeat(513),
      Buffer.from('{"text":"').toString("base64url"),
      Buffer.from('{"text":"ok","extra":true}').toString("base64url"),
    ]) {
      expect(() => codec.decode(cursor)).toThrow("Invalid test cursor");
    }
  });
  it("rejects invalid UTF-8 rather than decoding a replacement character", () => {
    const invalid = Buffer.concat([
      Buffer.from('{"text":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]).toString("base64url");
    expect(() => codec.decode(invalid)).toThrow("Invalid test cursor");
  });
  it("binds task cursors to the selected filters", () => {
    const filterHash = taskFilterHash({ status: "done" });
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: "2026-09-12T00:00:00Z",
        id: "10000000-0000-4000-8000-000000000001",
        filterHash,
      }),
    ).toString("base64url");
    expect(decodeTaskCursor(cursor, filterHash)?.createdAt).toBe("2026-09-12T00:00:00.000Z");
    expect(() => decodeTaskCursor(cursor, taskFilterHash({}))).toThrow("Invalid task cursor");
  });
});
