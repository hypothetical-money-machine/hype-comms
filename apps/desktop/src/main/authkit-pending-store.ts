import { createHash, randomUUID } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { entityIdSchema } from "@hype-comms/contracts";

import { normalizeDevelopmentApiOrigin } from "../shared/api-origin";
import {
  parseStoredAuthKitPendingAuthorization,
  type AuthKitPendingAuthorizationStore,
  type StoredAuthKitPendingAuthorization,
} from "./authkit-flow";
import { atomicWrite, syncDirectoryStrict, type SyncDirectory } from "./preference-file";

const MAX_PROTECTED_AUTHKIT_FILE_BYTES = 64 * 1_024;

export interface AuthKitSafeStorageAdapter {
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ readonly shouldReEncrypt: boolean; readonly result: string }>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  isAsyncEncryptionAvailable(): Promise<boolean>;
}

interface StoredAuthKitInstallation {
  readonly version: 1;
  readonly apiOrigin: string;
  readonly installationId: string;
}

export class AuthKitProtectedStoreUnavailableError extends Error {
  constructor() {
    super("The operating system credential store is unavailable");
    this.name = "AuthKitProtectedStoreUnavailableError";
  }
}

export class AuthKitProtectedStoreCorruptError extends Error {
  constructor() {
    super("Protected AuthKit data is invalid");
    this.name = "AuthKitProtectedStoreCorruptError";
  }
}

/** Stores only short-lived PKCE material and the non-secret stable installation identifier. */
export class SafeStorageAuthKitPendingStore implements AuthKitPendingAuthorizationStore {
  readonly #apiOrigin: string;
  readonly #cancellationFencePath: string;
  readonly #installationPath: string;
  readonly #pendingPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #safeStorage: AuthKitSafeStorageAdapter;
  readonly #syncDirectory: SyncDirectory;
  #installationIdPromise: Promise<string> | null = null;

