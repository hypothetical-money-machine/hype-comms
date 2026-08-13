import type { Pool, PoolClient } from "pg";

const CHANNEL = "hype_comms_events";

/** Backoff schedule for re-establishing LISTEN; the final delay repeats forever. */
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface RealtimeEventHubOptions {
  /** Overrides the reconnect backoff schedule; the last entry repeats. */
  readonly reconnectDelaysMs?: readonly number[];
}

/** Loss bookkeeping for a client `#listen()` has checked out but has not adopted yet. */
interface PendingListen {
  lost: boolean;
  error: unknown;
}

export class RealtimeEventHub {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #reconnectDelaysMs: readonly number[];
  /**
   * Clients an in-flight #listen() has checked out but not yet adopted. A loss for a client in here
   * belongs to that #listen() call, which cleans up once its LISTEN settles.
   */
  readonly #pending = new Map<PoolClient, PendingListen>();
  #client: PoolClient | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #stopped = false;
  /** True once LISTEN has succeeded, so a later success is known to be a re-LISTEN. */
  #hasListened = false;

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
      this.#detach(client);
      this.#release(client);
    }
  }

  /** Check out a dedicated client, issue LISTEN, and supervise it until it fails or closes. */
  async #listen(): Promise<void> {
    if (this.#client !== null || this.#stopped) return;
    const client = await this.pool.connect();
    // Supervise the client before writing to it. A checked-out client is no longer covered by the
    // pool's idle-client error handler, and pg emits `error` from the socket callback *before* the
    // in-flight query rejects, so attaching these after LISTEN leaves a window where a dying
    // connection raises ERR_UNHANDLED_ERROR and exits the process. LISTEN is exactly the write
    // that discovers a recycled half-open socket, so that window is the likely one.
    // The hub cannot own the client yet, so record it as pending: a loss delivered before adoption
    // has no adopted client to match, and the loss handler would otherwise drop it on the floor.
    const pending: PendingListen = { lost: false, error: undefined };
    this.#pending.set(client, pending);
    client.on("error", (error: unknown) => {
      this.#handleClientLoss(client, error);
    });
    client.once("end", () => {
      this.#handleClientLoss(client, new Error("Postgres realtime listener connection ended"));
    });
    const isRelisten = this.#hasListened;
    try {
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      // The client is still pending, so #handleClientLoss only recorded any socket error emitted
      // above and this catch owns the cleanup. Leaving #client null also keeps a later start() or
      // reconnect from being turned into a no-op by the idempotence guard.
      this.#pending.delete(client);
      this.#detach(client);
      this.#release(client, error);
      throw error;
    }
    // Past this point every branch cleans up for itself, so stop the loss handler deferring to us.
    this.#pending.delete(client);
    if (pending.lost) {
      // The connection died between LISTEN resolving and this continuation running: pg emits
      // `error` from the socket callback, so the loss arrived while the hub still had no client to
      // compare it against. Adopting a dead client would leave the hub certain it is live, with
      // subscribers silent and no reconnect scheduled, so take the loss handler's path instead.
      console.error(
        "The Postgres realtime listener was lost before the hub could adopt it",
        pending.error,
      );
      this.#detach(client);
      this.#release(client, pending.error);
      if (!this.#stopped) this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) {
      this.#detach(client);
      this.#release(client);
      return;
    }
    if (this.#client !== null) {
      // Two #listen() runs can overlap (start() racing a reconnect tick) and each check out a
      // client. Whoever adopted first is the live listener; overwriting it would strand it forever,
      // because the loss handler ignores a client the hub no longer holds. Destroy this spare
      // rather than hand a connection that still has LISTEN registered back to the pool.
      this.#detach(client);
      this.#release(client, new Error("Discarded a redundant Postgres realtime listener"));
      return;
    }
    client.on("notification", (notification) => {
      const workspaceId = notification.payload?.split(":", 1)[0];
      if (workspaceId === undefined) return;
      for (const listener of this.#listeners.get(workspaceId) ?? []) listener();
    });
    this.#client = client;
    this.#hasListened = true;
    this.#reconnectAttempt = 0;
    if (isRelisten) this.#catchUpSubscribers();
  }

  /**
   * Every NOTIFY raised while the listener was down went to nobody, and each socket still believes
   * it is live. Wake every subscriber once so it re-runs its HTTP flush and catches up; one failing
   * subscriber must not strand the others.
   */
  #catchUpSubscribers(): void {
    for (const listeners of this.#listeners.values()) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error("A realtime subscriber failed to catch up after a listener restart", error);
        }
      }
    }
  }

  /** Stop a released or replaced client from calling back into the hub. */
  #detach(client: PoolClient): void {
    client.removeAllListeners("notification");
    client.removeAllListeners("error");
    client.removeAllListeners("end");
  }

  #handleClientLoss(client: PoolClient, error: unknown): void {
    const pending = this.#pending.get(client);
    if (pending !== undefined) {
      // #listen() has not adopted this client yet and its LISTEN is still settling. Record the
      // first loss and let that call release the client, so neither side releases it twice.
      if (!pending.lost) {
        pending.lost = true;
        pending.error = error;
      }
      return;
    }
    // Ignore losses for a client we already replaced or released in close().
    if (this.#client !== client) return;
    this.#client = null;
    console.error("Unexpected error from the Postgres realtime listener", error);
    this.#detach(client);
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
