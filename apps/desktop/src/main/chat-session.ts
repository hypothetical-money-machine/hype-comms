import {
  apiErrorEnvelopeSchema,
  chatIdentitySchema,
  chatSignInRequestSchema,
  currentUserSchema,
  magicLinkRequestedSchema,
  magicLinkTokenSchema,
  requestMagicLinkSchema,
  type ChatSessionState,
  type MagicLinkDeliveryState,
  type MagicLinkToken,
} from "@hmm-chat/contracts";

import {
  createCurrentUserUrl,
  createIdentitySessionUrl,
  createMagicLinkUrl,
  createSessionUrl,
} from "../shared/api-origin";

const ACCESS_CODE_COOKIE_NAME = "hmm_chat_session";
const IDENTITY_COOKIE_NAME = "hmm_session";
const REQUEST_TIMEOUT_MS = 10_000;
export const INVALID_MAGIC_LINK_MESSAGE = "This sign-in link is invalid or has expired";

interface SessionCookie {
  readonly name: string;
  readonly value: string;
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
 * Owns both supported chat credentials inside the main process.
 *
 * Access codes and magic-link tokens exist only for the duration of their sign-in calls. Cookies
 * live in Electron's main-process cookie jar, encrypted in packaged builds, and the renderer only
 * receives the credential-free state defined in the contracts package.
 */
export class ChatSession {
  readonly #apiOrigin: string;
  readonly #cookies: SessionCookieStore;
  readonly #request: SessionFetch;
  readonly #accessSessionUrl: string;
  readonly #identitySessionUrl: string;
  readonly #currentUserUrl: string;
  readonly #magicLinkUrl: string;
  readonly #listeners = new Set<(state: ChatSessionState) => void>();
  #mutation: Promise<void> = Promise.resolve();
  #state: ChatSessionState = { status: "signed-out" };

  constructor(options: { apiOrigin: string; cookies: SessionCookieStore; request: SessionFetch }) {
    this.#apiOrigin = options.apiOrigin;
    this.#cookies = options.cookies;
    this.#request = options.request;
    this.#accessSessionUrl = createSessionUrl(options.apiOrigin);
    this.#identitySessionUrl = createIdentitySessionUrl(options.apiOrigin);
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

  /** Restores identity first, then the legacy access-code session. The first success wins. */
  restore(): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#restore());
  }

  async #restore(): Promise<ChatSessionState> {
    try {
      const identityResponse = await this.#fetch(this.#currentUserUrl, { method: "GET" });
      if (identityResponse.ok) {
        const identity = currentUserSchema.parse(await identityResponse.json());
        await this.#clearCookie(ACCESS_CODE_COOKIE_NAME);
        this.#setState({
          status: "signed-in",
          method: "email",
          name: identity.user.displayName,
          email: identity.email,
        });
        return this.#state;
      }
    } catch {
      // Try the access-code session next.
    }

    try {
      const accessResponse = await this.#fetch(this.#accessSessionUrl, { method: "GET" });
      if (accessResponse.ok) {
        const session = chatIdentitySchema.parse(await accessResponse.json());
        await this.#clearCookie(IDENTITY_COOKIE_NAME);
        this.#setState({
          status: "signed-in",
          method: "access-code",
          name: session.name,
        });
        return this.#state;
      }
    } catch {
      // Stay signed out when neither stored credential can be restored.
    }

    await Promise.all([
      this.#clearCookie(ACCESS_CODE_COOKIE_NAME),
      this.#clearCookie(IDENTITY_COOKIE_NAME),
    ]);
    this.#setState({ status: "signed-out" });
    return this.#state;
  }

  signIn(input: { name: string; accessCode: string }): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#signIn(input));
  }

  async #signIn(input: { name: string; accessCode: string }): Promise<ChatSessionState> {
    const request = chatSignInRequestSchema.parse(input);
    await this.#discardIdentitySession();

    let response: Response;
    try {
      response = await this.#fetch(this.#accessSessionUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      throw new ChatSessionError("Could not reach the chat server");
    }

    if (!response.ok) {
      throw new ChatSessionError(
        await readErrorMessage(
          response,
          response.status === 429
            ? "Too many sign-in attempts. Try again later."
            : "Name or access code is invalid",
        ),
      );
    }

    this.#setState({
      status: "signed-in",
      method: "access-code",
      name: request.name,
    });
    return this.#state;
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

  exchangeMagicLink(token: MagicLinkToken): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#exchangeMagicLink(token));
  }

  async #exchangeMagicLink(token: MagicLinkToken): Promise<ChatSessionState> {
    const parsed = magicLinkTokenSchema.safeParse(token);
    if (!parsed.success) {
      return this.#rejectMagicLink();
    }

    await this.#discardAccessSession();

    let response: Response;
    try {
      response = await this.#fetch(this.#identitySessionUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: parsed.data }),
      });
    } catch {
      return this.#rejectMagicLink();
    }

    if (!response.ok) {
      return this.#rejectMagicLink();
    }

    try {
      const identity = currentUserSchema.parse(await response.json());
      this.#setState({
        status: "signed-in",
        method: "email",
        name: identity.user.displayName,
        email: identity.email,
      });
      return this.#state;
    } catch {
      return this.#rejectMagicLink();
    }
  }

  async #rejectMagicLink(): Promise<never> {
    await this.#clearCookie(IDENTITY_COOKIE_NAME);
    this.#setState({ status: "signed-out", message: INVALID_MAGIC_LINK_MESSAGE });
    throw new ChatSessionError(INVALID_MAGIC_LINK_MESSAGE);
  }

  signOut(): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#signOut());
  }

  async #signOut(): Promise<ChatSessionState> {
    await Promise.all([
      this.#deleteSession(this.#accessSessionUrl),
      this.#deleteSession(this.#identitySessionUrl),
    ]);
    await Promise.all([
      this.#clearCookie(ACCESS_CODE_COOKIE_NAME),
      this.#clearCookie(IDENTITY_COOKIE_NAME),
    ]);
    this.#setState({ status: "signed-out" });
    return this.#state;
  }

  /** Cookie header for the websocket, which is opened by `ws` rather than Electron's stack. */
  async cookieHeader(): Promise<string | null> {
    const preferredNames =
      this.#state.status === "signed-in" && this.#state.method === "access-code"
        ? [ACCESS_CODE_COOKIE_NAME, IDENTITY_COOKIE_NAME]
        : [IDENTITY_COOKIE_NAME, ACCESS_CODE_COOKIE_NAME];

    for (const name of preferredNames) {
      const cookies = await this.#cookies.get({ url: this.#apiOrigin, name });
      const cookie = cookies[0];
      if (cookie !== undefined) {
        return `${cookie.name}=${cookie.value}`;
      }
    }
    return null;
  }

  async #discardIdentitySession(): Promise<void> {
    await this.#deleteSession(this.#identitySessionUrl);
    await this.#clearCookie(IDENTITY_COOKIE_NAME);
  }

  async #discardAccessSession(): Promise<void> {
    await this.#deleteSession(this.#accessSessionUrl);
    await this.#clearCookie(ACCESS_CODE_COOKIE_NAME);
  }

  async #deleteSession(url: string): Promise<void> {
    try {
      await this.#fetch(url, { method: "DELETE" });
    } catch {
      // Local cookie removal still signs this device out of that method.
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
    if (this.#state.status !== "signed-out") {
      this.#setState({ status: "signed-out" });
    }
  }
}
