import path from "node:path";

import { devicePreferencesSchema, type DevicePreferences } from "@hype-comms/contracts";

import { DEFAULT_DEVICE_PREFERENCES } from "../shared/device-preferences";
import { JsonPreferenceFile, type PreferenceStoreOptions } from "./preference-file";

export const MAX_DEVICE_PREFERENCES_FILE_BYTES = 4_096;

export class DevicePreferencesStore extends JsonPreferenceFile<DevicePreferences> {
  constructor(options: PreferenceStoreOptions) {
    super({
      filePath: path.join(options.userDataPath, "hype-comms-settings", "device-preferences.json"),
      syncDirectory: options.syncDirectory,
      maxBytes: MAX_DEVICE_PREFERENCES_FILE_BYTES,
      defaultValue: DEFAULT_DEVICE_PREFERENCES,
      codec: {
        decode: (value) => {
          const parsed = devicePreferencesSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
        encode: (value) => devicePreferencesSchema.parse(value),
      },
    });
  }
}
