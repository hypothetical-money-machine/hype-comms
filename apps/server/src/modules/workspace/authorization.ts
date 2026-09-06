import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";
import type { AuthenticatedBotIdentity } from "../bots/service.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
import { GroupDirectClientUpgradeRequiredError } from "./group-direct-capability.js";

export type AuthenticatedTaskIdentity = AuthenticatedIdentity | AuthenticatedBotIdentity;

export interface ConversationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  kind: "channel" | "direct_message" | "group_direct_message";
  name: string | null;
  slug: string | null;
  topic: string | null;
  channel_access: "workspace" | "members" | null;
  human_only: boolean;
  channel_mode: "chat" | "announcement" | null;
  is_archived: boolean;
  created_by: string | null;
  dm_user_low_id: string | null;
  dm_user_high_id: string | null;
  last_task_number: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TicketRow extends QueryResultRow {
  workspace_id: string;
  user_id: string;
  device_session_id: string | null;
  agent_token_id: string | null;
  reaction_events: boolean;
  read_state_events: boolean;
  task_events: boolean;
  announcement_channels: boolean;
  participated_thread_notifications: boolean;
  message_retract_events: boolean;
  member_profiles: boolean;
  ephemeral_activity: boolean;
  group_direct_messages: boolean;
  humans_only_channels: boolean;
}

interface RealtimeSessionRow extends QueryResultRow {
  revoked: boolean;
  expired: boolean;
  membership_inactive: boolean;
}

interface RealtimeAgentRow extends QueryResultRow {
  revoked: boolean;
  disabled: boolean;
  membership_inactive: boolean;
}

export type ConsumedRealtimeTicket = RealtimePrincipal;

export function conversationVisibilitySql(
  alias: "conversation" | "anchor",
  userParameter: string,
): string {
  return `(
    (
      EXISTS (
        SELECT 1 FROM users AS visible_actor
         WHERE visible_actor.id = ${userParameter}
           AND visible_actor.kind IN ('human', 'agent')
           AND (
            (
              ${alias}.kind = 'channel'
              AND ${alias}.channel_access = 'workspace'
              AND (
                visible_actor.kind = 'human'
                OR EXISTS (
                  SELECT 1
                    FROM conversation_memberships AS public_membership
                   WHERE public_membership.conversation_id = ${alias}.id
                     AND public_membership.user_id = ${userParameter}
                     AND public_membership.left_at IS NULL
                )
              )
            )
            OR (
              ${alias}.kind = 'channel'
              AND ${alias}.human_only
              AND visible_actor.kind = 'human'
            )
            OR (
              ${alias}.kind = 'channel'
              AND ${alias}.channel_access = 'members'
              AND NOT ${alias}.human_only
              AND EXISTS (
                SELECT 1
                  FROM conversation_memberships AS visible_membership
                 WHERE visible_membership.conversation_id = ${alias}.id
                   AND visible_membership.user_id = ${userParameter}
                   AND visible_membership.left_at IS NULL
              )
            )
            OR ${alias}.dm_user_low_id = ${userParameter}
            OR ${alias}.dm_user_high_id = ${userParameter}
            OR (
              ${alias}.kind = 'group_direct_message'
              AND EXISTS (
                SELECT 1
                  FROM conversation_memberships AS group_membership
                 WHERE group_membership.conversation_id = ${alias}.id
                   AND group_membership.user_id = ${userParameter}
                   AND group_membership.left_at IS NULL
              )
            )
          )
      )
    )
    OR (
      ${alias}.kind = 'channel'
      AND NOT ${alias}.human_only
      AND EXISTS (
        SELECT 1
          FROM bot_channel_grants AS visible_bot_grant
          JOIN users AS visible_bot
            ON visible_bot.id = visible_bot_grant.bot_user_id
           AND visible_bot.kind = 'bot'
         WHERE visible_bot_grant.conversation_id = ${alias}.id
           AND visible_bot_grant.bot_user_id = ${userParameter}
      )
    )
  )`;
}
export class WorkspaceAuthorization {
  constructor(private readonly pool: Pool) {}

