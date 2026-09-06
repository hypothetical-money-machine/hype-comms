import { useCallback, useSyncExternalStore } from "react";

import type { DevicePreferences, DevicePreferencesPatch } from "@hype-comms/contracts";

/**
 * The structural slice of `DevicePreferencesRuntime` the preference controls need. Typing against
 * the shape rather than the class keeps the controls testable with a plain fake.
 */
export interface DevicePreferencesControlRuntime {
  readonly state: DevicePreferences;
  readonly subscribe: (listener: () => void) => () => void;
  readonly update: (patch: DevicePreferencesPatch) => Promise<DevicePreferences>;
}

export function useDevicePreferences(runtime: DevicePreferencesControlRuntime): DevicePreferences {
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.state, [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
