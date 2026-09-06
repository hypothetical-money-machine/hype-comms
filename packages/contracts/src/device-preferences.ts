import { z } from "zod";

/** Raw JSON byte caps enforced before semantic validation at the desktop IPC boundary. */
export const DEVICE_PREFERENCES_IPC_MAX_BYTES = 2_048;
export const DEVICE_PREFERENCES_PATCH_IPC_MAX_BYTES = 2_048;

export const sidebarWidthPreferenceSchema = z.enum(["narrow", "default", "wide"]);
export const messageTextSizePreferenceSchema = z.enum(["small", "default", "large"]);
export const timestampFormatPreferenceSchema = z.enum(["system", "12-hour", "24-hour"]);
export const sendMessageShortcutPreferenceSchema = z.enum(["enter", "mod-enter"]);
export const motionPreferenceSchema = z.enum(["system", "reduced"]);

const devicePreferenceFields = {
  sidebarWidth: sidebarWidthPreferenceSchema,
  messageTextSize: messageTextSizePreferenceSchema,
  timestampFormat: timestampFormatPreferenceSchema,
  groupConsecutiveMessages: z.boolean(),
  alwaysShowGroupedMessageTimes: z.boolean(),
  showProfileTitles: z.boolean(),
  sendMessageShortcut: sendMessageShortcutPreferenceSchema,
  spellCheck: z.boolean(),
  motionPreference: motionPreferenceSchema,
} as const;

/** Complete versioned state for non-secret, device-local presentation and input preferences. */
export const devicePreferencesSchema = z
  .object({
    version: z.literal(1),
    ...devicePreferenceFields,
  })
  .strict();

/**
 * One or more preference changes. Main merges this patch with its latest committed state so two
 * independent controls cannot overwrite one another with stale full snapshots.
 */
export const devicePreferencesPatchSchema = z
  .object(devicePreferenceFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "A device-preference patch must contain at least one preference",
  });

export type SidebarWidthPreference = z.infer<typeof sidebarWidthPreferenceSchema>;
export type MessageTextSizePreference = z.infer<typeof messageTextSizePreferenceSchema>;
export type TimestampFormatPreference = z.infer<typeof timestampFormatPreferenceSchema>;
export type SendMessageShortcutPreference = z.infer<typeof sendMessageShortcutPreferenceSchema>;
export type MotionPreference = z.infer<typeof motionPreferenceSchema>;
export type DevicePreferences = z.infer<typeof devicePreferencesSchema>;
export type DevicePreferencesPatch = z.infer<typeof devicePreferencesPatchSchema>;
