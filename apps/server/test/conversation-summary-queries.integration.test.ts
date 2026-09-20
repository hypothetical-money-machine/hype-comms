import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { createTestDatabase, type TestDatabase } from "./support/database.js";

const userId = randomUUID();
const workspaceId = randomUUID();
const now = "2026-09-12T00:00:00.000Z";
const identity: AuthenticatedIdentity = {
  principalKind: "human",
  sessionId: randomUUID(),
  currentUser: {
    user: {
      id: userId,
      kind: "human",
      username: "summary",
      displayName: "Summary",
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    email: "summary@example.test",
    workspaceId,
    role: "owner",
  },
};

describe("conversation summary query budget", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    // One connection makes statement counting include every query issued by the repository.
    database = await createTestDatabase({ poolSize: 1 });
  });
  afterAll(async () => {
    await database?.dispose();
  });
  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      "INSERT INTO users (id, email, username, display_name) VALUES ($1, 'summary@example.test', 'summary', 'Summary')",
      [userId],
    );
    await database.pool.query(
      "INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Summary', 'summary', $2)",
      [workspaceId, userId],
    );
    await database.pool.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
      [workspaceId, userId],
    );
  });

  it.each([1, 10, 50])("bounds bootstrap queries for %i channels", async (count) => {
    await database.pool.query(
      `INSERT INTO conversations (id, workspace_id, kind, name, slug, channel_access, created_by)
       SELECT gen_random_uuid(), $1, 'channel', 'Channel ' || n, 'channel-' || n, 'workspace', $2
         FROM generate_series(1, $3::integer) AS n`,
      [workspaceId, userId, count],
    );
    const client = await database.pool.connect();
    const queries = vi.spyOn(client, "query");
    client.release();
    try {
      const response = await new WorkspaceRepository(database.pool).bootstrap(identity);
      expect(response.conversations).toHaveLength(count);
      expect(
        response.conversations.every((summary) => summary.participantIds.includes(userId)),
      ).toBe(true);
      // Includes BEGIN and COMMIT. An accidental per-conversation query fails for 10 and 50 rows.
      expect(queries.mock.calls.length).toBeGreaterThan(0);
      expect(queries.mock.calls.length).toBeLessThanOrEqual(12);
      console.info(
        JSON.stringify({ channels: count, bootstrapStatements: queries.mock.calls.length }),
      );
    } finally {
      queries.mockRestore();
    }
  });
});
