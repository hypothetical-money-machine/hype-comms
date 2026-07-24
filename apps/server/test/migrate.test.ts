import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { escapeIdentifier, type Pool } from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

async function withFreshSchema(fn: (pool: Pool) => Promise<void>): Promise<void> {
  if (testDatabaseUrl === undefined) return;

  const schemaName = `migrate_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminPool = createPool({ url: testDatabaseUrl, poolSize: 1 });
  await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
  const pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 2 });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  }
}

describeWithPostgres("runMigrations", () => {
  it("applies migrations cleanly and is idempotent", async () => {
    await withFreshSchema(async (pool) => {
      await expect(runMigrations(pool)).resolves.toEqual({ applied: ["0001_identity.sql"] });
      await expect(runMigrations(pool)).resolves.toEqual({ applied: [] });

      const result = await pool.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      expect(result.rows).toEqual([{ filename: "0001_identity.sql" }]);
    });
  });

  it("fails loudly when an applied migration file changes", async () => {
    await withFreshSchema(async (pool) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-migrations-"));
      const migrationUrl = new URL("../src/db/migrations/0001_identity.sql", import.meta.url);
      const copiedMigration = path.join(directory, "0001_identity.sql");
      try {
        await writeFile(copiedMigration, await readFile(migrationUrl, "utf8"));
        const directoryUrl = pathToFileURL(`${directory}${path.sep}`);
        await runMigrations(pool, directoryUrl);

        await writeFile(copiedMigration, `${await readFile(copiedMigration, "utf8")}\n-- edited\n`);

        await expect(runMigrations(pool, directoryUrl)).rejects.toThrow(
          /Migration checksum mismatch for 0001_identity\.sql/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
