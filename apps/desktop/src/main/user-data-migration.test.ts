import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { migrateLegacyUserData } from "./user-data-migration";
import { createTemporaryDirectory } from "./test-support/temporary-directory";

async function scratchDirectory(): Promise<string> {
  return createTemporaryDirectory("hmm-user-data-migration-");
}

describe("migrateLegacyUserData", () => {
  it("moves the legacy profile into the canonical path", async () => {
    const root = await scratchDirectory();
    const legacyPath = path.join(root, "HMM Chat");
    const currentPath = path.join(root, "Hype Comms");
    await mkdir(legacyPath);
    await writeFile(path.join(legacyPath, "Cookies"), "session");

    expect(migrateLegacyUserData({ currentPath, legacyPath })).toBe("migrated");
    await expect(readdir(currentPath)).resolves.toEqual(["Cookies"]);
    await expect(readdir(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does nothing when there is no legacy profile", async () => {
    const root = await scratchDirectory();
    const legacyPath = path.join(root, "HMM Chat");
    const currentPath = path.join(root, "Hype Comms");

    expect(migrateLegacyUserData({ currentPath, legacyPath })).toBe("not-needed");
    await expect(readdir(currentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces an empty new profile without losing legacy data", async () => {
    const root = await scratchDirectory();
    const legacyPath = path.join(root, "HMM Chat");
    const currentPath = path.join(root, "Hype Comms");
    await mkdir(legacyPath);
    await mkdir(currentPath);
    await writeFile(path.join(legacyPath, "Cookies"), "session");

    expect(migrateLegacyUserData({ currentPath, legacyPath })).toBe("migrated");
    await expect(readdir(currentPath)).resolves.toEqual(["Cookies"]);
  });

  it("refuses to overwrite a populated new profile", async () => {
    const root = await scratchDirectory();
    const legacyPath = path.join(root, "HMM Chat");
    const currentPath = path.join(root, "Hype Comms");
    await mkdir(legacyPath);
    await mkdir(currentPath);
    await writeFile(path.join(legacyPath, "old"), "legacy");
    await writeFile(path.join(currentPath, "new"), "current");

    expect(() => migrateLegacyUserData({ currentPath, legacyPath })).toThrow(
      /both user-data directories contain data/u,
    );
    await expect(readdir(legacyPath)).resolves.toEqual(["old"]);
    await expect(readdir(currentPath)).resolves.toEqual(["new"]);
  });

  it("refuses a non-directory collision", async () => {
    const root = await scratchDirectory();
    const legacyPath = path.join(root, "HMM Chat");
    const currentPath = path.join(root, "Hype Comms");
    await mkdir(legacyPath);
    await writeFile(currentPath, "not a directory");

    expect(() => migrateLegacyUserData({ currentPath, legacyPath })).toThrow(
      /Expected user-data path to be a directory/u,
    );
  });
});
