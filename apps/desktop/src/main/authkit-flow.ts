import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  authDesktopStateSchema,
  authPkceCodeChallengeSchema,
  authPkceCodeVerifierSchema,
  createDesktopAuthorizationResponseSchema,
  desktopAuthVariantSchema,
  desktopAuthCallbackParametersSchema,
  isoDateTimeSchema,
  type AuthDesktopState,
  type AuthPkceCodeVerifier,
  type CreateDesktopAuthorizationRequest,
  type CreateDesktopAuthorizationResponse,
  type DesktopAuthVariant,
  type DesktopAuthCallbackParameters,
} from "@hype-comms/contracts";

import { normalizeDevelopmentApiOrigin } from "../shared/api-origin";
import { normalizeExternalHttpsUrl } from "./security";

export const AUTHKIT_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
export const AUTHKIT_MAX_AUTHORIZATION_TTL_MS = 15 * 60 * 1_000;

export interface StoredAuthKitPendingAuthorization {
  readonly version: 1;
  readonly apiOrigin: string;
  readonly state: AuthDesktopState;
  readonly codeVerifier: AuthPkceCodeVerifier;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Pending state contains the PKCE verifier and therefore must be protected by an OS-backed store.
 * Implementations must make `save` durable before it resolves and make `clear` idempotent.
 */
export interface AuthKitPendingAuthorizationStore {
  load(): Promise<StoredAuthKitPendingAuthorization | null>;
  save(pending: StoredAuthKitPendingAuthorization): Promise<void>;
  clear(): Promise<void>;
}

export interface AuthKitAuthorizationApi {
  beginDesktopAuthorization(
    request: CreateDesktopAuthorizationRequest,
  ): Promise<CreateDesktopAuthorizationResponse>;
}

export type AuthKitHandoffCallback = Extract<
  DesktopAuthCallbackParameters,
  { readonly code: string }
>;

/** The caller owns the one-shot server exchange and all resulting session state. */
export interface ValidatedAuthKitHandoff {
  readonly callback: AuthKitHandoffCallback;
  readonly codeVerifier: AuthPkceCodeVerifier;
}

export type AuthKitCallbackOutcome =
  | { readonly status: "ignored" }
  | { readonly status: "expired" }
  | { readonly status: "authentication_failed" }
  | { readonly status: "handoff"; readonly handoff: ValidatedAuthKitHandoff };

export type AuthKitFlowStatus =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly expiresAt: string }
  | { readonly status: "expired" };

export interface AuthKitAuthorizationAttempt {
  readonly state: AuthDesktopState;
  readonly expiresAt: string;
}

export interface AuthKitFlowOptions {
  readonly api: AuthKitAuthorizationApi;
  readonly apiOrigin: string;
  readonly authVariant: DesktopAuthVariant;
  readonly authorizationTtlMs?: number;
  readonly now?: () => Date;
  readonly openExternal: (url: string) => Promise<void>;
  readonly store: AuthKitPendingAuthorizationStore;
}

export class AuthKitAuthorizationUrlError extends Error {
  constructor() {
    super("The authentication service returned an invalid authorization URL");
    this.name = "AuthKitAuthorizationUrlError";
  }
}

export class AuthKitAuthorizationExpiredError extends Error {
  constructor() {
    super("The AuthKit authorization attempt expired");
    this.name = "AuthKitAuthorizationExpiredError";
  }
}

export class AuthKitPendingAuthorizationCorruptError extends Error {
  constructor() {
    super("Stored AuthKit authorization data is invalid");
    this.name = "AuthKitPendingAuthorizationCorruptError";
  }
}

export function parseStoredAuthKitPendingAuthorization(
  value: unknown,
  apiOrigin: string,
): StoredAuthKitPendingAuthorization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthKitPendingAuthorizationCorruptError();
  }

  const candidate = value as Partial<StoredAuthKitPendingAuthorization>;
  const keys = Object.keys(value);
  const createdAt =
    isoDateTimeSchema.safeParse(candidate.createdAt).success &&
    typeof candidate.createdAt === "string"
      ? Date.parse(candidate.createdAt)
      : Number.NaN;
  const expiresAt =
    isoDateTimeSchema.safeParse(candidate.expiresAt).success &&
    typeof candidate.expiresAt === "string"
      ? Date.parse(candidate.expiresAt)
      : Number.NaN;
  if (
    keys.length !== 6 ||
    !keys.every((key) =>
      ["version", "apiOrigin", "state", "codeVerifier", "createdAt", "expiresAt"].includes(key),
    ) ||
    candidate.version !== 1 ||
    candidate.apiOrigin !== apiOrigin ||
    !authDesktopStateSchema.safeParse(candidate.state).success ||
    !authPkceCodeVerifierSchema.safeParse(candidate.codeVerifier).success ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > AUTHKIT_MAX_AUTHORIZATION_TTL_MS
  ) {
    throw new AuthKitPendingAuthorizationCorruptError();
  }

  return candidate as StoredAuthKitPendingAuthorization;
}

