import type {
  ResolvedColorScheme,
  ThemeDesign,
  ThemePreference,
  ThemeState,
} from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import {
  ThemeController,
  type NativeThemeAdapter,
  type ThemePreferencePersistence,
} from "./theme-controller";

class FakeNativeTheme implements NativeThemeAdapter {
  readonly #listeners = new Set<() => void>();
  #themeSource: "system" | ResolvedColorScheme = "system";
  #systemUsesDarkColors: boolean;
  #successfulSourceChangesBeforeFailure: number | null = null;
  sourceAssignments = 0;

  constructor(systemUsesDarkColors = false) {
    this.#systemUsesDarkColors = systemUsesDarkColors;
  }

  get themeSource(): "system" | ResolvedColorScheme {
    return this.#themeSource;
  }

  set themeSource(value: "system" | ResolvedColorScheme) {
    if (this.#successfulSourceChangesBeforeFailure === 0) {
      this.#successfulSourceChangesBeforeFailure = null;
      throw new Error("native theme unavailable");
    }
    if (this.#successfulSourceChangesBeforeFailure !== null) {
      this.#successfulSourceChangesBeforeFailure -= 1;
    }
    this.sourceAssignments += 1;
    this.#themeSource = value;
    this.emitUpdated();
  }

  get shouldUseDarkColors(): boolean {
    return this.#themeSource === "system"
      ? this.#systemUsesDarkColors
      : this.#themeSource === "dark";
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  on(event: "updated", listener: () => void): void {
    expect(event).toBe("updated");
    this.#listeners.add(listener);
  }

  off(event: "updated", listener: () => void): void {
    expect(event).toBe("updated");
    this.#listeners.delete(listener);
  }

  useSystemDarkColors(value: boolean): void {
    this.#systemUsesDarkColors = value;
    this.emitUpdated();
  }

  emitUpdated(): void {
    for (const listener of this.#listeners) listener();
  }

  failNextSourceChange(): void {
    this.#successfulSourceChangesBeforeFailure = 0;
  }

  failSourceChangeAfter(successfulChanges: number): void {
    this.#successfulSourceChangesBeforeFailure = successfulChanges;
  }
}

class FakePreferencePersistence implements ThemePreferencePersistence {
  readonly saves: ThemeDesign[] = [];
  loadRequests = 0;
  activeSaves = 0;
  maximumActiveSaves = 0;
  nextSaveError: Error | null = null;
  nextSaveGate: Promise<void> | null = null;

  readonly loadedDesign: ThemeDesign;

  constructor(loaded: ThemePreference | ThemeDesign = "system") {
    this.loadedDesign =
      typeof loaded === "string" ? { preference: loaded, accentColor: null } : loaded;
  }

  async load(): Promise<ThemeDesign> {
    this.loadRequests += 1;
    await Promise.resolve();
    return this.loadedDesign;
  }

  async save(design: ThemeDesign): Promise<void> {
    this.activeSaves += 1;
    this.maximumActiveSaves = Math.max(this.maximumActiveSaves, this.activeSaves);
    await Promise.resolve();
    const saveGate = this.nextSaveGate;
    this.nextSaveGate = null;
    await saveGate;
    const error = this.nextSaveError;
    this.nextSaveError = null;
    if (error !== null) {
      this.activeSaves -= 1;
      throw error;
    }
    this.saves.push(design);
    this.activeSaves -= 1;
  }
}

function controllerWith(
  nativeTheme: FakeNativeTheme,
  persistence = new FakePreferencePersistence(),
): ThemeController {
  return new ThemeController({ nativeTheme, persistence });
}

describe("ThemeController", () => {
  it("requires initialization before state, subscriptions, or writes are used", async () => {
    const controller = controllerWith(new FakeNativeTheme());

    expect(() => controller.state).toThrow(/initialized/);
    expect(() => controller.subscribe(() => undefined)).toThrow(/initialized/);
    await expect(controller.setPreference("dark")).rejects.toThrow(/initialized/);
    await expect(controller.resolveSystemState()).rejects.toThrow(/initialized/);
  });

  it("initializes once from persistence before exposing canonical system state", async () => {
    const nativeTheme = new FakeNativeTheme(true);
    const persistence = new FakePreferencePersistence("system");
    const controller = controllerWith(nativeTheme, persistence);

    const [first, second] = await Promise.all([controller.initialize(), controller.initialize()]);

    expect(first).toEqual({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: null,
    });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(persistence.loadRequests).toBe(1);
    expect(nativeTheme.themeSource).toBe("system");
    expect(nativeTheme.listenerCount).toBe(1);
  });

  it("applies a persisted explicit preference regardless of the system scheme", async () => {
    const nativeTheme = new FakeNativeTheme(true);
    const controller = controllerWith(nativeTheme, new FakePreferencePersistence("light"));

    await expect(controller.initialize()).resolves.toEqual({
      preference: "light",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: null,
    });
    expect(nativeTheme.themeSource).toBe("light");
  });

  it("resolves the system foundation behind an explicit theme without changing app state", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence({
      preference: "dark",
      accentColor: "#be123c",
    });
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));
    const activeState = controller.state;

    await expect(controller.resolveSystemState()).resolves.toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: "#be123c",
    });

