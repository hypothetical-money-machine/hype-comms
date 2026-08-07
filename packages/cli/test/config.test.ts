import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadProfileStore,
  normalizeApiOrigin,
  resolveProfile,
  saveProfile,
  updateProfileStore,
} from "../src/config.js";
import type { Runtime } from "../src/types.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "hmm-chat-cli-test-"));
  directories.push(value);
  return value;
}

function runtime(
  homeDirectory: string,
  env: NodeJS.ProcessEnv = {},
): Pick<Runtime, "env" | "homeDirectory" | "now"> {
  return { env, homeDirectory, now: Date.now };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("API origin validation", () => {
  it("allows HTTPS and loopback HTTP", () => {
    expect(normalizeApiOrigin("https://chat.example.test/")).toBe("https://chat.example.test");
    expect(normalizeApiOrigin("http://127.0.0.42:3000")).toBe("http://127.0.0.42:3000");
    expect(normalizeApiOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it.each([
    "http://chat.example.test",
    "https://user:secret@chat.example.test",
    "https://chat.example.test/v1",
    "ftp://chat.example.test",
  ])("rejects unsafe origin %s", (value) => {
    expect(() => normalizeApiOrigin(value)).toThrow();
  });
});

describe("profile storage", () => {
  it("stores profiles atomically with private permissions", async () => {
    const home = await directory();
    const configDir = join(home, "config");
    const value = runtime(home, { HMM_CHAT_CONFIG_DIR: configDir });
    await saveProfile(value, "work", {
      apiOrigin: "https://chat.example.test",
      credential: { kind: "human", sessionToken: "a".repeat(43) },
    });

    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(configDir, "profiles.json"))).mode & 0o777).toBe(0o600);
    expect(await loadProfileStore(configDir)).toMatchObject({
      profiles: {
        work: {
          apiOrigin: "https://chat.example.test",
          credential: { kind: "human" },
        },
      },
    });
  });

  it("keeps a stored credential when only the origin is re-asserted", async () => {
    const home = await directory();
    const configDir = join(home, "config");
    const value = runtime(home, { HMM_CHAT_CONFIG_DIR: configDir });
    await saveProfile(value, "work", {
      apiOrigin: "https://chat.example.test",
      credential: { kind: "human", sessionToken: "a".repeat(43) },
    });

    const saved = await saveProfile(value, "work", { apiOrigin: "https://chat.example.test/" });

    expect(saved.credential).toEqual({ kind: "human", sessionToken: "a".repeat(43) });
    expect(await loadProfileStore(configDir)).toMatchObject({
      profiles: { work: { credential: { kind: "human" } } },
    });
  });

  it("drops a stored credential when the profile moves to another origin", async () => {
    const home = await directory();
    const configDir = join(home, "config");
    const value = runtime(home, { HMM_CHAT_CONFIG_DIR: configDir });
    await saveProfile(value, "work", {
      apiOrigin: "https://chat.example.test",
      credential: { kind: "agent", token: `hmm_agent_${"b".repeat(43)}` },
    });

    const saved = await saveProfile(value, "work", { apiOrigin: "https://other.example.test" });

    // The credential was issued for the previous origin, so carrying it over would send it
    // somewhere it was never valid for.
    expect(saved.credential).toBeUndefined();
    expect((await loadProfileStore(configDir)).profiles.work?.credential).toBeUndefined();
  });

  it("applies environment overrides without persisting the environment token", async () => {
    const home = await directory();
    const configDir = join(home, "config");
    await saveProfile(runtime(home, { HMM_CHAT_CONFIG_DIR: configDir }), "work", {
      apiOrigin: "https://stored.example.test",
      credential: { kind: "human", sessionToken: "a".repeat(43) },
    });
    const agentToken = `hmm_agent_${"b".repeat(43)}`;
    const resolved = await resolveProfile(
      {
        env: {
          HMM_CHAT_CONFIG_DIR: configDir,
          HMM_CHAT_PROFILE: "work",
          HMM_CHAT_API_ORIGIN: "https://environment.example.test",
          HMM_CHAT_TOKEN: agentToken,
        },
        homeDirectory: home,
      },
      {},
    );

    expect(resolved).toMatchObject({
      name: "work",
      apiOrigin: "https://environment.example.test",
      credential: { kind: "agent", token: agentToken },
      credentialOrigin: "https://environment.example.test",
      credentialFromEnvironment: true,
    });
    expect((await loadProfileStore(configDir)).profiles.work?.credential?.kind).toBe("human");
  });

  it("keeps a saved credential bound to its stored origin when only the origin is overridden", async () => {
    const home = await directory();
    const configDir = join(home, "config");
    await saveProfile(runtime(home, { HMM_CHAT_CONFIG_DIR: configDir }), "work", {
      apiOrigin: "https://stored.example.test",
      credential: { kind: "agent", token: `hmm_agent_${"c".repeat(43)}` },
    });

    const resolved = await resolveProfile(
      {
        env: {
          HMM_CHAT_CONFIG_DIR: configDir,
          HMM_CHAT_PROFILE: "work",
          HMM_CHAT_API_ORIGIN: "https://override.example.test",
        },
        homeDirectory: home,
      },
      {},
    );

    expect(resolved).toMatchObject({
      apiOrigin: "https://override.example.test",
      credentialOrigin: "https://stored.example.test",
      credentialFromEnvironment: false,
    });
  });

  it("serializes concurrent profile mutations without losing updates", async () => {
    const home = await directory();
    const configDir = join(home, "config");
    const value = runtime(home, { HMM_CHAT_CONFIG_DIR: configDir });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        updateProfileStore(value, (store) => {
          store.profiles[`profile-${index}`] = {
            apiOrigin: `https://chat-${index}.example.test`,
          };
        }),
      ),
    );
    expect(Object.keys((await loadProfileStore(configDir)).profiles)).toHaveLength(8);
  });
});
