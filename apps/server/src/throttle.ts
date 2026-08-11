const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;

interface FailureWindow {
  failures: number;
  resetAt: number;
}

interface AttemptWindow {
  attempts: number;
  resetAt: number;
}

export interface SignInThrottleOptions {
  readonly maxFailures?: number;
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
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_FAILURES;
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

/**
 * Fixed-window throttle for authentication attempts.
 *
 * Only failures are counted, so a correct code never consumes budget. State is per-process and
 * in-memory: it is deliberately scoped to the single-replica deployment and resets on
 * restart. Behind a reverse proxy every request shares the proxy's address unless Fastify is
 * configured to trust forwarded headers, which collapses this into a global budget.
 */
export class SignInThrottle {
  readonly #windows = new Map<string, FailureWindow>();
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: SignInThrottleOptions = {}) {
    this.#maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Milliseconds the caller must wait, or 0 when an attempt is allowed. */
  retryAfterMs(key: string): number {
    const window = this.#windows.get(key);
    if (window === undefined) return 0;
    const now = this.#now();
    if (now >= window.resetAt) {
      this.#windows.delete(key);
      return 0;
    }
    if (window.failures < this.#maxFailures) return 0;
    return window.resetAt - now;
  }

  recordFailure(key: string): void {
    const now = this.#now();
    this.#prune(now);
    const window = this.#windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      this.#windows.set(key, { failures: 1, resetAt: now + this.#windowMs });
      return;
    }
    window.failures += 1;
  }

  recordSuccess(key: string): void {
    this.#windows.delete(key);
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now >= window.resetAt) this.#windows.delete(key);
    }
  }
}