  constructor(options: {
    readonly apiOrigin: string;
    readonly platform: NodeJS.Platform;
    readonly safeStorage: AuthKitSafeStorageAdapter;
    readonly syncDirectory?: SyncDirectory;
    readonly userDataPath: string;
  }) {
    const apiOrigin = normalizeDevelopmentApiOrigin(options.apiOrigin);
    if (apiOrigin === null) {
      throw new TypeError("AuthKit protected storage requires a safe API origin");
    }

    const authDirectory = path.join(options.userDataPath, "auth");
    const originKey = createHash("sha256").update(apiOrigin, "utf8").digest("hex").slice(0, 16);
    this.#apiOrigin = apiOrigin;
    this.#cancellationFencePath = path.join(
      authDirectory,
      `authkit-cancellation-${originKey}.fence`,
    );
    // Keep every protected record origin-local. The decrypted payload still repeats and validates
    // the origin as defense in depth, while the filename prevents a legitimate environment switch
    // (for example staging to production) from turning the other environment's record into a
    // permanent corruption error.
    this.#installationPath = path.join(authDirectory, `authkit-installation-${originKey}.bin`);
    this.#pendingPath = path.join(authDirectory, `authkit-pending-${originKey}.bin`);
    this.#platform = options.platform;
    this.#safeStorage = options.safeStorage;
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryStrict;
  }

  async assertAvailable(): Promise<void> {
    let available: boolean;
    try {
      available = await this.#safeStorage.isAsyncEncryptionAvailable();
    } catch {
      throw new AuthKitProtectedStoreUnavailableError();
    }

    if (!available) {
      throw new AuthKitProtectedStoreUnavailableError();
    }
  }

  load(): Promise<StoredAuthKitPendingAuthorization | null> {
    return this.#loadEncrypted(this.#pendingPath, (value) =>
      parseStoredAuthKitPendingAuthorization(value, this.#apiOrigin),
    );
  }

  async save(pending: StoredAuthKitPendingAuthorization): Promise<void> {
    const parsed = parseStoredAuthKitPendingAuthorization(pending, this.#apiOrigin);
    await this.#saveEncrypted(this.#pendingPath, parsed);
  }

  async clear(): Promise<void> {
    await this.#removeDurably(this.#pendingPath);
  }

  /**
   * Non-secret crash fence written before an explicit cancel or competing sign-in. It remains
   * readable even while the OS keyring is locked, so a later process cannot resurrect an older
   * protected authorization merely because deleting it had to be retried.
   */
  async armCancellationFence(): Promise<void> {
    try {
      await atomicWrite(this.#cancellationFencePath, "cancelled\n", this.#syncDirectory, {
        requireDirectorySync: true,
      });
    } catch {
      throw new AuthKitProtectedStoreUnavailableError();
    }
  }

  async hasCancellationFence(): Promise<boolean> {
    let file: FileHandle | undefined;
    try {
      file = await open(this.#cancellationFencePath, "r");
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw new AuthKitProtectedStoreUnavailableError();
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async clearCancellationFence(): Promise<void> {
    await this.#removeDurably(this.#cancellationFencePath);
  }

  loadOrCreateInstallationId(): Promise<string> {
    if (this.#installationIdPromise === null) {
      this.#installationIdPromise = this.#loadOrCreateInstallationId().catch((error: unknown) => {
        this.#installationIdPromise = null;
        throw error;
      });
    }
    return this.#installationIdPromise;
  }

  async #loadOrCreateInstallationId(): Promise<string> {
    const existing = await this.#loadEncrypted(this.#installationPath, (value) =>
      parseStoredInstallation(value, this.#apiOrigin),
    );
    if (existing !== null) {
      return existing.installationId;
    }

    const installation: StoredAuthKitInstallation = {
      version: 1,
      apiOrigin: this.#apiOrigin,
      installationId: randomUUID(),
    };
    await this.#saveEncrypted(this.#installationPath, installation);
    return installation.installationId;
  }

  async #loadEncrypted<T>(filePath: string, parse: (value: unknown) => T): Promise<T | null> {
    await this.assertAvailable();
    const encrypted = await readBoundedCiphertext(filePath);
    if (encrypted === null) {
      return null;
    }

    let decrypted: { readonly shouldReEncrypt: boolean; readonly result: string };
    try {
      decrypted = await this.#safeStorage.decryptStringAsync(encrypted);
    } catch {
      throw new AuthKitProtectedStoreUnavailableError();
    }
    if (
      decrypted.result.length === 0 ||
      Buffer.byteLength(decrypted.result, "utf8") > MAX_PROTECTED_AUTHKIT_FILE_BYTES
    ) {
      throw new AuthKitProtectedStoreCorruptError();
    }

    let parsed: T;
    try {
      parsed = parse(JSON.parse(decrypted.result) as unknown);
    } catch {
      throw new AuthKitProtectedStoreCorruptError();
    }

    if (decrypted.shouldReEncrypt) {
      await this.#saveEncrypted(filePath, parsed);
    }
    return parsed;
  }

  async #saveEncrypted(filePath: string, value: unknown): Promise<void> {
    await this.assertAvailable();
    let encrypted: Buffer;
    try {
      encrypted = await this.#safeStorage.encryptStringAsync(JSON.stringify(value));
    } catch {
      throw new AuthKitProtectedStoreUnavailableError();
    }

    const encoded = encrypted.toString("base64url");
    if (
      encrypted.length === 0 ||
      encoded.length === 0 ||
      Buffer.byteLength(encoded, "utf8") > MAX_PROTECTED_AUTHKIT_FILE_BYTES
    ) {
      throw new AuthKitProtectedStoreUnavailableError();
    }

    try {
      await atomicWrite(filePath, encoded, this.#syncDirectory, {
        requireDirectorySync: true,
      });
    } catch {
      throw new AuthKitProtectedStoreUnavailableError();
    }
  }

  async #removeDurably(filePath: string): Promise<void> {
    try {
      await rm(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw new AuthKitProtectedStoreUnavailableError();
    }
    if (this.#platform !== "win32") {
      try {
        // Sync even after ENOENT. A previous remove may have succeeded before its directory sync
        // failed, and this retry is what makes that deletion durable.
        await this.#syncDirectory(path.dirname(filePath));
      } catch {
        throw new AuthKitProtectedStoreUnavailableError();
      }
    }
  }
}

function parseStoredInstallation(value: unknown, apiOrigin: string): StoredAuthKitInstallation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthKitProtectedStoreCorruptError();
  }
  const candidate = value as Partial<StoredAuthKitInstallation>;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => ["version", "apiOrigin", "installationId"].includes(key)) ||
    candidate.version !== 1 ||
    candidate.apiOrigin !== apiOrigin ||
    !entityIdSchema.safeParse(candidate.installationId).success
  ) {
    throw new AuthKitProtectedStoreCorruptError();
  }
  return candidate as StoredAuthKitInstallation;
}

async function readBoundedCiphertext(filePath: string): Promise<Buffer | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_PROTECTED_AUTHKIT_FILE_BYTES
    ) {
      throw new AuthKitProtectedStoreCorruptError();
    }

    const bytes = Buffer.alloc(MAX_PROTECTED_AUTHKIT_FILE_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < bytes.length) {
      const result = await file.read(bytes, totalBytesRead, bytes.length - totalBytesRead, null);
      if (result.bytesRead === 0) {
        break;
      }
      totalBytesRead += result.bytesRead;
    }
    if (totalBytesRead === 0 || totalBytesRead > MAX_PROTECTED_AUTHKIT_FILE_BYTES) {
      throw new AuthKitProtectedStoreCorruptError();
    }

    const encoded = bytes.toString("utf8", 0, totalBytesRead);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new AuthKitProtectedStoreCorruptError();
    }
    const encrypted = Buffer.from(encoded, "base64url");
    if (encrypted.length === 0 || encrypted.toString("base64url") !== encoded) {
      throw new AuthKitProtectedStoreCorruptError();
    }
    return encrypted;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    if (error instanceof AuthKitProtectedStoreCorruptError) {
      throw error;
    }
    throw new AuthKitProtectedStoreUnavailableError();
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
