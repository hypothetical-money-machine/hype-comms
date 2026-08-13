/**
 * Development-only presentation settings for automation clients. These settings deliberately
 * retain a normal BrowserWindow and renderer; they only prevent the native window from becoming
 * visible or focused while it is driven through a local debugging connection.
 */

export const HEADLESS_DESKTOP_CONTENT_WIDTH = 1_280;
export const HEADLESS_DESKTOP_CONTENT_HEIGHT = 800;
export const HEADLESS_DESKTOP_SCALE_FACTOR = 1;
export const HEADLESS_DESKTOP_CDP_ADDRESS = "127.0.0.1";

export interface HeadlessDesktopConfiguration {
  readonly contentWidth: typeof HEADLESS_DESKTOP_CONTENT_WIDTH;
  readonly contentHeight: typeof HEADLESS_DESKTOP_CONTENT_HEIGHT;
  readonly deviceScaleFactor: typeof HEADLESS_DESKTOP_SCALE_FACTOR;
  readonly disableBackgroundThrottling: true;
  readonly focusOnNavigation: false;
  readonly focusable: false;
}

const configuration: HeadlessDesktopConfiguration = {
  contentWidth: HEADLESS_DESKTOP_CONTENT_WIDTH,
  contentHeight: HEADLESS_DESKTOP_CONTENT_HEIGHT,
  deviceScaleFactor: HEADLESS_DESKTOP_SCALE_FACTOR,
  disableBackgroundThrottling: true,
  focusOnNavigation: false,
  focusable: false,
};

function requireUnpackagedIsolatedProfile(isPackaged: boolean, profile: string): void {
  if (isPackaged || profile === "") {
    throw new Error(
      "HYPE_COMMS_DESKTOP_HEADLESS requires an unpackaged, isolated development profile",
    );
  }
}

/**
 * Enables invisible, local automation windows only when a caller explicitly opts in from an
 * isolated development profile. Rejecting other non-empty values keeps a typo from silently
 * launching an interactive client during an automated run.
 */
export function resolveHeadlessDesktopConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
  profile: string,
): HeadlessDesktopConfiguration | null {
  const value = env.HYPE_COMMS_DESKTOP_HEADLESS?.trim() ?? "";
  if (value === "") return null;
  if (value !== "1") {
    throw new Error("HYPE_COMMS_DESKTOP_HEADLESS must be set to 1");
  }

  requireUnpackagedIsolatedProfile(isPackaged, profile);
  return configuration;
}

export function shouldShowDesktopWindow(
  headlessConfiguration: HeadlessDesktopConfiguration | null,
): boolean {
  return headlessConfiguration === null;
}

export function shouldFocusDesktopWindow(
  headlessConfiguration: HeadlessDesktopConfiguration | null,
): boolean {
  return headlessConfiguration === null;
}

/**
 * A hidden automation renderer never represents a person seeing a message. Enforce that policy
 * at the privileged IPC boundary as well as in renderer-side visibility tracking.
 */
export function shouldAdvanceReadCursor(
  headlessConfiguration: HeadlessDesktopConfiguration | null,
): boolean {
  return headlessConfiguration === null;
}

/**
 * CDP is an automation capability, so a development user cannot accidentally expose a headless
 * renderer by supplying a broad Chromium remote-debugging address alongside the environment flag.
 */
export function assertHeadlessDesktopCommandLine(arguments_: readonly string[]): void {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    let address: string | undefined;
    let hasRemoteDebuggingAddress = false;
    if (argument.startsWith("--remote-debugging-address=")) {
      address = argument.slice("--remote-debugging-address=".length);
      hasRemoteDebuggingAddress = true;
    } else if (argument === "--remote-debugging-address") {
      address = arguments_[index + 1];
      index += 1;
      hasRemoteDebuggingAddress = true;
    }
    if (hasRemoteDebuggingAddress && address !== HEADLESS_DESKTOP_CDP_ADDRESS) {
      throw new Error(
        `HYPE_COMMS_DESKTOP_HEADLESS requires --remote-debugging-address=${HEADLESS_DESKTOP_CDP_ADDRESS}`,
      );
    }
  }
}
