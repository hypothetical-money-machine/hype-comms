import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";

import type { AgentCurrentPrincipal, CurrentUser } from "@hype-comms/contracts";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { DomainError } from "../src/domain-errors.js";
import type {
  AuthenticatedAgentIdentity,
  AuthenticatedIdentity,
} from "../src/modules/identity/service.js";
import type { RealtimePrincipal } from "../src/modules/realtime/auth.js";
import {
  type ConversationRow,
  WorkspaceAuthorization,
} from "../src/modules/workspace/authorization.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const now = "2026-07-24T12:00:00.000Z";
const ownerId = "10000000-0000-4000-8000-000000000001";
const memberId = "10000000-0000-4000-8000-000000000002";
const observerId = "10000000-0000-4000-8000-000000000003";
const workspaceId = "10000000-0000-4000-8000-000000000004";
const generalId = "10000000-0000-4000-8000-000000000005";
const ownerSessionId = "10000000-0000-4000-8000-000000000006";
const agentId = "10000000-0000-4000-8000-000000000007";
const agentTokenId = "10000000-0000-4000-8000-000000000008";
const botId = "10000000-0000-4000-8000-000000000009";
const outsiderId = "10000000-0000-4000-8000-00000000000a";
const invitedId = "10000000-0000-4000-8000-00000000000b";

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
const outsider = identity(currentUser(outsiderId, "outsider", "Outsider", "member"));
const invited = identity(currentUser(invitedId, "invited", "Invited", "member"));

const ownerPrincipal: RealtimePrincipal = {
  userId: ownerId,
  workspaceId,
  deviceSessionId: ownerSessionId,
  agentTokenId: null,
};

const agentPrincipal: RealtimePrincipal = {
  userId: agentId,
  workspaceId,
  deviceSessionId: null,
  agentTokenId,
};

const currentAgent: AgentCurrentPrincipal = {
  type: "agent",
  user: {
    id: agentId,
    kind: "agent",
    username: "authz-agent",
    displayName: "Authz Agent",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  },
  workspaceId,
  role: "member",
  scopes: ["workspace:read"],
};

const agent: AuthenticatedAgentIdentity = {
  currentUser: currentAgent,
  authorizationScopes: ["workspace:read"],
  principalKind: "agent",
  agentTokenId,
};

async function rejectedDomainError(operation: Promise<unknown>): Promise<DomainError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected the operation to reject");
}

