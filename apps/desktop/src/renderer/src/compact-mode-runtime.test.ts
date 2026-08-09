// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import type { CompactModeTransport } from "../../shared/desktop-api";
import { CompactModeRuntime } from "./compact-mode-runtime";

class FakeCompactModeTransport implements CompactModeTransport {
  readonly initialCompactMode: boolean;
  enabled: boolean;
  getEnabled: () => Promise<boolean> = () => Promise.resolve(this.enabled);
  setError: Error | null = null;
  subscriptionError: Error | null = null;
  readonly setCalls: boolean[] = [];
  readonly listeners = new Set<(enabled: boolean) => void>();

  constructor(initialCompactMode = false) {
    this.initialCompactMode = initialCompactMode;
    this.enabled = initialCompactMode;
  }

  getCompactMode(): Promise<boolean> {
    return this.getEnabled();
  }

  async setCompactMode(enabled: boolean): Promise<boolean> {
    this.setCalls.push(enabled);
    if (this.setError !== null) throw this.setError;
    this.enabled = enabled;
    return this.enabled;
  }

  onCompactModeChanged(listener: (enabled: boolean) => void): () => void {
    if (this.subscriptionError !== null) throw this.subscriptionError;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(enabled: boolean): void {
    this.enabled = enabled;
    for (const listener of this.listeners) listener(enabled);
  }
}

function createRoot(): HTMLElement {
  const root = document.documentElement;
  delete root.dataset.compact;
  return root;
}

describe("CompactModeRuntime", () => {
  it("applies the synchronous fallback before hydration", () => {
    const root = createRoot();
    const runtime = new CompactModeRuntime(new FakeCompactModeTransport(true), root);

    expect(root.dataset.compact).toBe("true");
    runtime.dispose();
  });

  it("does not set the attribute when the initial state is disabled", () => {
    const root = createRoot();
    const runtime = new CompactModeRuntime(new FakeCompactModeTransport(false), root);

    expect(root.dataset.compact).toBeUndefined();
    runtime.dispose();
  });

  it("does not overwrite a pushed state with stale hydration", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport();
    let resolveInitial: ((enabled: boolean) => void) | undefined;
    client.getEnabled = () =>
      new Promise<boolean>((resolve) => {
        resolveInitial = resolve;
      });
    const runtime = new CompactModeRuntime(client, root);

    const started = runtime.start();
    client.emit(true);
    resolveInitial?.(false);
    await started;

    expect(runtime.enabled).toBe(true);
    expect(root.dataset.compact).toBe("true");
    runtime.dispose();
  });

  it("applies live and selected states while deduplicating subscribers", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport();
    const runtime = new CompactModeRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    client.emit(true);
    client.emit(true);
    await runtime.setEnabled(false);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(client.setCalls).toEqual([false]);
    expect(root.dataset.compact).toBeUndefined();

    unsubscribe();
    runtime.dispose();
    expect(client.listeners.size).toBe(0);
  });

  it("round-trips setEnabled through the transport", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport();
    const runtime = new CompactModeRuntime(client, root);
    await runtime.start();

    const result = await runtime.setEnabled(true);

    expect(result).toBe(true);
    expect(runtime.enabled).toBe(true);
    expect(root.dataset.compact).toBe("true");
    runtime.dispose();
  });

  it("toggles the current state", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport(false);
    const runtime = new CompactModeRuntime(client, root);
    await runtime.start();

    await runtime.toggle();

    expect(runtime.enabled).toBe(true);
    expect(client.setCalls).toEqual([true]);
    runtime.dispose();
  });

  it("keeps the fallback when hydration is unavailable", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport(true);
    client.getEnabled = () => Promise.reject(new Error("IPC unavailable"));
    const runtime = new CompactModeRuntime(client, root);

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.enabled).toBe(true);
    runtime.dispose();
  });

  it("keeps the fallback when subscription setup is unavailable", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport();
    client.subscriptionError = new Error("subscription unavailable");
    const runtime = new CompactModeRuntime(client, root);

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.enabled).toBe(false);
    runtime.dispose();
  });

  it("stops listening after dispose", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport();
    const runtime = new CompactModeRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.dispose();
    client.emit(true);

    expect(listener).not.toHaveBeenCalled();
  });

  it("alternates rapid toggles instead of resending the in-flight target", async () => {
    const root = createRoot();
    const client = new FakeCompactModeTransport();
    const runtime = new CompactModeRuntime(client, root);
    await runtime.start();

    // The second toggle fires before the first save resolves; it must target the opposite of
    // the requested value, not recompute from the still-unchanged confirmed state.
    const first = runtime.toggle();
    const second = runtime.toggle();
    await Promise.all([first, second]);

    expect(client.setCalls).toEqual([true, false]);
    expect(runtime.enabled).toBe(false);
    runtime.dispose();
  });
});
