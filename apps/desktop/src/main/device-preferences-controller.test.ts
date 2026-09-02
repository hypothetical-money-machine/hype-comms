import type { DevicePreferences } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_DEVICE_PREFERENCES } from "../shared/device-preferences";
import {
  DevicePreferencesController,
  type DevicePreferencesPersistence,
} from "./device-preferences-controller";

class FakePersistence implements DevicePreferencesPersistence {
  readonly saves: DevicePreferences[] = [];
  loadRequests = 0;
  activeSaves = 0;
  maximumActiveSaves = 0;
  nextSaveError: Error | null = null;
  nextSaveGate: Promise<void> | null = null;

  constructor(readonly loaded: DevicePreferences = DEFAULT_DEVICE_PREFERENCES) {}

  async load(): Promise<DevicePreferences> {
    this.loadRequests += 1;
    await Promise.resolve();
    return this.loaded;
  }

  async save(preferences: DevicePreferences): Promise<void> {
    this.activeSaves += 1;
    this.maximumActiveSaves = Math.max(this.maximumActiveSaves, this.activeSaves);
    await Promise.resolve();
    const gate = this.nextSaveGate;
    this.nextSaveGate = null;
    await gate;
    const error = this.nextSaveError;
    this.nextSaveError = null;
    if (error !== null) {
      this.activeSaves -= 1;
      throw error;
    }
    this.saves.push(preferences);
    this.activeSaves -= 1;
  }
}

function controllerWith(
  persistence: DevicePreferencesPersistence = new FakePersistence(),
): DevicePreferencesController {
  return new DevicePreferencesController({ persistence });
}

