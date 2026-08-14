import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AiChannelPreferenceStore,
  MAX_AI_CHANNEL_PREFERENCE_FILE_BYTES,
  parseStoredAiChannelPreference,
} from "./ai-channel-preference-store";

const directories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-ai-channel-preference-"));
  directories.push(directory);
  return directory;
}

function preferenceFile(userDataPath: string): string {
  return path.join(userDataPath, "hype-comms-settings", "ai-channel.json");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("AiChannelPreferenceStore", () => {
  it("defaults to an unconfigured channel", async () => {
    const store = new AiChannelPreferenceStore({ userDataPath: await scratchDirectory() });
    await expect(store.load()).resolves.toEqual({ workspacePath: null, sessionId: null });
  });

  it("round-trips one workspace-bound session in a private file", async () => {
    const userDataPath = await scratchDirectory();
    const store = new AiChannelPreferenceStore({ userDataPath });
    await store.save({ workspacePath: "/work/hype-comms", sessionId: "session-1" });

    await expect(new AiChannelPreferenceStore({ userDataPath }).load()).resolves.toEqual({
      workspacePath: "/work/hype-comms",
      sessionId: "session-1",
    });
    expect(JSON.parse(await readFile(preferenceFile(userDataPath), "utf8"))).toEqual({
      version: 1,
      workspacePath: "/work/hype-comms",
      sessionId: "session-1",
    });
    if (process.platform !== "win32") {
      expect((await stat(preferenceFile(userDataPath))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects relative, partial, foreign, and oversized stored preferences", async () => {
    expect(
      parseStoredAiChannelPreference({ version: 1, workspacePath: "relative", sessionId: null }),
    ).toBeNull();
    expect(
      parseStoredAiChannelPreference({ version: 1, workspacePath: null, sessionId: "orphan" }),
    ).toBeNull();
    expect(
      parseStoredAiChannelPreference({ version: 2, workspacePath: null, sessionId: null }),
    ).toBeNull();

    const userDataPath = await scratchDirectory();
    const filePath = preferenceFile(userDataPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "x".repeat(MAX_AI_CHANNEL_PREFERENCE_FILE_BYTES + 1), "utf8");
    await expect(new AiChannelPreferenceStore({ userDataPath }).load()).resolves.toEqual({
      workspacePath: null,
      sessionId: null,
    });
  });

  it("serializes saves so the newest session wins", async () => {
    const userDataPath = await scratchDirectory();
    const store = new AiChannelPreferenceStore({ userDataPath });
    await Promise.all([
      store.save({ workspacePath: "/work/one", sessionId: "one" }),
      store.save({ workspacePath: "/work/two", sessionId: "two" }),
    ]);
    await expect(store.load()).resolves.toEqual({ workspacePath: "/work/two", sessionId: "two" });
  });
});
