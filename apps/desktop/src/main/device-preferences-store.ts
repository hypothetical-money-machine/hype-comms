import path from "node:path";

import { devicePreferencesSchema, type DevicePreferences } from "@hype-comms/contracts";

import { DEFAULT_DEVICE_PREFERENCES } from "../shared/device-preferences";
import {
  atomicWrite,
  readBoundedUtf8File,
  syncDirectoryBestEffort,
  type SyncDirectory,
} from "./preference-file";

export const MAX_DEVICE_PREFERENCES_FILE_BYTES = 4_096;

async function readStoredDevicePreferences(filePath: string): Promise<DevicePreferences | null> {
  const source = await readBoundedUtf8File(filePath, MAX_DEVICE_PREFERENCES_FILE_BYTES);
  if (source === null) return null;
  try {
    const parsed = devicePreferencesSchema.safeParse(JSON.parse(source) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Versioned, bounded, atomic storage for non-secret device preferences. */
export class DevicePreferencesStore {
  readonly #filePath: string;
  readonly #syncDirectory: SyncDirectory;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly userDataPath: string; readonly syncDirectory?: SyncDirectory }) {
    this.#filePath = path.join(
      options.userDataPath,
      "hype-comms-settings",
      "device-preferences.json",
    );
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryBestEffort;
  }

  async load(): Promise<DevicePreferences> {
    return (await readStoredDevicePreferences(this.#filePath)) ?? DEFAULT_DEVICE_PREFERENCES;
  }

  save(preferences: DevicePreferences): Promise<void> {
    const canonical = devicePreferencesSchema.parse(preferences);
    const source = `${JSON.stringify(canonical)}\n`;
    const request = this.#saveTail.then(() =>
      atomicWrite(this.#filePath, source, this.#syncDirectory),
    );
    this.#saveTail = request.catch(() => undefined);
    return request;
  }
}
