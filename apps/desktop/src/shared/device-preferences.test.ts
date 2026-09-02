import { describe, expect, it } from "vitest";

import {
  createInitialDevicePreferencesArgument,
  DEFAULT_DEVICE_PREFERENCES,
  parseInitialDevicePreferencesArgument,
  resolveInitialDevicePreferencesArgument,
} from "./device-preferences";

const CUSTOM_PREFERENCES = {
  ...DEFAULT_DEVICE_PREFERENCES,
  sidebarWidth: "wide",
  messageTextSize: "large",
  timestampFormat: "24-hour",
  groupConsecutiveMessages: false,
  alwaysShowGroupedMessageTimes: true,
  showProfileTitles: false,
  sendMessageShortcut: "mod-enter",
  spellCheck: false,
  motionPreference: "reduced",
} as const;

describe("device preferences startup argument", () => {
  it("round-trips a complete validated snapshot", () => {
    const argument = createInitialDevicePreferencesArgument(CUSTOM_PREFERENCES);

    expect(parseInitialDevicePreferencesArgument([argument])).toEqual(CUSTOM_PREFERENCES);
    expect(resolveInitialDevicePreferencesArgument([argument])).toEqual(CUSTOM_PREFERENCES);
  });

  it("falls back to the frozen defaults when the argument is missing or invalid", () => {
    expect(resolveInitialDevicePreferencesArgument([])).toBe(DEFAULT_DEVICE_PREFERENCES);
    expect(
      resolveInitialDevicePreferencesArgument([
        "--hype-comms-initial-device-preferences=%7B%22version%22%3A1%7D",
      ]),
    ).toBe(DEFAULT_DEVICE_PREFERENCES);
    expect(Object.isFrozen(DEFAULT_DEVICE_PREFERENCES)).toBe(true);
  });

  it("rejects unknown fields and oversized encoded input", () => {
    const expanded = `--hype-comms-initial-device-preferences=${encodeURIComponent(
      JSON.stringify({ ...DEFAULT_DEVICE_PREFERENCES, css: "body {}" }),
    )}`;
    const oversized = `--hype-comms-initial-device-preferences=${"x".repeat(10_000)}`;

    expect(() => parseInitialDevicePreferencesArgument([expanded])).toThrow(/invalid/u);
    expect(() => parseInitialDevicePreferencesArgument([oversized])).toThrow(/invalid/u);
  });

  it("uses the last matching argument and ignores unrelated arguments", () => {
    const defaults = createInitialDevicePreferencesArgument(DEFAULT_DEVICE_PREFERENCES);
    const custom = createInitialDevicePreferencesArgument(CUSTOM_PREFERENCES);

    expect(parseInitialDevicePreferencesArgument([defaults, "--renderer-process", custom])).toEqual(
      CUSTOM_PREFERENCES,
    );
  });
});