describe("WorkspaceAuthorization", () => {
  const schemaName = `workspace_authorization_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let authorization: WorkspaceAuthorization;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
    authorization = new WorkspaceAuthorization(pool);
  });

  beforeEach(async () => {
    authorization = new WorkspaceAuthorization(pool);
    await pool.query("TRUNCATE users CASCADE");
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'owner@example.com', 'owner', 'Owner'),
              ($2, 'member@example.com', 'member', 'Member'),
              ($3, 'observer@example.com', 'observer', 'Observer')`,
      [ownerId, memberId, observerId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Hype Comms', 'hype-comms', $2)`,
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
       VALUES ($1, $2, $3, $4, $4, clock_timestamp() + interval '1 day')`,
      [ownerSessionId, ownerId, Buffer.alloc(32, 7), now],
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        return await operation(client);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  }

  async function insertOutsider(): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'outsider@example.com', 'outsider', 'Outsider')`,
      [outsiderId],
    );
  }

  async function insertInvitedHuman(): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'invited@example.com', 'invited', 'Invited')`,
      [invitedId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'invited')`,
      [workspaceId, invitedId],
    );
  }

  async function insertAgent(): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, kind, email, username, display_name)
       VALUES ($1, 'agent', NULL, 'authz-agent', 'Authz Agent')`,
      [agentId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [workspaceId, agentId],
    );
    await pool.query(
      `INSERT INTO agents
         (user_id, workspace_id, created_by, legacy_public_channel_access)
       VALUES ($1, $2, $3, false)`,
      [agentId, workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO agent_tokens
         (id, workspace_id, agent_user_id, token_hash, label, scopes,
          inherited_channels_join, inherited_attachments_write, created_by)
       VALUES ($1, $2, $3, $4, 'Authz agent', $5::text[], false, false, $6)`,
      [agentTokenId, workspaceId, agentId, Buffer.alloc(32, 9), ["workspace:read"], ownerId],
    );
  }

  async function insertBot(): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, kind, email, username, display_name)
       VALUES ($1, 'bot', NULL, 'authz-bot', 'Authz Bot')`,
      [botId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [workspaceId, botId],
    );
    await pool.query(
      `INSERT INTO bot_channel_grants
         (workspace_id, bot_user_id, conversation_id, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, botId, generalId, ownerId],
    );
  }

  async function insertMembersChannel(
    conversationId: string,
    slug: string,
    options: { readonly archived?: boolean; readonly humanOnly?: boolean } = {},
  ): Promise<void> {
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, human_only, is_archived, created_by)
       VALUES ($1, $2, 'channel', $3, $4, 'members', $5, $6, $7)`,
      [
        conversationId,
        workspaceId,
        slug,
        slug,
        options.humanOnly === true,
        options.archived === true,
        ownerId,
      ],
    );
    if (options.humanOnly === true) return;
    await pool.query(
      `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [conversationId, workspaceId, ownerId],
    );
  }

  async function insertDirectMessage(conversationId: string, lowId: string, highId: string) {
    const [dmLow, dmHigh] = lowId <= highId ? [lowId, highId] : [highId, lowId];
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
       VALUES ($1, $2, 'direct_message', $3, $4, $5)`,
      [conversationId, workspaceId, dmLow, dmHigh, ownerId],
    );
  }

  async function insertGroupDirect(conversationId: string, memberIds: readonly string[]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, created_by, group_memberships_locked)
         VALUES ($1, $2, 'group_direct_message', $3, false)`,
        [conversationId, workspaceId, ownerId],
      );
      for (const [index, userId] of memberIds.entries()) {
        await client.query(
          `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, $4)`,
          [conversationId, workspaceId, userId, index === 0 ? "owner" : "member"],
        );
      }
      await client.query(`UPDATE conversations SET group_memberships_locked = true WHERE id = $1`, [
        conversationId,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertRealtimeTicket(
    options: {
      readonly userId?: string;
      readonly sessionId?: string | null;
      readonly agentTokenId?: string | null;
      readonly expiresAtSql?: string;
      readonly createdAtSql?: string;
      readonly capabilities?: {
        readonly reactionEvents?: boolean;
        readonly readStateEvents?: boolean;
        readonly taskEvents?: boolean;
        readonly announcementChannels?: boolean;
        readonly participatedThreadNotifications?: boolean;
        readonly messageRetractEvents?: boolean;
        readonly memberProfiles?: boolean;
        readonly ephemeralActivity?: boolean;
        readonly groupDirectMessages?: boolean;
        readonly humansOnlyChannels?: boolean;
        readonly systemChannels?: boolean;
      };
    } = {},
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest();
    const capabilities = options.capabilities ?? {};
    await pool.query(
      `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, agent_token_id, token_hash,
          created_at, expires_at, reaction_events, read_state_events, task_events,
          announcement_channels, participated_thread_notifications, message_retract_events,
          member_profiles, ephemeral_activity, group_direct_messages, humans_only_channels,
          system_channels)
       VALUES (
         $1, $2, $3, $4, $5, $6,
         ${options.createdAtSql ?? "clock_timestamp()"},
         ${options.expiresAtSql ?? "clock_timestamp() + interval '1 minute'"},
         $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
       )`,
      [
        randomUUID(),
        workspaceId,
        options.userId ?? ownerId,
        options.sessionId === undefined ? ownerSessionId : options.sessionId,
        options.agentTokenId === undefined ? null : options.agentTokenId,
        hash,
        capabilities.reactionEvents === true,
        capabilities.readStateEvents === true,
        capabilities.taskEvents === true,
        capabilities.announcementChannels === true,
        capabilities.participatedThreadNotifications === true,
        capabilities.messageRetractEvents === true,
        capabilities.memberProfiles === true,
        capabilities.ephemeralActivity === true,
        capabilities.groupDirectMessages === true,
        capabilities.humansOnlyChannels === true,
        capabilities.systemChannels === true,
      ],
    );
    return token;
  }

  async function loadConversation(conversationId: string): Promise<ConversationRow> {
    const result = await pool.query<ConversationRow>(`SELECT * FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("Expected a conversation row");
    return row;
  }

  describe("canViewConversation", () => {
    it("allows humans to view a public workspace channel without a seat", async () => {
      await expect(
        authorization.canViewConversation(workspaceId, ownerId, generalId),
      ).resolves.toBe(true);
      await expect(
        authorization.canViewConversation(workspaceId, memberId, generalId),
      ).resolves.toBe(true);
    });

    it("hides a public workspace channel from an agent without a seat", async () => {
      await insertAgent();
      await expect(
        authorization.canViewConversation(workspaceId, agentId, generalId),
      ).resolves.toBe(false);
      await pool.query(
        `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [generalId, workspaceId, agentId],
      );
      await expect(
        authorization.canViewConversation(workspaceId, agentId, generalId),
      ).resolves.toBe(true);
    });

    it("requires an active conversation seat for a members-only channel", async () => {
      const privateId = randomUUID();
      await insertMembersChannel(privateId, "private");
      await expect(
        authorization.canViewConversation(workspaceId, ownerId, privateId),
      ).resolves.toBe(true);
      await expect(
        authorization.canViewConversation(workspaceId, memberId, privateId),
      ).resolves.toBe(false);
      await pool.query(
        `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [privateId, workspaceId, memberId],
      );
      await expect(
        authorization.canViewConversation(workspaceId, memberId, privateId),
      ).resolves.toBe(true);
    });

    it("lets humans view a humans-only channel and hides it from agents", async () => {
      const humansId = randomUUID();
      await insertAgent();
      await insertMembersChannel(humansId, "humans", { humanOnly: true });
      await expect(authorization.canViewConversation(workspaceId, ownerId, humansId)).resolves.toBe(
        true,
      );
      await expect(
        authorization.canViewConversation(workspaceId, memberId, humansId),
      ).resolves.toBe(true);
      await expect(authorization.canViewConversation(workspaceId, agentId, humansId)).resolves.toBe(
        false,
      );
    });

    it("lets both 1:1 participants view a direct message", async () => {
      const dmId = randomUUID();
      await insertDirectMessage(dmId, ownerId, memberId);
      await expect(authorization.canViewConversation(workspaceId, ownerId, dmId)).resolves.toBe(
        true,
      );
      await expect(authorization.canViewConversation(workspaceId, memberId, dmId)).resolves.toBe(
        true,
      );
      await expect(authorization.canViewConversation(workspaceId, observerId, dmId)).resolves.toBe(
        false,
      );
    });

    it("shows group direct messages to participants and hides them from other active members", async () => {
      const groupId = randomUUID();
      await insertGroupDirect(groupId, [ownerId, memberId, observerId]);
      await expect(authorization.canViewConversation(workspaceId, ownerId, groupId)).resolves.toBe(
        true,
      );
      await expect(authorization.canViewConversation(workspaceId, memberId, groupId)).resolves.toBe(
        true,
      );
      await insertOutsider();
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [workspaceId, outsiderId],
      );
      await expect(
        authorization.canViewConversation(workspaceId, outsiderId, groupId),
      ).resolves.toBe(false);
    });

    it("returns false when the caller has no active workspace membership", async () => {
      await insertOutsider();
      await expect(
        authorization.canViewConversation(workspaceId, outsiderId, generalId),
      ).resolves.toBe(false);
    });
  });

  describe("consumeRealtimeTicket", () => {
    it("consumes tickets once and omits retained protocol-1 capability flags", async () => {
      const issued = await insertRealtimeTicket();
      await expect(authorization.consumeRealtimeTicket(issued)).resolves.toEqual({
        workspaceId,
        userId: ownerId,
        deviceSessionId: ownerSessionId,
        agentTokenId: null,
      });
      await expect(authorization.consumeRealtimeTicket(issued)).resolves.toBeNull();

      const capable = await insertRealtimeTicket({
        capabilities: {
          reactionEvents: true,
          readStateEvents: true,
          taskEvents: true,
          announcementChannels: true,
          participatedThreadNotifications: true,
          messageRetractEvents: true,
          memberProfiles: true,
          ephemeralActivity: true,
          groupDirectMessages: true,
          humansOnlyChannels: true,
          systemChannels: true,
        },
      });
      await expect(authorization.consumeRealtimeTicket(capable)).resolves.toEqual({
        workspaceId,
        userId: ownerId,
        deviceSessionId: ownerSessionId,
        agentTokenId: null,
      });
    });

    it("returns null for a revoked or expired device session after consuming the ticket", async () => {
      const revoked = await insertRealtimeTicket();
      await pool.query(`UPDATE device_sessions SET revoked_at = clock_timestamp() WHERE id = $1`, [
        ownerSessionId,
      ]);
      await expect(authorization.consumeRealtimeTicket(revoked)).resolves.toBeNull();
      const revokedState = await pool.query<{ consumed_at: Date | string | null }>(
        `SELECT consumed_at FROM realtime_tickets WHERE token_hash = $1`,
        [createHash("sha256").update(revoked).digest()],
      );
      expect(revokedState.rows[0]?.consumed_at).not.toBeNull();

      await pool.query(`UPDATE device_sessions SET revoked_at = NULL WHERE id = $1`, [
        ownerSessionId,
      ]);
      const expired = await insertRealtimeTicket();
      await pool.query(
        `UPDATE device_sessions
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [ownerSessionId],
      );
      await expect(authorization.consumeRealtimeTicket(expired)).resolves.toBeNull();
    });

    it("returns null when workspace membership is inactive and still consumes the ticket", async () => {
      const issued = await insertRealtimeTicket();
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'revoked'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, ownerId],
      );
      await expect(authorization.consumeRealtimeTicket(issued)).resolves.toBeNull();
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'active'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, ownerId],
      );
      await expect(authorization.consumeRealtimeTicket(issued)).resolves.toBeNull();
    });

    it("accepts a valid agent token and rejects revoked tokens and disabled agents", async () => {
      await insertAgent();
      const issued = await insertRealtimeTicket({
        userId: agentId,
        sessionId: null,
        agentTokenId,
        capabilities: { systemChannels: true },
      });
      await expect(authorization.consumeRealtimeTicket(issued)).resolves.toMatchObject({
        workspaceId,
        userId: agentId,
        deviceSessionId: null,
        agentTokenId,
      });

      const revoked = await insertRealtimeTicket({
        userId: agentId,
        sessionId: null,
        agentTokenId,
      });
      await pool.query(`UPDATE agent_tokens SET revoked_at = clock_timestamp() WHERE id = $1`, [
        agentTokenId,
      ]);
      await expect(authorization.consumeRealtimeTicket(revoked)).resolves.toBeNull();

      await pool.query(`UPDATE agent_tokens SET revoked_at = NULL WHERE id = $1`, [agentTokenId]);
      const disabled = await insertRealtimeTicket({
        userId: agentId,
        sessionId: null,
        agentTokenId,
      });
      await pool.query(`UPDATE agents SET disabled_at = clock_timestamp() WHERE user_id = $1`, [
        agentId,
      ]);
      await expect(authorization.consumeRealtimeTicket(disabled)).resolves.toBeNull();
    });

    it("cannot construct a ticket with both credentials because the table check forbids it", async () => {
      await insertAgent();
      await expect(
        pool.query(
          `INSERT INTO realtime_tickets
             (id, workspace_id, user_id, device_session_id, agent_token_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '1 minute')`,
          [randomUUID(), workspaceId, ownerId, ownerSessionId, agentTokenId, Buffer.alloc(32, 11)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("revalidateRealtimePrincipal", () => {
    it("accepts a live device session and rejects unknown, revoked, and expired ones", async () => {
      await expect(authorization.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
        status: "valid",
      });
      await expect(
        authorization.revalidateRealtimePrincipal({
          ...ownerPrincipal,
          deviceSessionId: randomUUID(),
        }),
      ).resolves.toEqual({ status: "invalid", reason: "unknown_session" });

      await pool.query(`UPDATE device_sessions SET revoked_at = clock_timestamp() WHERE id = $1`, [
        ownerSessionId,
      ]);
      await expect(authorization.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
        status: "invalid",
        reason: "session_revoked",
      });
      await pool.query(`UPDATE device_sessions SET revoked_at = NULL WHERE id = $1`, [
        ownerSessionId,
      ]);
      await pool.query(
        `UPDATE device_sessions
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [ownerSessionId],
      );
      await expect(authorization.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
        status: "invalid",
        reason: "session_expired",
      });
    });

    it("rejects a human principal whose membership is no longer active", async () => {
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'revoked'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, ownerId],
      );
      await expect(authorization.revalidateRealtimePrincipal(ownerPrincipal)).resolves.toEqual({
        status: "invalid",
        reason: "membership_inactive",
      });
    });

    it("revalidates agent tokens including revoked, disabled, and inactive cases", async () => {
      await insertAgent();
      await expect(authorization.revalidateRealtimePrincipal(agentPrincipal)).resolves.toEqual({
        status: "valid",
      });
      await expect(
        authorization.revalidateRealtimePrincipal({
          ...agentPrincipal,
          agentTokenId: randomUUID(),
        }),
      ).resolves.toEqual({ status: "invalid", reason: "unknown_agent_token" });

      await pool.query(`UPDATE agent_tokens SET revoked_at = clock_timestamp() WHERE id = $1`, [
        agentTokenId,
      ]);
      await expect(authorization.revalidateRealtimePrincipal(agentPrincipal)).resolves.toEqual({
        status: "invalid",
        reason: "agent_token_revoked",
      });
      await pool.query(`UPDATE agent_tokens SET revoked_at = NULL WHERE id = $1`, [agentTokenId]);
      await pool.query(`UPDATE agents SET disabled_at = clock_timestamp() WHERE user_id = $1`, [
        agentId,
      ]);
      await expect(authorization.revalidateRealtimePrincipal(agentPrincipal)).resolves.toEqual({
        status: "invalid",
        reason: "agent_disabled",
      });
      await pool.query(`UPDATE agents SET disabled_at = NULL WHERE user_id = $1`, [agentId]);
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'revoked'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, agentId],
      );
      await expect(authorization.revalidateRealtimePrincipal(agentPrincipal)).resolves.toEqual({
        status: "invalid",
        reason: "membership_inactive",
      });
    });
  });

  describe("transactional helpers", () => {
    it("requireVisibleConversation returns a visible row and 404s otherwise", async () => {
      const archivedId = randomUUID();
      await insertMembersChannel(archivedId, "archived", { archived: true });
      await withClient(async (client) => {
        const visible = await authorization.requireVisibleConversation(
          client,
          owner,
          generalId,
          false,
        );
        expect(visible.id).toBe(generalId);
        await expect(
          authorization.requireVisibleConversation(client, owner, generalId, true, true),
        ).resolves.toMatchObject({ id: generalId, is_archived: false });
        await expect(
          authorization.requireVisibleConversation(client, owner, archivedId, false),
        ).resolves.toMatchObject({ id: archivedId, is_archived: true });
        await expect(
          authorization.requireVisibleConversation(client, member, archivedId, false),
        ).rejects.toMatchObject({
          kind: "not_found",
          message: "Conversation not found",
        } satisfies Partial<DomainError>);
        const writableArchived = await rejectedDomainError(
          authorization.requireVisibleConversation(client, owner, archivedId, true),
        );
        expect(writableArchived).toMatchObject({
          kind: "not_found",
          message: "Conversation not found",
        } satisfies Partial<DomainError>);
      });
    });

    it("requireActivePrincipal returns the locked principal or 403", async () => {
      await insertAgent();
      await withClient(async (client) => {
        await expect(authorization.requireActivePrincipal(client, owner)).resolves.toEqual({
          role: "owner",
          kind: "human",
        });
        await expect(authorization.requireActivePrincipal(client, agent)).resolves.toEqual({
          role: "member",
          kind: "agent",
        });
      });
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'revoked'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberId],
      );
      await withClient(async (client) => {
        const revoked = await rejectedDomainError(
          authorization.requireActivePrincipal(client, member),
        );
        expect(revoked).toMatchObject({
          kind: "access_denied",
          message: "Workspace unavailable",
        } satisfies Partial<DomainError>);
        const missing = await rejectedDomainError(
          authorization.requireActivePrincipal(client, outsider),
        );
        expect(missing).toMatchObject({
          kind: "access_denied",
          message: "Workspace unavailable",
        } satisfies Partial<DomainError>);
      });
    });

    it("requireHumansOnlyCreator allows an active human and rejects agents and invited humans", async () => {
      await insertAgent();
      await insertInvitedHuman();
      await withClient(async (client) => {
        await expect(authorization.requireHumansOnlyCreator(client, owner)).resolves.toEqual({
          role: "owner",
          kind: "human",
        });
        const agentDenied = await rejectedDomainError(
          authorization.requireHumansOnlyCreator(client, agent),
        );
        expect(agentDenied).toMatchObject({
          kind: "access_denied",
          message: "Only humans can create humans-only channels",
        } satisfies Partial<DomainError>);
        const invitedDenied = await rejectedDomainError(
          authorization.requireHumansOnlyCreator(client, invited),
        );
        expect(invitedDenied).toMatchObject({
          kind: "access_denied",
          message: "Only humans can create humans-only channels",
        } satisfies Partial<DomainError>);
      });
    });

    it("requireActiveConversationParticipants checks the actor and every member", async () => {
      await insertAgent();
      await insertBot();
      await insertInvitedHuman();
      await withClient(async (client) => {
        await expect(
          authorization.requireActiveConversationParticipants(client, owner, [memberId, agentId]),
        ).resolves.toBeUndefined();
        const missing = await rejectedDomainError(
          authorization.requireActiveConversationParticipants(client, owner, [randomUUID()]),
        );
        expect(missing).toMatchObject({
          kind: "not_found",
          message: "One or more members were not found",
        } satisfies Partial<DomainError>);
        const botMember = await rejectedDomainError(
          authorization.requireActiveConversationParticipants(client, owner, [botId]),
        );
        expect(botMember).toMatchObject({
          kind: "not_found",
          message: "One or more members were not found",
        } satisfies Partial<DomainError>);
        const invitedMember = await rejectedDomainError(
          authorization.requireActiveConversationParticipants(client, owner, [invitedId]),
        );
        expect(invitedMember).toMatchObject({
          kind: "not_found",
          message: "One or more members were not found",
        } satisfies Partial<DomainError>);
      });
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'revoked'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, ownerId],
      );
      await withClient(async (client) => {
        const actorGone = await rejectedDomainError(
          authorization.requireActiveConversationParticipants(client, owner, [memberId]),
        );
        expect(actorGone).toMatchObject({
          kind: "access_denied",
          message: "Workspace unavailable",
        } satisfies Partial<DomainError>);
      });
    });

    it("requireVisibleChannelBySlug and visibleChannelIdBySlug resolve live channels", async () => {
      const archivedId = randomUUID();
      await insertMembersChannel(archivedId, "archived-ops", { archived: true });
      await withClient(async (client) => {
        await expect(
          authorization.requireVisibleChannelBySlug(client, owner, "general", false),
        ).resolves.toMatchObject({ id: generalId, slug: "general" });
        await expect(
          authorization.requireVisibleChannelBySlug(client, owner, "missing", false),
        ).rejects.toMatchObject({
          kind: "not_found",
          message: "Channel not found",
        } satisfies Partial<DomainError>);
        await expect(
          authorization.requireVisibleChannelBySlug(client, owner, "archived-ops", true),
        ).rejects.toMatchObject({
          kind: "not_found",
          message: "Channel not found",
        } satisfies Partial<DomainError>);
        await expect(
          authorization.requireVisibleChannelBySlug(client, owner, "archived-ops", false),
        ).resolves.toMatchObject({ id: archivedId });
      });
      await expect(authorization.visibleChannelIdBySlug(owner, "general", true)).resolves.toBe(
        generalId,
      );
    });

    it("requireManagedChannel requires an unarchived members channel owned by the caller", async () => {
      const managedId = randomUUID();
      const humansId = randomUUID();
      await insertMembersChannel(managedId, "managed");
      await insertMembersChannel(humansId, "humans-managed", { humanOnly: true });
      await pool.query(
        `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [managedId, workspaceId, memberId],
      );
      await withClient(async (client) => {
        await expect(
          authorization.requireManagedChannel(client, owner, managedId),
        ).resolves.toMatchObject({ id: managedId, channel_access: "members" });
        const memberDenied = await rejectedDomainError(
          authorization.requireManagedChannel(client, member, managedId),
        );
        expect(memberDenied).toMatchObject({
          kind: "access_denied",
          message: "Only a channel owner can manage members",
        } satisfies Partial<DomainError>);
        const publicDenied = await rejectedDomainError(
          authorization.requireManagedChannel(client, owner, generalId),
        );
        expect(publicDenied).toMatchObject({
          kind: "not_found",
          message: "Managed channel not found",
        } satisfies Partial<DomainError>);
        const humansDenied = await rejectedDomainError(
          authorization.requireManagedChannel(client, owner, humansId),
        );
        expect(humansDenied).toMatchObject({
          kind: "not_found",
          message: "Managed channel not found",
        } satisfies Partial<DomainError>);
      });
    });

    it("requireAnotherChannelOwner keeps at least one active owner", async () => {
      const managedId = randomUUID();
      await insertMembersChannel(managedId, "owners");
      await withClient(async (client) => {
        const onlyOwner = await rejectedDomainError(
          authorization.requireAnotherChannelOwner(client, managedId, ownerId),
        );
        expect(onlyOwner).toMatchObject({
          kind: "conflict",
          message: "A channel must retain at least one owner",
        } satisfies Partial<DomainError>);
      });
      await pool.query(
        `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
        [managedId, workspaceId, memberId],
      );
      await withClient(async (client) => {
        await expect(
          authorization.requireAnotherChannelOwner(client, managedId, ownerId),
        ).resolves.toBeUndefined();
      });
      await pool.query(
        `UPDATE workspace_memberships
            SET status = 'revoked'
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberId],
      );
      await withClient(async (client) => {
        const revokedOwner = await rejectedDomainError(
          authorization.requireAnotherChannelOwner(client, managedId, ownerId),
        );
        expect(revokedOwner).toMatchObject({
          kind: "conflict",
          message: "A channel must retain at least one owner",
        } satisfies Partial<DomainError>);
      });
    });

    it("membershipRole returns the live seat or null", async () => {
      const managedId = randomUUID();
      const dmId = randomUUID();
      await insertMembersChannel(managedId, "roles");
      await insertDirectMessage(dmId, ownerId, memberId);
      await pool.query(
        `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [managedId, workspaceId, memberId],
      );
      const managed = await loadConversation(managedId);
      const direct = await loadConversation(dmId);
      await withClient(async (client) => {
        await expect(authorization.membershipRole(client, owner, managed)).resolves.toBe("owner");
        await expect(authorization.membershipRole(client, member, managed)).resolves.toBe("member");
        await expect(authorization.membershipRole(client, observer, managed)).resolves.toBeNull();
        await expect(authorization.membershipRole(client, owner, direct)).resolves.toBeNull();
      });
    });
  });
});
