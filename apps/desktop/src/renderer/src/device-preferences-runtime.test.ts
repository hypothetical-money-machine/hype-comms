// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DevicePreferences, DevicePreferencesPatch } from "@hype-comms/contracts";

import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences";
import type { DevicePreferencesTransport } from "../../shared/desktop-api";
import { DevicePreferencesRuntime } from "./device-preferences-runtime";

const DEFAULT_PREFERENCES: DevicePreferences = DEFAULT_DEVICE_PREFERENCES;

const VISUAL_PREFERENCES: DevicePreferences = {
  ...DEFAULT_PREFERENCES,
  sidebarWidth: "wide",
  messageTextSize: "large",
  alwaysShowGroupedMessageTimes: true,
  showProfileTitles: false,
  motionPreference: "reduced",
};

class FakeDevicePreferencesTransport implements DevicePreferencesTransport {
  readonly initialDevicePreferences: DevicePreferences;
  state: DevicePreferences;
  getState: () => Promise<DevicePreferences> = () => Promise.resolve(this.state);
  updateError: Error | null = null;
  subscriptionError: Error | null = null;
  readonly patches: DevicePreferencesPatch[] = [];
  readonly listeners = new Set<(state: DevicePreferences) => void>();

  constructor(initialDevicePreferences: DevicePreferences = DEFAULT_PREFERENCES) {
    this.initialDevicePreferences = initialDevicePreferences;
    this.state = initialDevicePreferences;
  }

  getDevicePreferences(): Promise<DevicePreferences> {
    return this.getState();
  }

  async updateDevicePreferences(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    this.patches.push(patch);
    if (this.updateError !== null) throw this.updateError;
    this.state = { ...this.state, ...patch };
    return this.state;
  }

  onDevicePreferencesChanged(listener: (state: DevicePreferences) => void): () => void {
    if (this.subscriptionError !== null) throw this.subscriptionError;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: DevicePreferences): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

const DATA_ATTRIBUTES = [
  "sidebarWidth",
  "messageTextSize",
  "alwaysShowGroupedMessageTimes",
  "showProfileTitles",
  "motionPreference",
] as const;

function createRoot(): HTMLElement {
  const root = document.documentElement;
  for (const attribute of DATA_ATTRIBUTES) delete root.dataset[attribute];
  return root;
}

afterEach(() => {
  const root = document.documentElement;
  for (const attribute of DATA_ATTRIBUTES) delete root.dataset[attribute];
});

describe("DevicePreferencesRuntime", () => {
  it("applies every non-default visual preference synchronously before hydration", () => {
    const root = createRoot();
    const runtime = new DevicePreferencesRuntime(
      new FakeDevicePreferencesTransport(VISUAL_PREFERENCES),
      root,
    );

    expect(root.dataset.sidebarWidth).toBe("wide");
    expect(root.dataset.messageTextSize).toBe("large");
    expect(root.dataset.alwaysShowGroupedMessageTimes).toBe("true");
    expect(root.dataset.showProfileTitles).toBe("false");
    expect(root.dataset.motionPreference).toBe("reduced");
    runtime.dispose();
  });

  it("removes default-only attributes when the default state is applied", () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport(VISUAL_PREFERENCES);
    const runtime = new DevicePreferencesRuntime(client, root);

    expect(root.dataset.sidebarWidth).toBe("wide");
    client.state = DEFAULT_PREFERENCES;
    void runtime.start();

    return runtime.start().then(() => {
      for (const attribute of DATA_ATTRIBUTES) expect(root.dataset[attribute]).toBeUndefined();
      runtime.dispose();
    });
  });

  it("hydrates state and its document attributes from main", async () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport();
    client.state = VISUAL_PREFERENCES;
    const runtime = new DevicePreferencesRuntime(client, root);

    await runtime.start();

    expect(runtime.state).toBe(VISUAL_PREFERENCES);
    expect(root.dataset.sidebarWidth).toBe("wide");
    expect(root.dataset.motionPreference).toBe("reduced");
    runtime.dispose();
  });

