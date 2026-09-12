import path from "node:path";

import { notificationPreferenceSchema, type NotificationPreference } from "@hype-comms/contracts";

import { JsonPreferenceFile, type PreferenceStoreOptions } from "./preference-file";

export const MAX_NOTIFICATION_PREFERENCE_FILE_BYTES = 1_024;

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = Object.freeze({
  version: 1,
  devicePreference: "disabled",
  contentPreviewPreference: "disabled",
});

export class NotificationPreferenceStore extends JsonPreferenceFile<NotificationPreference> {
  constructor(options: PreferenceStoreOptions) {
    super({
      filePath: path.join(options.userDataPath, "hype-comms-settings", "notifications.json"),
      syncDirectory: options.syncDirectory,
      maxBytes: MAX_NOTIFICATION_PREFERENCE_FILE_BYTES,
      defaultValue: DEFAULT_NOTIFICATION_PREFERENCE,
      codec: {
        decode: (value) => {
          const parsed = notificationPreferenceSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
        encode: (value) => notificationPreferenceSchema.parse(value),
      },
    });
  }
}
