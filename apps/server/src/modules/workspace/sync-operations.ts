import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  realtimeTicketResponseSchema,
  syncResponseSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  type Conversation,
  type SyncResponse,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hype-comms/contracts";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { ApiError } from "../../errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { hashToken } from "../identity/tokens.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
import { conversationVisibilitySql } from "./conversation-access.js";
import { readConversationPage } from "./conversation-page-reader.js";
import { iso } from "./records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import { readWorkspaceMembers } from "./workspace-member-reader.js";
import { readWorkspaceSequence } from "./workspace-sequence.js";

const REALTIME_TICKET_TTL_MS = 30_000;

interface WorkspaceRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_event_sequence: string;
  announcement_channels_available: boolean;
  humans_only_channels_available: boolean;
}

interface EventRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  workspace_sequence: string;
  conversation_id: string | null;
  conversation_sequence: string | null;
  event_type: WorkspaceEvent["type"];
  entity_version: number;
  payload: unknown;
  occurred_at: Date | string;
  visible: boolean;
  participated_thread_notification: boolean;
  conversation_human_only: boolean;
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
  system_channels: boolean;
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

export interface WorkspacePrincipal {
  readonly workspaceId: string;
  readonly userId: string;
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
}

export type WorkspaceClientCapabilities = Omit<WorkspacePrincipal, "workspaceId" | "userId">;

