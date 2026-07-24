import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import { createPool } from "./pool.js";

const MIGRATION_LOCK_ID = "3247861932147781";

interface MigrationRow extends QueryResultRow {
  readonly filename: unknown;
  readonly checksum: unknown;
}

const migrationRowSchema = z
  .object({
    filename: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function defaultMigrationsDirectory(): URL {
  // Resolved against this module rather than the process working directory, so it works under tsx
  // in development and from dist in the container. The build copies the SQL beside the compiled
  // migrator; the runtime image ships dist alone and has no src to fall back to.
  return new URL("./migrations/", import.meta.url);
}

async function unlock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
}

/**
 * Apply each forward-only SQL migration once.
 *
 * The optional directory exists for isolated migration-runner tests; normal callers always use
 * the directory resolved relative to this module.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDirectory: URL = defaultMigrationsDirectory(),
): Promise<{ applied: string[] }> {
  const directoryEntries = await readdir(migrationsDirectory, { withFileTypes: true });
  const filenames = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const contents = await readFile(new URL(filename, migrationsDirectory), "utf8");
      return {
        filename,
        contents,
        checksum: createHash("sha256").update(contents).digest("hex"),
      };
    }),
  );

  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL
      )
    `);

    const result = await client.query<MigrationRow>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    const appliedByFilename = new Map(
      result.rows.map((row) => {
        const parsed = migrationRowSchema.parse(row);
        return [parsed.filename, parsed.checksum] as const;
      }),
    );

    for (const migration of migrations) {
      const appliedChecksum = appliedByFilename.get(migration.filename);
      if (appliedChecksum !== undefined && appliedChecksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for ${migration.filename}: ` +
            `database has ${appliedChecksum}, file has ${migration.checksum}`,
        );
      }
    }

    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedByFilename.has(migration.filename)) continue;

      await client.query("BEGIN");
      try {
        await client.query(migration.contents);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
          migration.filename,
          migration.checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(migration.filename);
    }

    return { applied };
  } finally {
    try {
      if (locked) await unlock(client);
    } finally {
      client.release();
    }
  }
}

async function runStandalone(): Promise<void> {
  const url = process.env.HMM_DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("HMM_DATABASE_URL is required");
  }

  const pool = createPool({
    url,
    poolSize: Number.parseInt(process.env.HMM_DATABASE_POOL_SIZE ?? "10", 10),
  });
  try {
    const result = await runMigrations(pool);
    console.log(
      result.applied.length === 0
        ? "Database schema is up to date"
        : `Applied migrations: ${result.applied.join(", ")}`,
    );
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  runStandalone().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
