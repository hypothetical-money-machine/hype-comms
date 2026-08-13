// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import type { ThemePreference, ThemeState } from "@hype-comms/contracts";

import type { ThemeTransport } from "../../shared/desktop-api";
import { getThemeDefinition, themeCssVariable, THEME_TOKEN_NAMES } from "../../shared/theme";
import { ThemeRuntime } from "./theme-runtime";

class FakeThemeTransport implements ThemeTransport {
  readonly initialThemeState: ThemeState;
  state: ThemeState;
  getState: () => Promise<ThemeState> = () => Promise.resolve(this.state);
  setError: Error | null = null;
  subscriptionError: Error | null = null;
  readonly setPreferences: ThemePreference[] = [];
  readonly listeners = new Set<(state: ThemeState) => void>();

  constructor(
    initialThemeState: ThemeState = {
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
    },
  ) {
    this.initialThemeState = initialThemeState;
    this.state = initialThemeState;
  }

  getThemeState(): Promise<ThemeState> {
    return this.getState();
  }

  async setThemePreference(preference: ThemePreference): Promise<ThemeState> {
    this.setPreferences.push(preference);
    if (this.setError !== null) throw this.setError;
    if (preference === "system") {
      this.state = {
        preference,
        resolvedThemeId: this.state.resolvedThemeId,
        resolvedColorScheme: this.state.resolvedColorScheme,
      };
    } else {
      const definition = getThemeDefinition(preference);
      this.state = {
        preference,
        resolvedThemeId: definition.id,
        resolvedColorScheme: definition.colorScheme,
      };
    }
    return this.state;
  }

  onThemeStateChanged(listener: (state: ThemeState) => void): () => void {
    if (this.subscriptionError !== null) throw this.subscriptionError;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: ThemeState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function createRoot(): HTMLElement {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.removeAttribute("data-theme-preference");
  root.removeAttribute("style");
  return root;
}

describe("ThemeRuntime", () => {
  it("applies a complete synchronous fallback before hydration", () => {
    const root = createRoot();
    const runtime = new ThemeRuntime(
      new FakeThemeTransport({
        preference: "dark",
        resolvedThemeId: "dark",
        resolvedColorScheme: "dark",
      }),
      root,
    );
    const definition = getThemeDefinition("dark");

    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.themePreference).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    for (const token of THEME_TOKEN_NAMES) {
      expect(root.style.getPropertyValue(themeCssVariable(token))).toBe(definition.tokens[token]);
    }
    runtime.dispose();
  });

  it("does not overwrite a pushed state with stale hydration", async () => {
    const root = createRoot();
    const client = new FakeThemeTransport();
    let resolveInitial: ((state: ThemeState) => void) | undefined;
    client.getState = () =>
      new Promise<ThemeState>((resolve) => {
        resolveInitial = resolve;
      });
    const runtime = new ThemeRuntime(client, root);

    const started = runtime.start();
    client.emit({
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    resolveInitial?.({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
    });
    await started;

    expect(runtime.state).toEqual({
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    expect(root.dataset.theme).toBe("dark");
    runtime.dispose();
  });

  it("applies live and selected states while deduplicating subscribers", async () => {
    const root = createRoot();
    const client = new FakeThemeTransport();
    const runtime = new ThemeRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    client.emit({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    client.emit({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    await runtime.setPreference("light");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(client.setPreferences).toEqual(["light"]);
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.themePreference).toBe("light");

    unsubscribe();
    runtime.dispose();
    expect(client.listeners.size).toBe(0);
  });

  it("keeps the system fallback when hydration is unavailable", async () => {
    const root = createRoot();
    const client = new FakeThemeTransport({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    client.getState = () => Promise.reject(new Error("IPC unavailable"));
    const runtime = new ThemeRuntime(client, root);

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.state).toEqual({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    runtime.dispose();
  });

  it("keeps the fallback when theme subscription setup is unavailable", async () => {
    const root = createRoot();
    const client = new FakeThemeTransport();
    client.subscriptionError = new Error("subscription unavailable");
    const runtime = new ThemeRuntime(client, root);

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.state).toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
    });
    runtime.dispose();
  });
});
