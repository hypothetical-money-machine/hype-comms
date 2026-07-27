import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  type CurrentUser,
  type SendConversationMessageRequest,
} from "@hmm-chat/contracts";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { ApiError } from "../src/errors.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import type { RealtimePrincipal } from "../src/modules/realtime/auth.js";
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

const ownerPrincipal: RealtimePrincipal = {
  userId: ownerId,
  workspaceId,
  deviceSessionId: ownerSessionId,
};

/** The wire form of a conversation keyset cursor, so tests can page from an arbitrary anchor. */
function conversationCursor(conversationId: string): string {
  return Buffer.from(JSON.stringify({ id: conversationId }), "utf8").toString("base64url");
}

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
               conversation_memberships, conversations, device_sessions, magic_link_tokens,
               invitations,
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
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by)
       VALUES ($1, $2, 'channel', 'General', 'general', 'workspace', $3)`,
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

  async function seedChannels(count: number): Promise<void> {
    const ids = Array.from({ length: count }, () => randomUUID());
    const labels = ids.map((_, index) => String(index + 1).padStart(4, "0"));
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by)
       SELECT seed.id, $2, 'channel', seed.name, seed.slug, 'workspace', $5
         FROM unnest($1::uuid[], $3::text[], $4::text[]) AS seed(id, name, slug)`,
      [
        ids,
        workspaceId,
        labels.map((label) => `Channel ${label}`),
        labels.map((label) => `channel-${label}`),
        ownerId,
      ],
    );
  }

  /** The order the repository promises, computed independently of the paging implementation. */
  async function orderedConversationIds(): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT id
         FROM conversations
        WHERE workspace_id = $1
        ORDER BY kind, lower(coalesce(name, '')), created_at, id`,
      [workspaceId],
    );
    return result.rows.map((row) => row.id);
  }

  it("boots into #general and tracks unread mentions and read cursors", async () => {
    const bootstrap = await repository.bootstrap(owner);
    expect(bootstrap.conversations).toHaveLength(1);
    expect(bootstrap.conversations[0]?.conversation.slug).toBe("general");

    const sent = await repository.sendMessage(owner, generalId, message(randomUUID()));
    const memberView = await repository.listConversations(
      member,
      undefined,
      CONVERSATION_PAGE_DEFAULT_LIMIT,
    );
    expect(memberView.conversations[0]).toMatchObject({
      unreadCount: 1,
      mentionCount: 1,
    });

    await repository.advanceReadCursor(member, generalId, sent.message.id);
    const readView = await repository.listConversations(
      member,
      undefined,
      CONVERSATION_PAGE_DEFAULT_LIMIT,
    );
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

  it("grants and revokes member-only channel access across every message boundary", async () => {
    const created = await repository.createChannel(owner, {
      name: "Leadership",
      slug: "leadership",
      topic: "Private planning",
      access: "members",
    });
    const conversationId = created.conversation.conversation.id;
    expect(created.conversation).toMatchObject({
      membershipRole: "owner",
      conversation: { access: "members" },
    });

    const observerConversations = await repository.listConversations(
      observer,
      undefined,
      CONVERSATION_PAGE_DEFAULT_LIMIT,
    );
    expect(
      observerConversations.conversations.some(
        (summary) => summary.conversation.id === conversationId,
      ),
    ).toBe(false);
    await expect(repository.history(observer, conversationId, undefined, 50)).rejects.toMatchObject(
      { statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>,
    );
    await expect(
      repository.sendMessage(observer, conversationId, {
        ...message(randomUUID(), "private"),
        mentionedUserIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    await expect(repository.listChannelMembers(observer, conversationId)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);

    const added = await repository.upsertChannelMember(owner, conversationId, memberId, {
      role: "member",
    });
    expect(added.channelMembers).toMatchObject({ canManage: true, access: "members" });
    expect(added.channelMembers.members.map(({ user: listed }) => listed.id)).toEqual([
      memberId,
      ownerId,
    ]);
    expect(
      (await repository.listConversations(member, undefined, 50)).conversations.find(
        (summary) => summary.conversation.id === conversationId,
      ),
    ).toMatchObject({ membershipRole: "member" });

    await expect(
      repository.upsertChannelMember(member, conversationId, observerId, { role: "member" }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" } satisfies Partial<ApiError>);
    const privateMessageInput = message(randomUUID());
    const privateMessage = await repository.sendMessage(
      member,
      conversationId,
      privateMessageInput,
    );
    expect(privateMessage).toMatchObject({ message: { conversationId } });
    await expect(
      repository.sendMessage(owner, conversationId, {
        ...message(randomUUID(), "secret @observer"),
        mentionedUserIds: [observerId],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" } satisfies Partial<ApiError>);

    const removed = await repository.removeChannelMember(owner, conversationId, memberId);
    expect(removed.channelMembers.members).toHaveLength(1);
    await expect(repository.history(member, conversationId, undefined, 50)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);
    expect(
      (await repository.listConversations(member, undefined, 50)).conversations.some(
        (summary) => summary.conversation.id === conversationId,
      ),
    ).toBe(false);
    await expect(
      repository.sendMessage(member, conversationId, privateMessageInput),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);

    const memberSync = await repository.sync(member, added.syncCursor, 100);
    expect(memberSync.events).toContainEqual(
      expect.objectContaining({
        type: "channel.membership_changed",
        conversationId,
        payload: { memberId, action: "removed" },
      }),
    );
    const replayedSync = await repository.sync(member, "0", 100);
    expect(
      replayedSync.events.some(
        (event) => event.type === "message.created" && event.conversationId === conversationId,
      ),
    ).toBe(false);
    expect(replayedSync.events).toContainEqual(
      expect.objectContaining({
        type: "channel.membership_changed",
        conversationId,
        payload: { memberId, action: "removed" },
      }),
    );
  });

  it("always retains an owner for a member-only channel", async () => {
    const created = await repository.createChannel(owner, {
      name: "Steering",
      slug: "steering",
      topic: null,
      access: "members",
    });
    const conversationId = created.conversation.conversation.id;

    await expect(
      repository.removeChannelMember(owner, conversationId, ownerId),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
    await expect(
      repository.upsertChannelMember(owner, conversationId, ownerId, { role: "member" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);

    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "owner" });
    const removals = await Promise.allSettled([
      repository.removeChannelMember(owner, conversationId, ownerId),
      repository.removeChannelMember(member, conversationId, memberId),
    ]);
    expect(removals.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = removals.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    } satisfies Partial<ApiError>);
    const activeOwners = await pool.query(
      `SELECT user_id
         FROM conversation_memberships
        WHERE conversation_id = $1 AND role = 'owner' AND left_at IS NULL`,
      [conversationId],
    );
    expect(activeOwners.rowCount).toBe(1);
  });

  it("does not count a workspace-revoked member as an active channel owner", async () => {
    const created = await repository.createChannel(owner, {
      name: "Operations",
      slug: "operations",
      topic: null,
      access: "members",
    });
    const conversationId = created.conversation.conversation.id;
    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "owner" });
    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'revoked'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, memberId],
    );

    await expect(
      repository.removeChannelMember(owner, conversationId, ownerId),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
    await expect(
      repository.upsertChannelMember(owner, conversationId, ownerId, { role: "member" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
  });

  it("reports workspace channels as visible to everyone but not individually managed", async () => {
    const members = await repository.listChannelMembers(member, generalId);
    expect(members).toMatchObject({
      conversationId: generalId,
      access: "workspace",
      canManage: false,
    });
    expect(members.members.map(({ user: listed }) => listed.id)).toEqual([
      memberId,
      observerId,
      ownerId,
    ]);
    await expect(
      repository.upsertChannelMember(owner, generalId, memberId, { role: "owner" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
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

  it("bootstraps one bounded page past the response cap and pages every conversation exactly once", async () => {
    // One more conversation than a response may carry: before pagination this made
    // workspaceBootstrapResponseSchema.parse throw, which the error handler mapped to 500.
    await seedChannels(CONVERSATION_PAGE_MAX_LIMIT);
    const expectedIds = await orderedConversationIds();
    expect(expectedIds.length).toBe(CONVERSATION_PAGE_MAX_LIMIT + 1);

    const bootstrap = await repository.bootstrap(owner);
    expect(bootstrap.conversations).toHaveLength(CONVERSATION_PAGE_DEFAULT_LIMIT);
    expect(bootstrap.conversationsHasMore).toBe(true);
    expect(bootstrap.conversationsNextCursor).not.toBeNull();

    const walked = bootstrap.conversations.map((summary) => summary.conversation.id);
    let cursor = bootstrap.conversationsNextCursor;
    let pages = 0;
    while (cursor !== null) {
      pages += 1;
      expect(pages).toBeLessThanOrEqual(expectedIds.length);
      const page = await repository.listConversations(
        owner,
        cursor,
        CONVERSATION_PAGE_DEFAULT_LIMIT,
      );
      // A handed-out cursor must always lead to progress, never to an empty page.
      expect(page.conversations.length).toBeGreaterThan(0);
      expect(page.conversations.length).toBeLessThanOrEqual(CONVERSATION_PAGE_DEFAULT_LIMIT);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      walked.push(...page.conversations.map((summary) => summary.conversation.id));
      cursor = page.nextCursor;
    }

    expect(walked).toEqual(expectedIds);
    expect(new Set(walked).size).toBe(walked.length);
  }, 120_000);

  it("stops conversation paging at an exact page boundary and on an empty trailing page", async () => {
    await seedChannels(3);
    const expectedIds = await orderedConversationIds();
    expect(expectedIds).toHaveLength(4);

    const exact = await repository.listConversations(owner, undefined, 4);
    expect(exact.conversations.map((summary) => summary.conversation.id)).toEqual(expectedIds);
    expect(exact.hasMore).toBe(false);
    expect(exact.nextCursor).toBeNull();

    const first = await repository.listConversations(owner, undefined, 2);
    expect(first.conversations.map((summary) => summary.conversation.id)).toEqual(
      expectedIds.slice(0, 2),
    );
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.listConversations(owner, first.nextCursor ?? undefined, 2);
    expect(second.conversations.map((summary) => summary.conversation.id)).toEqual(
      expectedIds.slice(2),
    );
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();

    const lastId = expectedIds.at(-1);
    if (lastId === undefined) throw new Error("Expected a seeded conversation");
    const beyond = await repository.listConversations(owner, conversationCursor(lastId), 4);
    expect(beyond.conversations).toEqual([]);
    expect(beyond.hasMore).toBe(false);
    expect(beyond.nextCursor).toBeNull();

    const historyShapedCursor = Buffer.from(JSON.stringify({ sequence: "1" }), "utf8").toString(
      "base64url",
    );
    const rejected = repository.listConversations(owner, historyShapedCursor, 4);
    await expect(rejected).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    } satisfies Partial<ApiError>);
  });

  it("continues conversation paging after the member loses access to the cursor anchor", async () => {
    const created = await repository.createChannel(owner, {
      name: "A Private",
      slug: "a-private",
      topic: null,
      access: "members",
    });
    const conversationId = created.conversation.conversation.id;
    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" });

    const first = await repository.listConversations(member, undefined, 1);
    expect(first.conversations.map((summary) => summary.conversation.id)).toEqual([conversationId]);
    expect(first.nextCursor).not.toBeNull();

    await repository.removeChannelMember(owner, conversationId, memberId);
    const second = await repository.listConversations(member, first.nextCursor ?? undefined, 50);
    expect(second.conversations.map((summary) => summary.conversation.id)).toContain(generalId);
  });

  it("revalidates a live realtime principal and rejects an unknown device session", async () => {
    await expect(repository.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
      status: "valid",
    });
    await expect(
      repository.revalidateRealtimePrincipal({
        ...ownerPrincipal,
        deviceSessionId: randomUUID(),
      }),
    ).resolves.toEqual({ status: "invalid", reason: "unknown_session" });
    // Revalidation is read-only: the session must survive being checked.
    expect(
      (await pool.query("SELECT id FROM device_sessions WHERE revoked_at IS NULL")).rowCount,
    ).toBe(1);
  });

  it("invalidates a realtime principal whose device session was revoked", async () => {
    await pool.query(`UPDATE device_sessions SET revoked_at = clock_timestamp() WHERE id = $1`, [
      ownerSessionId,
    ]);
    await expect(repository.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
      status: "invalid",
      reason: "session_revoked",
    });
  });

  it("invalidates a realtime principal whose device session expired", async () => {
    await pool.query(
      `UPDATE device_sessions
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [ownerSessionId],
    );
    await expect(repository.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
      status: "invalid",
      reason: "session_expired",
    });
  });

  it("invalidates a realtime principal whose membership is no longer active", async () => {
    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'revoked'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, ownerId],
    );
    await expect(repository.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
      status: "invalid",
      reason: "membership_inactive",
    });
    await expect(
      repository.revalidateRealtimePrincipal({ ...ownerPrincipal, workspaceId: randomUUID() }),
    ).resolves.toEqual({ status: "invalid", reason: "membership_inactive" });
  });
});
