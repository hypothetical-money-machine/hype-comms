import { productRealtimeEventSchema, type ProductRealtimeEvent } from "@hmm-chat/contracts";
import WebSocket, { type RawData } from "ws";

import type { WorkspaceTransport } from "./workspace-transport";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type RealtimeConnectionState = "connecting" | "live" | "offline" | "reconnecting";

export class WorkspaceRealtime {
  readonly #apiOrigin: string;
  readonly #rendererOrigin: string;
  readonly #transport: WorkspaceTransport;
  readonly #onEvent: (event: ProductRealtimeEvent) => void;
  readonly #onState: (state: RealtimeConnectionState) => void;
  #cursor = "0";
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #delayMs = INITIAL_RECONNECT_DELAY_MS;
  #stopped = true;

  constructor(options: {
    readonly apiOrigin: string;
    readonly rendererOrigin: string;
    readonly transport: WorkspaceTransport;
    readonly onEvent: (event: ProductRealtimeEvent) => void;
    readonly onState: (state: RealtimeConnectionState) => void;
  }) {
    this.#apiOrigin = options.apiOrigin;
    this.#rendererOrigin = options.rendererOrigin;
    this.#transport = options.transport;
    this.#onEvent = options.onEvent;
    this.#onState = options.onState;
  }

  start(after: string): void {
    this.#cursor = after;
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#delayMs = INITIAL_RECONNECT_DELAY_MS;
    this.#onState("connecting");
    void this.#connect();
  }

  acknowledge(cursor: string): void {
    if (BigInt(cursor) > BigInt(this.#cursor)) this.#cursor = cursor;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#socket?.close();
    this.#socket = null;
    this.#onState("offline");
  }

  async #connect(): Promise<void> {
    if (this.#stopped || this.#socket !== null) return;
    try {
      const ticket = await this.#transport.ticket();
      if (this.#stopped) return;
      const url = new URL("/v1/realtime", this.#apiOrigin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket.ticket);
      url.searchParams.set("after", this.#cursor);
      const socket = new WebSocket(url, { origin: this.#rendererOrigin });
      this.#socket = socket;
      socket.once("open", () => {
        this.#delayMs = INITIAL_RECONNECT_DELAY_MS;
      });
      socket.on("message", (data: RawData) => {
        try {
          const parsed = productRealtimeEventSchema.safeParse(JSON.parse(data.toString()));
          if (!parsed.success) {
            console.error("Ignored an invalid realtime event");
            return;
          }
          if (parsed.data.type === "system.connected") this.#onState("live");
          this.#onEvent(parsed.data);
        } catch (error) {
          console.error("Ignored an invalid realtime event", error);
        }
      });
      socket.on("error", (error) => {
        console.error("Workspace realtime connection failed", error.message);
      });
      socket.once("close", () => {
        if (this.#socket === socket) this.#socket = null;
        this.#scheduleReconnect();
      });
    } catch (error) {
      console.error("Could not obtain a realtime ticket", error);
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#onState("reconnecting");
    const maximum = this.#delayMs;
    const delay = Math.floor(Math.random() * maximum);
    this.#delayMs = Math.min(this.#delayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
  }
}
