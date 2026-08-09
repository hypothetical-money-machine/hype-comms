import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompactModePreferenceStore,
  MAX_COMPACT_MODE_FILE_BYTES,
} from "./compact-mode-preference-store";

const directories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-compact-mode-preference-"));
  directories.push(directory);
  return directory;
}

function preferenceDirectory(userDataPath: string): string {
  return path.join(userDataPath, "hmm-chat-settings");
}

function preferenceFile(userDataPath: string): string {
  return path.join(preferenceDirectory(userDataPath), "compact-mode.json");
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

describe("CompactModePreferenceStore", () => {
  it("defaults to disabled when the file is missing", async () => {
    const store = new CompactModePreferenceStore({ userDataPath: await scratchDirectory() });
    await expect(store.load()).resolves.toBe(false);
  });

  it("round-trips an enabled preference in a private file", async () => {
    const userDataPath = await scratchDirectory();
    const store = new CompactModePreferenceStore({ userDataPath });

    await store.save(true);

    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual({
      version: 1,
      enabled: true,
    });
    await expect(new CompactModePreferenceStore({ userDataPath }).load()).resolves.toBe(true);

    if (process.platform !== "win32") {
      expect((await stat(preferenceDirectory(userDataPath))).mode & 0o777).toBe(0o700);
      expect((await stat(preferenceFile(userDataPath))).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips a disabled preference", async () => {
    const userDataPath = await scratchDirectory();
    const store = new CompactModePreferenceStore({ userDataPath });

    await store.save(true);
    await store.save(false);

    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual({
      version: 1,
      enabled: false,
    });
    await expect(new CompactModePreferenceStore({ userDataPath }).load()).resolves.toBe(false);
  });

  it("does not collide with an existing theme preferences file", async () => {
    const userDataPath = await scratchDirectory();
    const themeFile = path.join(preferenceDirectory(userDataPath), "theme.json");
    const existingValue = JSON.stringify({ version: 1, preference: "dark" });
    await mkdir(preferenceDirectory(userDataPath), { recursive: true });
    await writeFile(themeFile, existingValue, "utf8");
    const store = new CompactModePreferenceStore({ userDataPath });

    await expect(store.save(true)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toBe(true);
    await expect(readFile(themeFile, "utf8")).resolves.toBe(existingValue);
    expect(await readdir(preferenceDirectory(userDataPath))).toEqual(
      expect.arrayContaining(["theme.json", "compact-mode.json"]),
    );
  });

  it("falls back safely for malformed, unversioned, non-strict, and oversized data", async () => {
    const userDataPath = await scratchDirectory();
    const store = new CompactModePreferenceStore({ userDataPath });
    const invalidValues = [
      "not json",
      JSON.stringify({ enabled: true }),
      JSON.stringify({ version: 2, enabled: true }),
      JSON.stringify({ version: 1, enabled: "true" }),
      JSON.stringify({ version: 1, enabled: 1 }),
      JSON.stringify({ version: 1, enabled: true, extra: true }),
      "x".repeat(MAX_COMPACT_MODE_FILE_BYTES + 1),
    ];

    for (const value of invalidValues) {
      await writeStoredValue(userDataPath, value);
      await expect(store.load()).resolves.toBe(false);
    }
  });

  it("serializes rapid saves so the last requested preference wins", async () => {
    const userDataPath = await scratchDirectory();
    const store = new CompactModePreferenceStore({ userDataPath });

    await Promise.all([store.save(true), store.save(false), store.save(true)]);

    await expect(store.load()).resolves.toBe(true);
    expect(await readdir(preferenceDirectory(userDataPath))).toEqual(["compact-mode.json"]);
  });

  it("continues saving after an earlier write fails", async () => {
    const userDataPath = await scratchDirectory();
    await writeFile(preferenceDirectory(userDataPath), "not a directory", "utf8");
    const store = new CompactModePreferenceStore({ userDataPath });

    await expect(store.save(true)).rejects.toThrow();

    await rm(preferenceDirectory(userDataPath));
    await expect(store.save(true)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a renamed preference committed when directory syncing fails",
    async () => {
      const userDataPath = await scratchDirectory();
      const syncDirectory = vi.fn(() => Promise.reject(new Error("directory sync unavailable")));
      const store = new CompactModePreferenceStore({ userDataPath, syncDirectory });

      await expect(store.save(true)).resolves.toBeUndefined();

      expect(syncDirectory).toHaveBeenCalledOnce();
      expect(syncDirectory).toHaveBeenCalledWith(preferenceDirectory(userDataPath));
      await expect(store.load()).resolves.toBe(true);
      expect(await readdir(preferenceDirectory(userDataPath))).toEqual(["compact-mode.json"]);
    },
  );
});
