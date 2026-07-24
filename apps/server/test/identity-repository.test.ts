import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const now = "2026-07-24T12:00:00.000Z";
const later = "2026-07-25T12:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

describeWithPostgres("IdentityRepository", () => {
  const schemaName = `identity_repository_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: IdentityRepository;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;

    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 6 });
    await runMigrations(pool);
    repository = new IdentityRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE device_sessions, magic_link_tokens, invitations, workspace_memberships,
               workspaces, users
      CASCADE
    `);
    await repository.insertUser({
      id: userId,
      email: "owner@example.com",
      username: "owner",
      displayName: "Workspace Owner",
      avatarUrl: null,
    });
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;

    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  it("consumes a magic link exactly once under concurrent consumers", async () => {
    const tokenHash = Buffer.alloc(32, 1);
    await repository.insertMagicLink({
      id: "10000000-0000-4000-8000-000000000010",
      tokenHash,
      email: "invitee@example.com",
      invitationId: null,
      expiresAt: later,
      createdAt: now,
    });

    const results = await Promise.all([
      repository.consumeMagicLink(tokenHash, "2026-07-24T12:01:00.000Z"),
      repository.consumeMagicLink(tokenHash, "2026-07-24T12:02:00.000Z"),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["already_consumed", "consumed"]);
    expect((await repository.consumeMagicLink(tokenHash, later)).status).toBe("already_consumed");
  });

  it("rotates a session token while preserving its device lineage", async () => {
    const previousHash = Buffer.alloc(32, 2);
    const nextHash = Buffer.alloc(32, 3);
    const id = "10000000-0000-4000-8000-000000000020";
    await repository.insertDeviceSession({
      id,
      userId,
      tokenHash: previousHash,
      label: "Morgan's laptop",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: later,
    });

    const result = await repository.rotateDeviceSession(
      previousHash,
      nextHash,
      "2026-07-24T13:00:00.000Z",
    );

    expect(result).toMatchObject({ status: "rotated", session: { id } });
    expect(await repository.findDeviceSessionByTokenHash(previousHash)).toBeNull();
    expect(await repository.findDeviceSessionByTokenHash(nextHash)).toMatchObject({ id });
    expect(
      (await repository.rotateDeviceSession(previousHash, Buffer.alloc(32, 4), later)).status,
    ).toBe("unavailable");
  });

  it("revokes every session for a user and makes their tokens unusable", async () => {
    const firstHash = Buffer.alloc(32, 5);
    const secondHash = Buffer.alloc(32, 6);
    await Promise.all([
      repository.insertDeviceSession({
        id: "10000000-0000-4000-8000-000000000030",
        userId,
        tokenHash: firstHash,
        label: "Phone",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: later,
      }),
      repository.insertDeviceSession({
        id: "10000000-0000-4000-8000-000000000031",
        userId,
        tokenHash: secondHash,
        label: "Laptop",
        createdAt: now,
        lastSeenAt: now,
        expiresAt: later,
      }),
    ]);

    expect(await repository.revokeAllDeviceSessions(userId, later)).toBe(2);
    expect(await repository.findDeviceSessionByTokenHash(firstHash)).toBeNull();
    expect(await repository.findDeviceSessionByTokenHash(secondHash)).toBeNull();
    expect(await repository.listDeviceSessions(userId)).toEqual([
      expect.objectContaining({ revokedAt: later }),
      expect.objectContaining({ revokedAt: later }),
    ]);
  });

  it("rejects a second pending invitation for the same case-insensitive email", async () => {
    await repository.insertWorkspace({
      id: workspaceId,
      name: "HMM",
      slug: "hmm",
      createdBy: userId,
    });
    await repository.insertInvitation({
      id: "10000000-0000-4000-8000-000000000040",
      workspaceId,
      email: "invitee@example.com",
      role: "member",
      invitedBy: userId,
      expiresAt: later,
    });

    await expect(
      repository.insertInvitation({
        id: "10000000-0000-4000-8000-000000000041",
        workspaceId,
        email: "INVITEE@example.com",
        role: "member",
        invitedBy: userId,
        expiresAt: later,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
