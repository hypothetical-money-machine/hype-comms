import type { App } from "electron";

/** Must remain identical to electron-builder's build.appId. */
export const DESKTOP_APPLICATION_ID = "com.hypotheticalmoneymachine.hmmchat";

type ApplicationIdentityTarget = Pick<App, "setAppUserModelId">;

/**
 * Establishes Windows toast attribution before the first BrowserWindow is constructed.
 * electron-builder installs the matching Start Menu identity for packaged NSIS applications.
 */
export function configureWindowsApplicationIdentity(
  target: ApplicationIdentityTarget,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") target.setAppUserModelId(DESKTOP_APPLICATION_ID);
}
