import path from "node:path";

import { JsonPreferenceFile, type PreferenceStoreOptions } from "./preference-file";

export const MAX_AI_CHANNEL_PREFERENCE_FILE_BYTES = 16_384;
const STORED_AI_CHANNEL_PREFERENCE_VERSION = 1;

export interface AiChannelPreference {
  readonly workspacePath: string | null;
  readonly sessionId: string | null;
}

const DEFAULT_AI_CHANNEL_PREFERENCE: AiChannelPreference = {
  workspacePath: null,
  sessionId: null,
};

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

/** A stored session is meaningful only together with the exact absolute workspace it belongs to. */
export function parseStoredAiChannelPreference(value: unknown): AiChannelPreference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.version !== STORED_AI_CHANNEL_PREFERENCE_VERSION
  ) {
    return null;
  }

  if (candidate.workspacePath === null && candidate.sessionId === null) {
    return DEFAULT_AI_CHANNEL_PREFERENCE;
  }
  if (
    !isBoundedString(candidate.workspacePath, 4_096) ||
    !path.isAbsolute(candidate.workspacePath) ||
    candidate.workspacePath.includes("\0") ||
    (candidate.sessionId !== null && !isBoundedString(candidate.sessionId, 256))
  ) {
    return null;
  }

  return {
    workspacePath: candidate.workspacePath,
    sessionId: candidate.sessionId,
  };
}

export class AiChannelPreferenceStore extends JsonPreferenceFile<AiChannelPreference> {
  constructor(options: PreferenceStoreOptions) {
    super({
      filePath: path.join(options.userDataPath, "hype-comms-settings", "ai-channel.json"),
      syncDirectory: options.syncDirectory,
      maxBytes: MAX_AI_CHANNEL_PREFERENCE_FILE_BYTES,
      defaultValue: DEFAULT_AI_CHANNEL_PREFERENCE,
      codec: {
        decode: parseStoredAiChannelPreference,
        encode: (preference) => ({
          version: STORED_AI_CHANNEL_PREFERENCE_VERSION,
          workspacePath: preference.workspacePath,
          sessionId: preference.sessionId,
        }),
      },
    });
  }
}
