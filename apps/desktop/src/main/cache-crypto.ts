import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  cacheDecryptBatchRequestSchema,
  cacheDecryptBatchResponseSchema,
  cacheEncryptBatchRequestSchema,
  cacheEncryptBatchResponseSchema,
  type CacheCryptoStatus,
  type CacheDecryptBatchRequest,
  type CacheDecryptBatchResponse,
  type CacheEncryptBatchRequest,
  type CacheEncryptBatchResponse,
  type CacheRecordContext,
  type CacheScope,
} from "@hmm-chat/contracts";

const CACHE_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_BATCH_PLAINTEXT_BYTES = 512 * 1_024;
const MAX_KEY_FILE_BYTES = 64 * 1_024;
/** Hex characters of the scope digest used in the key file name; 32 is 128 bits. */
const KEY_DIGEST_LENGTH = 32;
/** Written by builds that kept one key for every scope; adopted on first use, then removed. */
const LEGACY_KEY_FILE_NAME = "data-key.bin";

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend(): string;
}

interface StoredCacheKey {
  readonly version: 1;
  readonly apiOrigin: string;
  readonly scope: CacheScope;
  readonly keyVersion: 1;
  readonly dataKey: string;
}

type StoredKeyLoad =
  { readonly status: "missing" } | { readonly status: "loaded"; readonly key: Buffer };

/**
 * Why a stored key could not be used. `scope_mismatch` is the only reason that means the file
 * belongs to somebody else, so it is the only reason that must never delete the file.
 */
export type CacheKeyFailureReason =
  "unreadable_file" | "undecryptable" | "malformed" | "scope_mismatch";

export class CacheKeyCorruptError extends Error {
  readonly reason: CacheKeyFailureReason;

  constructor(reason: CacheKeyFailureReason) {
    super(`The protected local cache key is invalid (${reason})`);
    this.name = "CacheKeyCorruptError";
    this.reason = reason;
  }
}

export class CacheCiphertextCorruptError extends Error {
  constructor() {
    super("Protected local cache data could not be authenticated");
    this.name = "CacheCiphertextCorruptError";
  }
}

export class CacheCryptoUnavailableError extends Error {
  constructor() {
    super("Protected local cache encryption is unavailable");
    this.name = "CacheCryptoUnavailableError";
  }
}

function scopesEqual(left: CacheScope, right: CacheScope): boolean {
  return left.userId === right.userId && left.workspaceId === right.workspaceId;
}

function isMissingFileError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function parseStoredCacheKey(value: unknown): StoredCacheKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CacheKeyCorruptError("malformed");
  }
  const candidate = value as Partial<StoredCacheKey>;
  if (
    candidate.version !== 1 ||
    typeof candidate.apiOrigin !== "string" ||
    candidate.keyVersion !== 1 ||
    typeof candidate.dataKey !== "string" ||
    typeof candidate.scope !== "object" ||
    candidate.scope === null ||
    typeof candidate.scope.userId !== "string" ||
    typeof candidate.scope.workspaceId !== "string"
  ) {
    throw new CacheKeyCorruptError("malformed");
  }
  if (Buffer.from(candidate.dataKey, "base64url").length !== CACHE_KEY_BYTES) {
    throw new CacheKeyCorruptError("malformed");
  }
  return candidate as StoredCacheKey;
}

function additionalData(apiOrigin: string, scope: CacheScope, context: CacheRecordContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      apiOrigin,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      store: context.store,
      recordId: context.recordId,
      keyVersion: 1,
      schemaVersion: context.schemaVersion,
    }),
    "utf8",
  );
}

async function readBoundedFile(filePath: string): Promise<Buffer | null> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_KEY_FILE_BYTES) {
      throw new CacheKeyCorruptError("unreadable_file");
    }
    return await readFile(filePath);
  } catch (error) {
    if (error instanceof CacheKeyCorruptError) throw error;
    if (isMissingFileError(error)) return null;
    throw new CacheKeyCorruptError("unreadable_file");
  }
}

