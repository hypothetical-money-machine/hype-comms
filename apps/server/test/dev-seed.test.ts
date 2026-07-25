import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import { loadConfig } from "../src/config.js";
import { seedDevelopmentDemo, writeDevelopmentDemoCallbacks } from "../src/dev-seed.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

describeWithPostgres("development demo seed", () => {
  const schemaName = `dev_seed_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let callbackDirectory: string;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
    callbackDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-demo-callbacks-"));
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
    await rm(callbackDirectory, { recursive: true, force: true });
  });

  it("seeds two sign-in-ready clients and stable conversation data", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HMM_DATABASE_URL: schemaScopedUrl(testDatabaseUrl ?? "", schemaName),
      HMM_PUBLIC_API_URL: "http://127.0.0.1:3000",
    });

    const first = await seedDevelopmentDemo(pool, config);
    const eventCountAfterFirst = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sync_events",
    );
    const second = await seedDevelopmentDemo(pool, config);

    expect(first.clients.map(({ profile, displayName }) => ({ profile, displayName }))).toEqual([
      { profile: "claire", displayName: "Claire" },
      { profile: "woots", displayName: "Woots" },
    ]);
    for (const client of [...first.clients, ...second.clients]) {
      const callback = new URL(client.authCallbackUrl);
      expect(callback.protocol).toBe("hmm-chat:");
      expect(callback.hostname).toBe("auth");
      expect(callback.pathname).toBe("/callback");
      expect(callback.searchParams.get("token")).not.toBeNull();
    }
    expect(first.channels).toEqual(["general", "launch-planning", "design", "random"]);
    expect(first.messageCount).toBe(8);
    expect(second.workspaceId).toBe(first.workspaceId);
    const output = await writeDevelopmentDemoCallbacks(second, callbackDirectory);
    expect(JSON.stringify(output)).not.toContain("token=");
    for (const client of output.clients) {
      expect((await stat(client.callbackFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(client.callbackFile, "utf8")).toContain("token=");
    }

    const counts = await pool.query<{
      users: string;
      memberships: string;
      conversations: string;
      messages: string;
      events: string;
      magic_links: string;
    }>(`
      SELECT
        (SELECT count(*) FROM users)::text AS users,
        (SELECT count(*) FROM workspace_memberships)::text AS memberships,
        (SELECT count(*) FROM conversations)::text AS conversations,
        (SELECT count(*) FROM messages)::text AS messages,
        (SELECT count(*) FROM sync_events)::text AS events,
        (SELECT count(*) FROM magic_link_tokens)::text AS magic_links
    `);
    expect(counts.rows[0]).toEqual({
      users: "2",
      memberships: "2",
      conversations: "5",
      messages: "8",
      events: eventCountAfterFirst.rows[0]?.count,
      magic_links: "4",
    });
  });
});
