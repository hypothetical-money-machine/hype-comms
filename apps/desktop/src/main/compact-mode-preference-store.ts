import path from "node:path";

import type { CompactModePreference } from "@hype-comms/contracts";

import {
  atomicWrite,
  readBoundedUtf8File,
  syncDirectoryBestEffort,
  type SyncDirectory,
} from "./preference-file";

export const MAX_COMPACT_MODE_FILE_BYTES = 512;
const STORED_COMPACT_MODE_PREFERENCE_VERSION = 1;
const DEFAULT_COMPACT_MODE_PREFERENCE: CompactModePreference = false;

interface StoredCompactModePreference {
  readonly version: typeof STORED_COMPACT_MODE_PREFERENCE_VERSION;
  readonly enabled: CompactModePreference;
}

/** Strict envelope: unknown keys, a foreign version, or a non-boolean fall back to the default. */
function parseStoredCompactModePreference(value: unknown): CompactModePreference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.version !== STORED_COMPACT_MODE_PREFERENCE_VERSION ||
    typeof candidate.enabled !== "boolean"
  ) {
    return null;
  }
  return candidate.enabled;
}

async function readStoredCompactModePreference(
  filePath: string,
): Promise<CompactModePreference | null> {
  const source = await readBoundedUtf8File(filePath, MAX_COMPACT_MODE_FILE_BYTES);
  if (source === null) {
    return null;
  }
  try {
    return parseStoredCompactModePreference(JSON.parse(source));
  } catch {
    return null;
  }
}

export class CompactModePreferenceStore {
  readonly #filePath: string;
  readonly #syncDirectory: SyncDirectory;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly userDataPath: string; readonly syncDirectory?: SyncDirectory }) {
    this.#filePath = path.join(options.userDataPath, "hmm-chat-settings", "compact-mode.json");
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryBestEffort;
  }

  async load(): Promise<CompactModePreference> {
    return (
      (await readStoredCompactModePreference(this.#filePath)) ?? DEFAULT_COMPACT_MODE_PREFERENCE
    );
  }

  save(enabled: CompactModePreference): Promise<void> {
    const stored: StoredCompactModePreference = { version: 1, enabled };
    const source = `${JSON.stringify(stored)}\n`;
    const request = this.#saveTail.then(() =>
      atomicWrite(this.#filePath, source, this.#syncDirectory),
    );
    this.#saveTail = request.catch(() => undefined);
    return request;
  }
}