async function atomicWrite(filePath: string, value: Uint8Array): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
    await file.close();
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class CacheCrypto {
  readonly #apiOrigin: string;
  readonly #cacheDirectory: string;
  readonly #platform: NodeJS.Platform;
  readonly #safeStorage: SafeStorageAdapter;
  #dataKey: Buffer | null = null;
  #scope: CacheScope | null = null;
  /**
   * Whether the file at the current scope's key path is this scope's own. Only a scope that read or
   * wrote that file owns it. A `scope_mismatch` found somebody else's key there and deliberately
   * left it alone, so `clear()` must not finish the deletion `initialize` refused.
   */
  #ownsStoredKey = false;

  constructor(options: {
    readonly apiOrigin: string;
    readonly platform: NodeJS.Platform;
    readonly safeStorage: SafeStorageAdapter;
    readonly userDataPath: string;
  }) {
    this.#apiOrigin = options.apiOrigin;
    this.#cacheDirectory = path.join(options.userDataPath, "cache");
    this.#platform = options.platform;
    this.#safeStorage = options.safeStorage;
  }

  async initialize(scope: CacheScope): Promise<CacheCryptoStatus> {
    if (!this.#isProtectedStorageAvailable()) {
      this.#dataKey = null;
      this.#scope = scope;
      // Nothing on disk was read or written, so this instance owns no key file.
      this.#ownsStoredKey = false;
      return { mode: "memory_only", scope, reason: "credential_store_unavailable" };
    }

    const keyPath = this.#scopeKeyPath(scope);
    try {
      const loaded = await this.#loadStoredKey(keyPath, scope);
      if (loaded.status === "loaded") return this.#adopt(scope, loaded.key);
    } catch (error) {
      if (!(error instanceof CacheKeyCorruptError)) throw error;
      // Every reason but one describes this scope's own unusable file, and discarding that cannot
      // destroy another member's cache. A `scope_mismatch` says the opposite — the file holds
      // somebody else's key, reachable only by a digest collision or tampering — and it may be the
      // only copy of it, so it is left in place. Either way, report memory-only rather than locking
      // this member out of the app.
      if (error.reason !== "scope_mismatch") {
        await rm(keyPath, { force: true }).catch(() => undefined);
      }
      this.#dataKey = null;
      this.#scope = scope;
      // No key of this scope's own is on disk: either it was just discarded, or the file at this
      // path belongs to another member and must survive a later `clear()`.
      this.#ownsStoredKey = false;
      return { mode: "memory_only", scope, reason: "key_unavailable" };
    }

    const migrated = await this.#adoptLegacyKey(scope, keyPath);
    if (migrated !== null) return this.#adopt(scope, migrated);

    const key = randomBytes(CACHE_KEY_BYTES);
    await this.#saveKey(keyPath, scope, key);
    return this.#adopt(scope, key);
  }

  async clear(): Promise<void> {
    this.#dataKey?.fill(0);
    this.#dataKey = null;
    const scope = this.#scope;
    const ownedStoredKey = this.#ownsStoredKey;
    this.#scope = null;
    this.#ownsStoredKey = false;
    // In-memory key material is always dropped, but only a key file this instance established
    // ownership of is unlinked: other members on this OS account keep theirs, and a foreign file
    // left in place by a `scope_mismatch` is never this reset's to destroy.
    if (scope !== null && ownedStoredKey) await rm(this.#scopeKeyPath(scope), { force: true });
  }

  encrypt(input: CacheEncryptBatchRequest): CacheEncryptBatchResponse {
    const request = cacheEncryptBatchRequestSchema.parse(input);
    const { key, scope } = this.#active();
    const totalBytes = request.items.reduce(
      (total, item) => total + Buffer.byteLength(item.plaintext, "utf8"),
      0,
    );
    if (totalBytes > MAX_BATCH_PLAINTEXT_BYTES) throw new CacheCryptoUnavailableError();

    return cacheEncryptBatchResponseSchema.parse({
      items: request.items.map((item) => {
        const nonce = randomBytes(GCM_NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(additionalData(this.#apiOrigin, scope, item));
        const ciphertext = Buffer.concat([
          cipher.update(item.plaintext, "utf8"),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
        return {
          store: item.store,
          recordId: item.recordId,
          schemaVersion: item.schemaVersion,
          value: {
            version: 1,
            keyVersion: 1,
            schemaVersion: 1,
            nonce: nonce.toString("base64url"),
            ciphertext: ciphertext.toString("base64url"),
          },
        };
      }),
    });
  }

  decrypt(input: CacheDecryptBatchRequest): CacheDecryptBatchResponse {
    const request = cacheDecryptBatchRequestSchema.parse(input);
    const { key, scope } = this.#active();
    try {
      return cacheDecryptBatchResponseSchema.parse({
        items: request.items.map((item) => {
          const nonce = Buffer.from(item.value.nonce, "base64url");
          const combined = Buffer.from(item.value.ciphertext, "base64url");
          if (nonce.length !== GCM_NONCE_BYTES || combined.length < GCM_TAG_BYTES) {
            throw new CacheCiphertextCorruptError();
          }
          const ciphertext = combined.subarray(0, combined.length - GCM_TAG_BYTES);
          const tag = combined.subarray(combined.length - GCM_TAG_BYTES);
          const decipher = createDecipheriv("aes-256-gcm", key, nonce);
          decipher.setAAD(additionalData(this.#apiOrigin, scope, item));
          decipher.setAuthTag(tag);
          return {
            store: item.store,
            recordId: item.recordId,
            schemaVersion: item.schemaVersion,
            plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
              "utf8",
            ),
          };
        }),
      });
    } catch (error) {
      if (error instanceof CacheCiphertextCorruptError) throw error;
      throw new CacheCiphertextCorruptError();
    }
  }

  #active(): { readonly key: Buffer; readonly scope: CacheScope } {
    if (this.#dataKey === null || this.#scope === null) throw new CacheCryptoUnavailableError();
    return { key: this.#dataKey, scope: this.#scope };
  }

  /**
   * Takes a key as this scope's own. Every caller has just proven the file at this scope's key path
   * holds this scope's key — loaded from it, migrated into it, or freshly written to it — so this
   * instance owns that file and `clear()` may remove it.
   */
  #adopt(scope: CacheScope, key: Buffer): CacheCryptoStatus {
    if (this.#dataKey !== null && this.#dataKey !== key) this.#dataKey.fill(0);
    this.#dataKey = key;
    this.#scope = scope;
    this.#ownsStoredKey = true;
    return { mode: "persistent", scope, keyVersion: 1 };
  }

  /**
   * One key file per `{apiOrigin, userId, workspaceId}`, mirroring the renderer's per-workspace and
   * per-user cache database. Two members signing in on one OS account never share a key file, so
   * neither can invalidate the other's cached rows or undelivered outbox messages.
   */
  #scopeKeyPath(scope: CacheScope): string {
    const identity = JSON.stringify({
      version: 1,
      apiOrigin: this.#apiOrigin,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    });
    const digest = createHash("sha256").update(identity, "utf8").digest("hex");
    return path.join(this.#cacheDirectory, `data-key-${digest.slice(0, KEY_DIGEST_LENGTH)}.bin`);
  }

  async #loadStoredKey(filePath: string, scope: CacheScope): Promise<StoredKeyLoad> {
    const encrypted = await readBoundedFile(filePath);
    if (encrypted === null) return { status: "missing" };

    let serialized: string;
    try {
      serialized = this.#safeStorage.decryptString(encrypted);
    } catch {
      throw new CacheKeyCorruptError("undecryptable");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new CacheKeyCorruptError("malformed");
    }

    const stored = parseStoredCacheKey(parsed);
    if (stored.apiOrigin !== this.#apiOrigin || !scopesEqual(stored.scope, scope)) {
      throw new CacheKeyCorruptError("scope_mismatch");
    }
    return { status: "loaded", key: Buffer.from(stored.dataKey, "base64url") };
  }

  /**
   * Moves a pre-upgrade global key file to this scope's path when it belongs to this scope. A
   * legacy file for a different scope, or one that cannot be read, is left untouched: it may be
   * the only copy of another member's key.
   */
  async #adoptLegacyKey(scope: CacheScope, keyPath: string): Promise<Buffer | null> {
    const legacyPath = path.join(this.#cacheDirectory, LEGACY_KEY_FILE_NAME);
    let legacy: StoredKeyLoad;
    try {
      legacy = await this.#loadStoredKey(legacyPath, scope);
    } catch (error) {
      if (!(error instanceof CacheKeyCorruptError)) throw error;
      return null;
    }
    if (legacy.status === "missing") return null;

    await this.#saveKey(keyPath, scope, legacy.key);
    await rm(legacyPath, { force: true }).catch(() => undefined);
    return legacy.key;
  }

  #isProtectedStorageAvailable(): boolean {
    try {
      if (!this.#safeStorage.isEncryptionAvailable()) return false;
      if (this.#platform !== "linux") return true;
      const backend = this.#safeStorage.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return false;
    }
  }

  async #saveKey(keyPath: string, scope: CacheScope, key: Buffer): Promise<void> {
    try {
      const encrypted = this.#safeStorage.encryptString(
        JSON.stringify({
          version: 1,
          apiOrigin: this.#apiOrigin,
          scope,
          keyVersion: 1,
          dataKey: key.toString("base64url"),
        } satisfies StoredCacheKey),
      );
      if (encrypted.length === 0 || encrypted.length > MAX_KEY_FILE_BYTES) {
        throw new CacheCryptoUnavailableError();
      }
      await atomicWrite(keyPath, encrypted);
    } catch (error) {
      if (error instanceof CacheCryptoUnavailableError) throw error;
      throw new CacheCryptoUnavailableError();
    }
  }
}
