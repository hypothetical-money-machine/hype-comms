import path from "node:path";

import type { CompactModePreference } from "@hype-comms/contracts";

import { JsonPreferenceFile, type PreferenceStoreOptions } from "./preference-file";

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

export class CompactModePreferenceStore extends JsonPreferenceFile<CompactModePreference> {
  constructor(options: PreferenceStoreOptions) {
    super({
      filePath: path.join(options.userDataPath, "hype-comms-settings", "compact-mode.json"),
      syncDirectory: options.syncDirectory,
      maxBytes: MAX_COMPACT_MODE_FILE_BYTES,
      defaultValue: DEFAULT_COMPACT_MODE_PREFERENCE,
      codec: {
        decode: parseStoredCompactModePreference,
        encode: (enabled): StoredCompactModePreference => ({ version: 1, enabled }),
      },
    });
  }
}
