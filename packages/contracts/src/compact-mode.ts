import { z } from "zod";

/**
 * Whether the desktop client hides the workspace rail and sidebar until the user reveals them.
 * The preference is a plain boolean so it can cross IPC and persist without migration concerns.
 */
export const compactModePreferenceSchema = z.boolean();

export type CompactModePreference = z.infer<typeof compactModePreferenceSchema>;