/**
 * Owns only the short-lived native authorization transaction. Session exchange and persistence
 * deliberately remain with the caller so this can be integrated with the existing Hype Comms
 * session.
 */
export class AuthKitFlow {
  readonly #api: AuthKitAuthorizationApi;
  readonly #apiOrigin: string;
  readonly #authVariant: DesktopAuthVariant;
  readonly #authorizationTtlMs: number;
  readonly #now: () => Date;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #store: AuthKitPendingAuthorizationStore;
  #expiryGeneration = 0;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #initialized = false;
  #initializationPromise: Promise<AuthKitFlowStatus> | null = null;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #pending: StoredAuthKitPendingAuthorization | null = null;
  #startPromise: Promise<AuthKitAuthorizationAttempt> | null = null;

  constructor(options: AuthKitFlowOptions) {
    const apiOrigin = normalizeDevelopmentApiOrigin(options.apiOrigin);
    if (apiOrigin === null) {
      throw new TypeError("AuthKit flow requires a safe API origin");
    }
    const authorizationTtlMs = options.authorizationTtlMs ?? AUTHKIT_AUTHORIZATION_TTL_MS;
    if (
      !Number.isSafeInteger(authorizationTtlMs) ||
      authorizationTtlMs <= 0 ||
      authorizationTtlMs > AUTHKIT_MAX_AUTHORIZATION_TTL_MS
    ) {
      throw new RangeError("Invalid AuthKit authorization lifetime");
    }

    this.#api = options.api;
    this.#apiOrigin = apiOrigin;
    this.#authVariant = desktopAuthVariantSchema.parse(options.authVariant);
    this.#authorizationTtlMs = authorizationTtlMs;
    this.#now = options.now ?? (() => new Date());
    this.#openExternal = options.openExternal;
    this.#store = options.store;
  }

