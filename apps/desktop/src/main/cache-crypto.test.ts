import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CacheCiphertextCorruptError, CacheCrypto, type SafeStorageAdapter } from "./cache-crypto";

const directories: string[] = [];
const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
} as const;

class FakeSafeStorage implements SafeStorageAdapter {
  constructor(
    private readonly available = true,
    private readonly backend = "kwallet6",
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(value, "utf8");
  }

  decryptString(value: Buffer): string {
    return value.toString("utf8");
  }

  getSelectedStorageBackend(): string {
    return this.backend;
  }
}

async function crypto(storage = new FakeSafeStorage()): Promise<CacheCrypto> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-cache-crypto-"));
  directories.push(directory);
  return new CacheCrypto({
    apiOrigin: "https://chat.example",
    platform: "linux",
    safeStorage: storage,
    userDataPath: directory,
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CacheCrypto", () => {
  it("persists a wrapped key and authenticates record context", async () => {
    const storage = new FakeSafeStorage();
    const first = await crypto(storage);
    await expect(first.initialize(scope)).resolves.toMatchObject({ mode: "persistent" });
    const encrypted = first.encrypt({
      items: [
        {
          store: "message",
          recordId: "message-1",
          schemaVersion: 1,
          plaintext: "private message",
        },
      ],
    });
    expect(first.decrypt(encrypted).items[0]?.plaintext).toBe("private message");

    const tampered = {
      items: encrypted.items.map((item) => ({ ...item, recordId: "message-2" })),
    };
    expect(() => first.decrypt(tampered)).toThrow(CacheCiphertextCorruptError);
  });

  it("uses memory-only mode when Linux has only basic_text storage", async () => {
    const instance = await crypto(new FakeSafeStorage(true, "basic_text"));
    await expect(instance.initialize(scope)).resolves.toEqual({
      mode: "memory_only",
      scope,
      reason: "credential_store_unavailable",
    });
  });
});
