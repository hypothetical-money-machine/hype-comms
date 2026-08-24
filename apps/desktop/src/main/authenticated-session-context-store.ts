import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  authenticatedSessionContextSchema,
  type AuthenticatedSessionContext,
} from "@hype-comms/contracts";

import { atomicWrite, readBoundedUtf8File, syncDirectoryBestEffort } from "./preference-file";

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = 64 * 1_024;
const FINGERPRINT_SALT_BYTES = 32;
const FINGERPRINT_CONTEXT = "hype-comms-authenticated-session-context-v1";
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_SALT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface StoredAuthenticatedSessionContext {
  readonly version: typeof RECORD_VERSION;
  readonly apiOrigin: string;
  readonly credentialSalt: string;
  readonly credentialFingerprint: string;
  readonly session: AuthenticatedSessionContext;
}

export interface SessionContextSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend(): string;
}

export class SessionContextStoreUnavailableError extends Error {
  constructor() {
    super("Protected session context is unavailable");
    this.name = "SessionContextStoreUnavailableError";
  }
}

function parseRecord(value: unknown): StoredAuthenticatedSessionContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 5 ||
    candidate.version !== RECORD_VERSION ||
    typeof candidate.apiOrigin !== "string" ||
    typeof candidate.credentialSalt !== "string" ||
    !BASE64URL_SALT_PATTERN.test(candidate.credentialSalt) ||
    Buffer.from(candidate.credentialSalt, "base64url").length !== FINGERPRINT_SALT_BYTES ||
    typeof candidate.credentialFingerprint !== "string" ||
    !HEX_SHA256_PATTERN.test(candidate.credentialFingerprint)
  ) {
    return null;
  }
  const parsedSession = authenticatedSessionContextSchema.safeParse(candidate.session);
  if (!parsedSession.success) return null;
  return {
    version: RECORD_VERSION,
    apiOrigin: candidate.apiOrigin,
    credentialSalt: candidate.credentialSalt,
    credentialFingerprint: candidate.credentialFingerprint,
    session: parsedSession.data,
  };
}

function fingerprint(apiOrigin: string, salt: Buffer, credential: string): Buffer {
  return createHash("sha256")
    .update(FINGERPRINT_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(apiOrigin, "utf8")
    .update("\0", "utf8")
    .update(salt)
    .update("\0", "utf8")
    .update(credential, "utf8")
    .digest();
}

function decodeCiphertext(source: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(source)) return null;
  const encrypted = Buffer.from(source, "base64url");
  return encrypted.length > 0 && encrypted.toString("base64url") === source ? encrypted : null;
}

/**
 * Stores the last server-validated identity in OS-protected main-process storage. The credential
 * never enters the record: a random-salted SHA-256 digest binds the identity to the exact cookie
 * and configured API origin, and comparison is constant-time after strict record validation.
 */
export class AuthenticatedSessionContextStore {
  readonly #apiOrigin: string;
  readonly #filePath: string;
  readonly #platform: NodeJS.Platform;
  readonly #safeStorage: SessionContextSafeStorage;

  constructor(options: {
    readonly apiOrigin: string;
    readonly platform: NodeJS.Platform;
    readonly safeStorage: SessionContextSafeStorage;
    readonly userDataPath: string;
  }) {
    this.#apiOrigin = options.apiOrigin;
    const originKey = createHash("sha256")
      .update(options.apiOrigin, "utf8")
      .digest("hex")
      .slice(0, 16);
    this.#filePath = path.join(
      options.userDataPath,
      "auth",
      `authenticated-session-${originKey}.bin`,
    );
    this.#platform = options.platform;
    this.#safeStorage = options.safeStorage;
  }

  async load(credential: string): Promise<AuthenticatedSessionContext | null> {
    if (credential === "" || !this.#protectedStorageAvailable()) return null;
    const source = await readBoundedUtf8File(this.#filePath, MAX_RECORD_BYTES);
    if (source === null) return null;

    try {
      const encrypted = decodeCiphertext(source);
      if (encrypted === null) throw new Error("Invalid protected session context");
      const serialized = this.#safeStorage.decryptString(encrypted);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("Invalid protected session context");
      }
      const record = parseRecord(JSON.parse(serialized) as unknown);
      if (record === null || record.apiOrigin !== this.#apiOrigin) {
        throw new Error("Invalid protected session context");
      }
      const salt = Buffer.from(record.credentialSalt, "base64url");
      const expected = Buffer.from(record.credentialFingerprint, "hex");
      const actual = fingerprint(this.#apiOrigin, salt, credential);
      if (!timingSafeEqual(actual, expected)) {
        await this.clear().catch(() => undefined);
        return null;
      }
      return record.session;
    } catch {
      await this.clear().catch(() => undefined);
      return null;
    }
  }

  async replace(input: {
    readonly credential: string;
    readonly session: AuthenticatedSessionContext;
  }): Promise<void> {
    if (input.credential === "" || !this.#protectedStorageAvailable()) {
      throw new SessionContextStoreUnavailableError();
    }
    const session = authenticatedSessionContextSchema.parse(input.session);
    const salt = randomBytes(FINGERPRINT_SALT_BYTES);
    let encrypted: Buffer;
    try {
      encrypted = this.#safeStorage.encryptString(
        JSON.stringify({
          version: RECORD_VERSION,
          apiOrigin: this.#apiOrigin,
          credentialSalt: salt.toString("base64url"),
          credentialFingerprint: fingerprint(this.#apiOrigin, salt, input.credential).toString(
            "hex",
          ),
          session,
        } satisfies StoredAuthenticatedSessionContext),
      );
    } catch {
      throw new SessionContextStoreUnavailableError();
    }
    const source = encrypted.toString("base64url");
    if (
      encrypted.length === 0 ||
      source.length === 0 ||
      Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES
    ) {
      throw new SessionContextStoreUnavailableError();
    }
    try {
      await atomicWrite(this.#filePath, source, syncDirectoryBestEffort);
    } catch {
      throw new SessionContextStoreUnavailableError();
    }
  }

  async clear(): Promise<void> {
    await rm(this.#filePath, { force: true });
  }

  #protectedStorageAvailable(): boolean {
    try {
      if (!this.#safeStorage.isEncryptionAvailable()) return false;
      if (this.#platform !== "linux") return true;
      const backend = this.#safeStorage.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    } catch {
      return false;
    }
  }
}
