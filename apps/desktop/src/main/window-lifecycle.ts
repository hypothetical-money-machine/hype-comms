export interface LastWindowClosedActions {
  readonly platform: NodeJS.Platform;
  readonly windowlessRealtimeEnabled: boolean;
  readonly continueRealtimeWithoutRenderer: () => void;
  readonly stopRealtime: () => void;
  readonly quit: () => void;
}

/**
 * Keeps notification observation alive on macOS only when its explicit transport contract is
 * enabled. Default-off builds retain the stop fallback, while every other desktop platform
 * preserves the existing quit-on-last-window behavior.
 */
export function handleLastWindowClosed(actions: LastWindowClosedActions): void {
  if (actions.platform === "darwin" && actions.windowlessRealtimeEnabled) {
    actions.continueRealtimeWithoutRenderer();
  } else {
    actions.stopRealtime();
  }
  if (actions.platform !== "darwin") {
    actions.quit();
  }
}
