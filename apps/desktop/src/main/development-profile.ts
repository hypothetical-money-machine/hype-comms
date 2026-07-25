import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import type { ChatSessionState } from "@hmm-chat/contracts";

const PROFILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CALLBACK_FILE_BYTES = 16_384;

export function resolveDevelopmentProfile(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env.HMM_DESKTOP_PROFILE?.trim() ?? "";
  if (value === "") return "";
  if (!PROFILE_PATTERN.test(value)) {
    throw new Error("HMM_DESKTOP_PROFILE must be a lowercase slug");
  }
  return value;
}

function requireIsolatedUnpackagedProfile(
  variable: string,
  isPackaged: boolean,
  profile: string,
): void {
  if (isPackaged || profile === "") {
    throw new Error(`${variable} requires an unpackaged, isolated development profile`);
  }
}

export function resolveDevelopmentAuthCallbackFile(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
  profile: string,
): string | null {
  const value = env.HMM_DEVELOPMENT_AUTH_CALLBACK_FILE?.trim() ?? "";
  if (value === "") return null;
  requireIsolatedUnpackagedProfile("HMM_DEVELOPMENT_AUTH_CALLBACK_FILE", isPackaged, profile);
  if (value.includes("\0")) throw new Error("HMM_DEVELOPMENT_AUTH_CALLBACK_FILE is invalid");
  return path.resolve(value);
}

export function resolveDevelopmentUserDataPath(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
  profile: string,
  defaultUserDataPath: string,
): string {
  const root = env.HMM_DEVELOPMENT_USER_DATA_ROOT?.trim() ?? "";
  if (root === "") {
    return profile === ""
      ? defaultUserDataPath
      : path.join(defaultUserDataPath, `development-${profile}`);
  }
  requireIsolatedUnpackagedProfile("HMM_DEVELOPMENT_USER_DATA_ROOT", isPackaged, profile);
  return path.join(path.resolve(root), profile);
}

/**
 * Reads a private callback exactly once. Removal happens even for malformed content so restarting
 * the main process can never replay a credential.
 */
export async function consumeDevelopmentAuthCallbackFile(file: string): Promise<string | null> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("Development auth callback must be a regular file");
    }
    // Windows does not expose POSIX mode bits; the isolated profile and one-shot removal still
    // apply there, while POSIX builds enforce the launcher's 0600 contract.
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new Error("Development auth callback file must have mode 0600");
    }
    if (details.size > MAX_CALLBACK_FILE_BYTES) {
      throw new Error("Development auth callback file is too large");
    }
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

export function callbackForSignedOutSession(
  callback: string | null,
  restoredSession: ChatSessionState,
): string | null {
  return restoredSession.status === "signed-out" ? callback : null;
}
