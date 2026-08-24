import { Pool } from "pg";
import type { PoolClient } from "pg";

export interface DatabasePoolConfig {
  readonly url: string;
  readonly poolSize: number;
}

export interface TransactionOptions {
  /** PostgreSQL can abort either participant in a deadlock; retry only fully transactional work. */
  readonly deadlockRetries?: number;
}

/** Create the server's bounded Postgres connection pool. */
export function createPool(config: DatabasePoolConfig): Pool {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolSize,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "hype-comms-server",
  });

  // A Pool without an error listener turns an idle-client network error into an uncaught event.
  pool.on("error", (error) => {
    console.error("Unexpected error from an idle Postgres client", error);
  });

  return pool;
}

/** Run work on one client, committing on success and rolling back on failure. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const deadlockRetries = options.deadlockRetries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        attempt < deadlockRetries &&
        error instanceof Error &&
        "code" in error &&
        error.code === "40P01"
      ) {
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
