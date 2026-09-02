import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  DEVICE_PREFERENCES_IPC_MAX_BYTES,
  DEVICE_PREFERENCES_PATCH_IPC_MAX_BYTES,
  devicePreferencesPatchSchema,
  devicePreferencesSchema,
} from "../src/index.js";

const PREFERENCES = {
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
} as const;

describe("device preference contracts", () => {
  it("accepts the complete strict version-1 state", () => {
    expect(devicePreferencesSchema.parse(PREFERENCES)).toEqual(PREFERENCES);
    expect(
      devicePreferencesSchema.parse({
        ...PREFERENCES,
        sidebarWidth: "wide",
        messageTextSize: "large",
        timestampFormat: "24-hour",
        groupConsecutiveMessages: false,
        alwaysShowGroupedMessageTimes: true,
        showProfileTitles: false,
        sendMessageShortcut: "mod-enter",
        spellCheck: false,
        motionPreference: "reduced",
      }),
    ).toMatchObject({
      sidebarWidth: "wide",
      messageTextSize: "large",
      timestampFormat: "24-hour",
      sendMessageShortcut: "mod-enter",
      motionPreference: "reduced",
    });
  });

  it.each([
    {},
    { ...PREFERENCES, version: 2 },
    { ...PREFERENCES, sidebarWidth: "floating" },
    { ...PREFERENCES, messageTextSize: 16 },
    { ...PREFERENCES, timestampFormat: "utc" },
    { ...PREFERENCES, groupConsecutiveMessages: "true" },
    { ...PREFERENCES, sendMessageShortcut: "shift-enter" },
    { ...PREFERENCES, motionPreference: "animated" },
    { ...PREFERENCES, css: "body { display: none; }" },
  ])("rejects invalid or expanded state %#", (value) => {
    expect(devicePreferencesSchema.safeParse(value).success).toBe(false);
  });

  it("accepts strict non-empty partial updates", () => {
    expect(devicePreferencesPatchSchema.parse({ sidebarWidth: "narrow" })).toEqual({
      sidebarWidth: "narrow",
    });
    expect(
      devicePreferencesPatchSchema.parse({
        groupConsecutiveMessages: false,
        spellCheck: false,
      }),
    ).toEqual({ groupConsecutiveMessages: false, spellCheck: false });
  });

  it.each([
    {},
    { version: 1 },
    { sidebarWidth: "floating" },
    { spellCheck: 1 },
    { messageTextSize: "large", arbitraryCss: "* {}" },
  ])("rejects empty, invalid, versioned, or expanded patches %#", (value) => {
    expect(devicePreferencesPatchSchema.safeParse(value).success).toBe(false);
  });

  it("keeps canonical state and patches well below their IPC limits", () => {
    expect(Buffer.byteLength(JSON.stringify(PREFERENCES), "utf8")).toBeLessThan(
      DEVICE_PREFERENCES_IPC_MAX_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          sidebarWidth: "wide",
          messageTextSize: "large",
          timestampFormat: "24-hour",
          groupConsecutiveMessages: false,
          alwaysShowGroupedMessageTimes: true,
          showProfileTitles: false,
          sendMessageShortcut: "mod-enter",
          spellCheck: false,
          motionPreference: "reduced",
        }),
        "utf8",
      ),
    ).toBeLessThan(DEVICE_PREFERENCES_PATCH_IPC_MAX_BYTES);
  });
});
