import {
  apiErrorEnvelopeSchema,
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
} from "../shared/api-origin";

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
 * Owns the magic-link session inside the main process. Cookies live in Electron's main-process
 * cookie jar, encrypted in packaged builds, and the renderer receives only credential-free state.
 */
export class ChatSession {
  readonly #apiOrigin: string;
  readonly #cookies: SessionCookieStore;
  readonly #request: SessionFetch;
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

  /** Restores the invited member identity from Electron's protected cookie jar. */
  restore(): Promise<ChatSessionState> {
    return this.#runMutation(() => this.#restore());
  }

  async #restore(): Promise<ChatSessionState> {
    try {
      const identityResponse = await this.#fetch(this.#currentUserUrl, { method: "GET" });
      if (identityResponse.ok) {
        const identity = currentUserSchema.parse(await identityResponse.json());
        this.#setState({
          status: "signed-in",
          method: "email",
          name: identity.user.displayName,
          email: identity.email,
          userId: identity.user.id,
          workspaceId: identity.workspaceId,
        });
        return this.#state;
      }
    } catch {
      // Stay signed out when the stored credential cannot be restored.
    }

    await this.#clearCookie(IDENTITY_COOKIE_NAME);
    this.#setState({ status: "signed-out" });
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
        userId: identity.user.id,
        workspaceId: identity.workspaceId,
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
    await this.#deleteSession(this.#identitySessionUrl);
    await this.#clearCookie(IDENTITY_COOKIE_NAME);
    this.#setState({ status: "signed-out" });
    return this.#state;
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
