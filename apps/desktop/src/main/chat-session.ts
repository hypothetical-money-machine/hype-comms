import {
  apiErrorEnvelopeSchema,
  chatSignInRequestSchema,
  chatIdentitySchema,
  type ChatSessionState,
} from "@hmm-chat/contracts";
import { net, type Session } from "electron";

import { createSessionUrl } from "../shared/api-origin";

const SESSION_COOKIE_NAME = "hmm_chat_session";
const REQUEST_TIMEOUT_MS = 10_000;

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
 * Owns the chat session inside the main process.
 *
 * The access code arrives from the renderer only for the duration of a sign-in call and is never
 * stored. The resulting cookie lives in Electron's cookie jar, which the packaged app encrypts
 * through the `enableCookieEncryption` fuse, so no credential is ever readable by renderer code.
 *
 * The transport-level shape here (sign in, observe state, sign out) is what M1's magic-link flow
 * will also need; only the sign-in call itself is specific to the shared access code.
 */
export class ChatSession {
  readonly #apiOrigin: string;
  readonly #session: Session;
  readonly #sessionUrl: string;
  readonly #listeners = new Set<(state: ChatSessionState) => void>();
  #state: ChatSessionState = { status: "signed-out" };

  constructor(options: { apiOrigin: string; session: Session }) {
    this.#apiOrigin = options.apiOrigin;
    this.#session = options.session;
    this.#sessionUrl = createSessionUrl(options.apiOrigin);
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

  /** Re-reads the session from the server so a stored cookie survives an app restart. */
  async restore(): Promise<ChatSessionState> {
    try {
      const response = await this.#fetch(this.#sessionUrl, { method: "GET" });
      if (!response.ok) {
        this.#setState({ status: "signed-out" });
        return this.#state;
      }
      const session = chatIdentitySchema.parse(await response.json());
      this.#setState({ status: "signed-in", name: session.name });
    } catch {
      // A restore failure is indistinguishable from an unreachable server; stay signed out and
      // let the renderer offer sign-in rather than reporting a hard error at startup.
      this.#setState({ status: "signed-out" });
    }
    return this.#state;
  }

  async signIn(input: { name: string; accessCode: string }): Promise<ChatSessionState> {
    const request = chatSignInRequestSchema.parse(input);

    let response: Response;
    try {
      response = await this.#fetch(this.#sessionUrl, {
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

    this.#setState({ status: "signed-in", name: request.name });
    return this.#state;
  }

  async signOut(): Promise<ChatSessionState> {
    try {
      await this.#fetch(this.#sessionUrl, { method: "DELETE" });
    } catch {
      // Clearing the local cookie below still signs this device out.
    }
    await this.#clearCookie();
    this.#setState({ status: "signed-out" });
    return this.#state;
  }

  /** Cookie header for the websocket, which is opened by `ws` rather than Electron's stack. */
  async cookieHeader(): Promise<string | null> {
    const cookies = await this.#session.cookies.get({
      url: this.#apiOrigin,
      name: SESSION_COOKIE_NAME,
    });
    const cookie = cookies[0];
    return cookie === undefined ? null : `${cookie.name}=${cookie.value}`;
  }

  async #clearCookie(): Promise<void> {
    try {
      await this.#session.cookies.remove(this.#apiOrigin, SESSION_COOKIE_NAME);
    } catch {
      // Nothing to remove.
    }
  }

  /** Authenticated request against the chat API. Redirects are refused, cookies are included. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(url, init);
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    return net.fetch(url, {
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
