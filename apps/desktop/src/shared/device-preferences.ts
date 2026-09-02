import {
  DEVICE_PREFERENCES_IPC_MAX_BYTES,
  devicePreferencesSchema,
  type DevicePreferences,
} from "@hype-comms/contracts";

const INITIAL_DEVICE_PREFERENCES_ARGUMENT_PREFIX = "--hype-comms-initial-device-preferences=";

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = Object.freeze({
  version: 1,
  sidebarWidth: "default",
  messageTextSize: "default",
  timestampFormat: "system",
  groupConsecutiveMessages: true,
  alwaysShowGroupedMessageTimes: false,
  showProfileTitles: true,
  sendMessageShortcut: "enter",
  spellCheck: true,
  motionPreference: "system",
});

const DEVICE_PREFERENCE_KEYS = Object.keys(
  devicePreferencesSchema.shape,
) as readonly (keyof DevicePreferences)[];

/**
 * Compares every field the contract declares, so a preference added to the schema is covered here
 * without a second edit. Both processes use this to skip redundant writes and re-renders.
 */
export function devicePreferencesEqual(left: DevicePreferences, right: DevicePreferences): boolean {
  return DEVICE_PREFERENCE_KEYS.every((key) => left[key] === right[key]);
}

/** Encodes the initialized, non-secret preferences for the sandboxed preload. */
export function createInitialDevicePreferencesArgument(preferences: DevicePreferences): string {
  const canonical = devicePreferencesSchema.parse(preferences);
  return `${INITIAL_DEVICE_PREFERENCES_ARGUMENT_PREFIX}${encodeURIComponent(JSON.stringify(canonical))}`;
}

/** Parses the last matching argument and rejects missing, malformed, oversized, or expanded data. */
export function parseInitialDevicePreferencesArgument(argv: readonly string[]): DevicePreferences {
  let argument: string | undefined;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const candidate = argv[index];
    if (candidate?.startsWith(INITIAL_DEVICE_PREFERENCES_ARGUMENT_PREFIX) === true) {
      argument = candidate;
      break;
    }
  }
  if (argument === undefined) {
    throw new Error("Initial device preferences argument is missing");
  }

  const encoded = argument.slice(INITIAL_DEVICE_PREFERENCES_ARGUMENT_PREFIX.length);
  if (encoded.length > DEVICE_PREFERENCES_IPC_MAX_BYTES * 3) {
    throw new Error("Initial device preferences argument is invalid");
  }

  try {
    const source = decodeURIComponent(encoded);
    if (new TextEncoder().encode(source).byteLength > DEVICE_PREFERENCES_IPC_MAX_BYTES) {
      throw new Error("Initial device preferences exceed their byte limit");
    }
    return devicePreferencesSchema.parse(JSON.parse(source) as unknown);
  } catch (error) {
    throw new Error("Initial device preferences argument is invalid", { cause: error });
  }
}

/** Keeps cosmetic startup data from disabling the preload bridge. */
export function resolveInitialDevicePreferencesArgument(
  argv: readonly string[],
): DevicePreferences {
  try {
    return parseInitialDevicePreferencesArgument(argv);
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}
