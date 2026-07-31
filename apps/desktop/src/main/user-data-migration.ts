import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";

export const LEGACY_PRODUCT_NAME = "HMM Chat";

export type UserDataMigrationResult = "not-needed" | "migrated";

interface UserDataMigrationOptions {
  readonly currentPath: string;
  readonly legacyPath: string;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "darwin" || process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function directoryState(directory: string): "missing" | "empty" | "populated" {
  try {
    const details = lstatSync(directory);
    if (!details.isDirectory()) {
      throw new Error(`Expected user-data path to be a directory: ${directory}`);
    }
    return readdirSync(directory).length === 0 ? "empty" : "populated";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

/**
 * Move the pre-rebrand profile into the Hype Comms profile before Electron opens its session.
 *
 * TODO(v1.0.0): remove this compatibility migration and its tests once upgrades from HMM Chat
 * are outside the supported window. Hype Comms must continue using its own canonical path.
 */
export function migrateLegacyUserData({
  currentPath,
  legacyPath,
}: UserDataMigrationOptions): UserDataMigrationResult {
  if (samePath(currentPath, legacyPath)) {
    return "not-needed";
  }

  const legacyState = directoryState(legacyPath);
  if (legacyState === "missing") {
    return "not-needed";
  }

  const currentState = directoryState(currentPath);
  if (currentState === "populated") {
    throw new Error(
      `Cannot migrate legacy HMM Chat data because both user-data directories contain data: ` +
        `${legacyPath} and ${currentPath}. Resolve the directories manually before starting Hype Comms.`,
    );
  }

  if (currentState === "empty") {
    rmdirSync(currentPath);
  } else {
    mkdirSync(path.dirname(currentPath), { recursive: true, mode: 0o700 });
  }

  renameSync(legacyPath, currentPath);
  return "migrated";
}
