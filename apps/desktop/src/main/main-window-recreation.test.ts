import { describe, expect, it, vi } from "vitest";

import {
  MainWindowLifecycle,
  MainWindowRecreationCoordinator,
  type MainWindowLifecycleState,
} from "./main-window-recreation";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("MainWindowRecreationCoordinator", () => {
  it("coalesces concurrent recreation behind the same in-flight load", async () => {
    const pending = deferred();
    const operation = vi.fn(() => pending.promise);
    const coordinator = new MainWindowRecreationCoordinator();

    const first = coordinator.run(operation);
    const second = coordinator.run(operation);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();

    pending.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  it("clears a failed recreation so a later activation can retry", async () => {
    const coordinator = new MainWindowRecreationCoordinator();
    const failure = new Error("load failed");

    await expect(coordinator.run(async () => Promise.reject(failure))).rejects.toBe(failure);
    const retry = vi.fn();
    await expect(coordinator.run(retry)).resolves.toBeUndefined();
    expect(retry).toHaveBeenCalledOnce();
  });
});

interface FakeWindow {
  readonly name: string;
}

function createLifecycleHarness() {
  const oldWindow: FakeWindow = { name: "old" };
  const newWindow: FakeWindow = { name: "new" };
  let currentWindow: FakeWindow | null = oldWindow;
  let rendererReady = false;
  let rendererSessionGeneration = 1;
  const invalidatedBindings: number[] = [];
  const state: MainWindowLifecycleState<FakeWindow> = {
    currentWindow: () => currentWindow,
    setCurrentWindow: (window) => {
      currentWindow = window;
    },
    setRendererReady: (ready) => {
      rendererReady = ready;
    },
    advanceRendererSessionGeneration: () => {
      rendererSessionGeneration += 1;
    },
    invalidateRendererBinding: (webContentsId) => {
      invalidatedBindings.push(webContentsId);
    },
  };
  const lifecycle = new MainWindowLifecycle({ window: oldWindow, webContentsId: 41, state });
  return {
    lifecycle,
    oldWindow,
    newWindow,
    invalidatedBindings,
    read: () => ({ currentWindow, rendererReady, rendererSessionGeneration }),
    installNewWindow() {
      currentWindow = newWindow;
      rendererReady = false;
      rendererSessionGeneration += 1;
    },
  };
}

describe("MainWindowLifecycle", () => {
  it("updates ready state and generation for the matching window", () => {
    const harness = createLifecycleHarness();
    const ready = vi.fn();

    expect(harness.lifecycle.rendererDidFinishLoad(ready)).toBe(true);
    expect(harness.read()).toEqual({
      currentWindow: harness.oldWindow,
      rendererReady: true,
      rendererSessionGeneration: 1,
    });
    expect(ready).toHaveBeenCalledOnce();

    expect(harness.lifecycle.invalidateRenderer()).toBe(true);
    expect(harness.read()).toEqual({
      currentWindow: harness.oldWindow,
      rendererReady: false,
      rendererSessionGeneration: 2,
    });
    expect(harness.invalidatedBindings).toEqual([41]);

    harness.lifecycle.windowClosed();
    expect(harness.read().currentWindow).toBeNull();
    expect(harness.invalidatedBindings).toEqual([41, 41]);
  });

  it("keeps newer globals intact when stale-window callbacks arrive", () => {
    const harness = createLifecycleHarness();
    expect(harness.lifecycle.rendererDidFinishLoad(vi.fn())).toBe(true);
    harness.installNewWindow();
    const expected = harness.read();
    const staleReady = vi.fn();

    expect(harness.lifecycle.invalidateRenderer()).toBe(false);
    expect(harness.lifecycle.rendererDidFinishLoad(staleReady)).toBe(false);
    harness.lifecycle.loadFailed();
    harness.lifecycle.windowClosed();

    expect(harness.read()).toEqual(expected);
    expect(staleReady).not.toHaveBeenCalled();
    expect(harness.invalidatedBindings).toEqual([41, 41, 41, 41]);
  });
});
