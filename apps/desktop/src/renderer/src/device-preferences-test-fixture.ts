import type { DevicePreferences, DevicePreferencesPatch } from "@hype-comms/contracts";

import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences";
import type { DevicePreferencesTransport } from "../../shared/desktop-api";
import { DevicePreferencesRuntime } from "./device-preferences-runtime";

class TestDevicePreferencesTransport implements DevicePreferencesTransport {
  readonly listeners = new Set<(preferences: DevicePreferences) => void>();
  readonly initialDevicePreferences: DevicePreferences;
  #state: DevicePreferences;

  constructor(state: DevicePreferences) {
    this.initialDevicePreferences = state;
    this.#state = state;
  }

  getDevicePreferences(): Promise<DevicePreferences> {
    return Promise.resolve(this.#state);
  }

  updateDevicePreferences(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.listeners) listener(this.#state);
    return Promise.resolve(this.#state);
  }

  onDevicePreferencesChanged(listener: (preferences: DevicePreferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createTestDevicePreferencesRuntime(
  overrides: Partial<Omit<DevicePreferences, "version">> = {},
): DevicePreferencesRuntime {
  const state: DevicePreferences = { ...DEFAULT_DEVICE_PREFERENCES, ...overrides };
  return new DevicePreferencesRuntime(
    new TestDevicePreferencesTransport(state),
    document.documentElement,
  );
}
