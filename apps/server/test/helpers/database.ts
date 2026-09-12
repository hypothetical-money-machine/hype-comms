import { randomUUID } from "node:crypto";

import { describe } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";

/**
 * The Postgres test database URL, when the test host has one configured. Suites that need
 * Postgres should skip via {@link describeWithPostgres} rather than reading this directly.
 */
export const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;

/**
 * Use in place of `describe` for any suite that needs a live Postgres database. Skips the whole
 * suite when `HYPE_COMMS_TEST_DATABASE_URL` is not set, matching every server test file's
 * previous local `describeWithPostgres` definition.
 */
export const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

/**
 * Rewrites a Postgres connection URL so that new connections default to the given schema (falling
 * back to `public`). Used to give each test file its own isolated schema within the shared test
 * database.
 */
export function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

export interface TestSchema {
  /** Pool connected without a schema-scoped search path, used to create/drop the schema itself. */
  readonly adminPool: Pool;
  /** Pool connected with the schema-scoped search path; migrations run against this pool. */
  readonly pool: Pool;
  readonly schemaName: string;
  /** Ends both pools and drops the schema. Call from `afterAll`. */
  drop(): Promise<void>;
}

export interface CreateTestSchemaOptions {
  /** Used to build a readable, collision-resistant schema name for this suite. */
  readonly prefix: string;
  readonly adminPoolSize?: number;
  readonly poolSize?: number;
  readonly migrationsDirectory?: URL;
}

/**
 * Creates an isolated schema in the shared Postgres test database, points a pool at it, and runs
 * migrations against it. Callers must have already confirmed `testDatabaseUrl` is defined (i.e.
 * this is only invoked inside a `describeWithPostgres` block).
 */
export async function createTestSchema(options: CreateTestSchemaOptions): Promise<TestSchema> {
  if (testDatabaseUrl === undefined) {
    throw new Error("HYPE_COMMS_TEST_DATABASE_URL is not set");
  }
  const schemaName = `${options.prefix}_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminPool = createPool({ url: testDatabaseUrl, poolSize: options.adminPoolSize ?? 2 });
  await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
  const pool = createPool({
    url: schemaScopedUrl(testDatabaseUrl, schemaName),
    poolSize: options.poolSize ?? 8,
  });
  await runMigrations(pool, options.migrationsDirectory);
  return {
    adminPool,
    pool,
    schemaName,
    async drop() {
      await pool.end();
      await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    },
  };
}

export interface ResetDatabaseOptions {
  /**
   * Truncate exactly these tables (in this order) instead of discovering every table. Use this
   * when a suite deliberately resets a narrower set of tables than the full schema — for example
   * to rely on `CASCADE` from a single root table, or because the suite never touches the rest.
   */
  readonly only?: readonly string[];
}

/**
 * Truncates test data between cases. With no options, discovers every base table in the pool's
 * current schema (excluding `schema_migrations`) and truncates all of them in one statement. Pass
 * `only` to truncate a specific, deliberately narrower table list instead.
 */
export async function resetDatabase(pool: Pool, options: ResetDatabaseOptions = {}): Promise<void> {
  const tables =
    options.only ??
    (
      await pool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND current_schema() <> 'public'
           AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migrations'`,
      )
    ).rows.map((row) => row.table_name);
  if (options.only === undefined && tables.length === 0) {
    throw new Error(
      "resetDatabase discovered no tables: the pool is not scoped to a migrated test schema " +
        "(current_schema() resolved to public or to an empty schema).",
    );
  }
  if (tables.length === 0) return;
  const identifiers = tables.map((table) => escapeIdentifier(table)).join(", ");
  await pool.query(`TRUNCATE ${identifiers} CASCADE`);
}
