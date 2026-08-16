import type { App } from "electron";

export interface ApplicationIdentity {
  readonly appId: string;
  readonly desktopName: string;
  readonly isProductionBuild: boolean;
  readonly productName: string;
}

type ApplicationIdentityTarget = Pick<App, "setAppUserModelId" | "setDesktopName" | "setName">;

/**
 * Establishes the selected build's process identity before Electron resolves profile paths,
 * acquires the single-instance lock, or constructs a BrowserWindow. electron-builder installs the
 * matching Start Menu identity for packaged NSIS applications.
 */
export function configureApplicationIdentity(
  target: ApplicationIdentityTarget,
  platform: NodeJS.Platform,
  identity: ApplicationIdentity,
): void {
  // Stable releases historically derive their profile directory from package.json's scoped name.
  // Keep that behavior so an upgrade does not strand the existing session and preferences.
  if (!identity.isProductionBuild) target.setName(identity.productName);
  if (platform === "win32") target.setAppUserModelId(identity.appId);
  if (platform === "linux") target.setDesktopName(identity.desktopName);
}

interface LegacyProfileMigrationContext {
  readonly isPackaged: boolean;
  readonly isProductionBuild: boolean;
  readonly isNativeNotificationEvidence: boolean;
}

/** Only the stable installed application may adopt the pre-rebrand stable profile. */
export function shouldMigrateLegacyProfile({
  isPackaged,
  isProductionBuild,
  isNativeNotificationEvidence,
}: LegacyProfileMigrationContext): boolean {
  return isPackaged && isProductionBuild && !isNativeNotificationEvidence;
}
