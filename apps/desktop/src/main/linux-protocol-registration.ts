import { execFile } from "node:child_process";
import {
  access,
  constants as fsConstants,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { AuthProtocolScheme } from "./security";

/**
 * Linux binds a URL scheme to whichever installed `.desktop` file claims its
 * `x-scheme-handler/<scheme>` MIME type. electron-builder `protocols` only stamps MimeType onto a
 * `.desktop` file inside the AppImage; that file is never installed into the session, so
 * `xdg-mime` has no default and Chrome cannot return `hype-comms://` after AuthKit. The deb
 * installs via dpkg. This module writes a user-level desktop entry pointing at a durable Exec
 * target (`$APPIMAGE`, or the packaged binary when that path is not an ephemeral FUSE mount) and
 * claims the scheme through `xdg-mime default`, so the sign-in card can warn when browser handoff
 * cannot return to the app.
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
  /** Resolves `null` when the file is missing or unreadable; this never rejects. */
  readonly readFile: (filePath: string) => Promise<string | null>;
  /** True only for a regular file this user may execute; directories and mode-000 files fail. */
  readonly fileIsExecutable: (filePath: string) => Promise<boolean>;
  /** Spawn failures resolve as `{ exitCode: null, stdout: "" }`; this never rejects. */
  readonly runCommand: (
    command: string,
    commandArguments: readonly string[],
  ) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;
}

/** The self-registered entry the verifier must distrust until its Exec target proves to exist. */
export interface SelfRegisteredHandlerCheck {
  readonly desktopFileName: string;
  readonly desktopFilePath: string;
}

export type ProtocolHandlerBinding = "bound" | "unbound" | "unknown";

export type LinuxProtocolInstallSource = "appimage" | "packaged-executable";

export type LinuxProtocolInstallResolution =
  | { readonly status: LinuxProtocolInstallSource; readonly executablePath: string }
  | { readonly status: "invalid-path" }
  | { readonly status: "no-durable-exec" };

export type LinuxProtocolInstallAction =
  | "written"
  | "failed"
  | "skipped-already-bound"
  | "skipped-no-durable-exec"
  | "skipped-invalid-path";

export interface LinuxProtocolInstallInput {
  readonly scheme: AuthProtocolScheme;
  readonly installedDesktopName: string;
  readonly productName: string;
  readonly appImagePath: string | undefined;
  readonly packagedExecutablePath: string;
  readonly appDir: string | undefined;
  readonly homeDirectory: string;
  readonly xdgDataHome: string | undefined;
}

export interface LinuxProtocolInstallListeners {
  readonly onInvalidPath?: () => void;
  readonly onRegisterError?: (error: unknown) => void;
}

export interface LinuxProtocolInstallResult {
  readonly binding: ProtocolHandlerBinding;
  readonly install: LinuxProtocolInstallAction;
}

