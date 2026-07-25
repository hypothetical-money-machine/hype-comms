import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
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

export class CacheKeyCorruptError extends Error {
  constructor() {
    super("The protected local cache key is invalid");
    this.name = "CacheKeyCorruptError";
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

function parseStoredCacheKey(value: unknown): StoredCacheKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CacheKeyCorruptError();
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
    throw new CacheKeyCorruptError();
  }
  if (Buffer.from(candidate.dataKey, "base64url").length !== CACHE_KEY_BYTES) {
    throw new CacheKeyCorruptError();
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
      throw new CacheKeyCorruptError();
    }
    return await readFile(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
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
  readonly #keyPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #safeStorage: SafeStorageAdapter;
  #dataKey: Buffer | null = null;
  #scope: CacheScope | null = null;

  constructor(options: {
    readonly apiOrigin: string;
    readonly platform: NodeJS.Platform;
    readonly safeStorage: SafeStorageAdapter;
    readonly userDataPath: string;
  }) {
    this.#apiOrigin = options.apiOrigin;
    this.#keyPath = path.join(options.userDataPath, "cache", "data-key.bin");
    this.#platform = options.platform;
    this.#safeStorage = options.safeStorage;
  }

  async initialize(scope: CacheScope): Promise<CacheCryptoStatus> {
    if (!this.#isProtectedStorageAvailable()) {
      this.#dataKey = null;
      this.#scope = scope;
      return { mode: "memory_only", scope, reason: "credential_store_unavailable" };
    }

    const encrypted = await readBoundedFile(this.#keyPath);
    if (encrypted === null) {
      const key = randomBytes(CACHE_KEY_BYTES);
      await this.#saveKey(scope, key);
      this.#dataKey = key;
      this.#scope = scope;
      return { mode: "persistent", scope, keyVersion: 1 };
    }

    try {
      const stored = parseStoredCacheKey(
        JSON.parse(this.#safeStorage.decryptString(encrypted)) as unknown,
      );
      if (stored.apiOrigin !== this.#apiOrigin || !scopesEqual(stored.scope, scope)) {
        throw new CacheKeyCorruptError();
      }
      this.#dataKey = Buffer.from(stored.dataKey, "base64url");
      this.#scope = scope;
      return { mode: "persistent", scope, keyVersion: 1 };
    } catch (error) {
      if (error instanceof CacheKeyCorruptError) throw error;
      throw new CacheKeyCorruptError();
    }
  }

  async clear(): Promise<void> {
    this.#dataKey?.fill(0);
    this.#dataKey = null;
    this.#scope = null;
    await rm(this.#keyPath, { force: true });
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

  async #saveKey(scope: CacheScope, key: Buffer): Promise<void> {
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
      await atomicWrite(this.#keyPath, encrypted);
    } catch (error) {
      if (error instanceof CacheCryptoUnavailableError) throw error;
      throw new CacheCryptoUnavailableError();
    }
  }
}
