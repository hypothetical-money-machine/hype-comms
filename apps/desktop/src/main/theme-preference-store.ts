import path from "node:path";

import { themeDesignSchema, themePreferenceSchema, type ThemeDesign } from "@hype-comms/contracts";

import { isBuiltInThemeId } from "../shared/theme";
import { JsonPreferenceFile, type PreferenceStoreOptions } from "./preference-file";

export const MAX_THEME_PREFERENCE_FILE_BYTES = 4_096;
const STORED_THEME_DESIGN_VERSION = 2;
const DEFAULT_THEME_DESIGN: ThemeDesign = Object.freeze({
  preference: "system",
  accentColor: null,
});

interface StoredThemeDesign {
  readonly version: typeof STORED_THEME_DESIGN_VERSION;
  readonly preference: ThemeDesign["preference"];
  readonly accentColor: ThemeDesign["accentColor"];
}

function supportedDesign(value: unknown): ThemeDesign | null {
  const design = themeDesignSchema.safeParse(value);
  return design.success &&
    (design.data.preference === "system" || isBuiltInThemeId(design.data.preference))
    ? Object.freeze(design.data)
    : null;
}

function parseStoredThemeDesign(value: unknown): ThemeDesign | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);

  // Version 1 persisted only the built-in preference. Reading it as an accent-free design is the
  // migration; the next successful save writes the strict version-2 shape atomically.
  if (
    candidate.version === 1 &&
    keys.length === 2 &&
    Object.hasOwn(candidate, "version") &&
    Object.hasOwn(candidate, "preference")
  ) {
    const preference = themePreferenceSchema.safeParse(candidate.preference);
    return preference.success
      ? supportedDesign({ preference: preference.data, accentColor: null })
      : null;
  }

  if (
    candidate.version !== STORED_THEME_DESIGN_VERSION ||
    keys.length !== 3 ||
    !Object.hasOwn(candidate, "version") ||
    !Object.hasOwn(candidate, "preference") ||
    !Object.hasOwn(candidate, "accentColor")
  ) {
    return null;
  }

  return supportedDesign({
    preference: candidate.preference,
    accentColor: candidate.accentColor,
  });
}

export class ThemePreferenceStore extends JsonPreferenceFile<ThemeDesign> {
  constructor(options: PreferenceStoreOptions) {
    super({
      filePath: path.join(options.userDataPath, "hype-comms-settings", "theme.json"),
      syncDirectory: options.syncDirectory,
      maxBytes: MAX_THEME_PREFERENCE_FILE_BYTES,
      defaultValue: DEFAULT_THEME_DESIGN,
      codec: {
        decode: parseStoredThemeDesign,
        encode: (design): StoredThemeDesign => ({
          version: STORED_THEME_DESIGN_VERSION,
          ...design,
        }),
      },
    });
  }

  override save(design: ThemeDesign): Promise<void> {
    const parsed = themeDesignSchema.parse(design);
    if (parsed.preference !== "system" && !isBuiltInThemeId(parsed.preference)) {
      return Promise.reject(new Error(`Unknown built-in theme: ${parsed.preference}`));
    }
    return super.save(parsed);
  }
}
