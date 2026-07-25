import type { Pool, PoolClient } from "pg";

const CHANNEL = "hmm_chat_events";

export class RealtimeEventHub {
  readonly #listeners = new Map<string, Set<() => void>>();
  #client: PoolClient | null = null;

  constructor(private readonly pool: Pool) {}

  async start(): Promise<void> {
    if (this.#client !== null) return;
    const client = await this.pool.connect();
    try {
      await client.query(`LISTEN ${CHANNEL}`);
      client.on("notification", (notification) => {
        const workspaceId = notification.payload?.split(":", 1)[0];
        if (workspaceId === undefined) return;
        for (const listener of this.#listeners.get(workspaceId) ?? []) listener();
      });
      this.#client = client;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  subscribe(workspaceId: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(workspaceId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(workspaceId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(workspaceId);
    };
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#listeners.clear();
    if (client !== null) {
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      client.release();
    }
  }
}
