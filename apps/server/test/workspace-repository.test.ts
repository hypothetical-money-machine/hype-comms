import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import type { CurrentUser, SendConversationMessageRequest } from "@hmm-chat/contracts";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { ApiError } from "../src/errors.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const now = "2026-07-24T12:00:00.000Z";
const later = "2026-08-24T12:00:00.000Z";
const ownerId = "10000000-0000-4000-8000-000000000001";
const memberId = "10000000-0000-4000-8000-000000000002";
const observerId = "10000000-0000-4000-8000-000000000003";
const workspaceId = "10000000-0000-4000-8000-000000000004";
const generalId = "10000000-0000-4000-8000-000000000005";
const ownerSessionId = "10000000-0000-4000-8000-000000000006";

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

function currentUser(
  id: string,
  username: string,
  displayName: string,
  role: "owner" | "member",
): CurrentUser {
  return {
    user: {
      id,
      username,
      displayName,
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    email: `${username}@example.com`,
    workspaceId,
    role,
  };
}

function identity(user: CurrentUser, sessionId = randomUUID()): AuthenticatedIdentity {
  return { currentUser: user, sessionId };
}

const owner = identity(currentUser(ownerId, "owner", "Owner", "owner"), ownerSessionId);
const member = identity(currentUser(memberId, "member", "Member", "member"));
const observer = identity(currentUser(observerId, "observer", "Observer", "member"));

function message(clientMessageId: string, body = "hello @member"): SendConversationMessageRequest {
  return {
    threadRootId: null,
    body,
    bodyFormat: "hmm_markdown_v1",
    clientMessageId,
    mentionedUserIds: [memberId],
    attachmentIds: [],
  };
}

describeWithPostgres("WorkspaceRepository", () => {
  const schemaName = `workspace_repository_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: WorkspaceRepository;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
    repository = new WorkspaceRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE realtime_tickets, api_idempotency_records, sync_event_audiences,
               sync_events, conversation_read_cursors, message_mentions, messages,
               conversations, device_sessions, magic_link_tokens, invitations,
               workspace_memberships, workspaces, users
      CASCADE
    `);
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'owner@example.com', 'owner', 'Owner'),
              ($2, 'member@example.com', 'member', 'Member'),
              ($3, 'observer@example.com', 'observer', 'Observer')`,
      [ownerId, memberId, observerId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'HMM Chat', 'hmm-chat', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'),
              ($1, $3, 'member', 'active'),
              ($1, $4, 'member', 'active')`,
      [workspaceId, ownerId, memberId, observerId],
    );
    await pool.query(
      `INSERT INTO conversations (id, workspace_id, kind, name, slug, created_by)
       VALUES ($1, $2, 'channel', 'General', 'general', $3)`,
      [generalId, workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [ownerSessionId, ownerId, Buffer.alloc(32, 7), now, later],
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  it("boots into #general and tracks unread mentions and read cursors", async () => {
    const bootstrap = await repository.bootstrap(owner);
    expect(bootstrap.conversations).toHaveLength(1);
    expect(bootstrap.conversations[0]?.conversation.slug).toBe("general");

    const sent = await repository.sendMessage(owner, generalId, message(randomUUID()));
    const memberView = await repository.listConversations(member);
    expect(memberView.conversations[0]).toMatchObject({
      unreadCount: 1,
      mentionCount: 1,
    });

    await repository.advanceReadCursor(member, generalId, sent.message.id);
    const readView = await repository.listConversations(member);
    expect(readView.conversations[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it("returns one canonical message for concurrent retries and conflicts on changed input", async () => {
    const clientMessageId = randomUUID();
    const [first, second] = await Promise.all([
      repository.sendMessage(owner, generalId, message(clientMessageId)),
      repository.sendMessage(owner, generalId, message(clientMessageId)),
    ]);
    expect(second).toEqual(first);
    expect(
      (await pool.query("SELECT id FROM messages WHERE client_message_id = $1", [clientMessageId]))
        .rowCount,
    ).toBe(1);

    await expect(
      repository.sendMessage(owner, generalId, message(clientMessageId, "changed @member")),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
  });

  it("keeps direct-message history and events private while advancing other cursors", async () => {
    const direct = await repository.createDirectConversation(owner, { memberId });
    const conversationId = direct.conversation.conversation.id;
    await repository.sendMessage(owner, conversationId, message(randomUUID()));

    const memberSync = await repository.sync(member, "0", 100);
    expect(memberSync.events.some((event) => event.conversationId === conversationId)).toBe(true);
    const observerSync = await repository.sync(observer, "0", 100);
    expect(observerSync.events.some((event) => event.conversationId === conversationId)).toBe(
      false,
    );
    expect(observerSync.nextCursor).toBe(observerSync.highWaterCursor);
    await expect(repository.history(observer, conversationId, undefined, 50)).rejects.toMatchObject(
      {
        statusCode: 404,
        code: "NOT_FOUND",
      },
    );
  });

  it("consumes realtime tickets exactly once", async () => {
    const issued = await repository.issueRealtimeTicket(owner);
    await expect(repository.consumeRealtimeTicket(issued.ticket)).resolves.toEqual({
      workspaceId,
      userId: ownerId,
      deviceSessionId: ownerSessionId,
    });
    await expect(repository.consumeRealtimeTicket(issued.ticket)).resolves.toBeNull();
  });
});