describe("DevicePreferencesController", () => {
  it("requires initialization before state, subscriptions, or updates", async () => {
    const controller = controllerWith();

    expect(() => controller.state).toThrow(/initialized/u);
    expect(() => controller.subscribe(() => undefined)).toThrow(/initialized/u);
    await expect(controller.update({ spellCheck: false })).rejects.toThrow(/initialized/u);
  });

  it("initializes once with a validated, frozen persisted snapshot", async () => {
    const loaded = { ...DEFAULT_DEVICE_PREFERENCES, sidebarWidth: "wide" } as const;
    const persistence = new FakePersistence(loaded);
    const controller = controllerWith(persistence);

    const [first, second] = await Promise.all([controller.initialize(), controller.initialize()]);

    expect(first).toEqual(loaded);
    expect(second).toBe(first);
    expect(controller.state).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(persistence.loadRequests).toBe(1);
  });

  it("allows initialization to retry after persistence returns invalid data once", async () => {
    let first = true;
    const persistence: DevicePreferencesPersistence = {
      async load() {
        if (first) {
          first = false;
          return {
            ...DEFAULT_DEVICE_PREFERENCES,
            version: 2,
          } as unknown as DevicePreferences;
        }
        return DEFAULT_DEVICE_PREFERENCES;
      },
      async save() {
        return undefined;
      },
    };
    const controller = controllerWith(persistence);

    await expect(controller.initialize()).rejects.toThrow();
    await expect(controller.initialize()).resolves.toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  it("merges a strict patch, persists the full state, then publishes it", async () => {
    const persistence = new FakePersistence();
    const controller = controllerWith(persistence);
    await controller.initialize();
    const order: string[] = [];
    const originalSave = persistence.save.bind(persistence);
    persistence.save = async (preferences: DevicePreferences) => {
      order.push("save");
      await originalSave(preferences);
    };
    controller.subscribe(() => order.push("notify"));

    const next = await controller.update({ sidebarWidth: "wide", spellCheck: false });

    expect(next).toEqual({
      ...DEFAULT_DEVICE_PREFERENCES,
      sidebarWidth: "wide",
      spellCheck: false,
    });
    expect(persistence.saves).toEqual([next]);
    expect(order).toEqual(["save", "notify"]);
  });

  it("rejects empty, expanded, and invalid patches without saving", async () => {
    const persistence = new FakePersistence();
    const controller = controllerWith(persistence);
    await controller.initialize();

    await expect(controller.update({})).rejects.toThrow(/at least one/u);
    await expect(controller.update({ spellCheck: false, extra: true } as never)).rejects.toThrow();
    await expect(controller.update({ sidebarWidth: "floating" } as never)).rejects.toThrow();
    expect(persistence.saves).toEqual([]);
  });

  it("does not save or publish a patch that changes no value", async () => {
    const persistence = new FakePersistence();
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: DevicePreferences[] = [];
    controller.subscribe((state) => states.push(state));

    const result = await controller.update({ spellCheck: true });

    expect(result).toBe(controller.state);
    expect(persistence.saves).toEqual([]);
    expect(states).toEqual([]);
  });

  it("preserves prior state and does not publish when persistence rejects", async () => {
    const persistence = new FakePersistence();
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: DevicePreferences[] = [];
    controller.subscribe((state) => states.push(state));
    persistence.nextSaveError = new Error("disk full");

    await expect(controller.update({ messageTextSize: "large" })).rejects.toThrow("disk full");

    expect(controller.state).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(states).toEqual([]);
  });

  it("serializes concurrent patches and merges each with the latest committed state", async () => {
    const persistence = new FakePersistence();
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: DevicePreferences[] = [];
    controller.subscribe((state) => states.push(state));

    await Promise.all([
      controller.update({ sidebarWidth: "wide" }),
      controller.update({ spellCheck: false }),
      controller.update({ timestampFormat: "24-hour" }),
    ]);

    expect(persistence.maximumActiveSaves).toBe(1);
    expect(persistence.saves).toHaveLength(3);
    expect(persistence.saves[0]).toMatchObject({ sidebarWidth: "wide", spellCheck: true });
    expect(persistence.saves[1]).toMatchObject({ sidebarWidth: "wide", spellCheck: false });
    expect(persistence.saves[2]).toMatchObject({
      sidebarWidth: "wide",
      spellCheck: false,
      timestampFormat: "24-hour",
    });
    expect(states).toEqual(persistence.saves);
    expect(controller.state).toBe(persistence.saves[2]);
  });

  it("isolates listener and error-reporter failures after committing state", async () => {
    const persistence = new FakePersistence();
    const listenerErrors: unknown[] = [];
    const controller = new DevicePreferencesController({
      persistence,
      reportListenerError: (error) => {
        listenerErrors.push(error);
        throw new Error("report failed");
      },
    });
    await controller.initialize();
    const failure = new Error("renderer closed");
    const delivered: DevicePreferences[] = [];
    controller.subscribe(() => {
      throw failure;
    });
    controller.subscribe((state) => delivered.push(state));

    const next = await controller.update({ showProfileTitles: false });

    expect(listenerErrors).toEqual([failure]);
    expect(delivered).toEqual([next]);
  });

  it("writes queued patches through disposal without publishing them", async () => {
    const persistence = new FakePersistence();
    let releaseSave: (() => void) | undefined;
    persistence.nextSaveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: DevicePreferences[] = [];
    controller.subscribe((state) => states.push(state));

    const first = controller.update({ sidebarWidth: "narrow" });
    const second = controller.update({ spellCheck: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.activeSaves).toBe(1);
    controller.dispose();
    releaseSave?.();

    await expect(first).rejects.toThrow(/disposed/u);
    await expect(second).rejects.toThrow(/disposed/u);
    expect(persistence.saves).toHaveLength(2);
    expect(controller.state).toMatchObject({ sidebarWidth: "narrow", spellCheck: false });
    expect(states).toEqual([]);
    expect(() => controller.subscribe(() => undefined)).toThrow(/disposed/u);
    await expect(controller.update({ sidebarWidth: "wide" })).rejects.toThrow(/disposed/u);
  });
});
