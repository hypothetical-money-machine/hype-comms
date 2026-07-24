import { randomUUID } from "node:crypto";

import {
  apiErrorEnvelopeSchema,
  createChatMessageRequestSchema,
  chatHistorySchema,
  chatMessageEventSchema,
  chatMessageSchema,
  type ChatMessage,
} from "@hmm-chat/contracts";
import WebSocket, { type RawData } from "ws";

import { createWelcomeMessagesUrl, createWelcomeRealtimeUrl } from "../shared/api-origin";
import type { ChatSession } from "./chat-session";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class ChatTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ChatTransportError";
  }
}

/**
 * Authenticated access to the #welcome channel.
 *
 * Every call goes through the session so that the cookie stays in the main process. A 401 marks
 * the session signed out rather than retrying, which surfaces an expired or revoked session in the
 * renderer instead of looping.
 */
export class ChatTransport {
  readonly #session: ChatSession;
  readonly #messagesUrl: string;
  readonly #realtimeUrl: string;
  readonly #rendererOrigin: string;
  readonly #onMessage: (message: ChatMessage) => void;
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  #stopped = true;

  constructor(options: {
    session: ChatSession;
    rendererOrigin: string;
    onMessage: (message: ChatMessage) => void;
  }) {
    this.#session = options.session;
    this.#messagesUrl = createWelcomeMessagesUrl(options.session.apiOrigin);
    this.#realtimeUrl = createWelcomeRealtimeUrl(options.session.apiOrigin);
    this.#rendererOrigin = options.rendererOrigin;
    this.#onMessage = options.onMessage;
  }

  async #payload(response: Response): Promise<unknown> {
    if (response.ok) {
      return response.json();
    }

    if (response.status === 401) {
      this.#session.markSignedOut();
      this.stop();
    }

    let message = `Chat server request failed (${response.status})`;
    try {
      const parsed = apiErrorEnvelopeSchema.safeParse(await response.json());
      if (parsed.success) message = parsed.data.error.message;
    } catch {
      // Keep the status-based message.
    }
    throw new ChatTransportError(message, response.status);
  }

  async getMessages(): Promise<readonly ChatMessage[]> {
    const response = await this.#session.fetch(this.#messagesUrl, { method: "GET" });
    return chatHistorySchema.parse(await this.#payload(response)).messages;
  }

  async sendMessage(body: string): Promise<ChatMessage> {
    const request = createChatMessageRequestSchema.parse({
      clientMessageId: randomUUID(),
      body,
    });
    const response = await this.#session.fetch(this.#messagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return chatMessageSchema.parse(await this.#payload(response));
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }

  async #connect(): Promise<void> {
    if (this.#stopped || this.#socket !== null) return;

    const cookie = await this.#session.cookieHeader();
    if (cookie === null) {
      // Not signed in yet. start() is called again after a successful sign-in.
      return;
    }
    if (this.#stopped) return;

    const socket = new WebSocket(this.#realtimeUrl, {
      origin: this.#rendererOrigin,
      headers: { cookie },
    });
    this.#socket = socket;

    socket.once("open", () => {
      this.#reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    });
    socket.on("message", (data: RawData) => {
      try {
        const event = chatMessageEventSchema.safeParse(JSON.parse(data.toString()));
        if (event.success) {
          this.#onMessage(event.data.message);
        }
      } catch (error) {
        console.error("Ignored an invalid welcome-channel event", error);
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.#session.markSignedOut();
        this.stop();
      }
    });
    socket.on("error", (error) => {
      console.error("Welcome-channel realtime connection failed", error.message);
    });
    socket.once("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
      }
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }
}
