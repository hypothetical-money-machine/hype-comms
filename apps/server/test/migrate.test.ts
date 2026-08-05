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
      await expect(runMigrations(pool)).resolves.toEqual({
        applied: [
          "0001_identity.sql",
          "0002_conversation_core.sql",
          "0003_unicode_channel_slugs.sql",
          "0004_channel_memberships.sql",
          "0005_message_search.sql",
          "0006_message_reactions.sql",
          "0007_read_state_event_capability.sql",
          "0008_hype_comms_rebrand.sql",
          "0009_self_direct_messages.sql",
        ],
      });
      await expect(runMigrations(pool)).resolves.toEqual({ applied: [] });

      const result = await pool.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      expect(result.rows).toEqual([
        { filename: "0001_identity.sql" },
        { filename: "0002_conversation_core.sql" },
        { filename: "0003_unicode_channel_slugs.sql" },
        { filename: "0004_channel_memberships.sql" },
        { filename: "0005_message_search.sql" },
        { filename: "0006_message_reactions.sql" },
        { filename: "0007_read_state_event_capability.sql" },
        { filename: "0008_hype_comms_rebrand.sql" },
        { filename: "0009_self_direct_messages.sql" },
      ]);

      const userId = randomUUID();
      const workspaceId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'migration@example.test', 'migration', 'Migration')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ($1, 'Migration', 'migration', $2)`,
        [workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES
           ($1, $2, 'channel', 'Existing ASCII', 'existing-ascii', 'workspace', $3),
           ($4, $2, 'channel', 'Équipe Produit', 'équipe-produit', 'workspace', $3)`,
        [randomUUID(), workspaceId, userId, randomUUID()],
      );
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, channel_access, created_by)
           VALUES ($1, $2, 'channel', 'Duplicate', 'équipe-produit', 'workspace', $3)`,
          [randomUUID(), workspaceId, userId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, channel_access, created_by)
           VALUES ($1, $2, 'channel', 'Not normalized', $3, 'workspace', $4)`,
          [randomUUID(), workspaceId, "e\u0301quipe", userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, created_by)
           VALUES ($1, $2, 'channel', 'Missing access', 'missing-access', $3)`,
          [randomUUID(), workspaceId, userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
           VALUES ($1, $2, 'direct_message', $3, $3, $3)`,
          [randomUUID(), workspaceId, userId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("renames only the legacy default workspace", async () => {
    await withFreshSchema(async (pool) => {
      await runMigrations(pool);

      const userId = randomUUID();
      const defaultWorkspaceId = randomUUID();
      const legacyNamedCustomWorkspaceId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'rebrand@example.test', 'rebrand', 'Rebrand')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ($1, 'HMM Chat', 'hmm-chat', $3),
           ($2, 'HMM Chat', 'custom-workspace', $3)`,
        [defaultWorkspaceId, legacyNamedCustomWorkspaceId, userId],
      );

      const migration = await readFile(
        new URL("../src/db/migrations/0008_hype_comms_rebrand.sql", import.meta.url),
        "utf8",
      );
      await pool.query(migration);

      const renamed = await pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM workspaces ORDER BY id",
      );
      expect(new Map(renamed.rows.map((row) => [row.id, row.name]))).toEqual(
        new Map([
          [defaultWorkspaceId, "Hype Comms"],
          [legacyNamedCustomWorkspaceId, "HMM Chat"],
        ]),
      );

      await pool.query("UPDATE workspaces SET name = 'Morgan and Dan' WHERE id = $1", [
        defaultWorkspaceId,
      ]);
      await pool.query(migration);
      await expect(
        pool.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [
          defaultWorkspaceId,
        ]),
      ).resolves.toMatchObject({ rows: [{ name: "Morgan and Dan" }] });
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
