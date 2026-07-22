import { randomUUID } from "node:crypto";

import {
  apiErrorEnvelopeSchema,
  createDevelopmentWelcomeMessageRequestSchema,
  developmentWelcomeHistorySchema,
  developmentWelcomeMessageEventSchema,
  developmentWelcomeMessageSchema,
  type DevelopmentIdentity,
  type DevelopmentWelcomeMessage,
} from "@hmm-chat/contracts";
import { net } from "electron";
import WebSocket, { type RawData } from "ws";

import {
  createDevelopmentWelcomeMessagesUrl,
  createDevelopmentWelcomeRealtimeUrl,
} from "../shared/api-origin";

const RECONNECT_DELAY_MS = 1_000;

async function responsePayload(response: Response): Promise<unknown> {
  const payload: unknown = await response.json();
  if (response.ok) {
    return payload;
  }

  const error = apiErrorEnvelopeSchema.safeParse(payload);
  throw new Error(
    error.success ? error.data.error.message : `Chat server request failed (${response.status})`,
  );
}

export class WelcomeTransport {
  readonly #identity: DevelopmentIdentity;
  readonly #messagesUrl: string;
  readonly #realtimeUrl: string;
  readonly #rendererOrigin: string;
  readonly #onMessage: (message: DevelopmentWelcomeMessage) => void;
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;

  constructor(options: {
    apiOrigin: string;
    identity: DevelopmentIdentity;
    rendererOrigin: string;
    onMessage: (message: DevelopmentWelcomeMessage) => void;
  }) {
    this.#identity = options.identity;
    this.#messagesUrl = createDevelopmentWelcomeMessagesUrl(options.apiOrigin);
    this.#realtimeUrl = createDevelopmentWelcomeRealtimeUrl(options.apiOrigin);
    this.#rendererOrigin = options.rendererOrigin;
    this.#onMessage = options.onMessage;
  }

  async getMessages(): Promise<readonly DevelopmentWelcomeMessage[]> {
    const response = await net.fetch(this.#messagesUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return developmentWelcomeHistorySchema.parse(await responsePayload(response)).messages;
  }

  async sendMessage(body: string): Promise<DevelopmentWelcomeMessage> {
    const request = createDevelopmentWelcomeMessageRequestSchema.parse({
      clientMessageId: randomUUID(),
      authorName: this.#identity.name,
      body,
    });
    const response = await net.fetch(this.#messagesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return developmentWelcomeMessageSchema.parse(await responsePayload(response));
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
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

  #connect(): void {
    if (this.#stopped || this.#socket !== null) return;

    const socket = new WebSocket(this.#realtimeUrl, { origin: this.#rendererOrigin });
    this.#socket = socket;

    socket.on("message", (data: RawData) => {
      try {
        const payload: unknown = JSON.parse(data.toString());
        const event = developmentWelcomeMessageEventSchema.safeParse(payload);
        if (event.success) {
          this.#onMessage(event.data.message);
        }
      } catch (error) {
        console.error("Ignored an invalid welcome-channel event", error);
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
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, RECONNECT_DELAY_MS);
  }
}
