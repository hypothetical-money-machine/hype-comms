import { afterAll, beforeAll, expect, it } from "vitest";

import {
  createTestSchema,
  describeWithPostgres,
  resetDatabase,
  type TestSchema,
} from "./database.js";

describeWithPostgres("resetDatabase discovery", () => {
  let schema: TestSchema;

  beforeAll(async () => {
    schema = await createTestSchema({ prefix: "database_helper", poolSize: 2 });
  });

  afterAll(async () => {
    await schema.drop();
  });

  it("truncates every migrated table in the scoped schema without touching schema_migrations", async () => {
    await schema.pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ('30000000-0000-4000-8000-000000000001', 'reset@example.test', 'reset', 'Reset')`,
    );
    const migrationsBefore = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );

    await resetDatabase(schema.pool);

    const users = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users",
    );
    const migrationsAfter = await schema.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );
    expect(users.rows[0]?.count).toBe("0");
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
