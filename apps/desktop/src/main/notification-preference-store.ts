import path from "node:path";

import { notificationPreferenceSchema, type NotificationPreference } from "@hype-comms/contracts";

import {
  atomicWrite,
  readBoundedUtf8File,
  syncDirectoryBestEffort,
  type SyncDirectory,
} from "./preference-file";

export const MAX_NOTIFICATION_PREFERENCE_FILE_BYTES = 1_024;

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = Object.freeze({
  version: 1,
  devicePreference: "disabled",
  contentPreviewPreference: "disabled",
});

async function readStoredNotificationPreference(
  filePath: string,
): Promise<NotificationPreference | null> {
  const source = await readBoundedUtf8File(filePath, MAX_NOTIFICATION_PREFERENCE_FILE_BYTES);
  if (source === null) return null;
  try {
    const parsed = notificationPreferenceSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Versioned, bounded, atomic device-local notification preferences. */
export class NotificationPreferenceStore {
  readonly #filePath: string;
  readonly #syncDirectory: SyncDirectory;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly userDataPath: string; readonly syncDirectory?: SyncDirectory }) {
    this.#filePath = path.join(options.userDataPath, "hype-comms-settings", "notifications.json");
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryBestEffort;
  }

  async load(): Promise<NotificationPreference> {
    return (
      (await readStoredNotificationPreference(this.#filePath)) ?? DEFAULT_NOTIFICATION_PREFERENCE
    );
  }

  save(preference: NotificationPreference): Promise<void> {
    const parsed = notificationPreferenceSchema.parse(preference);
    const source = `${JSON.stringify(parsed)}\n`;
    const request = this.#saveTail.then(() =>
      atomicWrite(this.#filePath, source, this.#syncDirectory),
    );
    this.#saveTail = request.catch(() => undefined);
    return request;
  }
}
