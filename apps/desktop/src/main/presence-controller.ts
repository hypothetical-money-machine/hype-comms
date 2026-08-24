import type { PresenceState } from "@hype-comms/contracts";

export const PRESENCE_AWAY_IDLE_SECONDS = 5 * 60;
export const PRESENCE_IDLE_POLL_MS = 15_000;

type AvailablePresence = Exclude<PresenceState, "offline">;

/** Infers human availability from OS-wide idle time without recording an activity timeline. */
export class PresenceController {
  readonly #getIdleSeconds: () => number;
  readonly #publish: (state: AvailablePresence) => void;
  #state: AvailablePresence | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    readonly getIdleSeconds: () => number;
    readonly publish: (state: AvailablePresence) => void;
  }) {
    this.#getIdleSeconds = options.getIdleSeconds;
    this.#publish = options.publish;
  }

  start(): void {
    if (this.#poll !== null) return;
    this.refresh();
    this.#poll = setInterval(() => this.refresh(), PRESENCE_IDLE_POLL_MS);
    this.#poll.unref();
  }

  refresh(): void {
    let idleSeconds: number;
    try {
      idleSeconds = this.#getIdleSeconds();
    } catch {
      return;
    }
    this.#set(idleSeconds >= PRESENCE_AWAY_IDLE_SECONDS ? "away" : "online");
  }

  suspend(): void {
    this.#set("away");
  }

  resume(): void {
    this.refresh();
  }

  stop(): void {
    if (this.#poll !== null) clearInterval(this.#poll);
    this.#poll = null;
    this.#state = null;
  }

  #set(state: AvailablePresence): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#publish(state);
  }
}