    expect(nativeTheme.themeSource).toBe("dark");
    expect(controller.state).toBe(activeState);
    expect(persistence.saves).toEqual([]);
    expect(states).toEqual([]);
  });

  it("serializes system resolution behind an in-flight design write", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence("dark");
    let releaseSave: (() => void) | undefined;
    persistence.nextSaveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();

    const designRequest = controller.setDesign({ preference: "light", accentColor: "#2563eb" });
    const systemRequest = controller.resolveSystemState();
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.activeSaves).toBe(1);

    releaseSave?.();
    await expect(designRequest).resolves.toMatchObject({ preference: "light" });
    await expect(systemRequest).resolves.toMatchObject({
      preference: "system",
      resolvedThemeId: "light",
    });
    expect(nativeTheme.themeSource).toBe("light");
    expect(controller.state).toMatchObject({ preference: "light", accentColor: "#2563eb" });
  });

  it("rejects system resolution cleanly when the native adapter cannot remove its override", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence("dark");
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const activeState = controller.state;
    nativeTheme.failNextSourceChange();

    await expect(controller.resolveSystemState()).rejects.toThrow("native theme unavailable");

    expect(nativeTheme.themeSource).toBe("dark");
    expect(controller.state).toBe(activeState);
    expect(persistence.saves).toEqual([]);
  });

  it("repairs an explicit source on retry after probe restoration fails", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence("dark");
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const activeState = controller.state;
    nativeTheme.failSourceChangeAfter(1);

    await expect(controller.resolveSystemState()).rejects.toThrow("native theme unavailable");
    expect(nativeTheme.themeSource).toBe("system");
    expect(controller.state).toBe(activeState);

    await expect(controller.resolveSystemState()).resolves.toMatchObject({
      preference: "system",
      resolvedThemeId: "light",
    });
    expect(nativeTheme.themeSource).toBe("dark");
    expect(controller.state).toBe(activeState);
    expect(persistence.saves).toEqual([]);
  });

  it("reacts to system changes and suppresses duplicate states", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const controller = controllerWith(nativeTheme);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));

    nativeTheme.useSystemDarkColors(true);
    nativeTheme.emitUpdated();
    nativeTheme.useSystemDarkColors(false);

    expect(states).toEqual([
      {
        preference: "system",
        resolvedThemeId: "dark",
        resolvedColorScheme: "dark",
        accentColor: null,
      },
      {
        preference: "system",
        resolvedThemeId: "light",
        resolvedColorScheme: "light",
        accentColor: null,
      },
    ]);
    expect(controller.state).toBe(states[1]);
  });

  it("keeps explicit preferences fixed when the system later changes", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));

    await expect(controller.setPreference("dark")).resolves.toEqual({
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: null,
    });
    nativeTheme.useSystemDarkColors(false);

    expect(persistence.saves).toEqual([{ preference: "dark", accentColor: null }]);
    expect(nativeTheme.themeSource).toBe("dark");
    expect(states).toEqual([
      {
        preference: "dark",
        resolvedThemeId: "dark",
        resolvedColorScheme: "dark",
        accentColor: null,
      },
    ]);
  });

  it("persists a canonical accent without touching native source and preserves it across changes", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const assignmentsAfterInitialization = nativeTheme.sourceAssignments;

    await expect(
      controller.setDesign({ preference: "system", accentColor: "#A15EFF" }),
    ).resolves.toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: "#a15eff",
    });
    expect(nativeTheme.sourceAssignments).toBe(assignmentsAfterInitialization);

    nativeTheme.useSystemDarkColors(true);
    expect(controller.state).toEqual({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: "#a15eff",
    });

    await controller.setPreference("dark");
    expect(controller.state.accentColor).toBe("#a15eff");
    expect(persistence.saves).toEqual([
      { preference: "system", accentColor: "#a15eff" },
      { preference: "dark", accentColor: "#a15eff" },
    ]);
  });

  it("serializes a full design before a preference-only update without losing its accent", async () => {
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(new FakeNativeTheme(), persistence);
    await controller.initialize();

    await Promise.all([
      controller.setDesign({ preference: "system", accentColor: "#be123c" }),
      controller.setPreference("light"),
    ]);

    expect(persistence.maximumActiveSaves).toBe(1);
    expect(persistence.saves).toEqual([
      { preference: "system", accentColor: "#be123c" },
      { preference: "light", accentColor: "#be123c" },
    ]);
    expect(controller.state).toMatchObject({ preference: "light", accentColor: "#be123c" });
  });

  it("rejects invalid accent data before persistence", async () => {
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(new FakeNativeTheme(), persistence);
    await controller.initialize();

    await expect(
      controller.setDesign({ preference: "dark", accentColor: "url(file:///tmp/x)" }),
    ).rejects.toThrow();
    expect(persistence.saves).toEqual([]);
    expect(controller.state.accentColor).toBeNull();
  });

  it("preserves prior state when persistence rejects and recovers for a later write", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));
    persistence.nextSaveError = new Error("disk full");

    await expect(controller.setPreference("dark")).rejects.toThrow("disk full");
    expect(controller.state).toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: null,
    });
    expect(nativeTheme.themeSource).toBe("system");
    expect(states).toEqual([]);

    await expect(controller.setPreference("light")).resolves.toMatchObject({
      preference: "light",
    });
    expect(persistence.saves).toEqual([{ preference: "light", accentColor: null }]);
  });

  it("reconciles a system scheme update that arrives during a rejected save", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence();
    let releaseSave: (() => void) | undefined;
    persistence.nextSaveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    persistence.nextSaveError = new Error("disk full");
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));

    const request = controller.setPreference("dark");
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.activeSaves).toBe(1);
    nativeTheme.useSystemDarkColors(true);
    releaseSave?.();

    await expect(request).rejects.toThrow("disk full");
    expect(nativeTheme.themeSource).toBe("system");
    expect(controller.state).toEqual({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: null,
    });
    expect(states).toEqual([controller.state]);
    expect(persistence.saves).toEqual([]);
  });

  it("serializes rapid changes and publishes them in request order", async () => {
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(new FakeNativeTheme(), persistence);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));

    await Promise.all([controller.setPreference("dark"), controller.setPreference("light")]);

    expect(persistence.maximumActiveSaves).toBe(1);
    expect(persistence.saves).toEqual([
      { preference: "dark", accentColor: null },
      { preference: "light", accentColor: null },
    ]);
    expect(states.map((state) => state.preference)).toEqual(["dark", "light"]);
    expect(controller.state).toEqual({
      preference: "light",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: null,
    });
  });

  it("does not publish or save an already active preference", async () => {
    const persistence = new FakePreferencePersistence("dark");
    const controller = controllerWith(new FakeNativeTheme(), persistence);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));

    const state = await controller.setPreference("dark");

    expect(state).toBe(controller.state);
    expect(persistence.saves).toEqual([]);
    expect(states).toEqual([]);
  });

  it("rejects a valid but unregistered theme identifier before persisting it", async () => {
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(new FakeNativeTheme(), persistence);
    await controller.initialize();

    await expect(controller.setPreference("dim")).rejects.toThrow(
      /Unknown built-in theme identifier: dim/u,
    );
    expect(persistence.saves).toEqual([]);
    expect(controller.state.preference).toBe("system");
  });

  it("isolates listener failures after committing a preference", async () => {
    const nativeTheme = new FakeNativeTheme();
    const persistence = new FakePreferencePersistence();
    const listenerErrors: unknown[] = [];
    const controller = new ThemeController({
      nativeTheme,
      persistence,
      reportListenerError: (error) => listenerErrors.push(error),
    });
    await controller.initialize();
    const delivered: ThemeState[] = [];
    const listenerFailure = new Error("renderer closed");
    controller.subscribe(() => {
      throw listenerFailure;
    });
    controller.subscribe((state) => delivered.push(state));

    await expect(controller.setPreference("dark")).resolves.toEqual({
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: null,
    });

    expect(listenerErrors).toEqual([listenerFailure]);
    expect(delivered).toEqual([
      {
        preference: "dark",
        resolvedThemeId: "dark",
        resolvedColorScheme: "dark",
        accentColor: null,
      },
    ]);
  });

  it("keeps a durable preference when disposed during its completed save", async () => {
    const nativeTheme = new FakeNativeTheme();
    const persistence = new FakePreferencePersistence();
    let releaseSave: (() => void) | undefined;
    persistence.nextSaveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();

    const request = controller.setPreference("dark");
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.activeSaves).toBe(1);
    controller.dispose();
    releaseSave?.();

    await expect(request).rejects.toThrow(/disposed/);
    expect(nativeTheme.themeSource).toBe("system");
    expect(controller.state).toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: null,
    });
    expect(persistence.saves).toEqual([{ preference: "dark", accentColor: null }]);
  });

  it("does not persist a preference when the native adapter rejects", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const persistence = new FakePreferencePersistence();
    const controller = controllerWith(nativeTheme, persistence);
    await controller.initialize();
    nativeTheme.failNextSourceChange();

    await expect(controller.setPreference("dark")).rejects.toThrow("native theme unavailable");

    expect(controller.state).toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: null,
    });
    expect(nativeTheme.themeSource).toBe("system");
    expect(persistence.saves).toEqual([]);
  });

  it("unsubscribes from native updates and rejects new work after disposal", async () => {
    const nativeTheme = new FakeNativeTheme(false);
    const controller = controllerWith(nativeTheme);
    await controller.initialize();
    const states: ThemeState[] = [];
    controller.subscribe((state) => states.push(state));

    controller.dispose();
    controller.dispose();
    nativeTheme.useSystemDarkColors(true);

    expect(nativeTheme.listenerCount).toBe(0);
    expect(states).toEqual([]);
    expect(controller.state).toEqual({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: null,
    });
    expect(() => controller.subscribe(() => undefined)).toThrow(/disposed/);
    await expect(controller.setPreference("dark")).rejects.toThrow(/disposed/);
    await expect(controller.resolveSystemState()).rejects.toThrow(/disposed/);
  });
});
