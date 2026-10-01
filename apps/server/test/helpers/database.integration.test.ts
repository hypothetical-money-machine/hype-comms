import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { escapeIdentifier, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as poolModule from "../../src/db/pool.js";

import { createTestSchema, resetDatabase, type TestSchema } from "./database.js";

describe("resetDatabase discovery", () => {
  let schema: TestSchema;

  beforeAll(async () => {
    schema = await createTestSchema({ prefix: "database_helper", poolSize: 2 });
  });

  afterAll(async () => {
    await schema.drop();
  });

  it("closes both pools and removes its schema when migrations fail during setup", async () => {
    const migrations = await mkdtemp(path.join(tmpdir(), "failed-test-migrations-"));
    const prefix = `setup_fail_${randomUUID().slice(0, 8)}`;
    const pools: Pool[] = [];
    const originalCreatePool = poolModule.createPool;
    const createPoolSpy = vi.spyOn(poolModule, "createPool").mockImplementation((options) => {
      const pool = originalCreatePool(options);
      pools.push(pool);
      return pool;
    });
    try {
      await writeFile(path.join(migrations, "0001_invalid.sql"), "SELECT missing_setup_table");
      await expect(
        createTestSchema({
          prefix,
          poolSize: 1,
          migrationsDirectory: pathToFileURL(`${migrations}${path.sep}`),
        }),
      ).rejects.toThrow(/missing_setup_table/);
      const remaining = await schema.adminPool.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
        [prefix],
      );
      expect({ schemas: remaining.rows, endedPools: pools.map((pool) => pool.ended) }).toEqual({
        schemas: [],
        endedPools: [true, true],
      });
    } finally {
      createPoolSpy.mockRestore();
      for (const pool of pools) {
        if (!pool.ending) await pool.end();
      }
      const remaining = await schema.adminPool.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
        [prefix],
      );
      for (const { nspname } of remaining.rows) {
        await schema.adminPool.query(`DROP SCHEMA ${escapeIdentifier(nspname)} CASCADE`);
      }
      await rm(migrations, { recursive: true, force: true });
    }
  });

  it("truncates every migrated table in the scoped schema without touching schema_migrations", async () => {
    await schema.pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ('30000000-0000-4000-8000-000000000001', 'reset@example.test', 'reset', 'Reset')`,
    );
    // TRUNCATE ... CASCADE on users also empties every table that references it, which is most of
    // the schema. workos_events has no foreign key path to users in either direction, so it is
    // only emptied if discovery actually found it.
    await schema.pool.query(
      `INSERT INTO workos_events (event_id, event_type, workos_session_id, occurred_at)
       VALUES ('event_reset', 'session.revoked', 'session_reset', now())`,
    );
    const migrationsBefore = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );

    await resetDatabase(schema.pool);

    const users = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users",
    );
    const workosEvents = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workos_events",
    );
    const migrationsAfter = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );
    expect(users.rows[0]?.count).toBe("0");
    expect(workosEvents.rows[0]?.count).toBe("0");
    expect(migrationsAfter.rows[0]?.count).toBe(migrationsBefore.rows[0]?.count);
    expect(Number(migrationsAfter.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("refuses to run discovery against a pool that is not scoped to a test schema", async () => {
    await expect(resetDatabase(schema.adminPool)).rejects.toThrow(
      /not scoped to a migrated test schema/,
    );
  });

  it("refuses discovery on public even when public contains tables", async () => {
    // The shared test database's public schema is normally empty, which would let the
    // "discovered nothing" branch mask a missing public guard. Plant a table there for the
    // duration of this test so the guard itself is what refuses.
    const marker = `database_helper_guard_${process.pid}`;
    await schema.adminPool.query(`CREATE TABLE public.${marker} (id integer)`);
    try {
      await schema.adminPool.query(`INSERT INTO public.${marker} (id) VALUES (1)`);
      await expect(resetDatabase(schema.adminPool)).rejects.toThrow(
        /not scoped to a migrated test schema/,
      );
      const rows = await schema.adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${marker}`,
      );
      expect(rows.rows[0]?.count).toBe("1");
    } finally {
      await schema.adminPool.query(`DROP TABLE IF EXISTS public.${marker}`);
    }
  });
});
