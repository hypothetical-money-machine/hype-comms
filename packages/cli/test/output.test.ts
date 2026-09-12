import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { EventWriter } from "../src/output.js";

describe("acknowledged event output", () => {
  it("waits for the writable callback before accepting a backpressured event", async () => {
    let flushed: ((error?: Error | null) => void) | undefined;
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        flushed = callback;
      },
    });
    const writer = new EventWriter(stream);
    let acknowledged = false;
    try {
      const output = writer.write({ event: "test" }).then(() => {
        acknowledged = true;
      });
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      flushed!();
      await output;
      expect(acknowledged).toBe(true);
    } finally {
      writer.dispose();
      stream.destroy();
    }
  });
  it("rejects a failed output write without emitting an unhandled stream error", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("pipe closed"));
      },
    });
    const writer = new EventWriter(stream);
    try {
      await expect(writer.write({ event: "test" })).rejects.toThrow("pipe closed");
    } finally {
      writer.dispose();
    }
  });
});