function mapWorkspace(row: WorkspaceRow) {
  return workspaceSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

/** Owns bootstrap snapshots, replay reads and realtime ticket lifecycle. */
export class WorkspaceSyncOperations {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: Pick<
      WorkspaceRepositoryHooks,
      "announcementChannelsEnabled" | "humansOnlyChannelsEnabled" | "afterBootstrapCursorRead"
    > = {},
  ) {}
  get announcementChannelsEnabled(): boolean {
    return this.hooks.announcementChannelsEnabled ?? false;
  }
  get humansOnlyChannelsEnabled(): boolean {
    return this.hooks.humansOnlyChannelsEnabled ?? false;
  }
  async bootstrap(
    identity: AuthenticatedIdentity,
    includeGroupDirectMessages = true,
    includeSystemChannels = false,
  ): Promise<WorkspaceBootstrapResponse> {
    if (this.announcementChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET announcement_channels_available = true
          WHERE id = $1
            AND announcement_channels_available = false`,
        [identity.currentUser.workspaceId],
      );
    }
    if (this.humansOnlyChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET humans_only_channels_available = true
          WHERE id = $1
            AND humans_only_channels_available = false`,
        [identity.currentUser.workspaceId],
      );
    }
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const workspaceResult = await client.query<WorkspaceRow>(
          `SELECT id, name, slug, created_by, created_at, updated_at, last_event_sequence,
                  announcement_channels_available, humans_only_channels_available
           FROM workspaces
          WHERE id = $1`,
          [identity.currentUser.workspaceId],
        );
        const workspace = workspaceResult.rows[0];
        if (workspace === undefined) throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
        await this.hooks.afterBootstrapCursorRead?.();
        const members = await readWorkspaceMembers(client, workspace.id);
        // Bootstrap only ever carries the first page; the client pages the rest through
        // GET /v1/conversations, so a workspace can grow past the response cap without bricking.
        const page = await readConversationPage(
          client,
          identity,
          null,
          CONVERSATION_PAGE_DEFAULT_LIMIT,
          includeGroupDirectMessages,
          includeSystemChannels,
        );
        return workspaceBootstrapResponseSchema.parse({
          currentUser: identity.currentUser,
          workspace: mapWorkspace(workspace),
          members,
          conversations: page.conversations,
          conversationsNextCursor: page.nextCursor,
          conversationsHasMore: page.hasMore,
          syncCursor: workspace.last_event_sequence,
          featureFlags: {
            channels: true,
            directMessages: true,
            mentions: true,
            announcementChannels: workspace.announcement_channels_available,
            humansOnlyChannels: workspace.humans_only_channels_available,
          },
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async sync(
    identity: AuthenticatedIdentity,
    after: string,
    limit: number,
    capabilities: WorkspaceClientCapabilities = {},
  ): Promise<SyncResponse> {
    return this.syncPrincipal(
      {
        ...capabilities,
        workspaceId: identity.currentUser.workspaceId,
        userId: identity.currentUser.user.id,
      },
      after,
      limit,
    );
  }

  async syncPrincipal(
    principal: WorkspacePrincipal,
    after: string,
    limit: number,
  ): Promise<SyncResponse> {
    const client = await this.pool.connect();
    try {
      const highWaterCursor = await readWorkspaceSequence(client, principal.workspaceId);
      const afterSequence = BigInt(after);
      const highWaterSequence = BigInt(highWaterCursor);
      if (afterSequence > highWaterSequence) {
        throw new ApiError(410, "CURSOR_EXPIRED", "The sync cursor is no longer valid");
      }
      const earliest = await client.query<{ sequence: string | null } & QueryResultRow>(
        `SELECT min(workspace_sequence)::text AS sequence
           FROM sync_events
          WHERE workspace_id = $1`,
        [principal.workspaceId],
      );
      const earliestSequence = earliest.rows[0]?.sequence ?? null;
      const retainedCursorFloor =
        earliestSequence === null ? highWaterSequence : BigInt(earliestSequence) - 1n;
      if (afterSequence !== 0n && afterSequence < retainedCursorFloor) {
        throw new ApiError(410, "CURSOR_EXPIRED", "The sync cursor has expired");
      }
      const rows = await client.query<EventRow>(
        `SELECT event.*,
                coalesce(
                  (
                    SELECT conversation.human_only
                      FROM conversations AS conversation
                     WHERE conversation.id = event.conversation_id
                  ),
                  false
                ) AS conversation_human_only,
                (
                  $7::boolean
                  AND EXISTS (
                    SELECT 1
                      FROM sync_event_notification_reasons AS notification_reason
                     WHERE notification_reason.event_id = event.id
                       AND notification_reason.user_id = $2
                       AND notification_reason.reason = 'participated_thread_reply'
                  )
                ) AS participated_thread_notification,
                (
                  EXISTS (
                    SELECT 1
                      FROM sync_event_audiences AS audience
                     WHERE audience.event_id = event.id
                       AND audience.user_id = $2
                  )
                  AND (
                    event.conversation_id IS NULL
                    OR EXISTS (
                      SELECT 1
                        FROM conversations AS conversation
                       WHERE conversation.id = event.conversation_id
                         AND conversation.workspace_id = event.workspace_id
                         AND ${conversationVisibilitySql("conversation", "$2")}
                    )
                    OR (
                      event.event_type = 'channel.membership_changed'
                      AND event.payload ->> 'action' = 'removed'
                      AND event.payload ->> 'memberId' = $2::text
                      AND NOT EXISTS (
                        SELECT 1
                          FROM conversations AS removed_membership_conversation
                         WHERE removed_membership_conversation.id = event.conversation_id
                           AND removed_membership_conversation.human_only
                      )
                    )
                  )
                  AND (
                    $5::boolean
                    OR event.event_type NOT IN ('reaction.added', 'reaction.removed')
                  )
                  AND (
                    $6::boolean
                    OR event.event_type NOT IN ('task.created', 'task.updated')
                  )
                  AND (
                    $8::boolean
                    OR event.event_type <> 'message.retracted'
                  )
                  AND (
                    event.event_type <> 'message.created'
                    OR EXISTS (
                      SELECT 1
                        FROM messages AS created_message
                       WHERE created_message.id::text = event.payload #>> '{message,id}'
                         AND created_message.workspace_id = event.workspace_id
                         AND created_message.deleted_at IS NULL
                    )
                  )
                  AND (
                    event.event_type NOT IN ('reaction.added', 'reaction.removed')
                    OR EXISTS (
                      SELECT 1
                        FROM messages AS reaction_message
                       WHERE reaction_message.id::text = event.payload #>> '{reaction,messageId}'
                         AND reaction_message.workspace_id = event.workspace_id
                         AND reaction_message.deleted_at IS NULL
                    )
                  )
                  AND (
                    $9::boolean
                    OR event.conversation_id IS NULL
                    OR NOT EXISTS (
                      SELECT 1
                        FROM conversations AS group_conversation
                       WHERE group_conversation.id = event.conversation_id
                          AND group_conversation.workspace_id = event.workspace_id
                          AND group_conversation.kind = 'group_direct_message'
                    )
                  )
                  AND (
                    $10::boolean
                    OR event.conversation_id IS NULL
                    OR NOT EXISTS (
                      SELECT 1
                        FROM conversations AS system_conversation
                       WHERE system_conversation.id = event.conversation_id
                          AND system_conversation.workspace_id = event.workspace_id
                          AND system_conversation.is_system
                    )
                  )
                ) AS visible
           FROM sync_events AS event
          WHERE event.workspace_id = $1
            AND event.workspace_sequence > $3::bigint
          ORDER BY event.workspace_sequence
          LIMIT $4`,
        [
          principal.workspaceId,
          principal.userId,
          after,
          limit + 1,
          principal.reactionEvents ?? false,
          principal.taskEvents ?? false,
          principal.participatedThreadNotifications ?? false,
          principal.messageRetractEvents ?? false,
          principal.groupDirectMessages ?? false,
          principal.systemChannels ?? false,
        ],
      );
      const scanned = rows.rows.slice(0, limit);
      const nextCursor = scanned.at(-1)?.workspace_sequence ?? after;
      const response = syncResponseSchema.parse({
        events: scanned
          .filter((row) => row.visible)
          .map((row) =>
            this.#mapEvent(
              row,
              principal.readStateEvents ?? false,
              principal.participatedThreadNotifications ?? false,
              principal.memberProfiles ?? false,
              principal.humansOnlyChannels ?? false,
            ),
          ),
        nextCursor,
        highWaterCursor,
        hasMore: rows.rows.length > limit,
      });
      let events = response.events;
      if (!(principal.announcementChannels ?? false)) {
        events = events.map((event) => this.#legacyAnnouncementEvent(event));
      }
      return events === response.events ? response : ({ ...response, events } as SyncResponse);
    } finally {
      client.release();
    }
  }

  async issueRealtimeTicket(
    identity: AuthenticatedIdentity,
    capabilities: WorkspaceClientCapabilities = {},
  ) {
    const {
      reactionEvents = false,
      readStateEvents = false,
      taskEvents = false,
      announcementChannels = false,
      participatedThreadNotifications = false,
      messageRetractEvents = false,
      memberProfiles = false,
      ephemeralActivity = false,
      groupDirectMessages = false,
      humansOnlyChannels = false,
      systemChannels = false,
    } = capabilities;
    const deviceSessionId = identity.sessionId ?? null;
    const agentTokenId = identity.agentTokenId ?? null;
    if ((deviceSessionId === null) === (agentTokenId === null)) {
      throw new Error("Realtime tickets require exactly one authenticated credential");
    }
    const token = randomBytes(32).toString("base64url");
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_MS);
    await this.pool.query(
      `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, agent_token_id, token_hash, expires_at,
          reaction_events, read_state_events, task_events, announcement_channels,
          participated_thread_notifications, message_retract_events, member_profiles,
          ephemeral_activity, group_direct_messages, humans_only_channels, system_channels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        randomUUID(),
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        deviceSessionId,
        agentTokenId,
        hash,
        expiresAt,
        reactionEvents,
        readStateEvents,
        taskEvents,
        announcementChannels,
        participatedThreadNotifications,
        messageRetractEvents,
        memberProfiles,
        ephemeralActivity,
        groupDirectMessages,
        humansOnlyChannels,
        systemChannels,
      ],
    );
    return realtimeTicketResponseSchema.parse({
      ticket: token,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async consumeRealtimeTicket(token: string): Promise<ConsumedRealtimeTicket | null> {
    const hash = hashToken(token);
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
                   ticket.humans_only_channels,
                   ticket.system_channels
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
              ticket.humans_only_channels,
              ticket.system_channels
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
        systemChannels: row.system_channels,
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
        systemChannels: row.system_channels,
      };
    }
    throw new Error("Consumed realtime ticket has an invalid credential binding");
  }

  /**
   * Re-check a live realtime connection's bound credential and workspace membership.
   *
   * This is a read-only counterpart to {@link consumeRealtimeTicket}: it consumes nothing and
   * mutates nothing, so the realtime heartbeat can call it repeatedly. A socket authorized
   * minutes ago must not outlive a revoked/expired credential or a revoked membership.
   */
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

  #mapEvent(
    row: EventRow,
    readStateEvents: boolean,
    participatedThreadNotifications: boolean,
    memberProfiles: boolean,
    humansOnlyChannels: boolean,
  ): WorkspaceEvent {
    let event = workspaceEventSchema.parse({
      version: 1,
      id: row.id,
      type: row.event_type,
      occurredAt: iso(row.occurred_at),
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      workspaceSequence: row.workspace_sequence,
      conversationSequence: row.conversation_sequence,
      entityVersion: row.entity_version,
      delivery: "at_least_once",
      payload: row.payload,
    });
    if (humansOnlyChannels && row.conversation_human_only) {
      event = this.#humansOnlyChannelEvent(event);
    } else if (!humansOnlyChannels) {
      // HTTP already converts access: "humans" → "members" for clients that did not negotiate
      // humans-only-channels-v1. Realtime and HTTP sync share this mapper; leave the stored
      // payload canonical while projecting the legacy enum so 0.1.35 clients do not drop the event.
      event = this.#legacyHumansOnlyChannelEvent(event);
    }
    if (event.type === "message.created") {
      // Never trust shared event JSON to carry a recipient-specific reason. Rebuild the payload
      // from canonical message fields and add the reason only from the scoped relation selected
      // for this principal and an explicitly negotiated capability.
      return workspaceEventSchema.parse({
        ...event,
        payload: {
          message: event.payload.message,
          mentionedUserIds: event.payload.mentionedUserIds,
          ...(participatedThreadNotifications && row.participated_thread_notification
            ? { recipientNotificationReason: "participated_thread_reply" }
            : {}),
        },
      });
    }
    if (event.type === "member.updated" && !memberProfiles) {
      return this.#legacyMemberProfileEvent(event);
    }
    if (event.type !== "read_cursor.updated" || readStateEvents) return event;
    // Older clients validate v1 event payloads strictly. Keep the stored event canonical while
    // projecting its legacy shape for devices that did not negotiate read-state events.
    return {
      ...event,
      payload: { readCursor: event.payload.readCursor },
    };
  }

  #legacyAnnouncementEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (
      event.type !== "channel.created" &&
      event.type !== "channel.archived" &&
      event.type !== "direct_conversation.created"
    ) {
      return event;
    }
    const conversation: Partial<Conversation> = { ...event.payload.conversation };
    delete conversation.channelMode;
    return {
      ...event,
      payload: { ...event.payload, conversation },
    } as unknown as WorkspaceEvent;
  }

  #humansOnlyChannelEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "channel.created" && event.type !== "channel.archived") return event;
    return workspaceEventSchema.parse({
      ...event,
      payload: {
        ...event.payload,
        conversation: { ...event.payload.conversation, access: "humans" },
      },
    });
  }

  #legacyHumansOnlyChannelEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "channel.created" && event.type !== "channel.archived") return event;
    if (event.payload.conversation.access !== "humans") return event;
    return workspaceEventSchema.parse({
      ...event,
      payload: {
        ...event.payload,
        conversation: { ...event.payload.conversation, access: "members" },
      },
    });
  }

  #legacyMemberProfileEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "member.updated") return event;
    const member: Partial<typeof event.payload.member> = { ...event.payload.member };
    delete member.title;
    return { ...event, payload: { member } } as unknown as WorkspaceEvent;
  }
}
