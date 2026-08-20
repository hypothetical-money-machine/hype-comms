import { z } from "zod";

/**
 * Whether the desktop client uses compact density: tighter message, sidebar, and chrome
 * spacing, with the workspace rail and sidebar hidden until the user reveals them.
 * The preference is a plain boolean so it can cross IPC and persist without migration concerns.
 */
export const compactModePreferenceSchema = z.boolean();

export type CompactModePreference = z.infer<typeof compactModePreferenceSchema>;
