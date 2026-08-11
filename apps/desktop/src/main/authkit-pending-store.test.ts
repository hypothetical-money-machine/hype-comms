import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredAuthKitPendingAuthorization } from "./authkit-flow";
import {
  AuthKitProtectedStoreCorruptError,
  AuthKitProtectedStoreUnavailableError,
  SafeStorageAuthKitPendingStore,
  type AuthKitSafeStorageAdapter,
} from "./authkit-pending-store";

const API_ORIGIN = "https://chat-api.example.invalid";
const temporaryDirectories: string[] = [];

class FakeSafeStorage implements AuthKitSafeStorageAdapter {
  backendCalls = 0;
  decryptCalls = 0;
  encryptCalls = 0;

  constructor(
    private readonly backend = "kwallet6",
    private readonly available = true,
    private readonly shouldReEncrypt = false,
  ) {}

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available;
  }

  getSelectedStorageBackend(): string {
    this.backendCalls += 1;
    return this.backend;
  }

  async encryptStringAsync(plainText: string): Promise<Buffer> {
    this.encryptCalls += 1;
    return Buffer.from(`protected:${Buffer.from(plainText, "utf8").toString("base64url")}`, "utf8");
  }

  async decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ readonly shouldReEncrypt: boolean; readonly result: string }> {
    this.decryptCalls += 1;
    const value = encrypted.toString("utf8");
    if (!value.startsWith("protected:")) {
      throw new Error("invalid ciphertext");
    }
    return {
      shouldReEncrypt: this.shouldReEncrypt,
      result: Buffer.from(value.slice("protected:".length), "base64url").toString("utf8"),
    };
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-authkit-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function pending(apiOrigin = API_ORIGIN): StoredAuthKitPendingAuthorization {
  return {
    version: 1,
    apiOrigin,
    state: "s".repeat(43),
    codeVerifier: "v".repeat(43),
    createdAt: "2026-08-11T18:00:00.000Z",
    expiresAt: "2026-08-11T18:10:00.000Z",
  };
}

function protectedFilePath(
  userDataPath: string,
  kind: "installation" | "pending",
  apiOrigin = API_ORIGIN,
): string {
  const originKey = createHash("sha256").update(apiOrigin, "utf8").digest("hex").slice(0, 16);
  return path.join(userDataPath, "auth", `authkit-${kind}-${originKey}.bin`);
}

function store(
  userDataPath: string,
  safeStorage: AuthKitSafeStorageAdapter = new FakeSafeStorage(),
  apiOrigin = API_ORIGIN,
  platform: NodeJS.Platform = "linux",
): SafeStorageAuthKitPendingStore {
  return new SafeStorageAuthKitPendingStore({
    apiOrigin,
    platform,
    safeStorage,
    userDataPath,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("SafeStorageAuthKitPendingStore", () => {
  it("round-trips protected pending material and one stable installation id", async () => {
    const directory = await temporaryDirectory();
    const safeStorage = new FakeSafeStorage();
    const first = store(directory, safeStorage);

    await expect(first.load()).resolves.toBeNull();
    await first.save(pending());
    await expect(first.load()).resolves.toEqual(pending());
    const installationId = await first.loadOrCreateInstallationId();
    await expect(first.loadOrCreateInstallationId()).resolves.toBe(installationId);
    await expect(store(directory, safeStorage).loadOrCreateInstallationId()).resolves.toBe(
      installationId,
    );

    expect(installationId).toMatch(/^[0-9a-f-]{36}$/);
    const protectedPending = await readFile(protectedFilePath(directory, "pending"), "utf8");
    expect(protectedPending).not.toContain(pending().state);
    expect(protectedPending).not.toContain(pending().codeVerifier);
    expect(safeStorage.encryptCalls).toBeGreaterThanOrEqual(2);
    expect(safeStorage.decryptCalls).toBeGreaterThanOrEqual(2);
  });

  it("isolates pending state and installation identity by configured API origin", async () => {
    const directory = await temporaryDirectory();
    const safeStorage = new FakeSafeStorage();
    const production = store(directory, safeStorage);
    await production.save(pending());
    const productionInstallation = await production.loadOrCreateInstallationId();

    const stagingOrigin = "https://staging-chat.example.com";
    const otherEnvironment = store(directory, safeStorage, stagingOrigin);
    await expect(otherEnvironment.load()).resolves.toBeNull();
    const stagingInstallation = await otherEnvironment.loadOrCreateInstallationId();

    expect(stagingInstallation).not.toBe(productionInstallation);
    await expect(production.load()).resolves.toEqual(pending());
    await expect(production.loadOrCreateInstallationId()).resolves.toBe(productionInstallation);
    await expect(
      stat(protectedFilePath(directory, "installation", stagingOrigin)),
    ).resolves.toBeDefined();
  });

  it("persists a non-secret cancellation fence independently of protected state", async () => {
    const directory = await temporaryDirectory();
    const first = store(directory);

    await expect(first.hasCancellationFence()).resolves.toBe(false);
    await first.armCancellationFence();
    await expect(store(directory).hasCancellationFence()).resolves.toBe(true);

    const files = await readdir(path.join(directory, "auth"));
    const fenceName = files.find((name) => name.endsWith(".fence"));
    expect(fenceName).toBeDefined();
    const fence = await readFile(path.join(directory, "auth", fenceName ?? ""), "utf8");
    expect(fence).toBe("cancelled\n");
    expect(fence).not.toContain(API_ORIGIN);

    await first.clearCancellationFence();
    await expect(first.hasCancellationFence()).resolves.toBe(false);
  });

  it.each(["basic_text", "unknown"])(
    "uses async safeStorage availability independently of the sync Linux %s backend",
    async (backend) => {
      const safeStorage = new FakeSafeStorage(backend);
      const instance = store(await temporaryDirectory(), safeStorage);

      await expect(instance.load()).resolves.toBeNull();
      await expect(instance.loadOrCreateInstallationId()).resolves.toMatch(/^[0-9a-f-]{36}$/);
      expect(safeStorage.backendCalls).toBe(0);
    },
  );

  it("rejects unavailable safeStorage on every platform", async () => {
    const instance = store(
      await temporaryDirectory(),
      new FakeSafeStorage("ignored", false),
      API_ORIGIN,
      "darwin",
    );

    await expect(instance.save(pending())).rejects.toBeInstanceOf(
      AuthKitProtectedStoreUnavailableError,
    );
  });

  it("rejects oversized files before passing bytes to safeStorage", async () => {
    const directory = await temporaryDirectory();
    const authDirectory = path.join(directory, "auth");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(protectedFilePath(directory, "pending"), "A".repeat(64 * 1_024 + 1));
    const safeStorage = new FakeSafeStorage();

    await expect(store(directory, safeStorage).load()).rejects.toBeInstanceOf(
      AuthKitProtectedStoreCorruptError,
    );
    expect(safeStorage.decryptCalls).toBe(0);
  });

  it("rejects malformed or cross-origin decrypted records", async () => {
    const directory = await temporaryDirectory();
    const authDirectory = path.join(directory, "auth");
    await mkdir(authDirectory, { recursive: true });
    const safeStorage = new FakeSafeStorage();
    const encrypted = await safeStorage.encryptStringAsync(
      JSON.stringify({ ...pending(), apiOrigin: "https://attacker.example" }),
    );
    await writeFile(protectedFilePath(directory, "pending"), encrypted.toString("base64url"));

    await expect(store(directory, safeStorage).load()).rejects.toBeInstanceOf(
      AuthKitProtectedStoreCorruptError,
    );
  });

  it("classifies safeStorage decryption failures as temporary unavailability", async () => {
    const directory = await temporaryDirectory();
    const authDirectory = path.join(directory, "auth");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      protectedFilePath(directory, "pending"),
      Buffer.from("not protected", "utf8").toString("base64url"),
    );

    await expect(store(directory).load()).rejects.toBeInstanceOf(
      AuthKitProtectedStoreUnavailableError,
    );
  });

  it("rewraps a record when safeStorage reports key rotation", async () => {
    const directory = await temporaryDirectory();
    await store(directory).save(pending());
    const rotatingStorage = new FakeSafeStorage("kwallet6", true, true);

    await expect(store(directory, rotatingStorage).load()).resolves.toEqual(pending());
    expect(rotatingStorage.decryptCalls).toBe(1);
    expect(rotatingStorage.encryptCalls).toBe(1);
  });

  it("writes private files and clears pending state idempotently", async () => {
    const directory = await temporaryDirectory();
    const instance = store(directory);
    await instance.save(pending());
    const filePath = protectedFilePath(directory, "pending");

    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    }
    await instance.clear();
    await instance.clear();
    await expect(instance.load()).resolves.toBeNull();
  });

  it("rejects a save when the containing directory cannot be synced", async () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = await temporaryDirectory();
    const syncDirectory = vi.fn(async () => {
      throw new Error("directory sync unavailable");
    });
    const instance = new SafeStorageAuthKitPendingStore({
      apiOrigin: API_ORIGIN,
      platform: process.platform,
      safeStorage: new FakeSafeStorage(),
      syncDirectory,
      userDataPath: directory,
    });

    await expect(instance.save(pending())).rejects.toBeInstanceOf(
      AuthKitProtectedStoreUnavailableError,
    );
    expect(syncDirectory).toHaveBeenCalledWith(path.join(directory, "auth"));
  });

  it("rejects a clear when the removal cannot be durably synced", async () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = await temporaryDirectory();
    await store(directory).save(pending());
    const syncDirectory = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("directory sync unavailable"))
      .mockResolvedValue(undefined);
    const instance = new SafeStorageAuthKitPendingStore({
      apiOrigin: API_ORIGIN,
      platform: process.platform,
      safeStorage: new FakeSafeStorage(),
      syncDirectory,
      userDataPath: directory,
    });

    await expect(instance.clear()).rejects.toBeInstanceOf(AuthKitProtectedStoreUnavailableError);
    expect(syncDirectory).toHaveBeenCalledWith(path.join(directory, "auth"));
    await expect(instance.clear()).resolves.toBeUndefined();
    expect(syncDirectory).toHaveBeenCalledTimes(2);
  });
});
