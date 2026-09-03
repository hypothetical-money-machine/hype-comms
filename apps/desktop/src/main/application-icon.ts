import path from "node:path";

export const PACKAGED_APPLICATION_ICON_FILENAME = "hype-comms-icon.png";

export function resolveApplicationIconPath(options: {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, PACKAGED_APPLICATION_ICON_FILENAME)
    : path.join(options.appPath, "build", "icon.png");
}
