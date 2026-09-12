import {
  devicePreferencesPatchSchema,
  devicePreferencesSchema,
  type DevicePreferences,
  type DevicePreferencesPatch,
} from "@hype-comms/contracts";

import { devicePreferencesEqual } from "../shared/device-preferences";
import { PersistedPreference, type PreferencePersistence } from "./persisted-preference";

export type DevicePreferencesPersistence = PreferencePersistence<DevicePreferences>;

/** Partial updates merge with the latest durable value inside the serialized write. */
export class DevicePreferencesController extends PersistedPreference<DevicePreferences> {
  constructor(options: {
    readonly persistence: DevicePreferencesPersistence;
    readonly reportListenerError?: (error: unknown) => void;
  }) {
    super({
      ...options,
      name: "DevicePreferencesController",
      canonicalize: (value) => Object.freeze(devicePreferencesSchema.parse(value)),
      equal: devicePreferencesEqual,
    });
  }

  update(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    try {
      const canonicalPatch = devicePreferencesPatchSchema.parse(patch);
      return this.change((current) =>
        devicePreferencesSchema.parse({ ...current, ...canonicalPatch }),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
