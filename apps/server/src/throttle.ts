const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_EMAIL_DELIVERIES = 50;

interface AttemptWindow {
  attempts: number;
  resetAt: number;
}

export interface SignInThrottleOptions {
  readonly maxRequestsPerClient?: number;
  readonly maxRequestsPerEmailPerClient?: number;
  readonly maxDeliveriesPerEmail?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

export interface FixedWindowAttemptThrottleOptions {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

/** Counts every request in a fixed window and returns the wait for the first rejected request. */
export class FixedWindowAttemptThrottle {
  readonly #windows = new Map<string, AttemptWindow>();
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: FixedWindowAttemptThrottleOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#now = options.now ?? (() => Date.now());
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new TypeError("maxAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#windowMs) || this.#windowMs < 1) {
      throw new TypeError("windowMs must be a positive integer");
    }
  }

  /** Records an allowed attempt and returns 0, or returns milliseconds until retry. */
  recordAttempt(key: string): number {
    const now = this.#now();
    this.#prune(now);
    const window = this.#windows.get(key);
    if (window === undefined) {
      this.#windows.set(key, { attempts: 1, resetAt: now + this.#windowMs });
      return 0;
    }
    if (window.attempts >= this.#maxAttempts) return window.resetAt - now;
    window.attempts += 1;
    return 0;
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now >= window.resetAt) this.#windows.delete(key);
    }
  }
}

/** Fixed-window limits for unauthenticated magic-link requests and delivery attempts. */
export class SignInThrottle {
  readonly #requestsPerClient: FixedWindowAttemptThrottle;
  readonly #requestsPerEmailPerClient: FixedWindowAttemptThrottle;
  readonly #deliveriesPerEmail: FixedWindowAttemptThrottle;

  constructor(options: SignInThrottleOptions = {}) {
    const shared = {
      ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.#requestsPerClient = new FixedWindowAttemptThrottle({
      ...shared,
      maxAttempts: options.maxRequestsPerClient ?? DEFAULT_MAX_ATTEMPTS,
    });
    this.#requestsPerEmailPerClient = new FixedWindowAttemptThrottle({
      ...shared,
      maxAttempts: options.maxRequestsPerEmailPerClient ?? DEFAULT_MAX_ATTEMPTS,
    });
    this.#deliveriesPerEmail = new FixedWindowAttemptThrottle({
      ...shared,
      maxAttempts: options.maxDeliveriesPerEmail ?? DEFAULT_MAX_EMAIL_DELIVERIES,
    });
  }

  /** Counts every request in both client scopes, even when one of those scopes is exhausted. */
  recordMagicLinkRequest(email: string, clientIp: string): boolean {
    const clientWait = this.#requestsPerClient.recordAttempt(clientIp);
    const emailClientWait = this.#requestsPerEmailPerClient.recordAttempt(`${clientIp}\0${email}`);
    return clientWait === 0 && emailClientWait === 0;
  }

  /** Atomically reserves one slot in the higher, recipient-wide delivery ceiling. */
  reserveMagicLinkDelivery(email: string): boolean {
    return this.#deliveriesPerEmail.recordAttempt(email) === 0;
  }
}
