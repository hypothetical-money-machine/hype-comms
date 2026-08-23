import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  protectMainProcessLogStreams,
  reportMainProcessError,
  reportMainProcessEvent,
} from "./main-process-log";

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

  it("writes structured lifecycle events as a single line", () => {
    const writer = vi.fn();

    reportMainProcessEvent("session_teardown", { trigger: "will-quit" }, writer);

    expect(writer).toHaveBeenCalledWith(
      JSON.stringify({ event: "session_teardown", trigger: "will-quit" }),
    );
  });

  it("does not let a broken event log destination interrupt lifecycle work", () => {
    expect(() =>
      reportMainProcessEvent("session_teardown", {}, () => {
        throw new Error("stream closed");
      }),
    ).not.toThrow();
  });
});