  it("does not overwrite a pushed state with stale hydration", async () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport();
    let resolveInitial: ((state: DevicePreferences) => void) | undefined;
    client.getState = () =>
      new Promise<DevicePreferences>((resolve) => {
        resolveInitial = resolve;
      });
    const runtime = new DevicePreferencesRuntime(client, root);

    const started = runtime.start();
    client.emit(VISUAL_PREFERENCES);
    resolveInitial?.(DEFAULT_PREFERENCES);
    await started;

    expect(runtime.state).toBe(VISUAL_PREFERENCES);
    expect(root.dataset.sidebarWidth).toBe("wide");
    expect(root.dataset.motionPreference).toBe("reduced");
    runtime.dispose();
  });

  it("applies mutation responses and publishes one change", async () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport();
    const runtime = new DevicePreferencesRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);

    const result = await runtime.update({
      sidebarWidth: "narrow",
      messageTextSize: "small",
      alwaysShowGroupedMessageTimes: true,
      showProfileTitles: false,
      motionPreference: "reduced",
    });

    expect(client.patches).toEqual([
      {
        sidebarWidth: "narrow",
        messageTextSize: "small",
        alwaysShowGroupedMessageTimes: true,
        showProfileTitles: false,
        motionPreference: "reduced",
      },
    ]);
    expect(result).toBe(client.state);
    expect(runtime.state).toBe(client.state);
    expect(root.dataset.sidebarWidth).toBe("narrow");
    expect(root.dataset.messageTextSize).toBe("small");
    expect(root.dataset.alwaysShowGroupedMessageTimes).toBe("true");
    expect(root.dataset.showProfileTitles).toBe("false");
    expect(root.dataset.motionPreference).toBe("reduced");
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("accepts live pushes while deduplicating equal full states", async () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport();
    const runtime = new DevicePreferencesRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);

    client.emit(VISUAL_PREFERENCES);
    const acceptedState = runtime.state;
    client.emit({ ...VISUAL_PREFERENCES });
    client.emit({ ...VISUAL_PREFERENCES, timestampFormat: "24-hour" });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(acceptedState).toBe(VISUAL_PREFERENCES);
    expect(runtime.state.timestampFormat).toBe("24-hour");
    expect(root.dataset.sidebarWidth).toBe("wide");
    runtime.dispose();
  });

  it("keeps the synchronous state when hydration or subscription setup fails", async () => {
    const unavailable = new FakeDevicePreferencesTransport(VISUAL_PREFERENCES);
    unavailable.getState = () => Promise.reject(new Error("IPC unavailable"));
    const firstRuntime = new DevicePreferencesRuntime(unavailable, createRoot());

    await expect(firstRuntime.start()).resolves.toBeUndefined();
    expect(firstRuntime.state).toBe(VISUAL_PREFERENCES);
    expect(document.documentElement.dataset.sidebarWidth).toBe("wide");
    firstRuntime.dispose();

    const unsubscribable = new FakeDevicePreferencesTransport(VISUAL_PREFERENCES);
    unsubscribable.subscriptionError = new Error("subscription unavailable");
    const secondRuntime = new DevicePreferencesRuntime(unsubscribable, createRoot());

    await expect(secondRuntime.start()).resolves.toBeUndefined();
    expect(secondRuntime.state).toBe(VISUAL_PREFERENCES);
    expect(document.documentElement.dataset.motionPreference).toBe("reduced");
    secondRuntime.dispose();
  });

  it("does not change state when a mutation fails", async () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport(VISUAL_PREFERENCES);
    client.updateError = new Error("disk full");
    const runtime = new DevicePreferencesRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);

    await expect(runtime.update({ sidebarWidth: "narrow" })).rejects.toThrow("disk full");

    expect(runtime.state).toBe(VISUAL_PREFERENCES);
    expect(root.dataset.sidebarWidth).toBe("wide");
    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("stops live delivery and clears subscribers after disposal", async () => {
    const root = createRoot();
    const client = new FakeDevicePreferencesTransport();
    const runtime = new DevicePreferencesRuntime(client, root);
    await runtime.start();
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.dispose();
    client.emit(VISUAL_PREFERENCES);

    expect(client.listeners.size).toBe(0);
    expect(runtime.state).toBe(DEFAULT_PREFERENCES);
    expect(root.dataset.sidebarWidth).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
  it("resolves a system motion preference against the OS setting", () => {
    const root = createRoot();
    const listeners = new Set<() => void>();
    const matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    try {
      const runtime = new DevicePreferencesRuntime(
        new FakeDevicePreferencesTransport(DEFAULT_PREFERENCES),
        root,
      );

      // "system" plus an OS that asks for reduced motion stamps the same concrete value an
      // explicit choice would, so the stylesheet needs no media-query companion.
      expect(root.dataset.motionPreference).toBe("reduced");

      runtime.dispose();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the motion attribute off when neither the choice nor the OS asks for it", () => {
    const root = createRoot();
    const runtime = new DevicePreferencesRuntime(
      new FakeDevicePreferencesTransport(DEFAULT_PREFERENCES),
      root,
    );

    expect(root.dataset.motionPreference).toBeUndefined();
    runtime.dispose();
  });
});
