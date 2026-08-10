import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  MAX_NOTIFICATION_PREFERENCE_FILE_BYTES,
  NotificationPreferenceStore,
} from "./notification-preference-store";

const directories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-notification-preference-"));
  directories.push(directory);
  return directory;
}

function settingsDirectory(userDataPath: string): string {
  return path.join(userDataPath, "hmm-chat-settings");
}

function preferenceFile(userDataPath: string): string {
  return path.join(settingsDirectory(userDataPath), "notifications.json");
}

async function writeStoredValue(userDataPath: string, value: string): Promise<void> {
  await mkdir(settingsDirectory(userDataPath), { recursive: true });
  await writeFile(preferenceFile(userDataPath), value, "utf8");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NotificationPreferenceStore", () => {
  it("defaults to disabled with message previews off", async () => {
    const store = new NotificationPreferenceStore({ userDataPath: await scratchDirectory() });

    await expect(store.load()).resolves.toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
  });

  it("round-trips a strict preference through a private file", async () => {
    const userDataPath = await scratchDirectory();
    const store = new NotificationPreferenceStore({ userDataPath });
    const preference = {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
    } as const;

    await store.save(preference);

    await expect(new NotificationPreferenceStore({ userDataPath }).load()).resolves.toEqual(
      preference,
    );
    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual(preference);
    if (process.platform !== "win32") {
      expect((await stat(settingsDirectory(userDataPath))).mode & 0o777).toBe(0o700);
      expect((await stat(preferenceFile(userDataPath))).mode & 0o777).toBe(0o600);
    }
  });

  it("falls back for corrupt, unknown-version, non-strict, and oversized files", async () => {
    const userDataPath = await scratchDirectory();
    const store = new NotificationPreferenceStore({ userDataPath });
    const invalidValues = [
      "not json",
      JSON.stringify({
        version: 2,
        devicePreference: "enabled",
        contentPreviewPreference: "disabled",
      }),
      JSON.stringify({
        version: 1,
        devicePreference: "enabled",
        contentPreviewPreference: "disabled",
        body: "private canary",
      }),
      JSON.stringify({
        version: 1,
        devicePreference: "prompt",
        contentPreviewPreference: "disabled",
      }),
      "x".repeat(MAX_NOTIFICATION_PREFERENCE_FILE_BYTES + 1),
    ];

    for (const value of invalidValues) {
      await writeStoredValue(userDataPath, value);
      await expect(store.load()).resolves.toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
    }
  });

  it("serializes concurrent writes so the final request wins", async () => {
    const userDataPath = await scratchDirectory();
    const store = new NotificationPreferenceStore({ userDataPath });
    const enabled = {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
    } as const;
    const preview = {
      ...enabled,
      contentPreviewPreference: "enabled",
    } as const;

    await Promise.all([store.save(enabled), store.save(preview), store.save(enabled)]);

    await expect(store.load()).resolves.toEqual(enabled);
    expect(await readdir(settingsDirectory(userDataPath))).toEqual(["notifications.json"]);
  });

  it("keeps development profiles isolated by their user-data roots", async () => {
    const firstPath = await scratchDirectory();
    const secondPath = await scratchDirectory();
    const first = new NotificationPreferenceStore({ userDataPath: firstPath });
    const second = new NotificationPreferenceStore({ userDataPath: secondPath });

    await first.save({
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
    });

    await expect(first.load()).resolves.toMatchObject({ devicePreference: "enabled" });
    await expect(second.load()).resolves.toEqual(DEFAULT_NOTIFICATION_PREFERENCE);
  });

  it("continues after a failed write and tolerates directory sync failure", async () => {
    const userDataPath = await scratchDirectory();
    await writeFile(settingsDirectory(userDataPath), "not a directory", "utf8");
    const syncDirectory = vi.fn(() => Promise.reject(new Error("sync unavailable")));
    const store = new NotificationPreferenceStore({ userDataPath, syncDirectory });
    const preference = {
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "disabled",
    } as const;

    await expect(store.save(preference)).rejects.toThrow();
    await rm(settingsDirectory(userDataPath));
    await expect(store.save(preference)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(preference);
    if (process.platform !== "win32") expect(syncDirectory).toHaveBeenCalledOnce();
  });
});