  async requireGroupDirectMessagesForConversations(
    identity: AuthenticatedIdentity,
    conversationIds: readonly string[],
    supported: boolean,
  ): Promise<void> {
    if (supported || conversationIds.length === 0) return;
    const result = await this.pool.query<{ blocked: boolean } & QueryResultRow>(
      `SELECT EXISTS (
         SELECT 1
           FROM conversations AS conversation
          WHERE conversation.workspace_id = $1
            AND conversation.id = ANY($3::uuid[])
            AND conversation.kind = 'group_direct_message'
            AND ${conversationVisibilitySql("conversation", "$2")}
       ) AS blocked`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id, conversationIds],
    );
    if (result.rows[0]?.blocked) throw new GroupDirectClientUpgradeRequiredError();
  }

  async requireGroupDirectMessagesForMessages(
    identity: AuthenticatedIdentity,
    messageIds: readonly string[],
    supported: boolean,
    eligibility: "any" | "active" | "retractable" = "any",
  ): Promise<void> {
    if (supported || messageIds.length === 0) return;
    const eligibilitySql =
      eligibility === "active"
        ? "AND message.deleted_at IS NULL"
        : eligibility === "retractable"
          ? `AND message.author_id = $2
             AND (
               message.deleted_at IS NOT NULL
               OR (
                 message.edited_at IS NULL
                 AND clock_timestamp() <= message.created_at + interval '5 minutes'
               )
             )`
          : "";
    const result = await this.pool.query<{ blocked: boolean } & QueryResultRow>(
      `SELECT (
         count(*) = cardinality($3::uuid[])
         AND bool_or(conversation.kind = 'group_direct_message')
       ) AS blocked
           FROM messages AS message
           JOIN conversations AS conversation
             ON conversation.id = message.conversation_id
            AND conversation.workspace_id = message.workspace_id
          WHERE message.workspace_id = $1
            AND message.id = ANY($3::uuid[])
            AND ${conversationVisibilitySql("conversation", "$2")}
            ${eligibilitySql}`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id, messageIds],
    );
    if (result.rows[0]?.blocked) throw new GroupDirectClientUpgradeRequiredError();
  }

  async requireGroupDirectMessagesForAttachments(
    identity: AuthenticatedIdentity,
    attachmentIds: readonly string[],
    supported: boolean,
    eligibility: "any" | "content-write" | "complete" = "any",
  ): Promise<void> {
    if (supported || attachmentIds.length === 0) return;
    const eligibilitySql =
      eligibility === "content-write"
        ? `AND attachment.uploaded_by = $2
           AND attachment.status = 'pending'
           AND (
             attachment.upload_expires_at IS NULL
             OR attachment.upload_expires_at > clock_timestamp()
           )`
        : eligibility === "complete"
          ? `AND attachment.uploaded_by = $2
             AND (
               attachment.status = 'ready'
               OR (
                 attachment.status = 'pending'
                 AND (
                   attachment.upload_expires_at IS NULL
                   OR attachment.upload_expires_at > clock_timestamp()
                 )
               )
             )`
          : "";
    const result = await this.pool.query<{ blocked: boolean } & QueryResultRow>(
      `SELECT (
         count(*) = cardinality($3::uuid[])
         AND bool_or(conversation.kind = 'group_direct_message')
       ) AS blocked
           FROM attachments AS attachment
           JOIN conversations AS conversation
             ON conversation.id = attachment.conversation_id
            AND conversation.workspace_id = attachment.workspace_id
          WHERE attachment.workspace_id = $1
            AND attachment.id = ANY($3::uuid[])
            AND ${conversationVisibilitySql("conversation", "$2")}
            ${eligibilitySql}`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id, attachmentIds],
    );
    if (result.rows[0]?.blocked) throw new GroupDirectClientUpgradeRequiredError();
  }

  async canViewConversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
    includeGroupDirectMessages: boolean,
  ): Promise<boolean> {
    const result = await this.pool.query<{ visible: boolean } & QueryResultRow>(
      `SELECT EXISTS (
         SELECT 1
           FROM conversations AS conversation
           JOIN workspace_memberships AS active_membership
             ON active_membership.workspace_id = conversation.workspace_id
            AND active_membership.user_id = $2
            AND active_membership.status = 'active'
          WHERE conversation.id = $3
            AND conversation.workspace_id = $1
            AND ${conversationVisibilitySql("conversation", "$2")}
            AND ($4::boolean OR conversation.kind <> 'group_direct_message')
       ) AS visible`,
      [workspaceId, userId, conversationId, includeGroupDirectMessages],
    );
    return result.rows[0]?.visible ?? false;
  }

  async consumeRealtimeTicket(token: string): Promise<ConsumedRealtimeTicket | null> {
    const hash = createHash("sha256").update(token).digest();
    const result = await this.pool.query<TicketRow>(
      `WITH consumed_ticket AS (
         UPDATE realtime_tickets AS ticket
            SET consumed_at = clock_timestamp()
          WHERE ticket.token_hash = $1
            AND ticket.consumed_at IS NULL
            AND ticket.expires_at > clock_timestamp()
         RETURNING ticket.workspace_id,
                   ticket.user_id,
                   ticket.device_session_id,
                   ticket.agent_token_id,
                   ticket.reaction_events,
                   ticket.read_state_events,
                   ticket.task_events,
                   ticket.announcement_channels,
                   ticket.participated_thread_notifications,
                   ticket.message_retract_events,
                   ticket.member_profiles,
                   ticket.ephemeral_activity,
                   ticket.group_direct_messages,
                   ticket.humans_only_channels
       )
       SELECT ticket.workspace_id,
              ticket.user_id,
              ticket.device_session_id,
              ticket.agent_token_id,
              ticket.reaction_events,
              ticket.read_state_events,
              ticket.task_events,
              ticket.announcement_channels,
              ticket.participated_thread_notifications,
              ticket.message_retract_events,
              ticket.member_profiles,
              ticket.ephemeral_activity,
              ticket.group_direct_messages,
              ticket.humans_only_channels
         FROM consumed_ticket AS ticket
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = ticket.workspace_id
          AND membership.user_id = ticket.user_id
          AND membership.status = 'active'
        WHERE (
            (
              ticket.device_session_id IS NOT NULL
              AND ticket.agent_token_id IS NULL
              AND EXISTS (
                SELECT 1
                  FROM device_sessions AS session
                 WHERE session.id = ticket.device_session_id
                   AND session.user_id = ticket.user_id
                   AND session.revoked_at IS NULL
                   AND session.expires_at > clock_timestamp()
              )
            )
            OR
            (
              ticket.device_session_id IS NULL
              AND ticket.agent_token_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM agent_tokens AS agent_token
                  JOIN agents AS agent
                    ON agent.user_id = agent_token.agent_user_id
                   AND agent.workspace_id = agent_token.workspace_id
                 WHERE agent_token.id = ticket.agent_token_id
                   AND agent_token.workspace_id = ticket.workspace_id
                   AND agent_token.agent_user_id = ticket.user_id
                   AND agent_token.revoked_at IS NULL
                   AND agent.disabled_at IS NULL
              )
            )
          )`,
      [hash],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.device_session_id !== null && row.agent_token_id === null) {
      return {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        deviceSessionId: row.device_session_id,
        agentTokenId: null,
        reactionEvents: row.reaction_events,
        readStateEvents: row.read_state_events,
        taskEvents: row.task_events,
        announcementChannels: row.announcement_channels,
        participatedThreadNotifications: row.participated_thread_notifications,
        messageRetractEvents: row.message_retract_events,
        memberProfiles: row.member_profiles,
        ephemeralActivity: row.ephemeral_activity,
        groupDirectMessages: row.group_direct_messages,
        humansOnlyChannels: row.humans_only_channels,
      };
    }
    if (row.device_session_id === null && row.agent_token_id !== null) {
      return {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        deviceSessionId: null,
        agentTokenId: row.agent_token_id,
        reactionEvents: row.reaction_events,
        readStateEvents: row.read_state_events,
        taskEvents: row.task_events,
        announcementChannels: row.announcement_channels,
        participatedThreadNotifications: row.participated_thread_notifications,
        messageRetractEvents: row.message_retract_events,
        memberProfiles: row.member_profiles,
        ephemeralActivity: row.ephemeral_activity,
        groupDirectMessages: row.group_direct_messages,
        humansOnlyChannels: row.humans_only_channels,
      };
    }
    throw new Error("Consumed realtime ticket has an invalid credential binding");
  }

  async revalidateRealtimePrincipal(
    principal: RealtimePrincipal,
  ): Promise<RealtimePrincipalRevalidation> {
    if (principal.agentTokenId !== null) {
      const result = await this.pool.query<RealtimeAgentRow>(
        `SELECT token.revoked_at IS NOT NULL AS revoked,
                agent.disabled_at IS NOT NULL AS disabled,
                coalesce(membership.status, 'revoked') <> 'active' AS membership_inactive
           FROM agent_tokens AS token
           LEFT JOIN agents AS agent
             ON agent.user_id = token.agent_user_id
            AND agent.workspace_id = token.workspace_id
           LEFT JOIN workspace_memberships AS membership
             ON membership.user_id = token.agent_user_id
            AND membership.workspace_id = token.workspace_id
          WHERE token.id = $1
            AND token.workspace_id = $2
            AND token.agent_user_id = $3`,
        [principal.agentTokenId, principal.workspaceId, principal.userId],
      );
      const row = result.rows[0];
      if (row === undefined) return { status: "invalid", reason: "unknown_agent_token" };
      if (row.revoked) return { status: "invalid", reason: "agent_token_revoked" };
      if (row.disabled) return { status: "invalid", reason: "agent_disabled" };
      if (row.membership_inactive) {
        return { status: "invalid", reason: "membership_inactive" };
      }
      return { status: "valid" };
    }

    const result = await this.pool.query<RealtimeSessionRow>(
      `SELECT session.revoked_at IS NOT NULL AS revoked,
              session.expires_at <= clock_timestamp() AS expired,
              coalesce(membership.status, 'revoked') <> 'active' AS membership_inactive
         FROM device_sessions AS session
         LEFT JOIN workspace_memberships AS membership
           ON membership.user_id = session.user_id
          AND membership.workspace_id = $2
        WHERE session.id = $1
          AND session.user_id = $3`,
      [principal.deviceSessionId, principal.workspaceId, principal.userId],
    );
    const row = result.rows[0];
    if (row === undefined) return { status: "invalid", reason: "unknown_session" };
    if (row.revoked) return { status: "invalid", reason: "session_revoked" };
    if (row.expired) return { status: "invalid", reason: "session_expired" };
    if (row.membership_inactive) return { status: "invalid", reason: "membership_inactive" };
    return { status: "valid" };
  }

  async requireVisibleConversation(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    requireWritable: boolean,
    lock = false,
  ): Promise<ConversationRow> {
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations AS conversation
        WHERE conversation.id = $1
          AND conversation.workspace_id = $2
          AND ${conversationVisibilitySql("conversation", "$3")}
          AND ($4::boolean = false OR conversation.is_archived = false)
        ${lock ? "FOR UPDATE" : ""}`,
      [
        conversationId,
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        requireWritable,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Conversation not found");
    return row;
  }

  async requireActivePrincipal(
    client: PoolClient,
    identity: AuthenticatedIdentity,
  ): Promise<{ readonly role: "owner" | "member"; readonly kind: "human" | "agent" }> {
    const result = await client.query<
      { role: "owner" | "member"; kind: "human" | "agent" } & QueryResultRow
    >(
      `SELECT membership.role, user_account.kind
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $1
          AND membership.user_id = $2
          AND membership.status = 'active'
          AND user_account.kind IN ('human', 'agent')
        FOR UPDATE OF membership`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id],
    );
    const principal = result.rows[0];
    if (principal === undefined) {
      throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
    }
    // Existing membership mutations take the membership row before the workspace sequence row.
    // This matches delivery and identity revocation, preventing a membership/workspace inversion.
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      identity.currentUser.workspaceId,
    ]);
    return principal;
  }

  async requireHumansOnlyCreator(
    client: PoolClient,
    identity: AuthenticatedIdentity,
  ): Promise<{ readonly role: "owner" | "member"; readonly kind: "human" }> {
    const result = await client.query<
      {
        user_id: string;
        role: "owner" | "member";
        status: "invited" | "active" | "revoked";
        kind: "human";
      } & QueryResultRow
    >(
      `SELECT membership.user_id, membership.role, membership.status, user_account.kind
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $1
          AND user_account.kind = 'human'
        ORDER BY membership.user_id
        FOR UPDATE OF membership`,
      [identity.currentUser.workspaceId],
    );
    const principal = result.rows.find((row) => row.user_id === identity.currentUser.user.id);
    if (principal === undefined || principal.status !== "active") {
      throw new ApiError(403, "FORBIDDEN", "Only humans can create humans-only channels");
    }
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      identity.currentUser.workspaceId,
    ]);
    return { role: principal.role, kind: principal.kind };
  }

  async requireActiveConversationParticipants(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    memberIds: readonly string[],
  ): Promise<void> {
    const actorId = identity.currentUser.user.id;
    const participantIds = [...new Set([actorId, ...memberIds])].sort();
    const result = await client.query<{ id: string } & QueryResultRow>(
      `SELECT membership.user_id AS id
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $1
          AND membership.user_id = ANY($2::uuid[])
          AND membership.status = 'active'
          AND user_account.kind IN ('human', 'agent')
        ORDER BY membership.user_id
        FOR UPDATE OF membership`,
      [identity.currentUser.workspaceId, participantIds],
    );
    const activeIds = new Set(result.rows.map((row) => row.id));
    if (!activeIds.has(actorId)) {
      throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
    }
    if (memberIds.some((id) => !activeIds.has(id))) {
      throw new ApiError(404, "NOT_FOUND", "One or more members were not found");
    }
    // Membership rows are locked in deterministic UUID order before the workspace row. Agent
    // disable and human membership revocation use the same membership-before-workspace order, so
    // a DM cannot be created with a participant who is concurrently leaving the workspace.
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      identity.currentUser.workspaceId,
    ]);
  }

  async visibleChannelIdBySlug(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    requireWritable: boolean,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      return (
        await this.requireVisibleChannelBySlug(client, identity, channelSlug, requireWritable)
      ).id;
    } finally {
      client.release();
    }
  }

  async requireVisibleChannelBySlug(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    requireWritable: boolean,
  ): Promise<ConversationRow> {
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations AS conversation
        WHERE conversation.workspace_id = $1
          AND conversation.kind = 'channel'
          AND conversation.slug = $2
          AND ${conversationVisibilitySql("conversation", "$3")}
          AND ($4::boolean = false OR conversation.is_archived = false)`,
      [
        identity.currentUser.workspaceId,
        channelSlug,
        identity.currentUser.user.id,
        requireWritable,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Channel not found");
    return row;
  }

  async requireManagedChannel(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationRow> {
    // Membership mutations take message delivery's canonical conversation row lock before
    // inspecting or changing conversation_memberships.
    const conversation = await this.requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    await this.requireActivePrincipal(client, identity);
    if (
      conversation.kind !== "channel" ||
      conversation.channel_access !== "members" ||
      conversation.human_only
    ) {
      throw new ApiError(404, "NOT_FOUND", "Managed channel not found");
    }
    const role = await this.membershipRole(client, identity, conversation);
    if (role !== "owner") {
      throw new ApiError(403, "FORBIDDEN", "Only a channel owner can manage members");
    }
    return conversation;
  }

  async requireAnotherChannelOwner(
    client: PoolClient,
    conversationId: string,
    excludedUserId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1
         FROM conversation_memberships AS membership
         JOIN workspace_memberships AS workspace_membership
           ON workspace_membership.workspace_id = membership.workspace_id
          AND workspace_membership.user_id = membership.user_id
        WHERE membership.conversation_id = $1
          AND membership.user_id <> $2
          AND membership.role = 'owner'
          AND membership.left_at IS NULL
          AND workspace_membership.status = 'active'
        LIMIT 1`,
      [conversationId, excludedUserId],
    );
    if (result.rowCount !== 1) {
      throw new ApiError(409, "CONFLICT", "A channel must retain at least one owner");
    }
  }

  async membershipRole(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<"owner" | "member" | null> {
    if (conversation.kind === "direct_message") return null;
    const result = await client.query<{ role: "owner" | "member" } & QueryResultRow>(
      `SELECT role
         FROM conversation_memberships
        WHERE conversation_id = $1
          AND user_id = $2
          AND left_at IS NULL`,
      [conversation.id, identity.currentUser.user.id],
    );
    return result.rows[0]?.role ?? null;
  }
}
