import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { themePreferenceSchema, type ThemePreference } from "@hmm-chat/contracts";

import { isBuiltInThemeId } from "../shared/theme";

export const MAX_THEME_PREFERENCE_FILE_BYTES = 4_096;
const STORED_THEME_PREFERENCE_VERSION = 1;
const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

interface StoredThemePreference {
  readonly version: typeof STORED_THEME_PREFERENCE_VERSION;
  readonly preference: ThemePreference;
}

type SyncDirectory = (directory: string) => Promise<void>;

function parseStoredThemePreference(value: unknown): ThemePreference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(candidate, "version") ||
    !Object.hasOwn(candidate, "preference") ||
    candidate.version !== STORED_THEME_PREFERENCE_VERSION
  ) {
    return null;
  }

  const preference = themePreferenceSchema.safeParse(candidate.preference);
  return preference.success && (preference.data === "system" || isBuiltInThemeId(preference.data))
    ? preference.data
    : null;
}

async function readStoredThemePreference(filePath: string): Promise<ThemePreference | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_THEME_PREFERENCE_FILE_BYTES
    ) {
      return null;
    }

    const bytes = Buffer.alloc(MAX_THEME_PREFERENCE_FILE_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < bytes.length) {
      const result = await file.read(bytes, totalBytesRead, bytes.length - totalBytesRead, null);
      if (result.bytesRead === 0) {
        break;
      }
      totalBytesRead += result.bytesRead;
    }
    if (totalBytesRead === 0 || totalBytesRead > MAX_THEME_PREFERENCE_FILE_BYTES) {
      return null;
    }

    const source = bytes.toString("utf8", 0, totalBytesRead);
    return parseStoredThemePreference(JSON.parse(source) as unknown);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
  } catch {
    // The preference is already committed by rename; directory durability is best effort.
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function atomicWrite(
  filePath: string,
  value: string,
  syncDirectory: SyncDirectory,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, "wx", 0o600);
  let isOpen = true;
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
    await file.close();
    isOpen = false;
    await rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      await syncDirectory(directory).catch(() => undefined);
    }
  } catch (error) {
    if (isOpen) {
      await file.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ThemePreferenceStore {
  readonly #filePath: string;
  readonly #syncDirectory: SyncDirectory;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly userDataPath: string; readonly syncDirectory?: SyncDirectory }) {
    this.#filePath = path.join(options.userDataPath, "hmm-chat-settings", "theme.json");
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryBestEffort;
  }

  async load(): Promise<ThemePreference> {
    return (await readStoredThemePreference(this.#filePath)) ?? DEFAULT_THEME_PREFERENCE;
  }

  save(preference: ThemePreference): Promise<void> {
    const parsedPreference = themePreferenceSchema.parse(preference);
    if (parsedPreference !== "system" && !isBuiltInThemeId(parsedPreference)) {
      return Promise.reject(new Error(`Unknown built-in theme: ${parsedPreference}`));
    }
    const stored: StoredThemePreference = {
      version: STORED_THEME_PREFERENCE_VERSION,
      preference: parsedPreference,
    };
    const source = `${JSON.stringify(stored)}\n`;
    const request = this.#saveTail.then(() =>
      atomicWrite(this.#filePath, source, this.#syncDirectory),
    );
    this.#saveTail = request.catch(() => undefined);
    return request;
  }
}
