import { useCallback, useSyncExternalStore } from "react";

import type { CompactModeRuntime } from "./compact-mode-runtime";

/** Subscribes a component to the runtime's persisted compact-mode flag. */
export function useCompactModeEnabled(compactMode: CompactModeRuntime): boolean {
  const subscribe = useCallback(
    (listener: () => void) => compactMode.subscribe(listener),
    [compactMode],
  );
  const getSnapshot = useCallback(() => compactMode.enabled, [compactMode]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
