import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import type { CurrentUser } from "@hype-comms/contracts";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { ApiError } from "../src/errors.js";
import { BotService } from "../src/modules/bots/service.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-08-05T12:00:00.000Z");
const expiresAt = "2026-11-03T12:00:00.000Z";
const ownerId = "20000000-0000-4000-8000-000000000001";
const memberId = "20000000-0000-4000-8000-000000000002";
const workspaceId = "20000000-0000-4000-8000-000000000003";
const generalId = "20000000-0000-4000-8000-000000000004";
const otherId = "20000000-0000-4000-8000-000000000005";
const privateId = "20000000-0000-4000-8000-000000000006";

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

const ownerCurrentUser: CurrentUser = {
  user: {
    id: ownerId,
    kind: "human",
    username: "owner",
    displayName: "Owner",
    avatarUrl: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  },
  email: "owner@example.com",
  workspaceId,
  role: "owner",
};

const owner: AuthenticatedIdentity = {
  currentUser: ownerCurrentUser,
  sessionId: "20000000-0000-4000-8000-000000000007",
  principalKind: "human",
};

describeWithPostgres("BotService", () => {
  const schemaName = `bot_service_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let service: BotService;
  let workspaceRepository: WorkspaceRepository;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
    service = new BotService(pool, () => now);
    workspaceRepository = new WorkspaceRepository(pool, { humansOnlyChannelsEnabled: true });
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE bot_channel_grants, bot_credentials, realtime_tickets, api_idempotency_records,
               sync_event_audiences, sync_events, conversation_read_cursors, message_reactions,
               message_mentions, attachments, messages, conversation_memberships, conversations,
               device_sessions, magic_link_tokens, invitations, workspace_memberships,
               workspaces, users
      CASCADE
    `);
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       VALUES ($1, 'owner@example.com', 'human', 'owner', 'Owner'),
              ($2, 'member@example.com', 'human', 'member', 'Member')`,
      [ownerId, memberId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Hype Comms', 'hype-comms', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'),
              ($1, $3, 'member', 'active')`,
      [workspaceId, ownerId, memberId],
    );
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by)
       VALUES ($1, $4, 'channel', 'General', 'general', 'workspace', $5),
              ($2, $4, 'channel', 'Other', 'other', 'workspace', $5),
              ($3, $4, 'channel', 'Private', 'private', 'members', $5)`,
      [generalId, otherId, privateId, workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO conversation_memberships
         (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [privateId, workspaceId, ownerId],
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  it("creates a hash-only principal with least-privilege channel visibility", async () => {
    const issued = await service.createBot(ownerId, {
      username: "release-bot",
      displayName: "Release Bot",
      channelSlugs: ["general"],
      scopes: ["tasks:read", "tasks:write"],
      expiresAt,
    });
    const authenticated = await service.authenticate(issued.token);
    expect(authenticated).toMatchObject({
      principalKind: "bot",
      currentUser: {
        user: { id: issued.bot.id, kind: "bot", username: "release-bot" },
        workspaceId,
        role: "member",
      },
      scopes: ["tasks:read", "tasks:write"],
    });
    if (authenticated === null) throw new Error("Expected bot authentication");

    const stored = await pool.query<{
      email: string | null;
      kind: string;
      token_hash_hex: string;
    }>(
      `SELECT user_account.email,
              user_account.kind,
              encode(credential.token_hash, 'hex') AS token_hash_hex
         FROM bot_credentials AS credential
         JOIN users AS user_account ON user_account.id = credential.bot_user_id
        WHERE credential.id = $1`,
      [issued.credentialId],
    );
    expect(stored.rows[0]).toEqual({
      email: null,
      kind: "bot",
      token_hash_hex: hashToken(issued.token).toString("hex"),
    });

    await expect(
      workspaceRepository.listConversationTasks(authenticated, generalId, undefined, 100),
    ).resolves.toEqual({ tasks: [], nextCursor: null, hasMore: false });
    await expect(
      workspaceRepository.listConversationTasks(authenticated, otherId, undefined, 100),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    await expect(
      workspaceRepository.listConversationTasks(authenticated, privateId, undefined, 100),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);

    expect(await service.grantChannels(ownerId, "release-bot", ["private"])).toBe(1);
    await expect(
      workspaceRepository.listConversationTasks(authenticated, privateId, undefined, 100),
    ).resolves.toEqual({ tasks: [], nextCursor: null, hasMore: false });
    await expect(
      workspaceRepository.createDirectConversation(owner, { memberId: issued.bot.id }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);

    expect((await workspaceRepository.listMembers(owner)).members).toContainEqual(
      expect.objectContaining({ id: issued.bot.id, kind: "bot", username: "release-bot" }),
    );
    expect(await service.listBots(ownerId)).toEqual([
      expect.objectContaining({
        bot: expect.objectContaining({ id: issued.bot.id, kind: "bot" }),
        activeCredentials: 1,
        channelSlugs: ["general", "private"],
      }),
    ]);
  });

  it("attributes bot task writes and rotates and revokes credentials", async () => {
    const first = await service.createBot(ownerId, {
      username: "task-bot",
      displayName: "Task Bot",
      channelSlugs: ["general"],
      scopes: ["tasks:read", "tasks:write"],
      expiresAt,
    });
    const authenticated = await service.authenticate(first.token);
    if (authenticated === null) throw new Error("Expected bot authentication");
    const created = await workspaceRepository.createChannelTask(
      authenticated,
      "general",
      {
        title: "Verify the release",
        description: null,
        priority: "high",
        assigneeId: authenticated.currentUser.user.id,
        dueOn: "2026-08-20",
        sourceMessageId: null,
      },
      randomUUID(),
    );
    expect(created.task).toMatchObject({
      createdBy: authenticated.currentUser.user.id,
      updatedBy: authenticated.currentUser.user.id,
      assigneeId: authenticated.currentUser.user.id,
    });
    await expect(workspaceRepository.getTask(authenticated, created.task.id)).resolves.toEqual({
      task: { ...created.task, updatedBy: authenticated.currentUser.user.id },
    });
    await expect(
      workspaceRepository.getChannelTaskByNumber(authenticated, "general", created.task.number),
    ).resolves.toEqual({
      task: { ...created.task, updatedBy: authenticated.currentUser.user.id },
    });
    await expect(
      workspaceRepository.listChannelTasks(authenticated, "general", undefined, 100, {
        status: "todo",
        priority: "high",
        assignee: "me",
        dueAfter: "2026-08-01",
        dueBefore: "2026-08-31",
        updatedAfter: "2000-01-01T00:00:00.000Z",
        updatedBy: "me",
      }),
    ).resolves.toMatchObject({
      tasks: [{ ...created.task, updatedBy: authenticated.currentUser.user.id }],
    });
    const event = await pool.query<{ actor_user_id: string }>(
      `SELECT actor_user_id
         FROM sync_events
        WHERE event_type = 'task.created'
          AND payload->'task'->>'id' = $1`,
      [created.task.id],
    );
    expect(event.rows[0]?.actor_user_id).toBe(authenticated.currentUser.user.id);

    const updated = await workspaceRepository.updateTask(
      owner,
      created.task.id,
      {
        expectedVersion: created.task.version,
        title: "Verify and report the release",
        description: null,
        priority: "urgent",
        assigneeId: authenticated.currentUser.user.id,
        dueOn: created.task.dueOn,
      },
      randomUUID(),
    );
    await expect(
      workspaceRepository.getTask(authenticated, updated.task.id),
    ).resolves.toMatchObject({ task: { id: updated.task.id, updatedBy: ownerId } });
    await expect(
      workspaceRepository.listChannelTasks(authenticated, "general", undefined, 100, {
        updatedBy: "me",
      }),
    ).resolves.toMatchObject({ tasks: [] });

    const rotated = await service.rotateCredential(ownerId, {
      username: "task-bot",
      scopes: ["tasks:read"],
      expiresAt,
    });
    await expect(service.authenticate(first.token)).resolves.toBeNull();
    await expect(service.authenticate(rotated.token)).resolves.toMatchObject({
      scopes: ["tasks:read"],
    });
    expect(await service.revokeCredentials(ownerId, "task-bot")).toBe(1);
    await expect(service.authenticate(rotated.token)).resolves.toBeNull();
  });

  it("rejects announcement channels before creating or extending a bot", async () => {
    const announcementId = randomUUID();
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, channel_mode, created_by)
       VALUES ($1, $2, 'channel', 'Announcements', 'announcements', 'workspace',
               'announcement', $3)`,
      [announcementId, workspaceId, ownerId],
    );

    await expect(
      service.createBot(ownerId, {
        username: "announcement-bot",
        displayName: "Announcement Bot",
        channelSlugs: ["announcements"],
        scopes: ["tasks:read"],
        expiresAt,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    await expect(
      pool.query("SELECT 1 FROM users WHERE username = 'announcement-bot'"),
    ).resolves.toMatchObject({ rowCount: 0 });

    const issued = await service.createBot(ownerId, {
      username: "release-bot",
      displayName: "Release Bot",
      channelSlugs: ["general"],
      scopes: ["tasks:read"],
      expiresAt,
    });
    await expect(
      service.grantChannels(ownerId, issued.bot.username, ["announcements"]),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    await expect(
      pool.query(
        `SELECT 1
           FROM bot_channel_grants
          WHERE bot_user_id = $1 AND conversation_id = $2`,
        [issued.bot.id, announcementId],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rejects humans-only channels before creating or extending a bot", async () => {
    const created = await workspaceRepository.createChannel(owner, {
      name: "People",
      slug: "people",
      topic: "Humans only",
      access: "humans",
    });
    const humansOnlyChannelId = created.conversation.conversation.id;
    expect(created.conversation.conversation.access).toBe("humans");

    await expect(
      service.createBot(ownerId, {
        username: "people-bot",
        displayName: "People Bot",
        channelSlugs: ["people"],
        scopes: ["tasks:read"],
        expiresAt,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    await expect(
      pool.query("SELECT 1 FROM users WHERE username = 'people-bot'"),
    ).resolves.toMatchObject({ rowCount: 0 });

    const issued = await service.createBot(ownerId, {
      username: "release-bot",
      displayName: "Release Bot",
      channelSlugs: ["general"],
      scopes: ["tasks:read"],
      expiresAt,
    });
    await expect(
      service.grantChannels(ownerId, issued.bot.username, ["people"]),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    await expect(
      pool.query(
        `SELECT 1
           FROM bot_channel_grants
          WHERE bot_user_id = $1 AND conversation_id = $2`,
        [issued.bot.id, humansOnlyChannelId],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("rejects expired, non-owner, and over-capacity bot provisioning", async () => {
    await expect(
      service.createBot(memberId, {
        username: "member-bot",
        displayName: "Member Bot",
        channelSlugs: ["general"],
        scopes: ["tasks:read"],
        expiresAt,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" } satisfies Partial<ApiError>);
    await expect(
      service.createBot(ownerId, {
        username: "expired-bot",
        displayName: "Expired Bot",
        channelSlugs: ["general"],
        scopes: ["tasks:read"],
        expiresAt: now.toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" } satisfies Partial<ApiError>);

    const extraUsers = Array.from({ length: 23 }, () => randomUUID());
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       SELECT seed.id,
              ('capacity-' || seed.ordinality || '@example.com')::public.citext,
              'human',
              'capacity-' || seed.ordinality,
              'Capacity ' || seed.ordinality
         FROM unnest($1::uuid[]) WITH ORDINALITY AS seed(id, ordinality)`,
      [extraUsers],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       SELECT $1, seed.id, 'member', 'active'
         FROM unnest($2::uuid[]) AS seed(id)`,
      [workspaceId, extraUsers],
    );
    await expect(
      service.createBot(ownerId, {
        username: "capacity-bot",
        displayName: "Capacity Bot",
        channelSlugs: ["general"],
        scopes: ["tasks:read"],
        expiresAt,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" } satisfies Partial<ApiError>);
  });
});
