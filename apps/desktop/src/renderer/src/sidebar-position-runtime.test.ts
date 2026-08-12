// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_POSITION_STORAGE_KEY,
  SidebarPositionRuntime,
  type SidebarPositionStorage,
} from "./sidebar-position-runtime";

class MemoryStorage implements SidebarPositionStorage {
  readonly values = new Map<string, string>();
  getError: Error | null = null;
  setError: Error | null = null;

  getItem(key: string): string | null {
    if (this.getError !== null) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError !== null) throw this.setError;
    this.values.set(key, value);
  }
}

afterEach(() => {
  delete document.documentElement.dataset.sidebarPosition;
});

describe("SidebarPositionRuntime", () => {
  it("defaults to the existing left placement", () => {
    const runtime = new SidebarPositionRuntime(document.documentElement, new MemoryStorage());

    expect(runtime.position).toBe("left");
    expect(document.documentElement.dataset.sidebarPosition).toBe("left");
  });

  it("restores a saved right placement before the app renders", () => {
    const storage = new MemoryStorage();
    storage.values.set(SIDEBAR_POSITION_STORAGE_KEY, "right");

    const runtime = new SidebarPositionRuntime(document.documentElement, storage);

    expect(runtime.position).toBe("right");
    expect(document.documentElement.dataset.sidebarPosition).toBe("right");
  });

  it("fails closed to left for malformed or unreadable storage", () => {
    const malformed = new MemoryStorage();
    malformed.values.set(SIDEBAR_POSITION_STORAGE_KEY, "bottom");
    expect(new SidebarPositionRuntime(document.documentElement, malformed).position).toBe("left");

    const unreadable = new MemoryStorage();
    unreadable.getError = new Error("storage denied");
    expect(new SidebarPositionRuntime(document.documentElement, unreadable).position).toBe("left");
  });

  it("persists changes and emits only when the placement changes", () => {
    const storage = new MemoryStorage();
    const runtime = new SidebarPositionRuntime(document.documentElement, storage);
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.setPosition("right");
    runtime.setPosition("right");

    expect(storage.values.get(SIDEBAR_POSITION_STORAGE_KEY)).toBe("right");
    expect(document.documentElement.dataset.sidebarPosition).toBe("right");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps placement usable for the session when persistence is unavailable", () => {
    const storage = new MemoryStorage();
    storage.setError = new Error("storage denied");
    const runtime = new SidebarPositionRuntime(document.documentElement, storage);

    runtime.setPosition("right");

    expect(runtime.position).toBe("right");
    expect(document.documentElement.dataset.sidebarPosition).toBe("right");
    expect(storage.values.has(SIDEBAR_POSITION_STORAGE_KEY)).toBe(false);
  });
});
