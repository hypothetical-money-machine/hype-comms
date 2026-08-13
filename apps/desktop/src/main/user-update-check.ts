import type { UpdateState } from "@hype-comms/contracts";

export interface UpdateCheckDialog {
  readonly type: "info" | "error";
  readonly message: string;
  readonly detail: string;
}

export interface UserInitiatedUpdateCheckOptions {
  readonly checkNow: () => Promise<void>;
  readonly readState: () => UpdateState;
  readonly subscribe: (listener: (state: UpdateState) => void) => () => void;
  readonly appVersion: string;
}

/** The menu command stays clickable only while the controller can still act on a click. */
export function isCheckForUpdatesEnabled(state: UpdateState): boolean {
  return state.status !== "unsupported";
}

/**
 * Dialog when the main window cannot be restored before a user-initiated check. Renderer-handled
 * update states need a window, so the check must not proceed without one.
 */
export function dialogForWindowRestoreFailure(): UpdateCheckDialog {
  return {
    type: "error",
    message: "Couldn't check for updates",
    detail: "The app window couldn't be opened. Open the app window and try again.",
  };
}

/**
 * Chooses whether a native update-check dialog may attach to the main BrowserWindow. Restore
 * failures always force an unparented dialog so a half-built, hidden window cannot swallow a
 * macOS sheet.
 */
export function shouldParentUpdateCheckDialog(
  mainWindow: { readonly isDestroyed: () => boolean } | null,
  options: { readonly parentToMainWindow?: boolean } = {},
): boolean {
  if (options.parentToMainWindow === false) {
    return false;
  }
  return mainWindow !== null && !mainWindow.isDestroyed();
}

/**
 * Decides the dialog for the terminal state of a user-initiated check. "idle", "error", and
 * "unsupported" have no renderer UI (and renderer delivery drops state when no window exists), so
 * they get a native dialog; "available", "downloading", and "ready" already render in the window.
 */
export function dialogForUpdateCheckState(
  state: UpdateState,
  appVersion: string,
): UpdateCheckDialog | null {
  if (state.status === "idle") {
    return {
      type: "info",
      message: "You're up to date",
      detail: `Hype Comms ${appVersion} is the latest version.`,
    };
  }
  if (state.status === "error") {
    return {
      type: "error",
      message: "Update check failed",
      detail: state.message,
    };
  }
  if (state.status === "unsupported") {
    return {
      type: "info",
      message: "Updates aren't available",
      detail: "Automatic updates aren't supported for this installation.",
    };
  }
  return null;
}

/**
 * Runs a user-initiated update check and reports which dialog, if any, should be shown. checkNow
 * resolves without waiting when a scheduled check is already in flight, so a still-"checking"
 * state is watched until that check settles. Automatic scheduled checks never pass through here,
 * so they keep their silent behavior.
 */
export async function runUserInitiatedUpdateCheck(
  options: UserInitiatedUpdateCheckOptions,
): Promise<UpdateCheckDialog | null> {
  await options.checkNow();
  return dialogForUpdateCheckState(await settledState(options), options.appVersion);
}

async function settledState(options: UserInitiatedUpdateCheckOptions): Promise<UpdateState> {
  const current = options.readState();
  if (current.status !== "checking") {
    return current;
  }

  return new Promise((resolve) => {
    const unsubscribe = options.subscribe((state) => {
      if (state.status === "checking") {
        return;
      }
      unsubscribe();
      resolve(state);
    });
  });
}
