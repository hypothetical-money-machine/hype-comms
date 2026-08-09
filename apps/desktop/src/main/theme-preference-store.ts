import path from "node:path";

import { themePreferenceSchema, type ThemePreference } from "@hmm-chat/contracts";

import { isBuiltInThemeId } from "../shared/theme";
import {
  atomicWrite,
  readBoundedUtf8File,
  syncDirectoryBestEffort,
  type SyncDirectory,
} from "./preference-file";

export const MAX_THEME_PREFERENCE_FILE_BYTES = 4_096;
const STORED_THEME_PREFERENCE_VERSION = 1;
const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

interface StoredThemePreference {
  readonly version: typeof STORED_THEME_PREFERENCE_VERSION;
  readonly preference: ThemePreference;
}

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
  const source = await readBoundedUtf8File(filePath, MAX_THEME_PREFERENCE_FILE_BYTES);
  if (source === null) {
    return null;
  }
  try {
    return parseStoredThemePreference(JSON.parse(source) as unknown);
  } catch {
    return null;
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
