import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPool } from "../src/db/pool.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import * as summaryReader from "../src/modules/workspace/conversation-summary-reader.js";
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

  it("reads a conversation page and its details from one repeatable-read snapshot", async () => {
    const conversationId = randomUUID();
    const authorId = randomUUID();
    const messageId = randomUUID();
    await database.pool.query(
      "INSERT INTO users (id, email, username, display_name) VALUES ($1, 'author@example.test', 'author', 'Author')",
      [authorId],
    );
    await database.pool.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')",
      [workspaceId, authorId],
    );
    await database.pool.query(
      "INSERT INTO conversations (id, workspace_id, kind, name, slug, channel_access, created_by) VALUES ($1, $2, 'channel', 'Snapshot', 'snapshot', 'workspace', $3)",
      [conversationId, workspaceId, userId],
    );
    const writer = createPool({ url: database.url, poolSize: 1 });
    const readDetails = summaryReader.readConversationSummaries;
    const details = vi
      .spyOn(summaryReader, "readConversationSummaries")
      .mockImplementationOnce(async (client, actorId, conversations) => {
        expect(conversations.map((conversation) => conversation.id)).toEqual([conversationId]);
        // Commit after the page is selected and before any batched detail query starts.
        await writer.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, body, body_format
           ) VALUES ($1, $2, $3, 1, 1, $4, decode(repeat('00', 32), 'hex'), $5,
                     'arrived after page selection', 'hype_comms_markdown_v1')`,
          [messageId, workspaceId, conversationId, randomUUID(), authorId],
        );
        await writer.query(
          "INSERT INTO message_mentions (message_id, mentioned_user_id) VALUES ($1, $2)",
          [messageId, userId],
        );
        return readDetails(client, actorId, conversations);
      });
    try {
      const repository = new WorkspaceRepository(database.pool);
      const page = await repository.listConversations(identity, undefined, 1);
      expect(details).toHaveBeenCalledOnce();
      expect(page.conversations[0]).toMatchObject({
        lastMessage: null,
        unreadCount: 0,
        mentionCount: 0,
      });
      details.mockRestore();
      const nextPage = await repository.listConversations(identity, undefined, 1);
      expect(nextPage.conversations[0]).toMatchObject({
        lastMessage: { id: messageId },
        unreadCount: 1,
        mentionCount: 1,
      });
    } finally {
      details.mockRestore();
      await writer.end();
    }
  });
});
