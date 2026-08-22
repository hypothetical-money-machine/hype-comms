import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AuthenticatedSessionContext } from "@hype-comms/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthenticatedSessionContextStore,
  type SessionContextSafeStorage,
} from "./authenticated-session-context-store";

const API_ORIGIN = "https://chat.example";
const CREDENTIAL = "first-exact-protected-credential";
const session: AuthenticatedSessionContext = {
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
};
const directories: string[] = [];

class FakeSafeStorage implements SessionContextSafeStorage {
  constructor(
    private readonly available = true,
    private readonly backend = "kwallet6",
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(Buffer.from(value, "utf8").toString("base64url"), "utf8");
  }

  decryptString(value: Buffer): string {
    return Buffer.from(value.toString("utf8"), "base64url").toString("utf8");
  }

  getSelectedStorageBackend(): string {
    return this.backend;
  }
}

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-session-context-"));
  directories.push(directory);
  return directory;
}

function storeIn(
  userDataPath: string,
  safeStorage: SessionContextSafeStorage = new FakeSafeStorage(),
  apiOrigin = API_ORIGIN,
): AuthenticatedSessionContextStore {
  return new AuthenticatedSessionContextStore({
    apiOrigin,
    platform: "linux",
    safeStorage,
    userDataPath,
  });
}

async function onlyRecordPath(userDataPath: string): Promise<string> {
  const directory = path.join(userDataPath, "auth");
  const names = (await readdir(directory)).filter((name) =>
    name.startsWith("authenticated-session-"),
  );
  expect(names).toHaveLength(1);
  const name = names[0];
  if (name === undefined) throw new Error("Expected a protected session context record");
  return path.join(directory, name);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AuthenticatedSessionContextStore", () => {
  it("protects a salted credential-and-origin-bound identity record", async () => {
    const directory = await scratchDirectory();
    const store = storeIn(directory);

    await store.replace({ credential: CREDENTIAL, session });

    await expect(store.load(CREDENTIAL)).resolves.toEqual(session);
    const filePath = await onlyRecordPath(directory);
    const bytes = await readFile(filePath);
    expect(bytes.toString("utf8")).not.toContain(CREDENTIAL);
    expect(bytes.toString("utf8")).not.toContain(session.email);
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed when the protected credential is missing", async () => {
    const directory = await scratchDirectory();
    const store = storeIn(directory);
    await store.replace({ credential: CREDENTIAL, session });

    await expect(store.load("")).resolves.toBeNull();
  });

  it("fails closed when the protected credential is replaced", async () => {
    const directory = await scratchDirectory();
    const store = storeIn(directory);
    await store.replace({ credential: CREDENTIAL, session });

    await expect(store.load("replacement-protected-credential")).resolves.toBeNull();
    await expect(store.load(CREDENTIAL)).resolves.toBeNull();
  });

  it("fails closed for a different API origin", async () => {
    const directory = await scratchDirectory();
    await storeIn(directory).replace({ credential: CREDENTIAL, session });

    await expect(
      storeIn(directory, undefined, "https://other.example").load(CREDENTIAL),
    ).resolves.toBeNull();
  });

  it("fails closed and removes a corrupt fingerprint record", async () => {
    const directory = await scratchDirectory();
    const store = storeIn(directory);
    await store.replace({ credential: CREDENTIAL, session });
    const filePath = await onlyRecordPath(directory);
    await writeFile(filePath, "not-protected-data", "utf8");

    await expect(store.load(CREDENTIAL)).resolves.toBeNull();
    await expect(stat(filePath)).rejects.toThrow();
  });

  it.each([
    { available: false, backend: "kwallet6" },
    { available: true, backend: "basic_text" },
    { available: true, backend: "unknown" },
  ])("refuses unavailable protected storage %#", async ({ available, backend }) => {
    const store = storeIn(await scratchDirectory(), new FakeSafeStorage(available, backend));

    await expect(store.replace({ credential: CREDENTIAL, session })).rejects.toThrow(
      "Protected session context is unavailable",
    );
    await expect(store.load(CREDENTIAL)).resolves.toBeNull();
  });
});
