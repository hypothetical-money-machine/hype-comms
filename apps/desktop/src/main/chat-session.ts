import {
  apiErrorEnvelopeSchema,
  authCapabilitiesSchema,
  authKitLogoutUrlHeaderName,
  authKitLogoutUrlSchema,
  createDesktopAuthorizationRequestSchema,
  createDesktopAuthorizationResponseSchema,
  currentUserSchema,
  exchangeAuthHandoffRequestSchema,
  magicLinkRequestedSchema,
  magicLinkTokenSchema,
  requestMagicLinkSchema,
  type ChatSessionState,
  type AuthCapabilities,
  type AuthKitLogoutUrl,
  type CreateDesktopAuthorizationRequest,
  type CreateDesktopAuthorizationResponse,
  type CurrentUser,
  type ExchangeAuthHandoffRequest,
  type MagicLinkDeliveryState,
  type MagicLinkToken,
} from "@hype-comms/contracts";

import {
  createAuthCapabilitiesUrl,
  createAuthHandoffExchangeUrl,
  createCurrentUserUrl,
  createDesktopAuthorizationUrl,
  createIdentitySessionUrl,
  createMagicLinkUrl,
} from "../shared/api-origin";

const IDENTITY_COOKIE_NAME = "hype_comms_session";
const REQUEST_TIMEOUT_MS = 10_000;
/** Renew a day before the stored credential lapses, so a slow or offline device still recovers. */
const RENEWAL_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Also keeps every armed delay far below the platform timer ceiling. */
const RENEWAL_MAX_DELAY_MS = 12 * 60 * 60 * 1000;
const RENEWAL_MIN_DELAY_MS = 60_000;
const RENEWAL_RETRY_DELAY_MS = 5 * 60_000;
const RENEWAL_MAX_RETRY_DELAY_MS = 60 * 60_000;

export const INVALID_MAGIC_LINK_MESSAGE = "This sign-in link is invalid or has expired";
export const AUTHKIT_FAILED_MESSAGE = "WorkOS sign-in could not be completed. Please try again.";
export const SESSION_UNREACHABLE_MESSAGE =
  "Could not reach the chat server. Your session is preserved.";
export const SESSION_SERVER_ERROR_MESSAGE =
  "The chat server is not responding correctly. Your session is preserved.";

interface SessionCookie {
  readonly name: string;
  readonly value: string;
  /** Seconds since the epoch, as Electron reports cookie expiry. Absent for session cookies. */
  readonly expirationDate?: number;
}

/**
 * Outcome of a single `GET /v1/auth/me` probe. Only an authentication rejection may discard the
 * stored credential; every other outcome leaves the device session intact.
 */
type IdentityProbe =
  | { readonly status: "identified"; readonly identity: CurrentUser }
  /** `401`, this endpoint's only credential refusal; one rotation may still recover it. */
  | { readonly status: "expired" }
  /** The request never completed: offline, no server yet, or the request timeout. */
  | { readonly status: "unreachable" }
  /** The service answered, but not usefully: `403`, `5xx`, an odd status, or an invalid body. */
  | { readonly status: "failed" };

/** The credential-preserving state published when no verdict on the credential was reached. */
type SessionUnavailableState = Extract<ChatSessionState, { status: "session-unavailable" }>;

/**
 * Whether an unsuccessful response is this service refusing the credential or token that produced
 * it. Only a `401` is: both the identity endpoint (`requireAuthenticatedIdentity`) and the
 * magic-link exchange answer `401` when they reject what was supplied. Every other status comes
 * from somewhere else and a still-valid credential survives it — a `403` from an allowed-origin,
 * workspace, proxy, or gateway check; a `409` when the workspace is at capacity; a `404` or `405`
 * from a partial deploy or rollback; a `408` or `429` from a slow or rate-limited edge; any `5xx`.
 * Discarding the stored credential on one of those would sign a working device out for good.
 */
function isCredentialRefusal(status: number): boolean {
  return status === 401;
}

/** Neither outcome is a verdict on the credential, so both keep it and invite a retry. */
function unavailableState(status: "unreachable" | "failed"): SessionUnavailableState {
  if (status === "unreachable") {
    return {
      status: "session-unavailable",
      reason: "server_unreachable",
      message: SESSION_UNREACHABLE_MESSAGE,
    };
  }
  return {
    status: "session-unavailable",
    reason: "server_error",
    message: SESSION_SERVER_ERROR_MESSAGE,
  };
}

export interface SessionCookieStore {
  readonly get: (filter: {
    readonly url: string;
    readonly name: string;
  }) => Promise<SessionCookie[]>;
  readonly remove: (url: string, name: string) => Promise<void>;
}

