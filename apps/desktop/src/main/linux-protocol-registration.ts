import path from "node:path";

import type { AuthProtocolScheme } from "./security";

/**
 * Linux binds a URL scheme to whichever installed `.desktop` file claims its
 * `x-scheme-handler/<scheme>` MIME type. The deb installs one system-wide, but an AppImage installs
 * nothing, so Electron's `setAsDefaultProtocolClient` has nothing to bind and the AuthKit browser
 * redirect dies in the user's browser. This module writes a user-level desktop entry pointing at
 * the running AppImage and verifies the binding through `xdg-mime`, so the sign-in card can warn
 * when browser handoff cannot return to the app.
 */

export interface LinuxDesktopFilePlan {
  readonly desktopFileName: string;
  readonly desktopFilePath: string;
  readonly applicationsDirectory: string;
  readonly desktopFileContents: string;
  readonly mimeType: string;
  /** Handler names that satisfy verification: the packaged entry or the self-registered one. */
  readonly acceptedHandlers: readonly string[];
}

export interface LinuxProtocolRegistrationTarget {
  readonly makeDirectory: (directoryPath: string) => Promise<void>;
  readonly writeFile: (filePath: string, contents: string) => Promise<void>;
  /** Spawn failures resolve as `{ exitCode: null, stdout: "" }`; this never rejects. */
  readonly runCommand: (
    command: string,
    commandArguments: readonly string[],
  ) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;
}

export type ProtocolHandlerBinding = "bound" | "unbound" | "unknown";

/**
 * The self-registered entry must never reuse the installed name: a user-level file named
 * `com.hypemm.hypecomms.desktop` would shadow the deb's system entry and repoint its Exec at a
 * possibly deleted AppImage.
 */
export function appImageDesktopFileName(installedDesktopName: string): string {
  const stem = installedDesktopName.endsWith(".desktop")
    ? installedDesktopName.slice(0, -".desktop".length)
    : installedDesktopName;
  return `${stem}.appimage.desktop`;
}

/** Desktop Entry spec quoting: reserved characters inside a quoted Exec argument. */
export function quoteExecArgument(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (character) => `\\${character}`)}"`;
}

export function createAppImageDesktopFilePlan(input: {
  readonly scheme: AuthProtocolScheme;
  readonly installedDesktopName: string;
  readonly productName: string;
  readonly appImagePath: string;
  readonly homeDirectory: string;
  readonly xdgDataHome: string | undefined;
}): LinuxDesktopFilePlan | null {
  const appImagePath = input.appImagePath;
  if (appImagePath === "" || appImagePath.includes("\n") || appImagePath.includes("\r")) {
    return null;
  }

  const dataHome =
    input.xdgDataHome === undefined || input.xdgDataHome === ""
      ? path.join(input.homeDirectory, ".local", "share")
      : input.xdgDataHome;
  const applicationsDirectory = path.join(dataHome, "applications");
  const desktopFileName = appImageDesktopFileName(input.installedDesktopName);
  const mimeType = `x-scheme-handler/${input.scheme}`;
  const desktopFileContents = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${input.productName}`,
    `Comment=${input.productName} URL handler (self-registered by the AppImage)`,
    `Exec=${quoteExecArgument(appImagePath)} %u`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=${mimeType};`,
    "",
  ].join("\n");

  return {
    desktopFileName,
    desktopFilePath: path.join(applicationsDirectory, desktopFileName),
    applicationsDirectory,
    desktopFileContents,
    mimeType,
    acceptedHandlers: [input.installedDesktopName, desktopFileName],
  };
}

/**
 * Rewrites the desktop entry on every startup so a moved or re-downloaded AppImage heals itself,
 * then claims the scheme through `xdg-mime`. The desktop-database refresh is best-effort: scheme
 * resolution reads `mimeapps.list`, which `xdg-mime default` updates directly.
 */
export async function registerAppImageProtocolHandler(
  plan: LinuxDesktopFilePlan,
  target: LinuxProtocolRegistrationTarget,
): Promise<void> {
  await target.makeDirectory(plan.applicationsDirectory);
  await target.writeFile(plan.desktopFilePath, plan.desktopFileContents);
  await target.runCommand("xdg-mime", ["default", plan.desktopFileName, plan.mimeType]);
  await target.runCommand("update-desktop-database", [plan.applicationsDirectory]);
}

/**
 * `unknown` covers boxes without xdg-utils; only a confirmed empty or foreign handler reports
 * `unbound`, so the sign-in warning never fires on a query that simply could not run.
 */
export async function queryProtocolHandlerBinding(
  mimeType: string,
  acceptedHandlers: readonly string[],
  target: Pick<LinuxProtocolRegistrationTarget, "runCommand">,
): Promise<ProtocolHandlerBinding> {
  const result = await target.runCommand("xdg-mime", ["query", "default", mimeType]);
  if (result.exitCode !== 0) {
    return "unknown";
  }
  const handler = result.stdout.trim();
  return acceptedHandlers.includes(handler) ? "bound" : "unbound";
}
