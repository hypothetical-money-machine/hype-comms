import { describe, expect, it } from "vitest";

import { CompactModeController, type CompactModePersistence } from "./compact-mode-controller";

class FakePersistence implements CompactModePersistence {
  readonly saves: boolean[] = [];
  loadRequests = 0;
  activeSaves = 0;
  maximumActiveSaves = 0;
  nextSaveError: Error | null = null;
  nextSaveGate: Promise<void> | null = null;

  constructor(readonly loadedEnabled: boolean = false) {}

  async load(): Promise<boolean> {
    this.loadRequests += 1;
    await Promise.resolve();
    return this.loadedEnabled;
  }

  async save(enabled: boolean): Promise<void> {
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
    this.saves.push(enabled);
    this.activeSaves -= 1;
  }
}

function controllerWith(persistence = new FakePersistence()): CompactModeController {
  return new CompactModeController({ persistence });
}

describe("CompactModeController", () => {
  it("requires initialization before state, subscriptions, or writes are used", async () => {
    const controller = controllerWith();

    expect(() => controller.enabled).toThrow(/initialized/);
    expect(() => controller.subscribe(() => undefined)).toThrow(/initialized/);
    await expect(controller.setEnabled(true)).rejects.toThrow(/initialized/);
  });

  it("initializes once from persistence and exposes the persisted value", async () => {
    const persistence = new FakePersistence(true);
    const controller = controllerWith(persistence);

    const [first, second] = await Promise.all([controller.initialize(), controller.initialize()]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(persistence.loadRequests).toBe(1);
    expect(controller.enabled).toBe(true);
  });

  it("initializes with a persisted false value", async () => {
    const persistence = new FakePersistence(false);
    const controller = controllerWith(persistence);

    await expect(controller.initialize()).resolves.toBe(false);
    expect(controller.enabled).toBe(false);
  });

  it("allows a retry after a failed initialization", async () => {
    let shouldFail = true;
    const persistence: CompactModePersistence = {
      async load() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("load failed");
        }
        return true;
      },
      async save() {
        return undefined;
      },
    };
    const controller = new CompactModeController({ persistence });

    await expect(controller.initialize()).rejects.toThrow("load failed");
    await expect(controller.initialize()).resolves.toBe(true);
    expect(controller.enabled).toBe(true);
  });

  it("persists before notifying listeners", async () => {
    const persistence = new FakePersistence(false);
    const controller = controllerWith(persistence);
    await controller.initialize();
    const order: string[] = [];
    const originalSave = persistence.save.bind(persistence);
    persistence.save = async (enabled: boolean) => {
      order.push("save");
      await originalSave(enabled);
    };
    controller.subscribe(() => order.push("notify"));

    await controller.setEnabled(true);

    expect(order).toEqual(["save", "notify"]);
  });

  it("does not publish or save an unchanged value", async () => {
    const persistence = new FakePersistence(true);
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: boolean[] = [];
    controller.subscribe((enabled) => states.push(enabled));

    const result = await controller.setEnabled(true);

    expect(result).toBe(true);
    expect(persistence.saves).toEqual([]);
    expect(states).toEqual([]);
  });

  it("preserves prior state and rejects when persistence rejects", async () => {
    const persistence = new FakePersistence(false);
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: boolean[] = [];
    controller.subscribe((enabled) => states.push(enabled));
    persistence.nextSaveError = new Error("disk full");

    await expect(controller.setEnabled(true)).rejects.toThrow("disk full");

    expect(controller.enabled).toBe(false);
    expect(states).toEqual([]);
  });

  it("isolates listener failures after committing state", async () => {
    const persistence = new FakePersistence(false);
    const listenerErrors: unknown[] = [];
    const controller = new CompactModeController({
      persistence,
      reportListenerError: (error) => listenerErrors.push(error),
    });
    await controller.initialize();
    const delivered: boolean[] = [];
    const listenerFailure = new Error("renderer closed");
    controller.subscribe(() => {
      throw listenerFailure;
    });
    controller.subscribe((enabled) => delivered.push(enabled));

    await expect(controller.setEnabled(true)).resolves.toBe(true);

    expect(listenerErrors).toEqual([listenerFailure]);
    expect(delivered).toEqual([true]);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const persistence = new FakePersistence(false);
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: boolean[] = [];
    const unsubscribe = controller.subscribe((enabled) => states.push(enabled));

    unsubscribe();
    await controller.setEnabled(true);

    expect(states).toEqual([]);
  });

  it("rejects new work after disposal", async () => {
    const persistence = new FakePersistence(false);
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: boolean[] = [];
    controller.subscribe((enabled) => states.push(enabled));

    controller.dispose();
    controller.dispose();

    expect(states).toEqual([]);
    expect(controller.enabled).toBe(false);
    expect(() => controller.subscribe(() => undefined)).toThrow(/disposed/);
    await expect(controller.setEnabled(true)).rejects.toThrow(/disposed/);
  });

  it("commits the durable value without notifying when disposed during its save", async () => {
    const persistence = new FakePersistence(false);
    let releaseSave: (() => void) | undefined;
    persistence.nextSaveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: boolean[] = [];
    controller.subscribe((enabled) => states.push(enabled));

    const request = controller.setEnabled(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.activeSaves).toBe(1);
    controller.dispose();
    releaseSave?.();

    await expect(request).rejects.toThrow(/disposed/);
    // In-memory state tracks what reached disk so later queued writes compare correctly.
    expect(controller.enabled).toBe(true);
    expect(persistence.saves).toEqual([true]);
    expect(states).toEqual([]);
  });

  it("still writes a toggle queued behind an in-flight save at disposal", async () => {
    const persistence = new FakePersistence(false);
    let releaseSave: (() => void) | undefined;
    persistence.nextSaveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    const controller = controllerWith(persistence);
    await controller.initialize();

    // Toggle on then immediately back off; quit lands while the first save is still flushing.
    const first = controller.setEnabled(true);
    const second = controller.setEnabled(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(persistence.activeSaves).toBe(1);
    controller.dispose();
    releaseSave?.();

    await expect(first).rejects.toThrow(/disposed/);
    await expect(second).rejects.toThrow(/disposed/);
    // The user's newest preference is what the next launch must restore.
    expect(persistence.saves).toEqual([true, false]);
    expect(controller.enabled).toBe(false);
  });

  it("serializes concurrent changes and publishes them in request order", async () => {
    const persistence = new FakePersistence(false);
    const controller = controllerWith(persistence);
    await controller.initialize();
    const states: boolean[] = [];
    controller.subscribe((enabled) => states.push(enabled));

    await Promise.all([controller.setEnabled(true), controller.setEnabled(false)]);

    expect(persistence.maximumActiveSaves).toBe(1);
    expect(persistence.saves).toEqual([true, false]);
    expect(states).toEqual([true, false]);
    expect(controller.enabled).toBe(false);
  });
});
