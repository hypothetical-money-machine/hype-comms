import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DevicePreferences } from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DEVICE_PREFERENCES } from "../shared/device-preferences";
import {
  DevicePreferencesStore,
  MAX_DEVICE_PREFERENCES_FILE_BYTES,
} from "./device-preferences-store";

const directories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-device-preferences-"));
  directories.push(directory);
  return directory;
}

function preferenceDirectory(userDataPath: string): string {
  return path.join(userDataPath, "hype-comms-settings");
}

function preferenceFile(userDataPath: string): string {
  return path.join(preferenceDirectory(userDataPath), "device-preferences.json");
}

function preferences(overrides: Partial<DevicePreferences> = {}): DevicePreferences {
  return { ...DEFAULT_DEVICE_PREFERENCES, ...overrides };
}

async function writeStoredValue(userDataPath: string, value: string): Promise<void> {
  await mkdir(preferenceDirectory(userDataPath), { recursive: true });
  await writeFile(preferenceFile(userDataPath), value, "utf8");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DevicePreferencesStore", () => {
  it("defaults every preference when the file is missing", async () => {
    const store = new DevicePreferencesStore({ userDataPath: await scratchDirectory() });

    await expect(store.load()).resolves.toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  it("round-trips a complete versioned snapshot in a private file", async () => {
    const userDataPath = await scratchDirectory();
    const store = new DevicePreferencesStore({ userDataPath });
    const expected = preferences({
      sidebarWidth: "wide",
      messageTextSize: "large",
      timestampFormat: "24-hour",
      groupConsecutiveMessages: false,
      alwaysShowGroupedMessageTimes: true,
      showProfileTitles: false,
      sendMessageShortcut: "mod-enter",
      spellCheck: false,
      motionPreference: "reduced",
    });

    await store.save(expected);

    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual(expected);
    await expect(new DevicePreferencesStore({ userDataPath }).load()).resolves.toEqual(expected);
    if (process.platform !== "win32") {
      expect((await stat(preferenceDirectory(userDataPath))).mode & 0o777).toBe(0o700);
      expect((await stat(preferenceFile(userDataPath))).mode & 0o777).toBe(0o600);
    }
  });

  it("falls back for malformed, foreign-version, expanded, incomplete, and oversized data", async () => {
    const userDataPath = await scratchDirectory();
    const store = new DevicePreferencesStore({ userDataPath });
    const invalidValues = [
      "not json",
      JSON.stringify({ ...DEFAULT_DEVICE_PREFERENCES, version: 2 }),
      JSON.stringify({ ...DEFAULT_DEVICE_PREFERENCES, arbitraryCss: "body {}" }),
      JSON.stringify({ version: 1, sidebarWidth: "default" }),
      JSON.stringify({ ...DEFAULT_DEVICE_PREFERENCES, spellCheck: "true" }),
      "x".repeat(MAX_DEVICE_PREFERENCES_FILE_BYTES + 1),
    ];

    for (const value of invalidValues) {
      await writeStoredValue(userDataPath, value);
      await expect(store.load()).resolves.toEqual(DEFAULT_DEVICE_PREFERENCES);
    }
  });

  it("rejects an invalid snapshot before writing", async () => {
    const userDataPath = await scratchDirectory();
    const store = new DevicePreferencesStore({ userDataPath });

    expect(() =>
      store.save({
        ...DEFAULT_DEVICE_PREFERENCES,
        sidebarWidth: "floating",
      } as unknown as DevicePreferences),
    ).toThrow();
    await expect(readdir(preferenceDirectory(userDataPath))).rejects.toThrow();
  });

  it("serializes rapid saves so the last requested snapshot wins", async () => {
    const userDataPath = await scratchDirectory();
    const store = new DevicePreferencesStore({ userDataPath });

    await Promise.all([
      store.save(preferences({ sidebarWidth: "narrow" })),
      store.save(preferences({ sidebarWidth: "wide" })),
      store.save(preferences({ messageTextSize: "large" })),
    ]);

    await expect(store.load()).resolves.toEqual(preferences({ messageTextSize: "large" }));
    expect(await readdir(preferenceDirectory(userDataPath))).toEqual(["device-preferences.json"]);
  });

  it("continues saving after an earlier write fails", async () => {
    const userDataPath = await scratchDirectory();
    await writeFile(preferenceDirectory(userDataPath), "not a directory", "utf8");
    const store = new DevicePreferencesStore({ userDataPath });

    await expect(store.save(preferences({ spellCheck: false }))).rejects.toThrow();

    await rm(preferenceDirectory(userDataPath));
    await expect(store.save(preferences({ spellCheck: false }))).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(preferences({ spellCheck: false }));
  });

  it.skipIf(process.platform === "win32")(
    "keeps a renamed snapshot committed when directory syncing fails",
    async () => {
      const userDataPath = await scratchDirectory();
      const syncDirectory = vi.fn(() => Promise.reject(new Error("directory sync unavailable")));
      const store = new DevicePreferencesStore({ userDataPath, syncDirectory });

      await expect(
        store.save(preferences({ timestampFormat: "12-hour" })),
      ).resolves.toBeUndefined();

      expect(syncDirectory).toHaveBeenCalledWith(preferenceDirectory(userDataPath));
      await expect(store.load()).resolves.toEqual(preferences({ timestampFormat: "12-hour" }));
    },
  );
});
