import type { NotificationPreference, NotificationState } from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationSettingsController,
  type NotificationCapabilitySource,
  type NotificationPreferencePersistence,
} from "./notification-settings-controller";

const DISABLED: NotificationPreference = {
  version: 1,
  devicePreference: "disabled",
  contentPreviewPreference: "disabled",
};
const ENABLED: NotificationPreference = { ...DISABLED, devicePreference: "enabled" };

class FakePersistence implements NotificationPreferencePersistence {
  readonly saves: NotificationPreference[] = [];
  failNext = false;

  constructor(readonly loaded: NotificationPreference = DISABLED) {}

  async load(): Promise<NotificationPreference> {
    return this.loaded;
  }

  async save(preference: NotificationPreference): Promise<void> {
    await Promise.resolve();
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.saves.push(preference);
  }
}

class FakeCapability implements NotificationCapabilitySource {
  state = { nativeSupport: "supported", osPermission: "unknown" } as const;
  reads = 0;

  read() {
    this.reads += 1;
    return this.state;
  }
}

function createController(
  persistence: NotificationPreferencePersistence = new FakePersistence(),
  capability: NotificationCapabilitySource = new FakeCapability(),
): NotificationSettingsController {
  return new NotificationSettingsController({ persistence, capability });
}

describe("NotificationSettingsController", () => {
  it("initializes device intent separately from support and permission", async () => {
    const controller = createController();

    await expect(controller.initialize()).resolves.toEqual({
      ...DISABLED,
      nativeSupport: "supported",
      osPermission: "unknown",
    });
  });

  it("persists preference before publishing it", async () => {
    const persistence = new FakePersistence();
    const controller = createController(persistence);
    await controller.initialize();
    const states: NotificationState[] = [];
    controller.subscribe((state) => states.push(state));

    await expect(controller.setPreference(ENABLED)).resolves.toMatchObject(ENABLED);

    expect(persistence.saves).toEqual([ENABLED]);
    expect(states).toEqual([expect.objectContaining(ENABLED)]);
  });

  it("preserves the prior state when persistence fails", async () => {
    const persistence = new FakePersistence();
    const controller = createController(persistence);
    await controller.initialize();
    persistence.failNext = true;

    await expect(controller.setPreference(ENABLED)).rejects.toThrow("disk full");
    expect(controller.state).toMatchObject(DISABLED);
  });

  it("publishes restrictive intent synchronously and keeps it after persistence fails", async () => {
    const preference = { ...ENABLED, contentPreviewPreference: "enabled" } as const;
    const persistence = new FakePersistence(preference);
    const controller = createController(persistence);
    await controller.initialize();
    const states: NotificationState[] = [];
    controller.subscribe((state) => states.push(state));
    persistence.failNext = true;

    const disabling = controller.setPreference(DISABLED);
    expect(controller.state).toMatchObject(DISABLED);
    expect(states).toEqual([expect.objectContaining(DISABLED)]);

    await expect(disabling).rejects.toThrow("disk full");
    expect(controller.state).toMatchObject(DISABLED);
    expect(states).toHaveLength(1);
  });

  it("stops attempts after presenter failure until an explicit refresh", async () => {
    const capability = new FakeCapability();
    const controller = createController(new FakePersistence(ENABLED), capability);
    await controller.initialize();

    expect(controller.markPresenterFailure()).toMatchObject({ nativeSupport: "unsupported" });
    expect(controller.state.nativeSupport).toBe("unsupported");

    await expect(controller.refreshCapability()).resolves.toMatchObject({
      nativeSupport: "supported",
      osPermission: "unknown",
    });
    expect(capability.reads).toBe(2);
  });

  it("keeps denied permission stable without prompting or retrying", async () => {
    const capability: NotificationCapabilitySource = {
      read: vi.fn(() => ({ nativeSupport: "supported", osPermission: "denied" }) as const),
    };
    const controller = createController(new FakePersistence(ENABLED), capability);

    await expect(controller.initialize()).resolves.toMatchObject({
      devicePreference: "enabled",
      nativeSupport: "supported",
      osPermission: "denied",
    });
    expect(capability.read).toHaveBeenCalledOnce();
  });

  it("fails closed when capability inspection throws", async () => {
    const controller = createController(new FakePersistence(), {
      read: () => {
        throw new Error("native API failed");
      },
    });

    await expect(controller.initialize()).resolves.toMatchObject({
      nativeSupport: "unsupported",
      osPermission: "unknown",
    });
  });

  it("rejects malformed preferences and new work after disposal", async () => {
    const controller = createController();
    await controller.initialize();

    await expect(
      controller.setPreference({ ...ENABLED, body: "private canary" } as NotificationPreference),
    ).rejects.toThrow();
    controller.dispose();
    expect(() => controller.state).toThrow(/disposed/);
    await expect(controller.refreshCapability()).rejects.toThrow(/disposed/);
  });
});
