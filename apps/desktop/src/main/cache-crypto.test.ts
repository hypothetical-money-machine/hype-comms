import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CacheEncryptBatchRequest, CacheScope } from "@hmm-chat/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CacheCiphertextCorruptError,
  CacheCrypto,
  CacheCryptoUnavailableError,
  type SafeStorageAdapter,
} from "./cache-crypto";

const API_ORIGIN = "https://chat.example";
const LEGACY_KEY_FILE_NAME = "data-key.bin";
const directories: string[] = [];
const scope = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
} as const;
const secondScope = {
  userId: "10000000-0000-4000-8000-000000000003",
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

/** Models an OS credential store that can no longer unwrap what it previously wrapped. */
class UnwrapFailingSafeStorage implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(value, "utf8");
  }

  decryptString(): string {
    throw new Error("the credential store rejected the wrapped key");
  }

  getSelectedStorageBackend(): string {
    return "kwallet6";
  }
}

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-cache-crypto-"));
  directories.push(directory);
  return directory;
}

function cryptoIn(
  userDataPath: string,
  storage: SafeStorageAdapter = new FakeSafeStorage(),
): CacheCrypto {
  return new CacheCrypto({
    apiOrigin: API_ORIGIN,
    platform: "linux",
    safeStorage: storage,
    userDataPath,
  });
}

async function crypto(storage = new FakeSafeStorage()): Promise<CacheCrypto> {
  return cryptoIn(await scratchDirectory(), storage);
}

async function keyFileNames(userDataPath: string): Promise<string[]> {
  const names = await readdir(path.join(userDataPath, "cache"));
  return names.filter((name) => name.endsWith(".bin")).sort();
}

async function onlyKeyPath(userDataPath: string): Promise<string> {
  const names = await keyFileNames(userDataPath);
  const [name] = names;
  if (names.length !== 1 || name === undefined) throw new Error("expected one cache key file");
  return path.join(userDataPath, "cache", name);
}

function record(recordId: string, plaintext: string): CacheEncryptBatchRequest {
  return { items: [{ store: "outbox", recordId, schemaVersion: 1, plaintext }] };
}

