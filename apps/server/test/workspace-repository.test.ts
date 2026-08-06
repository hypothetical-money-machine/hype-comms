import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  REACTIONS_PER_MEMBER_PER_MESSAGE_MAX,
  REACTIONS_PER_MESSAGE_MAX,
  type CreateTaskRequest,
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
const reactionEmojis = [
  "😀",
  "😃",
  "😄",
  "😁",
  "😆",
  "😅",
  "😂",
  "🤣",
  "😊",
  "😇",
  "🙂",
  "🙃",
  "😉",
  "😌",
  "😍",
  "🥰",
  "😘",
  "😗",
  "😙",
  "😚",
  "😋",
  "😛",
] as const;

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
      kind: "human",
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
  return { currentUser: user, sessionId, principalKind: "human" };
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

function searchCursor(
  query: string,
  overrides: Partial<{
    queryHash: string;
    rank: number;
    workspaceSequence: string;
    id: string;
  }> = {},
): string {
  return Buffer.from(
    JSON.stringify({
      queryHash: createHash("sha256").update(query.trim()).digest("base64url"),
      rank: 0.1,
      workspaceSequence: "1",
      id: randomUUID(),
      ...overrides,
    }),
    "utf8",
  ).toString("base64url");
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

function taskInput(title: string, overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    title,
    description: null,
    priority: "none",
    assigneeId: null,
    dueOn: null,
    sourceMessageId: null,
    ...overrides,
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
               sync_events, conversation_read_cursors, message_reactions, message_mentions, messages,
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
       VALUES ($1, 'Hype Comms', 'hmm-chat', $2)`,
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

  async function seedMessageEvents(count: number): Promise<string[]> {
    const cursors: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const sent = await repository.sendMessage(owner, generalId, {
        ...message(randomUUID(), `sync event ${index + 1}`),
        mentionedUserIds: [],
      });
      cursors.push(sent.syncCursor);
    }
    return cursors;
  }

  async function seedReactionRows(
    messageId: string,
    entries: readonly { readonly userId: string; readonly emoji: string }[],
  ): Promise<void> {
    await pool.query(
      `INSERT INTO message_reactions (id, workspace_id, message_id, user_id, emoji)
       SELECT seed.id, $2, $3, seed.user_id, seed.emoji
         FROM unnest($1::uuid[], $4::uuid[], $5::text[]) AS seed(id, user_id, emoji)`,
      [
        entries.map(() => randomUUID()),
        workspaceId,
        messageId,
        entries.map((entry) => entry.userId),
        entries.map((entry) => entry.emoji),
      ],
    );
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

  it("bootstraps its cursor and summaries from one repeatable-read snapshot", async () => {
    const cursorRead = Promise.withResolvers<void>();
    const continueBootstrap = Promise.withResolvers<void>();
    const racingRepository = new WorkspaceRepository(pool, {
      afterBootstrapCursorRead: async () => {
        cursorRead.resolve();
        await continueBootstrap.promise;
      },
    });

    const bootstrapping = racingRepository.bootstrap(member);
    await cursorRead.promise;
    let sent: Awaited<ReturnType<WorkspaceRepository["sendMessage"]>>;
    try {
      sent = await repository.sendMessage(owner, generalId, message(randomUUID()));
    } finally {
      continueBootstrap.resolve();
    }
    const bootstrap = await bootstrapping;
    expect(bootstrap).toMatchObject({
      syncCursor: "0",
      conversations: [
        {
          lastMessage: null,
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    });

    const replay = await repository.sync(member, bootstrap.syncCursor, 100);
    expect(replay.events).toContainEqual(
      expect.objectContaining({
        type: "message.created",
        workspaceSequence: sent.syncCursor,
        payload: expect.objectContaining({
          message: expect.objectContaining({ id: sent.message.id }),
        }),
      }),
    );
  });

  it("emits remaining canonical counts only to the member advancing the cursor", async () => {
    const rendered = await repository.sendMessage(owner, generalId, message(randomUUID()));
    const committedAfterRender = await repository.sendMessage(
      owner,
      generalId,
      message(randomUUID(), "still unread @member"),
    );

    const advanced = await repository.advanceReadCursor(member, generalId, rendered.message.id);
    const legacySync = await repository.sync(member, committedAfterRender.syncCursor, 100);
    const legacyReadEvent = legacySync.events.find((event) => event.type === "read_cursor.updated");
    expect(legacyReadEvent?.payload).toEqual({
      readCursor: expect.objectContaining({ lastReadMessageId: rendered.message.id }),
    });

    const memberSync = await repository.sync(
      member,
      committedAfterRender.syncCursor,
      100,
      false,
      true,
    );
    const readEvent = memberSync.events.find((event) => event.type === "read_cursor.updated");
    expect(readEvent).toMatchObject({
      workspaceSequence: advanced.syncCursor,
      payload: {
        readCursor: {
          userId: memberId,
          lastReadMessageId: rendered.message.id,
          lastReadConversationSequence: rendered.message.conversationSequence,
        },
        unreadCount: 1,
        mentionCount: 1,
      },
    });

    const [ownerSync, observerSync] = await Promise.all([
      repository.sync(owner, committedAfterRender.syncCursor, 100),
      repository.sync(observer, committedAfterRender.syncCursor, 100),
    ]);
    for (const sync of [ownerSync, observerSync]) {
      expect(sync.events.some((event) => event.id === readEvent?.id)).toBe(false);
    }
    expect(
      (await repository.listConversations(member, undefined, CONVERSATION_PAGE_DEFAULT_LIMIT))
        .conversations[0],
    ).toMatchObject({ unreadCount: 1, mentionCount: 1 });
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

  it("replays channel mutations without duplicating rows or sync events", async () => {
    const idempotencyKey = randomUUID();
    const input = {
      name: "Reliable Operations",
      slug: "reliable-operations",
      topic: null,
      access: "members",
    } as const;
    const [created, replayedCreate] = await Promise.all([
      repository.createChannel(owner, input, idempotencyKey),
      repository.createChannel(owner, input, idempotencyKey),
    ]);
    expect(replayedCreate).toEqual(created);
    await expect(
      repository.createChannel(owner, { ...input, slug: "different-channel" }, idempotencyKey),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);

    const conversationId = created.conversation.conversation.id;
    const [added, replayedAdd] = await Promise.all([
      repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" }),
      repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" }),
    ]);
    expect(replayedAdd).toEqual(added);
    const [removed, replayedRemove] = await Promise.all([
      repository.removeChannelMember(owner, conversationId, memberId),
      repository.removeChannelMember(owner, conversationId, memberId),
    ]);
    expect(replayedRemove).toEqual(removed);
    const [archived, replayedArchive] = await Promise.all([
      repository.archiveChannel(owner, conversationId),
      repository.archiveChannel(owner, conversationId),
    ]);
    expect(replayedArchive).toEqual(archived);

    const counts = await pool.query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count
         FROM sync_events
        WHERE conversation_id = $1
        GROUP BY event_type
        ORDER BY event_type`,
      [conversationId],
    );
    expect(counts.rows).toEqual([
      { event_type: "channel.archived", count: "1" },
      { event_type: "channel.created", count: "1" },
      { event_type: "channel.membership_changed", count: "2" },
    ]);
    expect(
      (await pool.query("SELECT id FROM conversations WHERE slug = $1", [input.slug])).rowCount,
    ).toBe(1);
  });

  it("adds and removes reactions idempotently while hydrating authorized messages", async () => {
    const sent = await repository.sendMessage(owner, generalId, {
      ...message(randomUUID(), "reaction target"),
      mentionedUserIds: [],
    });
    const [first, replay] = await Promise.all([
      repository.addReaction(owner, sent.message.id, "🎉"),
      repository.addReaction(owner, sent.message.id, "🎉"),
    ]);
    expect(replay.reaction).toEqual(first.reaction);
    expect(
      (
        await pool.query(
          `SELECT id FROM message_reactions
            WHERE message_id = $1 AND user_id = $2 AND emoji = '🎉'`,
          [sent.message.id, ownerId],
        )
      ).rowCount,
    ).toBe(1);

    const memberReaction = await repository.addReaction(member, sent.message.id, "🎉");
    const listed = await repository.listMessageReactions(observer, [sent.message.id]);
    expect(listed.reactions).toEqual([first.reaction, memberReaction.reaction]);

    const [removed, absent] = await Promise.all([
      repository.removeReaction(owner, sent.message.id, "🎉"),
      repository.removeReaction(owner, sent.message.id, "🎉"),
    ]);
    expect([removed.removed, absent.removed].sort()).toEqual([false, true]);
    expect((await repository.listMessageReactions(owner, [sent.message.id])).reactions).toEqual([
      memberReaction.reaction,
    ]);

    const legacySync = await repository.sync(observer, sent.syncCursor, 100);
    expect(legacySync.events).toEqual([]);
    expect(legacySync.nextCursor).toBe(legacySync.highWaterCursor);

    const sync = await repository.sync(observer, sent.syncCursor, 100, true);
    const reactionEvents = sync.events.filter(
      (event) => event.type === "reaction.added" || event.type === "reaction.removed",
    );
    expect(reactionEvents).toHaveLength(3);
    expect(reactionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reaction.added",
          conversationId: generalId,
          conversationSequence: sent.message.conversationSequence,
          payload: { reaction: first.reaction },
        }),
        expect.objectContaining({
          type: "reaction.added",
          payload: { reaction: memberReaction.reaction },
        }),
        expect.objectContaining({
          type: "reaction.removed",
          payload: { reaction: first.reaction },
        }),
      ]),
    );
  });

  it("serializes the per-member reaction cap at its concurrent boundary", async () => {
    const sent = await repository.sendMessage(owner, generalId, {
      ...message(randomUUID(), "member quota target"),
      mentionedUserIds: [],
    });
    await seedReactionRows(
      sent.message.id,
      reactionEmojis
        .slice(0, REACTIONS_PER_MEMBER_PER_MESSAGE_MAX - 1)
        .map((emoji) => ({ userId: ownerId, emoji })),
    );

    const attempts = await Promise.allSettled([
      repository.addReaction(
        owner,
        sent.message.id,
        reactionEmojis[REACTIONS_PER_MEMBER_PER_MESSAGE_MAX - 1],
      ),
      repository.addReaction(
        owner,
        sent.message.id,
        reactionEmojis[REACTIONS_PER_MEMBER_PER_MESSAGE_MAX],
      ),
    ]);
    const failure = attempts.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(failure?.reason as ApiError).toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    } satisfies Partial<ApiError>);
    expect(
      (
        await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM message_reactions
            WHERE message_id = $1 AND user_id = $2`,
          [sent.message.id, ownerId],
        )
      ).rows[0]?.count,
    ).toBe(String(REACTIONS_PER_MEMBER_PER_MESSAGE_MAX));
    await expect(
      repository.addReaction(
        owner,
        sent.message.id,
        reactionEmojis[REACTIONS_PER_MEMBER_PER_MESSAGE_MAX + 1],
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
  });

  it("serializes the total reaction cap at its concurrent boundary", async () => {
    const sent = await repository.sendMessage(owner, generalId, {
      ...message(randomUUID(), "total quota target"),
      mentionedUserIds: [],
    });
    const extraUsers = Array.from({ length: 10 }, (_, index) => ({
      id: randomUUID(),
      username: `reaction-quota-${index}`,
    }));
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       SELECT seed.id, seed.username || '@example.com', seed.username, seed.username
         FROM unnest($1::uuid[], $2::text[]) AS seed(id, username)`,
      [extraUsers.map((user) => user.id), extraUsers.map((user) => user.username)],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       SELECT $1, seed.user_id, 'member', 'active'
         FROM unnest($2::uuid[]) AS seed(user_id)`,
      [workspaceId, extraUsers.map((user) => user.id)],
    );

    const reactingUserIds = [ownerId, memberId, observerId, ...extraUsers.map((user) => user.id)];
    const seededEntries = reactingUserIds.flatMap((userId, index) =>
      reactionEmojis
        .slice(0, index === reactingUserIds.length - 1 ? 9 : 20)
        .map((emoji) => ({ userId, emoji })),
    );
    expect(seededEntries).toHaveLength(REACTIONS_PER_MESSAGE_MAX - 1);
    await seedReactionRows(sent.message.id, seededEntries);

    const finalUser = extraUsers.at(-1);
    if (finalUser === undefined) throw new Error("Reaction quota user was not created");
    const finalIdentity = identity(
      currentUser(finalUser.id, finalUser.username, finalUser.username, "member"),
    );
    const attempts = await Promise.allSettled([
      repository.addReaction(finalIdentity, sent.message.id, reactionEmojis[9]),
      repository.addReaction(finalIdentity, sent.message.id, reactionEmojis[10]),
    ]);
    const failure = attempts.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(failure?.reason as ApiError).toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    } satisfies Partial<ApiError>);
    expect(
      (
        await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM message_reactions WHERE message_id = $1`,
          [sent.message.id],
        )
      ).rows[0]?.count,
    ).toBe(String(REACTIONS_PER_MESSAGE_MAX));
    await expect(
      repository.addReaction(finalIdentity, sent.message.id, reactionEmojis[11]),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
  });

  it("enforces conversation visibility and archived-channel write rules for reactions", async () => {
    const privateChannel = await repository.createChannel(owner, {
      name: "Reaction Council",
      slug: "reaction-council",
      topic: null,
      access: "members",
    });
    const conversationId = privateChannel.conversation.conversation.id;
    const sent = await repository.sendMessage(owner, conversationId, {
      ...message(randomUUID(), "private reaction target"),
      mentionedUserIds: [],
    });

    await expect(repository.addReaction(member, sent.message.id, "👍")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);
    await expect(repository.listMessageReactions(member, [sent.message.id])).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);
    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" });
    await expect(repository.addReaction(member, sent.message.id, "👍")).resolves.toMatchObject({
      reaction: { userId: memberId, messageId: sent.message.id, emoji: "👍" },
    });
    await repository.removeChannelMember(owner, conversationId, memberId);
    await expect(repository.removeReaction(member, sent.message.id, "👍")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);
    await expect(repository.listMessageReactions(member, [sent.message.id])).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);

    const publicChannel = await repository.createChannel(owner, {
      name: "Archived Reactions",
      slug: "archived-reactions",
      topic: null,
      access: "workspace",
    });
    const archivedConversationId = publicChannel.conversation.conversation.id;
    const archivedMessage = await repository.sendMessage(owner, archivedConversationId, {
      ...message(randomUUID(), "archived reaction target"),
      mentionedUserIds: [],
    });
    await repository.archiveChannel(owner, archivedConversationId);
    await expect(
      repository.addReaction(owner, archivedMessage.message.id, "👍"),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
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

  it("creates one reusable direct conversation for messaging yourself", async () => {
    const direct = await repository.createDirectConversation(owner, { memberId: ownerId });
    const conversationId = direct.conversation.conversation.id;

    expect(direct.conversation.participantIds).toEqual([ownerId]);
    expect(
      (await repository.bootstrap(owner)).conversations.find(
        (summary) => summary.conversation.id === conversationId,
      ),
    ).toMatchObject({ participantIds: [ownerId] });

    const replay = await repository.createDirectConversation(owner, { memberId: ownerId });
    expect(replay).toEqual(direct);

    const sent = await repository.sendMessage(owner, conversationId, {
      ...message(randomUUID(), "note to self"),
      mentionedUserIds: [],
    });
    await expect(repository.history(owner, conversationId, undefined, 50)).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: sent.message.id, body: "note to self" })],
    });
  });

  it("creates, pages, updates, and canonically reorders channel and personal tasks", async () => {
    const source = await repository.sendMessage(
      owner,
      generalId,
      message(randomUUID(), "Turn this decision into work @member"),
    );
    const createKey = randomUUID();
    const [createdA, replayedA] = await Promise.all([
      repository.createTask(
        owner,
        generalId,
        taskInput("Draft the rollout", {
          priority: "high",
          assigneeId: memberId,
          dueOn: "2026-09-01",
          sourceMessageId: source.message.id,
        }),
        createKey,
      ),
      repository.createTask(
        owner,
        generalId,
        taskInput("Draft the rollout", {
          priority: "high",
          assigneeId: memberId,
          dueOn: "2026-09-01",
          sourceMessageId: source.message.id,
        }),
        createKey,
      ),
    ]);
    expect(replayedA).toEqual(createdA);
    const createdB = await repository.createTask(
      owner,
      generalId,
      taskInput("Prepare the announcement"),
      randomUUID(),
    );
    const createdC = await repository.createTask(
      owner,
      generalId,
      taskInput("Confirm launch metrics"),
      randomUUID(),
    );

    const firstPage = await repository.listConversationTasks(owner, generalId, undefined, 2);
    expect(firstPage.tasks).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await repository.listConversationTasks(
      owner,
      generalId,
      firstPage.nextCursor ?? undefined,
      2,
    );
    expect(secondPage.hasMore).toBe(false);
    expect(new Set([...firstPage.tasks, ...secondPage.tasks].map((task) => task.id))).toEqual(
      new Set([createdA.task.id, createdB.task.id, createdC.task.id]),
    );

    const movedC = await repository.moveTask(
      owner,
      createdC.task.id,
      {
        expectedVersion: createdC.task.version,
        status: "todo",
        beforeTaskId: createdA.task.id,
      },
      randomUUID(),
    );
    expect(movedC.task.rank).not.toBe(createdC.task.rank);
    const board = await pool.query<{ title: string }>(
      `SELECT title FROM tasks
        WHERE conversation_id = $1 AND status = 'todo'
        ORDER BY rank, id`,
      [generalId],
    );
    expect(board.rows.map((row) => row.title)).toEqual([
      "Confirm launch metrics",
      "Draft the rollout",
      "Prepare the announcement",
    ]);

    const updatedA = await repository.updateTask(
      owner,
      createdA.task.id,
      {
        expectedVersion: createdA.task.version,
        title: "Draft and review the rollout",
        description: "Include rollback ownership.",
        priority: "urgent",
        assigneeId: memberId,
        dueOn: "2026-09-02",
      },
      randomUUID(),
    );
    await expect(
      repository.updateTask(
        owner,
        createdA.task.id,
        {
          expectedVersion: createdA.task.version,
          title: "Stale edit",
          description: null,
          priority: "none",
          assigneeId: null,
          dueOn: null,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
    const completedA = await repository.moveTask(
      owner,
      createdA.task.id,
      { expectedVersion: updatedA.task.version, status: "done", beforeTaskId: null },
      randomUUID(),
    );
    expect(completedA.task).toMatchObject({ status: "done" });
    expect(completedA.task.completedAt).not.toBeNull();

    const assigned = await repository.listMyTasks(member, undefined, 100);
    expect(assigned.tasks).toContainEqual(
      expect.objectContaining({ id: createdA.task.id, assigneeId: memberId }),
    );
    const legacySync = await repository.sync(owner, "0", 100, false, false, false);
    expect(legacySync.events.some((event) => event.type.startsWith("task."))).toBe(false);
    const taskSync = await repository.sync(owner, "0", 100, false, false, true);
    expect(taskSync.events).toContainEqual(
      expect.objectContaining({
        type: "task.updated",
        entityVersion: completedA.task.version,
        payload: { task: completedA.task },
      }),
    );

    const ordinaryDirect = await repository.createDirectConversation(owner, { memberId });
    await expect(
      repository.createTask(
        owner,
        ordinaryDirect.conversation.conversation.id,
        taskInput("Not a shared-DM task"),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);

    const selfDirect = await repository.createDirectConversation(owner, { memberId: ownerId });
    const personal = await repository.createTask(
      owner,
      selfDirect.conversation.conversation.id,
      taskInput("Remember the follow-up", { assigneeId: ownerId }),
      randomUUID(),
    );
    expect((await repository.listMyTasks(owner, undefined, 100)).tasks).toContainEqual(
      expect.objectContaining({ id: personal.task.id, assigneeId: ownerId }),
    );
  });

  it("keeps task pagination stable when an unseen task is updated", async () => {
    const created = [];
    for (const title of ["First task", "Second task", "Third task"]) {
      created.push(
        await repository.createTask(
          owner,
          generalId,
          taskInput(title, { assigneeId: memberId }),
          randomUUID(),
        ),
      );
    }

    const boardFirstPage = await repository.listConversationTasks(owner, generalId, undefined, 2);
    const myFirstPage = await repository.listMyTasks(member, undefined, 2);
    const firstPageIds = new Set(boardFirstPage.tasks.map((task) => task.id));
    expect(new Set(myFirstPage.tasks.map((task) => task.id))).toEqual(firstPageIds);
    const unseen = created.find(({ task }) => !firstPageIds.has(task.id));
    expect(unseen).toBeDefined();
    if (unseen === undefined) throw new Error("Expected an unseen task");

    await repository.updateTask(
      owner,
      unseen.task.id,
      {
        expectedVersion: unseen.task.version,
        title: `${unseen.task.title} updated`,
        description: unseen.task.description,
        priority: unseen.task.priority,
        assigneeId: unseen.task.assigneeId,
        dueOn: unseen.task.dueOn,
      },
      randomUUID(),
    );

    const boardSecondPage = await repository.listConversationTasks(
      owner,
      generalId,
      boardFirstPage.nextCursor ?? undefined,
      2,
    );
    const mySecondPage = await repository.listMyTasks(
      member,
      myFirstPage.nextCursor ?? undefined,
      2,
    );
    const expectedIds = new Set(created.map(({ task }) => task.id));
    expect(
      new Set([...boardFirstPage.tasks, ...boardSecondPage.tasks].map((task) => task.id)),
    ).toEqual(expectedIds);
    expect(new Set([...myFirstPage.tasks, ...mySecondPage.tasks].map((task) => task.id))).toEqual(
      expectedIds,
    );
  });

  it("unassigns tasks before removing a member from a private channel", async () => {
    const channel = await repository.createChannel(owner, {
      name: "Task Crew",
      slug: "task-crew",
      topic: null,
      access: "members",
    });
    const conversationId = channel.conversation.conversation.id;
    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" });
    const created = await repository.createTask(
      owner,
      conversationId,
      taskInput("Member-owned work", { assigneeId: memberId }),
      randomUUID(),
    );

    await repository.removeChannelMember(owner, conversationId, memberId);

    const [task] = (await repository.listConversationTasks(owner, conversationId, undefined, 10))
      .tasks;
    expect(task).toMatchObject({ id: created.task.id, assigneeId: null, version: 2 });
    await expect(
      repository.listConversationTasks(member, conversationId, undefined, 10),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    const memberSync = await repository.sync(member, created.syncCursor, 100, false, false, true);
    expect(memberSync.events.some((event) => event.type === "task.updated")).toBe(false);
  });

  it("expires a nonzero cursor behind high-water when no sync events remain", async () => {
    const [staleCursor] = await seedMessageEvents(2);
    if (staleCursor === undefined) throw new Error("Expected a stale sync cursor");
    await pool.query(`DELETE FROM sync_events WHERE workspace_id = $1`, [workspaceId]);

    await expect(repository.sync(owner, staleCursor, 100)).rejects.toMatchObject({
      statusCode: 410,
      code: "CURSOR_EXPIRED",
    } satisfies Partial<ApiError>);
  });

  it("returns an empty sync when the cursor equals high-water and no sync events remain", async () => {
    const highWaterCursor = (await seedMessageEvents(2)).at(-1);
    if (highWaterCursor === undefined) throw new Error("Expected a high-water sync cursor");
    await pool.query(`DELETE FROM sync_events WHERE workspace_id = $1`, [workspaceId]);

    await expect(repository.sync(owner, highWaterCursor, 100)).resolves.toEqual({
      events: [],
      nextCursor: highWaterCursor,
      highWaterCursor,
      hasMore: false,
    });
  });

  it("preserves bootstrap from zero when no sync events remain", async () => {
    const highWaterCursor = (await seedMessageEvents(2)).at(-1);
    if (highWaterCursor === undefined) throw new Error("Expected a high-water sync cursor");
    await pool.query(`DELETE FROM sync_events WHERE workspace_id = $1`, [workspaceId]);

    await expect(repository.sync(owner, "0", 100)).resolves.toEqual({
      events: [],
      nextCursor: "0",
      highWaterCursor,
      hasMore: false,
    });
  });

  it("expires a cursor that falls before the retained sync event range", async () => {
    const [staleCursor, retainedPredecessor, earliestRetainedCursor] = await seedMessageEvents(3);
    if (
      staleCursor === undefined ||
      retainedPredecessor === undefined ||
      earliestRetainedCursor === undefined
    ) {
      throw new Error("Expected seeded sync cursors");
    }
    await pool.query(
      `DELETE FROM sync_events
        WHERE workspace_id = $1 AND workspace_sequence <= $2::bigint`,
      [workspaceId, retainedPredecessor],
    );

    await expect(repository.sync(owner, staleCursor, 100)).rejects.toMatchObject({
      statusCode: 410,
      code: "CURSOR_EXPIRED",
    } satisfies Partial<ApiError>);
  });

  it("searches only messages in conversations the caller can currently access", async () => {
    const searchBody = "Quarterly avalanche review";
    const publicMessage = await repository.sendMessage(owner, generalId, {
      ...message(randomUUID(), searchBody),
      mentionedUserIds: [],
    });
    const privateChannel = await repository.createChannel(owner, {
      name: "Private Search",
      slug: "private-search",
      topic: null,
      access: "members",
    });
    const privateConversationId = privateChannel.conversation.conversation.id;
    const privateMessage = await repository.sendMessage(owner, privateConversationId, {
      ...message(randomUUID(), searchBody),
      mentionedUserIds: [],
    });
    const direct = await repository.createDirectConversation(owner, { memberId });
    const directMessage = await repository.sendMessage(owner, direct.conversation.conversation.id, {
      ...message(randomUUID(), searchBody),
      mentionedUserIds: [],
    });

    const ownerSearch = await repository.searchMessages(
      owner,
      "quarterly avalanche",
      undefined,
      50,
    );
    expect(new Set(ownerSearch.results.map(({ message: result }) => result.id))).toEqual(
      new Set([publicMessage.message.id, privateMessage.message.id, directMessage.message.id]),
    );
    const memberSearch = await repository.searchMessages(
      member,
      "quarterly avalanche",
      undefined,
      50,
    );
    expect(new Set(memberSearch.results.map(({ message: result }) => result.id))).toEqual(
      new Set([publicMessage.message.id, directMessage.message.id]),
    );
    const observerSearch = await repository.searchMessages(
      observer,
      "quarterly avalanche",
      undefined,
      50,
    );
    expect(observerSearch.results.map(({ message: result }) => result.id)).toEqual([
      publicMessage.message.id,
    ]);

    const pagedIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.searchMessages(owner, "quarterly avalanche", cursor, 1);
      pagedIds.push(...page.results.map(({ message: result }) => result.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(pagedIds).toEqual(ownerSearch.results.map(({ message: result }) => result.id));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);

    await repository.upsertChannelMember(owner, privateConversationId, memberId, {
      role: "member",
    });
    expect(
      (await repository.searchMessages(member, "quarterly avalanche", undefined, 50)).results.map(
        ({ message: result }) => result.id,
      ),
    ).toContain(privateMessage.message.id);
    await repository.removeChannelMember(owner, privateConversationId, memberId);
    expect(
      (await repository.searchMessages(member, "quarterly avalanche", undefined, 50)).results.map(
        ({ message: result }) => result.id,
      ),
    ).not.toContain(privateMessage.message.id);

    await expect(
      repository.searchMessages(owner, "quarterly avalanche", "not-a-cursor", 50),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" } satisfies Partial<ApiError>);
    const firstPage = await repository.searchMessages(owner, "quarterly avalanche", undefined, 1);
    expect(firstPage.nextCursor).not.toBeNull();
    await expect(
      repository.searchMessages(owner, "different query", firstPage.nextCursor ?? undefined, 1),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" } satisfies Partial<ApiError>);
    await expect(
      repository.searchMessages(
        owner,
        "quarterly avalanche",
        searchCursor("quarterly avalanche", { rank: 1e39 }),
        50,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" } satisfies Partial<ApiError>);
    await expect(
      repository.searchMessages(
        owner,
        "quarterly avalanche",
        searchCursor("quarterly avalanche", { workspaceSequence: "9223372036854775808" }),
        50,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" } satisfies Partial<ApiError>);
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
      reactionEvents: false,
      readStateEvents: false,
      taskEvents: false,
    });
    await expect(repository.consumeRealtimeTicket(issued.ticket)).resolves.toBeNull();

    const capable = await repository.issueRealtimeTicket(owner, true, true, true);
    await expect(repository.consumeRealtimeTicket(capable.ticket)).resolves.toEqual({
      workspaceId,
      userId: ownerId,
      deviceSessionId: ownerSessionId,
      reactionEvents: true,
      readStateEvents: true,
      taskEvents: true,
    });
  });

  it("consumes but refuses a ticket when its workspace membership was revoked", async () => {
    const issued = await repository.issueRealtimeTicket(owner);
    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'revoked'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, ownerId],
    );

    await expect(repository.consumeRealtimeTicket(issued.ticket)).resolves.toBeNull();

    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'active'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, ownerId],
    );
    await expect(repository.consumeRealtimeTicket(issued.ticket)).resolves.toBeNull();
  });

  it("refuses a ticket when its workspace membership row is absent", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE realtime_tickets
         ALTER CONSTRAINT realtime_tickets_workspace_id_user_id_fkey
         DEFERRABLE INITIALLY DEFERRED`,
      );
      await client.query(`SET CONSTRAINTS realtime_tickets_workspace_id_user_id_fkey DEFERRED`);
      await client.query(
        `INSERT INTO device_sessions
           (id, user_id, token_hash, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [member.sessionId, memberId, Buffer.alloc(32, 8), now, later],
      );
      await client.query(
        `DELETE FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberId],
      );
      const transactionRepository = new WorkspaceRepository(client as unknown as Pool);
      const issued = await transactionRepository.issueRealtimeTicket(member);

      expect(
        (
          await client.query(
            `SELECT 1
               FROM workspace_memberships
              WHERE workspace_id = $1 AND user_id = $2`,
            [workspaceId, memberId],
          )
        ).rowCount,
      ).toBe(0);
      await expect(transactionRepository.consumeRealtimeTicket(issued.ticket)).resolves.toBeNull();
      const ticketState = await client.query<{ consumed_at: Date | string | null }>(
        `SELECT consumed_at
           FROM realtime_tickets
          WHERE token_hash = $1`,
        [createHash("sha256").update(issued.ticket).digest()],
      );
      expect(ticketState.rows[0]?.consumed_at).not.toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
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
