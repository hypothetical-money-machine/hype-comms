import { escapeIdentifier, type Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import * as migrations from "../../src/db/migrate.js";
import * as poolModule from "../../src/db/pool.js";
import { createTestDatabase } from "./database.js";

describe("disposable database setup", () => {
  it("closes both pools and removes its database when migrations fail during setup", async () => {
    const witness = await createTestDatabase({ migrate: false });
    const failure = new Error("Migration setup failed");
    const adminPools: Pool[] = [];
    let workloadPool: Pool | undefined;
    let databaseName: string | undefined;
    const originalCreatePool = poolModule.createPool;
    const createPoolSpy = vi.spyOn(poolModule, "createPool").mockImplementation((options) => {
      const pool = originalCreatePool(options);
      adminPools.push(pool);
      return pool;
    });
    const migrationSpy = vi
      .spyOn(migrations, "runMigrations")
      .mockImplementationOnce(async (pool) => {
        workloadPool = pool;
        const result = await pool.query<{ name: string }>("SELECT current_database() AS name");
        databaseName = result.rows[0]?.name;
        throw failure;
      });
    try {
      await expect(createTestDatabase()).rejects.toBe(failure);
      expect(databaseName).toBeDefined();
      const remaining = await witness.pool.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname = $1",
        [databaseName],
      );
      expect({ databases: remaining.rows, endedPools: [...adminPools, workloadPool] }).toEqual({
        databases: [],
        endedPools: [
          expect.objectContaining({ ended: true }),
          expect.objectContaining({ ended: true }),
        ],
      });
    } finally {
      migrationSpy.mockRestore();
      createPoolSpy.mockRestore();
      try {
        for (const pool of [...adminPools, workloadPool]) {
          if (pool !== undefined && !pool.ending) await pool.end();
        }
        if (databaseName !== undefined) {
          await witness.pool.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)}`);
        }
      } finally {
        await witness.dispose();
      }
    }
  });
});