export type SessionFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ChatSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSessionError";
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = apiErrorEnvelopeSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Owns the magic-link session inside the main process. Cookies live in Electron's main-process
 * cookie jar, encrypted in packaged builds, and the renderer receives only credential-free state.
 */
export class ChatSession {
  readonly #apiOrigin: string;
  readonly #cookies: SessionCookieStore;
  readonly #request: SessionFetch;
  readonly #identitySessionUrl: string;
  readonly #authCapabilitiesUrl: string;
  readonly #authHandoffExchangeUrl: string;
  readonly #desktopAuthorizationUrl: string;
  readonly #sessionRefreshUrl: string;
  readonly #currentUserUrl: string;
  readonly #magicLinkUrl: string;
  readonly #listeners = new Set<(state: ChatSessionState) => void>();
  #mutation: Promise<void> = Promise.resolve();
  #state: ChatSessionState = { status: "signed-out" };
  #renewalTimer: ReturnType<typeof setTimeout> | null = null;
  #renewalFailures = 0;
  #logoutUrl: AuthKitLogoutUrl | null = null;

  constructor(options: { apiOrigin: string; cookies: SessionCookieStore; request: SessionFetch }) {
    this.#apiOrigin = options.apiOrigin;
    this.#cookies = options.cookies;
    this.#request = options.request;
    this.#identitySessionUrl = createIdentitySessionUrl(options.apiOrigin);
    this.#authCapabilitiesUrl = createAuthCapabilitiesUrl(options.apiOrigin);
    this.#authHandoffExchangeUrl = createAuthHandoffExchangeUrl(options.apiOrigin);
    this.#desktopAuthorizationUrl = createDesktopAuthorizationUrl(options.apiOrigin);
    this.#sessionRefreshUrl = new URL("/v1/auth/session/refresh", options.apiOrigin).href;
    this.#currentUserUrl = createCurrentUserUrl(options.apiOrigin);
    this.#magicLinkUrl = createMagicLinkUrl(options.apiOrigin);
  }

  get state(): ChatSessionState {
    return this.#state;
  }

  get apiOrigin(): string {
    return this.#apiOrigin;
  }

