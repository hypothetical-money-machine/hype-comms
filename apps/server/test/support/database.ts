import { randomUUID } from "node:crypto";

import { escapeIdentifier, Pool } from "pg";
import { describe } from "vitest";

import {
  assertTestDatabaseName,
  requireTestDatabaseUrl,
} from "../../../../scripts/test-database-config.mjs";
import { runMigrations } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";

export const describeWithPostgres =
  process.env.HYPE_COMMS_TEST_DATABASE_URL === undefined ? describe.skip : describe;

export interface TestDatabase {
  readonly pool: Pool;
  readonly url: string;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

/** Owns a disposable database. Application repositories and subprocesses use its URL only. */
export async function createTestDatabase(
  options: { migrate?: boolean; poolSize?: number; applicationName?: string } = {},
): Promise<TestDatabase> {
  const parentUrl = requireTestDatabaseUrl(process.env);
  const admin = createPool({ url: parentUrl, poolSize: 1 });
  const name = `hype_comms_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  const connectionClosures = new Set<Promise<void>>();
  let pool: Pool | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      try {
        await pool?.end();
        await Promise.all(connectionClosures);
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE ${escapeIdentifier(name)}`);
        } finally {
          await admin.end();
        }
      }
    })();
    return disposal;
  };

  try {
    const actual = await admin.query<{ name: string }>("SELECT current_database() AS name");
    assertTestDatabaseName(actual.rows[0]?.name ?? "");
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)} TEMPLATE template0`);
    created = true;
    const url = new URL(parentUrl);
    url.pathname = `/${name}`;
    url.searchParams.delete("options");
    pool = new Pool({
      connectionString: url.toString(),
      max: options.poolSize ?? 8,
      application_name: options.applicationName ?? "hype-comms-test",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on("connect", (client) => {
      const closed = new Promise<void>((resolve) => client.once("end", resolve));
      connectionClosures.add(closed);
      void closed.then(() => connectionClosures.delete(closed));
    });
    if (options.migrate !== false) await runMigrations(pool);
    const databasePool = pool;
    return {
      pool: databasePool,
      url: url.toString(),
      async reset() {
        const tables = await databasePool.query<{ name: string }>(`
          SELECT tablename AS name FROM pg_catalog.pg_tables
          WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
          ORDER BY tablename
        `);
        if (tables.rows.length === 0) return;
        const names = tables.rows.map(({ name }) => `public.${escapeIdentifier(name)}`);
        // Include every application table in one statement so foreign keys do not impose ordering.
        // Do not CASCADE: a future reference from migration metadata must fail instead of erasing it.
        await databasePool.query(`TRUNCATE ${names.join(", ")} RESTART IDENTITY`);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
