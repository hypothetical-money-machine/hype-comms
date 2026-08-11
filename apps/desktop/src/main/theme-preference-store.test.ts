import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_THEME_PREFERENCE_FILE_BYTES, ThemePreferenceStore } from "./theme-preference-store";

const directories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-theme-preference-"));
  directories.push(directory);
  return directory;
}

function preferenceDirectory(userDataPath: string): string {
  return path.join(userDataPath, "hype-comms-settings");
}

function preferenceFile(userDataPath: string): string {
  return path.join(preferenceDirectory(userDataPath), "theme.json");
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

describe("ThemePreferenceStore", () => {
  it("uses an accent-free system design when the file is missing", async () => {
    const store = new ThemePreferenceStore({ userDataPath: await scratchDirectory() });
    await expect(store.load()).resolves.toEqual({ preference: "system", accentColor: null });
  });

  it("round-trips a versioned design in a private file", async () => {
    const userDataPath = await scratchDirectory();
    const store = new ThemePreferenceStore({ userDataPath });

    await store.save({ preference: "dark", accentColor: "#A15EFF" });

    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual({
      version: 2,
      preference: "dark",
      accentColor: "#a15eff",
    });
    await expect(new ThemePreferenceStore({ userDataPath }).load()).resolves.toEqual({
      preference: "dark",
      accentColor: "#a15eff",
    });

    if (process.platform !== "win32") {
      expect((await stat(preferenceDirectory(userDataPath))).mode & 0o777).toBe(0o700);
      expect((await stat(preferenceFile(userDataPath))).mode & 0o777).toBe(0o600);
    }
  });

  it("migrates a strict version-1 preference and writes version 2 on the next save", async () => {
    const userDataPath = await scratchDirectory();
    await writeStoredValue(userDataPath, JSON.stringify({ version: 1, preference: "light" }));
    const store = new ThemePreferenceStore({ userDataPath });

    await expect(store.load()).resolves.toEqual({ preference: "light", accentColor: null });
    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual({
      version: 1,
      preference: "light",
    });

    await store.save({ preference: "light", accentColor: "#2563eb" });
    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual({
      version: 2,
      preference: "light",
      accentColor: "#2563eb",
    });
  });

  it("does not collide with an existing application preferences file", async () => {
    const userDataPath = await scratchDirectory();
    const existingPreferences = path.join(userDataPath, "preferences");
    const existingValue = JSON.stringify({ spellcheck: { dictionaries: ["en-US"] } });
    await writeFile(existingPreferences, existingValue, "utf8");
    const store = new ThemePreferenceStore({ userDataPath });

    await expect(store.save({ preference: "dark", accentColor: null })).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual({ preference: "dark", accentColor: null });
    await expect(readFile(existingPreferences, "utf8")).resolves.toBe(existingValue);
  });

  it("falls back safely for malformed, unversioned, non-strict, and oversized data", async () => {
    const userDataPath = await scratchDirectory();
    const store = new ThemePreferenceStore({ userDataPath });
    const invalidValues = [
      "not json",
      JSON.stringify({ preference: "dark", accentColor: null }),
      JSON.stringify({ version: 2, preference: "dark" }),
      JSON.stringify({ version: 3, preference: "dark", accentColor: null }),
      JSON.stringify({ version: 1, preference: "midnight" }),
      JSON.stringify({ version: 1, preference: "dim" }),
      JSON.stringify({ version: 1, preference: "dark", extra: true }),
      JSON.stringify({ version: 2, preference: "dark", accentColor: "#fff" }),
      JSON.stringify({ version: 2, preference: "dark", accentColor: "url(file:///tmp/x)" }),
      JSON.stringify({ version: 2, preference: "dark", accentColor: null, extra: true }),
      "x".repeat(MAX_THEME_PREFERENCE_FILE_BYTES + 1),
    ];

    for (const value of invalidValues) {
      await writeStoredValue(userDataPath, value);
      await expect(store.load()).resolves.toEqual({ preference: "system", accentColor: null });
    }
  });

  it("serializes rapid saves so the last requested preference wins", async () => {
    const userDataPath = await scratchDirectory();
    const store = new ThemePreferenceStore({ userDataPath });

    await Promise.all([
      store.save({ preference: "dark", accentColor: "#be123c" }),
      store.save({ preference: "light", accentColor: "#2563eb" }),
      store.save({ preference: "system", accentColor: null }),
    ]);

    await expect(store.load()).resolves.toEqual({ preference: "system", accentColor: null });
    expect(await readdir(preferenceDirectory(userDataPath))).toEqual(["theme.json"]);
  });

  it("rejects syntactically valid theme IDs that are not in the bundled registry", async () => {
    const userDataPath = await scratchDirectory();
    const store = new ThemePreferenceStore({ userDataPath });

    await expect(store.save({ preference: "dim", accentColor: null })).rejects.toThrow(
      /Unknown built-in theme: dim/u,
    );
    await expect(store.load()).resolves.toEqual({ preference: "system", accentColor: null });
  });

  it("continues saving after an earlier write fails", async () => {
    const userDataPath = await scratchDirectory();
    await writeFile(preferenceDirectory(userDataPath), "not a directory", "utf8");
    const store = new ThemePreferenceStore({ userDataPath });

    await expect(store.save({ preference: "dark", accentColor: null })).rejects.toThrow();

    await rm(preferenceDirectory(userDataPath));
    await expect(
      store.save({ preference: "light", accentColor: "#2563eb" }),
    ).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual({
      preference: "light",
      accentColor: "#2563eb",
    });
  });

  it.skipIf(process.platform === "win32")(
    "keeps a renamed preference committed when directory syncing fails",
    async () => {
      const userDataPath = await scratchDirectory();
      const syncDirectory = vi.fn(() => Promise.reject(new Error("directory sync unavailable")));
      const store = new ThemePreferenceStore({ userDataPath, syncDirectory });

      await expect(
        store.save({ preference: "dark", accentColor: "#be123c" }),
      ).resolves.toBeUndefined();

      expect(syncDirectory).toHaveBeenCalledOnce();
      expect(syncDirectory).toHaveBeenCalledWith(preferenceDirectory(userDataPath));
      await expect(store.load()).resolves.toEqual({
        preference: "dark",
        accentColor: "#be123c",
      });
      expect(await readdir(preferenceDirectory(userDataPath))).toEqual(["theme.json"]);
    },
  );
});