/** A wrapped key file for `keyScope`, exactly as `FakeSafeStorage` would have written it. */
function storedKeyBytes(keyScope: CacheScope, fill: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      apiOrigin: API_ORIGIN,
      scope: keyScope,
      keyVersion: 1,
      dataKey: Buffer.alloc(32, fill).toString("base64url"),
    }),
    "utf8",
  );
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

  it("keys the cache per scope so a second member on one machine is not locked out", async () => {
    const directory = await scratchDirectory();
    const first = cryptoIn(directory);
    const second = cryptoIn(directory);

    await expect(first.initialize(scope)).resolves.toEqual({
      mode: "persistent",
      scope,
      keyVersion: 1,
    });
    await expect(second.initialize(secondScope)).resolves.toEqual({
      mode: "persistent",
      scope: secondScope,
      keyVersion: 1,
    });
    expect(await keyFileNames(directory)).toHaveLength(2);

    const firstCiphertext = first.encrypt(record("outbox-1", "first member draft"));
    const secondCiphertext = second.encrypt(record("outbox-1", "second member draft"));
    expect(first.decrypt(firstCiphertext).items[0]?.plaintext).toBe("first member draft");
    expect(second.decrypt(secondCiphertext).items[0]?.plaintext).toBe("second member draft");
    expect(() => second.decrypt(firstCiphertext)).toThrow(CacheCiphertextCorruptError);
    expect(() => first.decrypt(secondCiphertext)).toThrow(CacheCiphertextCorruptError);

    // Signing the first member back in after the second one wrote a key still finds their key.
    const reopened = cryptoIn(directory);
    await expect(reopened.initialize(scope)).resolves.toMatchObject({ mode: "persistent" });
    expect(reopened.decrypt(firstCiphertext).items[0]?.plaintext).toBe("first member draft");
  });

  it("recovers memory-only from a malformed key file, not a terminal error", async () => {
    const directory = await scratchDirectory();
    await cryptoIn(directory).initialize(scope);
    const keyPath = await onlyKeyPath(directory);
    await writeFile(keyPath, "}} not json {{", "utf8");

    const reopened = cryptoIn(directory);
    await expect(reopened.initialize(scope)).resolves.toEqual({
      mode: "memory_only",
      scope,
      reason: "key_unavailable",
    });
    expect(() => reopened.encrypt(record("outbox-1", "no key"))).toThrow(
      CacheCryptoUnavailableError,
    );
    await expect(stat(keyPath)).rejects.toThrow();

    // The discarded key is replaced on the next start, so persistence is not lost for good.
    const later = cryptoIn(directory);
    await expect(later.initialize(scope)).resolves.toMatchObject({ mode: "persistent" });
  });

  it("never deletes a key file that turns out to hold another member's scope", async () => {
    const directory = await scratchDirectory();
    await cryptoIn(directory).initialize(scope);
    const keyPath = await onlyKeyPath(directory);
    // Only a truncated-digest collision or a tampered file puts a foreign scope at this path, and
    // either way the file may be the only copy of that member's key.
    const foreignBytes = storedKeyBytes(secondScope, 9);
    await writeFile(keyPath, foreignBytes);

    const reopened = cryptoIn(directory);
    await expect(reopened.initialize(scope)).resolves.toEqual({
      mode: "memory_only",
      scope,
      reason: "key_unavailable",
    });
    expect((await readFile(keyPath)).equals(foreignBytes)).toBe(true);
  });

  it("never deletes another member's key file when the local cache is reset", async () => {
    const directory = await scratchDirectory();
    await cryptoIn(directory).initialize(scope);
    const keyPath = await onlyKeyPath(directory);
    const foreignBytes = storedKeyBytes(secondScope, 9);
    await writeFile(keyPath, foreignBytes);

    const reopened = cryptoIn(directory);
    await expect(reopened.initialize(scope)).resolves.toMatchObject({
      mode: "memory_only",
      reason: "key_unavailable",
    });

    // `cache:crypto-reset` from the renderer lands here. It must not finish the deletion that the
    // scope_mismatch above deliberately refused, however often the member resets their cache.
    await reopened.clear();
    await reopened.clear();

    expect((await readFile(keyPath)).equals(foreignBytes)).toBe(true);
    // The reset still leaves this instance with no usable key material of its own.
    expect(() => reopened.encrypt(record("outbox-1", "no key"))).toThrow(
      CacheCryptoUnavailableError,
    );
  });

  it("recovers memory-only when the credential store cannot unwrap the stored key", async () => {
    const directory = await scratchDirectory();
    await cryptoIn(directory).initialize(scope);

    const reopened = cryptoIn(directory, new UnwrapFailingSafeStorage());
    await expect(reopened.initialize(scope)).resolves.toEqual({
      mode: "memory_only",
      scope,
      reason: "key_unavailable",
    });
    expect(await keyFileNames(directory)).toHaveLength(0);
  });

  it("adopts a pre-upgrade global key file that belongs to the signed-in scope", async () => {
    const directory = await scratchDirectory();
    const before = cryptoIn(directory);
    await before.initialize(scope);
    const ciphertext = before.encrypt(record("outbox-1", "kept across the upgrade"));
    const legacyPath = path.join(directory, "cache", LEGACY_KEY_FILE_NAME);
    await rename(await onlyKeyPath(directory), legacyPath);

    const upgraded = cryptoIn(directory);
    await expect(upgraded.initialize(scope)).resolves.toMatchObject({ mode: "persistent" });
    expect(upgraded.decrypt(ciphertext).items[0]?.plaintext).toBe("kept across the upgrade");
    const migrated = await keyFileNames(directory);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).not.toBe(LEGACY_KEY_FILE_NAME);
  });

  it("never destroys a pre-upgrade key that belongs to another member", async () => {
    const directory = await scratchDirectory();
    const cacheDirectory = path.join(directory, "cache");
    await mkdir(cacheDirectory, { recursive: true });
    const legacyPath = path.join(cacheDirectory, LEGACY_KEY_FILE_NAME);
    const legacyBytes = storedKeyBytes(scope, 7);
    await writeFile(legacyPath, legacyBytes);

    const other = cryptoIn(directory);
    await expect(other.initialize(secondScope)).resolves.toEqual({
      mode: "persistent",
      scope: secondScope,
      keyVersion: 1,
    });
    const ciphertext = other.encrypt(record("outbox-1", "second member draft"));
    expect(other.decrypt(ciphertext).items[0]?.plaintext).toBe("second member draft");
    expect((await readFile(legacyPath)).equals(legacyBytes)).toBe(true);
  });

  it("clears only the signed-in member's key file", async () => {
    const directory = await scratchDirectory();
    const first = cryptoIn(directory);
    const second = cryptoIn(directory);
    await first.initialize(scope);
    await second.initialize(secondScope);
    const ciphertext = second.encrypt(record("outbox-1", "still deliverable"));

    await first.clear();

    expect(await keyFileNames(directory)).toHaveLength(1);
    const reopened = cryptoIn(directory);
    await expect(reopened.initialize(secondScope)).resolves.toMatchObject({ mode: "persistent" });
    expect(reopened.decrypt(ciphertext).items[0]?.plaintext).toBe("still deliverable");
  });
});
