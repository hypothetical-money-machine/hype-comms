export interface LastWindowClosedActions {
  readonly platform: NodeJS.Platform;
  readonly stopRealtime: () => void;
  readonly quit: () => void;
}

/**
 * Stops renderer-owned realtime whenever the final window disappears. macOS keeps the process
 * alive so activation can recreate a window; every other desktop platform preserves the existing
 * quit-on-last-window behavior.
 */
export function handleLastWindowClosed(actions: LastWindowClosedActions): void {
  actions.stopRealtime();
  if (actions.platform !== "darwin") {
    actions.quit();
  }
}
