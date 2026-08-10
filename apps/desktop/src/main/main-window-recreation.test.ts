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
  it("coalesces calls behind one trailing recreation", async () => {
    const pending = deferred();
    const firstOperation = vi.fn(() => pending.promise);
    const secondOperation = vi.fn();
    const coalescedOperation = vi.fn();
    const coordinator = new MainWindowRecreationCoordinator();

    const first = coordinator.run(firstOperation);
    const second = coordinator.run(secondOperation);
    const coalesced = coordinator.run(coalescedOperation);
    expect(second).not.toBe(first);
    expect(coalesced).toBe(second);
    await Promise.resolve();
    expect(firstOperation).toHaveBeenCalledOnce();
    expect(secondOperation).not.toHaveBeenCalled();
    expect(coalescedOperation).not.toHaveBeenCalled();

    pending.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(secondOperation).toHaveBeenCalledOnce();
    expect(coalescedOperation).not.toHaveBeenCalled();
  });

  it("keeps at most one trailing check while each recreation is in flight", async () => {
    const firstPending = deferred();
    const trailingPending = deferred();
    const firstOperation = vi.fn(() => firstPending.promise);
    const trailingOperation = vi.fn(() => trailingPending.promise);
    const coordinator = new MainWindowRecreationCoordinator();

    const first = coordinator.run(firstOperation);
    const trailing = coordinator.run(trailingOperation);
    expect(coordinator.run(vi.fn())).toBe(trailing);

    firstPending.resolve();
    await expect(first).resolves.toBeUndefined();
    await Promise.resolve();
    expect(trailingOperation).toHaveBeenCalledOnce();

    const nextTrailingOperation = vi.fn();
    const nextTrailing = coordinator.run(nextTrailingOperation);
    expect(coordinator.run(vi.fn())).toBe(nextTrailing);
    expect(nextTrailingOperation).not.toHaveBeenCalled();

    trailingPending.resolve();
    await expect(trailing).resolves.toBeUndefined();
    await expect(nextTrailing).resolves.toBeUndefined();
    expect(nextTrailingOperation).toHaveBeenCalledOnce();
  });

  it("does not drop a later window-health recheck when state changes in flight", async () => {
    const pending = deferred();
    const coordinator = new MainWindowRecreationCoordinator();
    let windowState: "healthy" | "destroyed" | "recreated" = "healthy";
    const firstOperation = vi.fn(async () => {
      expect(windowState).toBe("healthy");
      await pending.promise;
    });
    const secondOperation = vi.fn(() => {
      if (windowState === "destroyed") windowState = "recreated";
    });

    const first = coordinator.run(firstOperation);
    await Promise.resolve();
    windowState = "destroyed";
    const second = coordinator.run(secondOperation);

    pending.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(secondOperation).toHaveBeenCalledOnce();
    expect(windowState).toBe("recreated");
  });

  it("runs a queued recreation after an earlier attempt fails", async () => {
    const pending = deferred();
    const coordinator = new MainWindowRecreationCoordinator();
    const failure = new Error("load failed");
    const first = coordinator.run(async () => {
      await pending.promise;
      throw failure;
    });
    const retry = vi.fn();
    const second = coordinator.run(retry);

    pending.resolve();
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(retry).toHaveBeenCalledOnce();
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
