import { Pool } from "pg";
import type { PoolClient } from "pg";

export interface DatabasePoolConfig {
  readonly url: string;
  readonly poolSize: number;
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
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