  initialize(): Promise<AuthKitFlowStatus> {
    if (this.#initializationPromise === null) {
      const initialization = this.#enqueueLifecycle(() => this.#initialize());
      this.#initializationPromise = initialization.then(
        (status) => {
          this.#initializationPromise = null;
          return status;
        },
        (error: unknown) => {
          this.#initializationPromise = null;
          throw error;
        },
      );
    }
    return this.#initializationPromise;
  }

  start(): Promise<AuthKitAuthorizationAttempt> {
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }

    const start = this.#enqueueLifecycle(() => this.#start());
    this.#startPromise = start.finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  handleCallback(callback: DesktopAuthCallbackParameters): Promise<AuthKitCallbackOutcome> {
    return this.#enqueueLifecycle(() => this.#handleCallback(callback));
  }

  cancel(): Promise<boolean> {
    return this.#enqueueLifecycle(async () => {
      await this.#ensureInitialized();
      const pending = this.#pending;
      if (pending === null) {
        return false;
      }
      await this.#retire(pending.state);
      return true;
    });
  }

  dispose(): void {
    this.#cancelExpiryTimer();
  }

  async #initialize(): Promise<AuthKitFlowStatus> {
    if (this.#initialized) {
      const pending = this.#pending;
      if (pending !== null && this.#isExpired(pending)) {
        await this.#retire(pending.state);
        return { status: "expired" };
      }
      if (pending !== null) {
        this.#scheduleExpiry(pending);
      }
      return this.#currentStatus();
    }

    const loaded = await this.#store.load();
    const pending =
      loaded === null ? null : parseStoredAuthKitPendingAuthorization(loaded, this.#apiOrigin);
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) {
      throw new RangeError("Invalid AuthKit authorization clock value");
    }
    if (
      pending !== null &&
      Date.parse(pending.expiresAt) - now > AUTHKIT_MAX_AUTHORIZATION_TTL_MS
    ) {
      throw new AuthKitPendingAuthorizationCorruptError();
    }
    this.#pending = pending;
    if (pending === null) {
      this.#initialized = true;
      return { status: "idle" };
    }

    if (this.#isExpired(pending)) {
      await this.#retire(pending.state);
      this.#initialized = true;
      return { status: "expired" };
    }

    this.#initialized = true;
    this.#scheduleExpiry(pending);
    return { status: "pending", expiresAt: pending.expiresAt };
  }

  async #ensureInitialized(): Promise<AuthKitFlowStatus> {
    if (this.#initialized) {
      return this.#currentStatus();
    }
    return this.#initialize();
  }

  async #start(): Promise<AuthKitAuthorizationAttempt> {
    await this.#ensureInitialized();
    if (this.#pending !== null) {
      await this.#retire(this.#pending.state);
    }

    const createdAt = this.#now();
    if (!Number.isFinite(createdAt.getTime())) {
      throw new RangeError("Invalid AuthKit authorization clock value");
    }

    const state = authDesktopStateSchema.parse(randomBytes(32).toString("base64url"));
    const codeVerifier = authPkceCodeVerifierSchema.parse(randomBytes(32).toString("base64url"));
    const codeChallenge = authPkceCodeChallengeSchema.parse(
      createHash("sha256").update(codeVerifier, "ascii").digest("base64url"),
    );
    const pending: StoredAuthKitPendingAuthorization = {
      version: 1,
      apiOrigin: this.#apiOrigin,
      state,
      codeVerifier,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.#authorizationTtlMs).toISOString(),
    };

    await this.#store.save(pending);
    this.#pending = pending;
    this.#scheduleExpiry(pending);

    try {
      const authorization = await this.#api.beginDesktopAuthorization({
        codeChallenge,
        state,
        ...(this.#authVariant === "development" ? { variant: this.#authVariant } : {}),
      });
      if (this.#isExpired(pending)) {
        throw new AuthKitAuthorizationExpiredError();
      }
      const response = createDesktopAuthorizationResponseSchema.safeParse(authorization);
      const authorizationUrl = response.success
        ? normalizeExternalHttpsUrl(response.data.authorizationUrl)
        : null;
      if (authorizationUrl === null) {
        throw new AuthKitAuthorizationUrlError();
      }
      await this.#openExternal(authorizationUrl);
      if (this.#isExpired(pending)) {
        throw new AuthKitAuthorizationExpiredError();
      }
    } catch (error) {
      await this.#retire(state);
      throw error;
    }

    return { state, expiresAt: pending.expiresAt };
  }

  async #handleCallback(callback: DesktopAuthCallbackParameters): Promise<AuthKitCallbackOutcome> {
    const initialized = await this.#ensureInitialized();
    if (initialized.status === "expired") {
      return { status: "expired" };
    }
    const parsed = desktopAuthCallbackParametersSchema.safeParse(callback);
    const pending = this.#pending;
    if (!parsed.success || pending === null || !securelyEqual(parsed.data.state, pending.state)) {
      return { status: "ignored" };
    }

    if (this.#isExpired(pending)) {
      await this.#retire(pending.state);
      return { status: "expired" };
    }

    await this.#retire(pending.state);
    if ("error" in parsed.data) {
      return { status: "authentication_failed" };
    }

    return {
      status: "handoff",
      handoff: {
        callback: parsed.data,
        codeVerifier: pending.codeVerifier,
      },
    };
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycleTail.then(operation);
    this.#lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #currentStatus(): AuthKitFlowStatus {
    return this.#pending === null
      ? { status: "idle" }
      : { status: "pending", expiresAt: this.#pending.expiresAt };
  }

  #isExpired(pending: StoredAuthKitPendingAuthorization): boolean {
    return Date.parse(pending.expiresAt) <= this.#now().getTime();
  }

  async #expire(expectedState: AuthDesktopState): Promise<void> {
    const pending = this.#pending;
    if (pending === null || !securelyEqual(pending.state, expectedState)) {
      return;
    }
    if (!this.#isExpired(pending)) {
      this.#scheduleExpiry(pending);
      return;
    }
    await this.#retire(expectedState);
  }

  async #retire(expectedState: AuthDesktopState): Promise<void> {
    const pending = this.#pending;
    if (pending === null || !securelyEqual(pending.state, expectedState)) {
      return;
    }
    await this.#store.clear();
    this.#pending = null;
    this.#cancelExpiryTimer();
  }

  #scheduleExpiry(pending: StoredAuthKitPendingAuthorization): void {
    this.#cancelExpiryTimer();
    const generation = this.#expiryGeneration;
    const delay = Math.min(
      AUTHKIT_MAX_AUTHORIZATION_TTL_MS,
      Math.max(0, Date.parse(pending.expiresAt) - this.#now().getTime()),
    );
    const timer = setTimeout(() => {
      if (generation === this.#expiryGeneration) {
        this.#expiryTimer = null;
      }
      void this.#enqueueLifecycle(() => this.#expire(pending.state)).catch(() => undefined);
    }, delay);
    timer.unref();
    this.#expiryTimer = timer;
  }

  #cancelExpiryTimer(): void {
    this.#expiryGeneration += 1;
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }
}

function securelyEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
