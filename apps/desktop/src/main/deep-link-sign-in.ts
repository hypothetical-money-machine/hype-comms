import type { MagicLinkToken } from "@hype-comms/contracts";

import { parseAuthCallbackToken } from "./auth-callback";
import { findAuthCallbackUrl, type AuthProtocolScheme } from "./security";

export type DeepLinkSignInOutcome = "cancelled" | "failed" | "succeeded";
export type DeepLinkExchangeOutcome = "failed" | "invalid" | "succeeded";

export type ConfirmDeepLinkSignIn = () => Promise<boolean>;

export interface DeepLinkSignInQueueOptions {
  readonly confirm: ConfirmDeepLinkSignIn;
  readonly exchange: (token: MagicLinkToken) => Promise<DeepLinkExchangeOutcome>;
  readonly onInvalidLink: () => Promise<void>;
}

/**
 * Serializes sign-ins received from the OS protocol handler. The confirmation callback deliberately
 * receives no token or callback URL, so a UI implementation cannot accidentally display it.
 */
export class DeepLinkSignInQueue {
  readonly #confirm: ConfirmDeepLinkSignIn;
  readonly #exchange: (token: MagicLinkToken) => Promise<DeepLinkExchangeOutcome>;
  readonly #onInvalidLink: () => Promise<void>;
  readonly #pending: MagicLinkToken[] = [];
  #draining = false;
  #ready = false;

  constructor(options: DeepLinkSignInQueueOptions) {
    this.#confirm = options.confirm;
    this.#exchange = options.exchange;
    this.#onInvalidLink = options.onInvalidLink;
  }

  enqueue(token: MagicLinkToken): void {
    this.#pending.push(token);
    void this.#drain();
  }

  async markReady(): Promise<void> {
    this.#ready = true;
    await this.#drain();
  }

  async #drain(): Promise<void> {
    if (!this.#ready || this.#draining) return;

    this.#draining = true;
    try {
      while (this.#pending.length > 0) {
        const token = this.#pending.shift();
        if (token === undefined) continue;
        if (!(await this.#confirm())) continue;
        try {
          if ((await this.#exchange(token)) === "invalid") await this.#onInvalidLink();
        } catch {
          // ChatSession publishes only credential-free errors. A later callback remains usable.
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

export function routeOpenUrlMagicLink(
  value: string,
  scheme: AuthProtocolScheme,
  queue: DeepLinkSignInQueue,
): boolean {
  const token = parseAuthCallbackToken(value, scheme);
  if (token === null) return false;
  queue.enqueue(token);
  return true;
}

export function routeSecondInstanceMagicLink(
  commandLine: readonly string[],
  scheme: AuthProtocolScheme,
  queue: DeepLinkSignInQueue,
): boolean {
  const callback = findAuthCallbackUrl(commandLine, scheme);
  return callback !== null && routeOpenUrlMagicLink(callback, scheme, queue);
}
