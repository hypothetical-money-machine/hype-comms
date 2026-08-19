import { describe, expect, it, vi } from "vitest";

import {
  FENCED_BLOCKQUOTE_MODE_STORAGE_KEY,
  FencedBlockquoteRuntime,
  type FencedBlockquoteStorage,
} from "./fenced-blockquote-runtime";

function memoryStorage(initial: string | null = null): FencedBlockquoteStorage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

describe("FencedBlockquoteRuntime", () => {
  it("defaults invalid and missing preferences to standard Markdown", () => {
    expect(new FencedBlockquoteRuntime(null).mode).toBe("off");
    expect(new FencedBlockquoteRuntime(memoryStorage("both")).mode).toBe("off");
  });

  it("restores either supported fence", () => {
    expect(new FencedBlockquoteRuntime(memoryStorage("double-quote")).mode).toBe("double-quote");
    expect(new FencedBlockquoteRuntime(memoryStorage("greater-than")).mode).toBe("greater-than");
  });

  it("persists changes and publishes them once", () => {
    const setItem = vi.fn();
    const runtime = new FencedBlockquoteRuntime({ getItem: () => null, setItem });
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.setMode("double-quote");
    runtime.setMode("double-quote");

    expect(setItem).toHaveBeenCalledWith(FENCED_BLOCKQUOTE_MODE_STORAGE_KEY, "double-quote");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the session preference when storage fails", () => {
    const runtime = new FencedBlockquoteRuntime({
      getItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => {
        throw new Error("unavailable");
      },
    });

    runtime.setMode("greater-than");
    expect(runtime.mode).toBe("greater-than");
  });
});
