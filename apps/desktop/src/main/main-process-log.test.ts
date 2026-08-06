import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { protectMainProcessLogStreams, reportMainProcessError } from "./main-process-log";

describe("main-process logging", () => {
  it("does not throw when a closed console stream rejects a write", () => {
    const failure = Object.assign(new Error("write EIO"), { code: "EIO" });
    const writer = vi.fn(() => {
      throw failure;
    });

    expect(() =>
      reportMainProcessError("Realtime connection failed", failure, writer),
    ).not.toThrow();
    expect(writer).toHaveBeenCalledWith("Realtime connection failed", failure);
  });

  it("absorbs asynchronous stdout and stderr errors", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    protectMainProcessLogStreams([stdout, stderr]);

    expect(() =>
      stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(() =>
      stderr.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" })),
    ).not.toThrow();
  });
});
