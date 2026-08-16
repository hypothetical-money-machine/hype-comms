export type DesktopBuildFlavorName = "development" | "production";

export interface DesktopBuildFlavor {
  readonly name: DesktopBuildFlavorName;
  readonly isProduction: boolean;
  readonly packageName: string;
  readonly appId: string;
  readonly productName: string;
  readonly executableName: string;
  readonly artifactName: string;
  readonly desktopName: string;
  readonly linuxPackageName: string;
  readonly protocolScheme: string;
  readonly releaseDirectory: string;
  readonly updateUrl: string | null;
}

export const DESKTOP_BUILD_FLAVOR_ENV: "HYPE_COMMS_BUILD_FLAVOR";
export const DEVELOPMENT_DESKTOP_BUILD_FLAVOR: DesktopBuildFlavor;
export const PRODUCTION_DESKTOP_BUILD_FLAVOR: DesktopBuildFlavor;

export function resolveDesktopBuildFlavor(value?: string): DesktopBuildFlavor;