  subscribe(listener: (state: ChatSessionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(state: ChatSessionState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  #runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Restores the invited member identity from Electron's protected cookie jar. */
  restore(): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#restore());
  }

  async #restore(): Promise<ChatSessionState> {
    let probe = await this.#probeIdentity();
    // A `401` gets exactly one credential rotation before this device pauses for login.
    if (probe.status === "expired" && (await this.#rotateSession())) {
      probe = await this.#probeIdentity();
    }

    switch (probe.status) {
      case "identified": {
        this.#applySignedIn(probe.identity);
        await this.#scheduleRenewal();
        return this.#state;
      }
      case "expired": {
        // The only outcome that discards a stored credential: the service refused it.
        this.#stopRenewal();
        await this.#clearCookie(IDENTITY_COOKIE_NAME);
        this.#setState({ status: "signed-out" });
        return this.#state;
      }
      default: {
        // Unreachable or answering unusably. Neither says the credential is bad, so it stays.
        this.#setState(unavailableState(probe.status));
        return this.#state;
      }
    }
  }

  /** Reads the signed-in identity without ever letting a transient failure look like a sign-out. */
  async #probeIdentity(): Promise<IdentityProbe> {
    let response: Response;
    try {
      response = await this.#fetch(this.#currentUserUrl, { method: "GET" });
    } catch {
      // Offline, a server that is not listening yet, or the request timeout aborting.
      return { status: "unreachable" };
    }

    // `401` is the only refusal this endpoint has (`requireAuthenticatedIdentity`); a `403` here
    // comes from an origin or gateway check, and every other status is just a failure.
    if (!response.ok) {
      return isCredentialRefusal(response.status) ? { status: "expired" } : { status: "failed" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "failed" };
    }

    const identity = currentUserSchema.safeParse(body);
    return identity.success
      ? { status: "identified", identity: identity.data }
      : { status: "failed" };
  }

  #applySignedIn(identity: CurrentUser): void {
    this.#logoutUrl = null;
    this.#setState({
      status: "signed-in",
      method: "email",
      name: identity.user.displayName,
      email: identity.email,
      userId: identity.user.id,
      workspaceId: identity.workspaceId,
    });
  }

  async requestMagicLink(input: { email: string }): Promise<MagicLinkDeliveryState> {
    const request = requestMagicLinkSchema.parse(input);

    let response: Response;
    try {
      response = await this.#fetch(this.#magicLinkUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      throw new ChatSessionError("Could not reach the chat server");
    }

    if (response.status === 202) {
      magicLinkRequestedSchema.parse(await response.json());
      return { status: "email-sent" };
    }

    const message = await readErrorMessage(response, "Could not request a sign-in link");
    if (response.status === 503) {
      return { status: "administrator-delivery", message };
    }

    throw new ChatSessionError(message);
  }

  /** Older servers have no discovery endpoint, so their existing magic-link path remains usable. */
  async getAuthCapabilities(): Promise<AuthCapabilities> {
    let response: Response;
    try {
      response = await this.#fetch(this.#authCapabilitiesUrl, { method: "GET" });
    } catch {
      throw new ChatSessionError("Could not reach the chat server");
    }
    if (response.status === 404) {
      return { authKit: false, magicLink: true };
    }
    if (!response.ok) {
      throw new ChatSessionError("Could not load sign-in options");
    }
    try {
      return authCapabilitiesSchema.parse(await response.json());
    } catch {
      throw new ChatSessionError("The chat server returned invalid sign-in options");
    }
  }

  async beginDesktopAuthorization(
    input: CreateDesktopAuthorizationRequest,
  ): Promise<CreateDesktopAuthorizationResponse> {
    const request = createDesktopAuthorizationRequestSchema.parse(input);
    let response: Response;
    try {
      response = await this.#fetch(this.#desktopAuthorizationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      throw new ChatSessionError("Could not reach the authentication service");
    }
    if (!response.ok) {
      throw new ChatSessionError(
        await readErrorMessage(response, "Could not start WorkOS sign-in"),
      );
    }
    try {
      return createDesktopAuthorizationResponseSchema.parse(await response.json());
    } catch {
      throw new ChatSessionError("The authentication service returned an invalid response");
    }
  }

  exchangeAuthKitHandoff(input: ExchangeAuthHandoffRequest): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#exchangeAuthKitHandoff(input));
  }

  async #exchangeAuthKitHandoff(input: ExchangeAuthHandoffRequest): Promise<ChatSessionState> {
    const handoff = exchangeAuthHandoffRequestSchema.parse(input);
    let response: Response;
    try {
      response = await this.#fetch(this.#authHandoffExchangeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(handoff),
      });
    } catch {
      return this.#failAuthKitSignIn();
    }
    if (!response.ok) {
      return this.#failAuthKitSignIn();
    }

    let identity: CurrentUser;
    try {
      identity = currentUserSchema.parse(await response.json());
    } catch {
      return this.#failAuthKitSignIn();
    }
    this.#applySignedIn(identity);
    await this.#scheduleRenewal();
    return this.#state;
  }

  reportAuthKitFailure(): void {
    if (this.#state.status !== "signed-in") {
      this.#setState({ status: "signed-out", message: AUTHKIT_FAILED_MESSAGE });
    }
  }

  #failAuthKitSignIn(): never {
    this.reportAuthKitFailure();
    throw new ChatSessionError(AUTHKIT_FAILED_MESSAGE);
  }

  exchangeMagicLink(token: MagicLinkToken): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#exchangeMagicLink(token));
  }

  async #exchangeMagicLink(token: MagicLinkToken): Promise<ChatSessionState> {
    const parsed = magicLinkTokenSchema.safeParse(token);
    if (!parsed.success) {
      return this.#rejectMagicLink();
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#identitySessionUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: parsed.data }),
      });
    } catch {
      // Offline or timed out. The link may still be good, and the stored credential certainly is.
      return this.#failMagicLink("unreachable");
    }

    if (!response.ok) {
      // Only a refusal of the supplied link discards the credential, and this endpoint refuses one
      // with a `401`. Every other status refuses the *request*, not the link: a `409` when the
      // workspace is at capacity, a `404` or `405` mid-deploy or rollback, a `408` or `429` from a
      // slow or rate-limited edge, a `403` from an origin or gateway check, a `5xx` from the
      // service. None of them says anything about the credential in the jar, so that one stays.
      return isCredentialRefusal(response.status)
        ? this.#rejectMagicLink()
        : this.#failMagicLink("failed");
    }

    let identity: CurrentUser;
    try {
      identity = currentUserSchema.parse(await response.json());
    } catch {
      // The exchange may well have succeeded; a body this device cannot read is not a refusal.
      return this.#failMagicLink("failed");
    }

    this.#applySignedIn(identity);
    await this.#scheduleRenewal();
    return this.#state;
  }

  /** The service refused the link: the only exchange outcome that discards the credential. */
  async #rejectMagicLink(): Promise<never> {
    this.#stopRenewal();
    await this.#clearCookie(IDENTITY_COOKIE_NAME);
    this.#setState({ status: "signed-out", message: INVALID_MAGIC_LINK_MESSAGE });
    throw new ChatSessionError(INVALID_MAGIC_LINK_MESSAGE);
  }

  /**
   * Reports an exchange that reached no verdict. The stored credential and any armed renewal are
   * left untouched, so a retry can still recover the session this device already had.
   */
  #failMagicLink(status: "unreachable" | "failed"): never {
    const state = unavailableState(status);
    this.#setState(state);
    throw new ChatSessionError(state.message);
  }

  signOut(): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#signOut());
  }

  async #signOut(): Promise<ChatSessionState> {
    this.#stopRenewal();
    this.#logoutUrl = null;
    const logoutUrl = await this.#deleteSession(this.#identitySessionUrl);
    await this.#clearCookie(IDENTITY_COOKIE_NAME);
    this.#logoutUrl = logoutUrl;
    this.#setState({ status: "signed-out" });
    return this.#state;
  }

  /** Returns the provider logout target once without adding it to renderer-visible session state. */
  consumeLogoutUrl(): AuthKitLogoutUrl | null {
    const logoutUrl = this.#logoutUrl;
    this.#logoutUrl = null;
    return logoutUrl;
  }

  /**
   * Rotates the stored credential before it expires. Each rotation slides the 30-day window
   * forward, so an actively used device is never signed out mid-use. Serialized on the same
   * mutation chain as restore, exchange, and sign-out.
   */
  renewSession(): Promise<void> {
    return this.#runMutation(() => this.#renewSession());
  }

  async #renewSession(): Promise<void> {
    if (this.#state.status === "signed-out") {
      this.#stopRenewal();
      return;
    }

    if (await this.#rotateSession()) {
      this.#renewalFailures = 0;
      await this.#scheduleRenewal();
      return;
    }

    // A failed renewal is never an escalation: the credential stays in the jar and we try again.
    // A credential the service has genuinely rejected is discarded by the next authenticated
    // request instead (`markSignedOut`) or by the next restore.
    this.#renewalFailures += 1;
    const backoff = RENEWAL_RETRY_DELAY_MS * 2 ** (this.#renewalFailures - 1);
    this.#armRenewal(Math.min(backoff, RENEWAL_MAX_RETRY_DELAY_MS));
  }

  /** Performs one credential rotation. Returns false when it could not be completed. */
  async #rotateSession(): Promise<boolean> {
    try {
      const response = await this.#fetch(this.#sessionRefreshUrl, { method: "POST" });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #scheduleRenewal(): Promise<void> {
    const expiresAt = await this.#readIdentityExpiry();
    this.#armRenewal(
      expiresAt === null ? RENEWAL_MAX_DELAY_MS : expiresAt - RENEWAL_MARGIN_MS - Date.now(),
    );
  }

  #armRenewal(delayMs: number): void {
    this.#stopRenewal();
    const delay = Math.min(Math.max(delayMs, RENEWAL_MIN_DELAY_MS), RENEWAL_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      this.#renewalTimer = null;
      void this.renewSession();
    }, delay);
    // A pending renewal must never hold the Electron main process open at quit.
    timer.unref?.();
    this.#renewalTimer = timer;
  }

  /** Cancels any pending renewal. Safe to call repeatedly; also the teardown entry point. */
  stop(): void {
    this.#stopRenewal();
  }

  #stopRenewal(): void {
    if (this.#renewalTimer !== null) {
      clearTimeout(this.#renewalTimer);
      this.#renewalTimer = null;
    }
  }

  /** Milliseconds since the epoch at which the stored credential lapses, when the jar knows. */
  async #readIdentityExpiry(): Promise<number | null> {
    try {
      const cookies = await this.#cookies.get({
        url: this.#apiOrigin,
        name: IDENTITY_COOKIE_NAME,
      });
      const stored = cookies.find((cookie) => cookie.name === IDENTITY_COOKIE_NAME);
      const expirationDate = stored?.expirationDate;
      return expirationDate === undefined ? null : expirationDate * 1000;
    } catch {
      return null;
    }
  }

  async #deleteSession(url: string): Promise<AuthKitLogoutUrl | null> {
    try {
      const response = await this.#fetch(url, { method: "DELETE" });
      if (!response.ok) return null;
      const parsed = authKitLogoutUrlSchema.safeParse(
        response.headers.get(authKitLogoutUrlHeaderName),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      // Local cookie removal still signs this device out of that method.
      return null;
    }
  }

  async #clearCookie(name: string): Promise<void> {
    try {
      await this.#cookies.remove(this.#apiOrigin, name);
    } catch {
      // Nothing to remove.
    }
  }

  /** Authenticated request against the chat API. Redirects are refused, cookies are included. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(url, init);
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    return this.#request(url, {
      ...init,
      cache: "no-store",
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** Marks the session as ended after the server rejects an authenticated request. */
  markSignedOut(): void {
    this.#stopRenewal();
    if (this.#state.status !== "signed-out") {
      this.#setState({ status: "signed-out" });
    }
  }
}
