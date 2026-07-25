import type { Pool, PoolClient } from "pg";

const CHANNEL = "hmm_chat_events";

/** Backoff schedule for re-establishing LISTEN; the final delay repeats forever. */
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface RealtimeEventHubOptions {
  /** Overrides the reconnect backoff schedule; the last entry repeats. */
  readonly reconnectDelaysMs?: readonly number[];
}

export class RealtimeEventHub {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #reconnectDelaysMs: readonly number[];
  #client: PoolClient | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #stopped = false;

  constructor(
    private readonly pool: Pool,
    options: RealtimeEventHubOptions = {},
  ) {
    const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.#reconnectDelaysMs = delays.length === 0 ? DEFAULT_RECONNECT_DELAYS_MS : delays;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#listen();
  }

  subscribe(workspaceId: string, listener: () => void): () => void {
    const existing = this.#listeners.get(workspaceId);
    const listeners = existing ?? new Set<() => void>();
    if (existing === undefined) this.#listeners.set(workspaceId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      // Only evict the set we own: a later subscriber may have installed a fresh one, and this
      // closure can be invoked more than once (socket close and socket error both tear down).
      if (this.#listeners.get(workspaceId) === listeners && listeners.size === 0) {
        this.#listeners.delete(workspaceId);
      }
    };
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const client = this.#client;
    this.#client = null;
    this.#listeners.clear();
    if (client !== null) {
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      client.removeAllListeners("notification");
      client.removeAllListeners("error");
      client.removeAllListeners("end");
      this.#release(client);
    }
  }

  /** Check out a dedicated client, issue LISTEN, and supervise it until it fails or closes. */
  async #listen(): Promise<void> {
    if (this.#client !== null || this.#stopped) return;
    const client = await this.pool.connect();
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      this.#release(client);
      throw error;
    }
    if (this.#stopped) {
      this.#release(client);
      return;
    }
    client.on("notification", (notification) => {
      const workspaceId = notification.payload?.split(":", 1)[0];
      if (workspaceId === undefined) return;
      for (const listener of this.#listeners.get(workspaceId) ?? []) listener();
    });
    // A checked-out client is no longer covered by the pool's idle-client error handler, so
    // without these listeners a Postgres restart raises ERR_UNHANDLED_ERROR and exits the process.
    client.on("error", (error: unknown) => {
      this.#handleClientLoss(client, error);
    });
    client.once("end", () => {
      this.#handleClientLoss(client, new Error("Postgres realtime listener connection ended"));
    });
    this.#client = client;
    this.#reconnectAttempt = 0;
  }

  #handleClientLoss(client: PoolClient, error: unknown): void {
    // Ignore losses for a client we already replaced or released in close().
    if (this.#client !== client) return;
    this.#client = null;
    console.error("Unexpected error from the Postgres realtime listener", error);
    client.removeAllListeners("notification");
    client.removeAllListeners("error");
    client.removeAllListeners("end");
    this.#release(client, error);
    if (this.#stopped) return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== null || this.#client !== null) return;
    const index = Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1);
    const delayMs = this.#reconnectDelaysMs[index] ?? 0;
    this.#reconnectAttempt += 1;
    const timer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#listen().catch((error: unknown) => {
        console.error("Failed to re-establish the Postgres realtime listener", error);
        this.#scheduleReconnect();
      });
    }, delayMs);
    timer.unref();
    this.#reconnectTimer = timer;
  }

  /**
   * Release a client at most once. Passing the failure destroys it instead of returning a broken
   * connection to the pool; pg throws if release is called twice, which must not escape here.
   */
  #release(client: PoolClient, error?: unknown): void {
    try {
      if (error === undefined) {
        client.release();
        return;
      }
      client.release(error instanceof Error ? error : new Error(String(error)));
    } catch (releaseError) {
      console.error("Failed to release the Postgres realtime listener", releaseError);
    }
  }
}