/** The production effect layer: real filesystem plus `execFile` (no shell) with a 5s timeout. */
export function createLinuxProtocolRegistrationTarget(): LinuxProtocolRegistrationTarget {
  return {
    makeDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true });
    },
    writeFile: async (filePath, contents) => {
      await writeFile(filePath, contents, "utf8");
    },
    readFile: async (filePath) => {
      try {
        return await readFile(filePath, "utf8");
      } catch {
        return null;
      }
    },
    fileIsExecutable: async (filePath) => {
      try {
        if (!(await stat(filePath)).isFile()) {
          return false;
        }
        await access(filePath, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    runCommand: (command, commandArguments) =>
      new Promise((resolve) => {
        execFile(
          command,
          [...commandArguments],
          { timeout: 5_000, windowsHide: true },
          (error, stdout) => {
            if (error === null) {
              resolve({ exitCode: 0, stdout });
              return;
            }
            resolve({ exitCode: typeof error.code === "number" ? error.code : null, stdout: "" });
          },
        );
      }),
  };
}

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

export function userApplicationsDirectory(
  homeDirectory: string,
  xdgDataHome: string | undefined,
): string {
  const dataHome =
    xdgDataHome === undefined || xdgDataHome === ""
      ? path.join(homeDirectory, ".local", "share")
      : xdgDataHome;
  return path.join(dataHome, "applications");
}

/**
 * First Exec argument of a desktop entry, undoing the quoting `quoteExecArgument` applies.
 * Unquoted single-path Exec lines are accepted too; anything else parses as `null`.
 */
export function parseDesktopEntryExecPath(desktopFileContents: string): string | null {
  const execLine = desktopFileContents
    .split("\n")
    .find((line) => line.startsWith("Exec="))
    ?.slice("Exec=".length)
    .trim();
  if (execLine === undefined || execLine === "") {
    return null;
  }
  if (!execLine.startsWith('"')) {
    const firstArgument = execLine.split(/\s/, 1)[0] ?? "";
    return firstArgument === "" ? null : firstArgument;
  }
  let executablePath = "";
  for (let index = 1; index < execLine.length; index += 1) {
    const character = execLine[index];
    if (character === "\\") {
      index += 1;
      executablePath += execLine[index] ?? "";
      continue;
    }
    if (character === '"') {
      return executablePath === "" ? null : executablePath;
    }
    executablePath += character;
  }
  return null;
}

/** Empty or newline-containing paths cannot be written into a Desktop Entry Exec line. */
export function isUsableDesktopExecPath(value: string): boolean {
  return value.trim() !== "" && !value.includes("\n") && !value.includes("\r");
}

/**
 * AppImage FUSE mounts (`/tmp/.mount_*` and `$APPDIR`) disappear when the AppImage exits.
 * Registering those as Exec would leave a handler that launches nothing after the mount is gone.
 */
export function isEphemeralAppImageMountPath(
  executablePath: string,
  appDir: string | undefined,
): boolean {
  if (executablePath.split(path.sep).some((segment) => segment.startsWith(".mount_"))) {
    return true;
  }
  if (appDir === undefined || appDir === "") {
    return false;
  }
  const relative = path.relative(appDir, executablePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Prefer `$APPIMAGE` when the AppImage runtime set a durable path. Fall back to the packaged
 * executable for extracted launches. Never fall back from a present-but-unusable `$APPIMAGE` onto
 * the FUSE mount, and never register the mount itself.
 */
export function resolveLinuxProtocolInstallExecutable(input: {
  readonly appImagePath: string | undefined;
  readonly packagedExecutablePath: string;
  readonly appDir: string | undefined;
}): LinuxProtocolInstallResolution {
  if (input.appImagePath !== undefined && input.appImagePath !== "") {
    return isUsableDesktopExecPath(input.appImagePath)
      ? { status: "appimage", executablePath: input.appImagePath }
      : { status: "invalid-path" };
  }
  if (!isUsableDesktopExecPath(input.packagedExecutablePath)) {
    return { status: "no-durable-exec" };
  }
  if (isEphemeralAppImageMountPath(input.packagedExecutablePath, input.appDir)) {
    return { status: "no-durable-exec" };
  }
  return { status: "packaged-executable", executablePath: input.packagedExecutablePath };
}

function selfRegisteredHandlerCheck(
  installedDesktopName: string,
  homeDirectory: string,
  xdgDataHome: string | undefined,
): SelfRegisteredHandlerCheck {
  const desktopFileName = appImageDesktopFileName(installedDesktopName);
  return {
    desktopFileName,
    desktopFilePath: path.join(
      userApplicationsDirectory(homeDirectory, xdgDataHome),
      desktopFileName,
    ),
  };
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
  if (!isUsableDesktopExecPath(appImagePath)) {
    return null;
  }

  const applicationsDirectory = userApplicationsDirectory(input.homeDirectory, input.xdgDataHome);
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
 *
 * When the default resolves to the self-registered entry, its filename alone is not proof: the
 * AppImage that wrote it may have been moved or deleted since, leaving an entry whose Exec launches
 * nothing. The deb path verifies without rewriting, so it must read the entry and confirm the Exec
 * target is still launchable before trusting it.
 */
export async function queryProtocolHandlerBinding(
  mimeType: string,
  acceptedHandlers: readonly string[],
  target: Pick<LinuxProtocolRegistrationTarget, "runCommand" | "readFile" | "fileIsExecutable">,
  selfRegistered?: SelfRegisteredHandlerCheck,
): Promise<ProtocolHandlerBinding> {
  const result = await target.runCommand("xdg-mime", ["query", "default", mimeType]);
  if (result.exitCode !== 0) {
    return "unknown";
  }
  const handler = result.stdout.trim();
  if (!acceptedHandlers.includes(handler)) {
    return "unbound";
  }
  if (selfRegistered === undefined || handler !== selfRegistered.desktopFileName) {
    return "bound";
  }
  const contents = await target.readFile(selfRegistered.desktopFilePath);
  const executablePath = contents === null ? null : parseDesktopEntryExecPath(contents);
  if (executablePath === null) {
    return "unbound";
  }
  return (await target.fileIsExecutable(executablePath)) ? "bound" : "unbound";
}

/**
 * Installs the user-level handler when there is a durable Exec target, then verifies the binding.
 *
 * `$APPIMAGE` always rewrites the entry so a moved file heals itself. An extracted packaged
 * binary installs only while the scheme is not already bound, so a working deb is not stolen.
 * Ephemeral AppImage mounts and newline-containing paths skip the write and still query.
 */
export async function installAndQueryLinuxProtocolHandler(
  input: LinuxProtocolInstallInput,
  target: LinuxProtocolRegistrationTarget,
  listeners: LinuxProtocolInstallListeners = {},
): Promise<LinuxProtocolInstallResult> {
  const selfRegistered = selfRegisteredHandlerCheck(
    input.installedDesktopName,
    input.homeDirectory,
    input.xdgDataHome,
  );
  const mimeType = `x-scheme-handler/${input.scheme}`;
  const acceptedHandlers = [input.installedDesktopName, selfRegistered.desktopFileName];
  const queryBinding = (): Promise<ProtocolHandlerBinding> =>
    queryProtocolHandlerBinding(mimeType, acceptedHandlers, target, selfRegistered);

  const resolution = resolveLinuxProtocolInstallExecutable({
    appImagePath: input.appImagePath,
    packagedExecutablePath: input.packagedExecutablePath,
    appDir: input.appDir,
  });

  if (resolution.status === "invalid-path") {
    listeners.onInvalidPath?.();
    return { binding: await queryBinding(), install: "skipped-invalid-path" };
  }
  if (resolution.status === "no-durable-exec") {
    return { binding: await queryBinding(), install: "skipped-no-durable-exec" };
  }

  const plan = createAppImageDesktopFilePlan({
    scheme: input.scheme,
    installedDesktopName: input.installedDesktopName,
    productName: input.productName,
    appImagePath: resolution.executablePath,
    homeDirectory: input.homeDirectory,
    xdgDataHome: input.xdgDataHome,
  });
  if (plan === null) {
    listeners.onInvalidPath?.();
    return { binding: await queryBinding(), install: "skipped-invalid-path" };
  }

  if (resolution.status === "packaged-executable") {
    const current = await queryBinding();
    if (current === "bound") {
      return { binding: current, install: "skipped-already-bound" };
    }
  }

  try {
    await registerAppImageProtocolHandler(plan, target);
  } catch (error) {
    listeners.onRegisterError?.(error);
    return { binding: await queryBinding(), install: "failed" };
  }

  return { binding: await queryBinding(), install: "written" };
}
