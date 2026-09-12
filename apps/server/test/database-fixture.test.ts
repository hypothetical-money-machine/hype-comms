import { afterAll, beforeAll, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrate.js";
import { createTestDatabase, describeWithPostgres, type TestDatabase } from "./support/database.js";

describeWithPostgres("isolated database fixture", () => {
  let first: TestDatabase;
  let second: TestDatabase;

  beforeAll(async () => {
    first = await createTestDatabase();
    second = await createTestDatabase();
  });

  afterAll(async () => {
    await Promise.all([first?.dispose(), second?.dispose()]);
  });

  it("isolates records and discovers new application tables without erasing migration metadata", async () => {
    expect(first.url).not.toBe(second.url);
    await first.pool.query(
      "CREATE TABLE fixture_record (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY)",
    );
    await first.pool.query("INSERT INTO fixture_record DEFAULT VALUES");
    await expect(second.pool.query("SELECT * FROM fixture_record")).rejects.toMatchObject({
      code: "42P01",
    });
    const migrations = await first.pool.query("SELECT * FROM schema_migrations ORDER BY filename");

    await first.reset();

    expect((await first.pool.query("SELECT * FROM fixture_record")).rows).toEqual([]);
    expect(
      (await first.pool.query("SELECT * FROM schema_migrations ORDER BY filename")).rows,
    ).toEqual(migrations.rows);
    expect(
      (await first.pool.query("INSERT INTO fixture_record DEFAULT VALUES RETURNING id")).rows,
    ).toEqual([{ id: 1 }]);
    await expect(runMigrations(first.pool)).resolves.toEqual({ applied: [] });
  });

  it("waits for pooled connections to close and disposes idempotently", async () => {
    const disposable = await createTestDatabase();
    await disposable.pool.query("SELECT 1");
    await Promise.all([disposable.dispose(), disposable.dispose()]);
    await expect(disposable.pool.query("SELECT 1")).rejects.toThrow(/end/);
  });
});
