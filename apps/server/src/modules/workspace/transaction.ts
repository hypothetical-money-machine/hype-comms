import type { Pool, PoolClient } from "pg";

/** Preserve each workspace use case's isolation and commit mutation plus events together. */
export async function runWorkspaceTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  options: {
    readonly isolationLevel?: "repeatable_read";
    readonly readOnly?: boolean;
  } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    const isolation =
      options.isolationLevel === "repeatable_read" ? " ISOLATION LEVEL REPEATABLE READ" : "";
    const accessMode = options.readOnly === true ? " READ ONLY" : "";
    await client.query(`BEGIN TRANSACTION${isolation}${accessMode}`);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
