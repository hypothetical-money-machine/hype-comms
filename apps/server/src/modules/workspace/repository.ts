import { createHash, randomBytes, randomUUID } from "node:crypto";
import { attachmentsForMessages } from "./attachment-queries.js";
import {
  mapAttachment,
  type AttachmentRow,
  type ExpiredAttachmentRow,
  type ReadableAttachmentRow,
  type UploadAttachmentRow,
} from "./attachment-records.js";
import {
  conversationAudience,
  conversationVisibilitySql,
  requireVisibleConversation,
} from "./conversation-access.js";
import { ConversationEventWriter } from "./conversation-events.js";
import { WorkspaceMessageOperations } from "./message-operations.js";
import { UUID_PATTERN } from "./pagination.js";
import { WorkspaceTaskOperations } from "./task-operations.js";
import { mapTask, type TaskRow } from "./task-records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { mapUser, type UserRow } from "./user-records.js";
import { requireActivePrincipal } from "./workspace-access.js";
import { auditAnnouncement, type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import { readWorkspaceSequence } from "./workspace-sequence.js";
export type { AnnouncementAuditRecord, WorkspaceRepositoryHooks } from "./workspace-hooks.js";

import {
  ATTACHMENT_MAX_BYTES,
  channelMembershipMutationResponseSchema,
  channelMembersResponseSchema,
  COMMUNICATION_PATHS_MAX_PATHS,
  communicationPathsResponseSchema,
  completeFileUploadResponseSchema,
  CONVERSATION_FILES_MAX_LIMIT,
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  conversationFilesResponseSchema,
  conversationMutationResponseSchema,
  conversationSchema,
  createFileUploadResponseSchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  listMessageAttachmentsResponseSchema,
  listPublicChannelsResponseSchema,
  MESSAGE_HISTORY_MAX_LIMIT,
  realtimeTicketResponseSchema,
  syncResponseSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  type Attachment,
  type ChannelAccess,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type CommunicationPathsResponse,
  type CompleteFileUploadRequest,
  type CompleteFileUploadResponse,
  type Conversation,
  type ConversationFilesResponse,
  type ConversationMutationResponse,
  type ConversationSummary,
  type CreateChannelRequest,
  type CreateFileUploadRequest,
  type CreateFileUploadResponse,
  type DirectConversationRequest,
  type GroupDirectConversationRequest,
  type ListConversationsResponse,
  type ListMembersResponse,
  type ListMessageAttachmentsResponse,
  type ListPublicChannelsResponse,
  type SyncResponse,
  type UpsertChannelMemberRequest,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { hashToken } from "../identity/tokens.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
import { SYSTEM_USER_ID, type BuiltInChannelDefinition } from "../system-channels/registry.js";
import type { SystemBulletin } from "../system-channels/release-notes.js";
import {
  ATTACHMENT_UPLOAD_TTL_MS,
  isRejectedAttachment,
  sanitizeFileName,
  sha256Buffer,
  sha256Hex,
  type AttachmentStore,
} from "./file-store.js";
import { GroupDirectClientUpgradeRequiredError } from "./group-direct-capability.js";
import {
  fingerprintApiRequest,
  lockIdempotencyScope,
  runIdempotentMutation,
} from "./idempotency.js";
import {
  insertSyncEvent,
  insertSyncEventWithSequence,
  nextWorkspaceSequence,
} from "./sync-events.js";

const REALTIME_TICKET_TTL_MS = 30_000;
const SYNC_RETENTION_DAYS = 90;
const ATTACHMENT_CLEANUP_BATCH_SIZE = 100;
const UNCLAIMED_READY_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

import { readConversationSummaries } from "./conversation-summary-reader.js";
import {
  iso,
  mapConversation,
  mapMessage,
  nullableIso,
  participants,
  type ConversationRow,
  type MessageRow,
} from "./records.js";

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

interface PublicChannelRow extends ConversationRow {
  joined: boolean;
}

interface ConversationMembershipRow extends QueryResultRow {
  conversation_id: string;
  workspace_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: Date | string;
  left_at: Date | string | null;
  updated_at: Date | string;
}

interface ChannelMemberRow extends UserRow {
  role: "owner" | "member";
  joined_at: Date | string;
}

interface CommunicationPathRow extends QueryResultRow {
  member_a_id: string;
  member_b_id: string;
  direct_message_count: string;
  shared_channel_count: string;
  channel_message_count: string;
  last_activity_at: Date | string | null;
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

/** One bounded page of conversation summaries plus the keyset cursor that follows it. */
interface ConversationPage {
  readonly conversations: ConversationSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface AttachmentCleanupFailure {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly error: unknown;
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

/** Keep durable events readable by servers whose strict access enum predates humans-only. */
function mapStoredConversation(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    topic: row.topic,
    access: row.channel_access,
    channelMode: row.kind === "channel" ? (row.channel_mode ?? "chat") : null,
    // Emitted only for built-in channels: the key is absent, never false, so payloads for ordinary
    // channels stay byte-identical for clients whose schema predates built-in channels.
    ...(row.is_system ? { isBuiltIn: true as const } : {}),
    isArchived: row.is_archived,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

/**
 * The canonical low/high ordering behind the `(workspace_id, dm_user_low_id, dm_user_high_id)`
 * unique index. Every DM lookup and insert derives its pair here so the two cannot drift.
 */
function directMessagePair(actorId: string, memberId: string): { low: string; high: string } {
  const pair = [actorId, memberId].sort();
  const low = pair[0];
  const high = pair[1];
  if (low === undefined || high === undefined) throw new Error("Invalid direct-message pair");
  return { low, high };
}

function encodeFilesCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeFilesCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("createdAt" in parsed) ||
      !("id" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt: createdAt.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

function encodeConversationCursor(conversationId: string): string {
  return Buffer.from(JSON.stringify({ id: conversationId }), "utf8").toString("base64url");
}

/**
 * Decode the opaque keyset cursor back into the anchor conversation id. A cursor that does not
 * carry a conversation id is a client error, not a server fault, so it is rejected with 400
 * instead of failing the whole listing.
 */
function decodeConversationCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error("Invalid cursor");
    }
    return parsed.id;
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid conversation cursor");
  }
}

export class WorkspaceRepository {
  private readonly messages: WorkspaceMessageOperations;
  private readonly tasks: WorkspaceTaskOperations;
  private readonly events: ConversationEventWriter;

  constructor(
    private readonly pool: Pool,
    private readonly hooks: WorkspaceRepositoryHooks = {},
  ) {
    this.events = new ConversationEventWriter(this.announcementChannelsEnabled);
    this.tasks = new WorkspaceTaskOperations(pool, this.events);
    this.messages = new WorkspaceMessageOperations(pool, this.events, hooks);
  }

  get announcementChannelsEnabled(): boolean {
    return this.hooks.announcementChannelsEnabled ?? false;
  }

  get humansOnlyChannelsEnabled(): boolean {
    return this.hooks.humansOnlyChannelsEnabled ?? false;
  }

  get systemChannelsEnabled(): boolean {
    return this.hooks.systemChannelsEnabled ?? false;
  }

  /** Persist the one-way cutover before this process begins serving default-agency traffic. */
  async enableDefaultAgentAgency(): Promise<void> {
    await this.pool.query(
      `UPDATE workspaces
          SET default_agent_agency_available = true
        WHERE default_agent_agency_available = false`,
    );
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
        const members = await this.#members(client, workspace.id);
        // Bootstrap only ever carries the first page; the client pages the rest through
        // GET /v1/conversations, so a workspace can grow past the response cap without bricking.
        const page = await this.#conversationSummaries(
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

  async listMembers(identity: AuthenticatedIdentity): Promise<ListMembersResponse> {
    const client = await this.pool.connect();
    try {
      return listMembersResponseSchema.parse({
        members: await this.#members(client, identity.currentUser.workspaceId),
      });
    } finally {
      client.release();
    }
  }

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

  /**
   * Reuses the canonical conversation visibility predicate for ephemeral delivery. The active
   * workspace-membership join makes each best-effort authorization reflect revocation immediately
   * instead of waiting for the socket heartbeat to close the connection. The capability argument
   * is bound into the realtime ticket, so an older device cannot discover a group conversation
   * through typing frames merely because another device for the same user supports groups.
   */
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

  /**
   * Owner-only administration: every undirected communication link between two distinct active
   * human or agent members, aggregated from committed messages and memberships. Message bodies
   * are never read; only counts and timestamps leave the database. Owner authorization happens
   * at the route, where the authenticated principal's role is already resolved per request.
   *
   * Deliberate scope decisions:
   * - Bots are excluded. They are integrations rather than members: their channel access comes
   *   from `bot_channel_grants` rather than membership semantics, so treating them as pair
   *   endpoints would fabricate links no human recognizes.
   * - Deactivated members are excluded from both endpoints of every path, so revoked members'
   *   DM history does not resurface in the owner's report.
   * - Pairs that share channels but have exchanged no messages are still reported (as potential
   *   paths), but sort strictly below pairs with actual message volume.
   *
   * Both reads run in one repeatable-read snapshot so `members` and `paths` can never disagree,
   * and the result is bounded by the contract's path cap -- with endpoints restricted to active
   * human/agent members the pair count is at most C(25,2), which equals the cap exactly.
   */
  async communicationPaths(identity: AuthenticatedIdentity): Promise<CommunicationPathsResponse> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const members = await this.#members(client, identity.currentUser.workspaceId);
        const result = await client.query<CommunicationPathRow>(
          // `actor` is the active human/agent member set; every path endpoint comes from it.
          // `accessible` mirrors channel visibility: humans implicitly see public channels,
          // while agents and restricted-channel members require a live conversation seat. Bots
          // are deliberately absent here -- their grant-based access never produces a
          // member-to-member path under the scope decisions above.
          `WITH actor AS (
           SELECT membership.user_id AS user_id, user_account.kind
             FROM workspace_memberships AS membership
             JOIN users AS user_account ON user_account.id = membership.user_id
            WHERE membership.workspace_id = $1
              AND membership.status = 'active'
              AND user_account.kind IN ('human', 'agent')
         ),
         accessible AS (
           SELECT actor.user_id AS user_id,
                  conversation.id AS conversation_id
             FROM actor
             JOIN conversations AS conversation
               ON conversation.workspace_id = $1
              AND conversation.kind = 'channel'
              AND conversation.is_archived = false
              AND (conversation.channel_access = 'workspace' OR conversation.human_only)
              AND actor.kind = 'human'
            UNION
           SELECT conversation_membership.user_id AS user_id,
                  conversation_membership.conversation_id AS conversation_id
             FROM conversation_memberships AS conversation_membership
             JOIN conversations AS conversation
               ON conversation.id = conversation_membership.conversation_id
              AND conversation.kind = 'channel'
              AND conversation.is_archived = false
             JOIN actor ON actor.user_id = conversation_membership.user_id
            WHERE conversation_membership.workspace_id = $1
              AND conversation_membership.left_at IS NULL
              AND NOT conversation.human_only
         ),
         dm_source AS (
           SELECT conversation.dm_user_low_id AS member_a_id,
                  conversation.dm_user_high_id AS member_b_id,
                  COUNT(message.id) AS direct_message_count,
                  MAX(message.created_at) AS last_dm_at
             FROM conversations AS conversation
             JOIN actor AS low ON low.user_id = conversation.dm_user_low_id
             JOIN actor AS high ON high.user_id = conversation.dm_user_high_id
             JOIN messages AS message
               ON message.conversation_id = conversation.id
              AND message.deleted_at IS NULL
            WHERE conversation.workspace_id = $1
              AND conversation.kind = 'direct_message'
              AND conversation.dm_user_low_id <> conversation.dm_user_high_id
            GROUP BY 1, 2
            UNION ALL
           SELECT LEAST(message.author_id, recipient.user_id) AS member_a_id,
                  GREATEST(message.author_id, recipient.user_id) AS member_b_id,
                  COUNT(message.id) AS direct_message_count,
                  MAX(message.created_at) AS last_dm_at
             FROM conversations AS conversation
             JOIN messages AS message
               ON message.conversation_id = conversation.id
              AND message.deleted_at IS NULL
             JOIN actor AS author ON author.user_id = message.author_id
             JOIN conversation_memberships AS recipient_membership
               ON recipient_membership.conversation_id = conversation.id
              AND recipient_membership.left_at IS NULL
              AND recipient_membership.user_id <> message.author_id
             JOIN actor AS recipient ON recipient.user_id = recipient_membership.user_id
            WHERE conversation.workspace_id = $1
              AND conversation.kind = 'group_direct_message'
            GROUP BY 1, 2
         ),
         dm AS (
           SELECT member_a_id,
                  member_b_id,
                  SUM(direct_message_count) AS direct_message_count,
                  MAX(last_dm_at) AS last_dm_at
             FROM dm_source
            GROUP BY 1, 2
         ),
         shared AS (
            SELECT sender.user_id AS member_a_id,
                   peer.user_id AS member_b_id,
                   COUNT(DISTINCT sender.conversation_id) AS shared_channel_count
              FROM accessible AS sender
              JOIN accessible AS peer
                ON peer.conversation_id = sender.conversation_id
               AND peer.user_id > sender.user_id
             GROUP BY 1, 2
         ),
         channel_activity AS (
           SELECT LEAST(message.author_id, recipient.user_id) AS member_a_id,
                  GREATEST(message.author_id, recipient.user_id) AS member_b_id,
                  COUNT(*) AS channel_message_count,
                  MAX(message.created_at) AS last_channel_at
             FROM messages AS message
             JOIN actor AS author ON author.user_id = message.author_id
             JOIN conversations AS conversation
               ON conversation.id = message.conversation_id
              AND conversation.kind = 'channel'
             JOIN accessible AS recipient
               ON recipient.conversation_id = message.conversation_id
              AND recipient.user_id <> message.author_id
            WHERE message.workspace_id = $1
              AND message.deleted_at IS NULL
            GROUP BY 1, 2
         )
         SELECT COALESCE(dm.member_a_id, shared.member_a_id, activity.member_a_id) AS member_a_id,
                COALESCE(dm.member_b_id, shared.member_b_id, activity.member_b_id) AS member_b_id,
                COALESCE(dm.direct_message_count, 0) AS direct_message_count,
                COALESCE(shared.shared_channel_count, 0) AS shared_channel_count,
                COALESCE(activity.channel_message_count, 0) AS channel_message_count,
                GREATEST(dm.last_dm_at, activity.last_channel_at) AS last_activity_at
           FROM dm
           FULL OUTER JOIN shared
             ON shared.member_a_id = dm.member_a_id
            AND shared.member_b_id = dm.member_b_id
           FULL OUTER JOIN channel_activity AS activity
             ON activity.member_a_id = COALESCE(dm.member_a_id, shared.member_a_id)
            AND activity.member_b_id = COALESCE(dm.member_b_id, shared.member_b_id)
          ORDER BY COALESCE(dm.direct_message_count, 0)
                 + COALESCE(activity.channel_message_count, 0) DESC,
                 COALESCE(shared.shared_channel_count, 0) DESC,
                 member_a_id,
                 member_b_id
          LIMIT $2`,
          [identity.currentUser.workspaceId, COMMUNICATION_PATHS_MAX_PATHS],
        );
        return communicationPathsResponseSchema.parse({
          generatedAt: new Date().toISOString(),
          members,
          paths: result.rows.map((row) => ({
            memberAId: row.member_a_id,
            memberBId: row.member_b_id,
            directMessageCount: Number(row.direct_message_count),
            sharedChannelCount: Number(row.shared_channel_count),
            channelMessageCount: Number(row.channel_message_count),
            lastActivityAt: nullableIso(row.last_activity_at),
          })),
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listConversations(
    identity: AuthenticatedIdentity,
    after: string | undefined,
    limit: number,
    includeGroupDirectMessages = true,
    includeSystemChannels = false,
  ): Promise<ListConversationsResponse> {
    const anchorId = decodeConversationCursor(after);
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const page = await this.#conversationSummaries(
          client,
          identity,
          anchorId,
          limit,
          includeGroupDirectMessages,
          includeSystemChannels,
        );
        return listConversationsResponseSchema.parse({
          conversations: page.conversations,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listPublicChannels(
    identity: AuthenticatedIdentity,
    after: string | undefined,
    limit: number,
  ): Promise<ListPublicChannelsResponse> {
    const anchorId = decodeConversationCursor(after);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_PAGE_MAX_LIMIT);
    const result = await this.pool.query<PublicChannelRow>(
      `SELECT conversation.*,
              CASE
                WHEN actor.kind = 'human' THEN true
                ELSE EXISTS (
                  SELECT 1
                    FROM conversation_memberships AS membership
                   WHERE membership.conversation_id = conversation.id
                     AND membership.user_id = $2
                     AND membership.left_at IS NULL
                )
              END AS joined
         FROM conversations AS conversation
         JOIN workspace_memberships AS workspace_membership
           ON workspace_membership.workspace_id = conversation.workspace_id
          AND workspace_membership.user_id = $2
          AND workspace_membership.status = 'active'
         JOIN users AS actor
           ON actor.id = workspace_membership.user_id
          AND actor.kind IN ('human', 'agent')
        WHERE conversation.workspace_id = $1
          AND conversation.kind = 'channel'
          AND conversation.channel_access = 'workspace'
          AND conversation.is_archived = false
          AND NOT conversation.is_system
          AND (
            $3::uuid IS NULL
            OR (
              lower(conversation.name),
              conversation.created_at,
              conversation.id
            ) > (
              SELECT lower(anchor.name), anchor.created_at, anchor.id
                FROM conversations AS anchor
               WHERE anchor.id = $3::uuid
                 AND anchor.workspace_id = $1
                 AND anchor.kind = 'channel'
                 AND anchor.channel_access = 'workspace'
                 AND NOT anchor.is_system
            )
          )
        ORDER BY lower(conversation.name), conversation.created_at, conversation.id
        LIMIT $4`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id, anchorId, pageLimit + 1],
    );
    const selected = result.rows.slice(0, pageLimit);
    const last = selected.at(-1);
    const nextCursor =
      result.rows.length > pageLimit && last !== undefined
        ? encodeConversationCursor(last.id)
        : null;
    return listPublicChannelsResponseSchema.parse({
      channels: selected.map((row) => ({ conversation: mapConversation(row), joined: row.joined })),
      nextCursor,
      hasMore: nextCursor !== null,
    });
  }

  async joinPublicChannel(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const locked = await client.query<ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE id = $1
            AND workspace_id = $2
            AND kind = 'channel'
            AND channel_access = 'workspace'
            AND is_archived = false
          FOR UPDATE`,
        [conversationId, identity.currentUser.workspaceId],
      );
      const conversation = locked.rows[0];
      if (conversation === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Channel not found");
      }
      const principal = await requireActivePrincipal(client, identity);
      if (principal.kind === "human") {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, conversation),
          syncCursor: await readWorkspaceSequence(client, identity.currentUser.workspaceId),
        });
      }
      const existing = await client.query<ConversationMembershipRow>(
        `SELECT *
           FROM conversation_memberships
          WHERE conversation_id = $1
            AND user_id = $2
          FOR UPDATE`,
        [conversationId, identity.currentUser.user.id],
      );
      if (existing.rows[0]?.left_at === null) {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, conversation),
          syncCursor: await readWorkspaceSequence(client, identity.currentUser.workspaceId),
        });
      }
      const audienceBefore = await conversationAudience(client, conversation);
      await client.query(
        `INSERT INTO conversation_memberships
           (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')
         ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET role = 'member',
               joined_at = clock_timestamp(),
               left_at = NULL,
               updated_at = clock_timestamp()`,
        [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const audienceAfter = await conversationAudience(client, conversation);
      const event = await this.events.insert(client, identity, {
        type: "channel.membership_changed",
        conversation,
        payload: { memberId: identity.currentUser.user.id, action: "added" },
        audienceUserIds: [...new Set([...audienceBefore, ...audienceAfter])],
      });
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, conversation),
        syncCursor: event.workspaceSequence,
      });
    });
  }

  async createChannel(
    identity: AuthenticatedIdentity,
    input: CreateChannelRequest,
    idempotencyKey?: string,
    announcementCapability = false,
    correlationId?: string,
    defaultAgentAgencyEnabled = true,
  ): Promise<ConversationMutationResponse> {
    let acceptedAnnouncementId: string | undefined;
    const response = await runWorkspaceTransaction(this.pool, async (client) => {
      const create = async (): Promise<ConversationMutationResponse> => {
        const channelMode = input.channelMode ?? "chat";
        const principal =
          input.access === "humans"
            ? await this.#requireHumansOnlyCreator(client, identity)
            : await requireActivePrincipal(client, identity);
        const storedAccess: Exclude<ChannelAccess, "humans"> =
          input.access === "humans" ? "members" : input.access;
        if (
          input.access === "humans" &&
          !(await this.#humansOnlyChannelsAvailable(client, identity.currentUser.workspaceId))
        ) {
          throw new ApiError(403, "FORBIDDEN", "Humans-only channels are unavailable");
        }
        if (channelMode === "announcement") {
          const announcementChannelsAvailable = await this.events.announcementChannelsAvailable(
            client,
            identity.currentUser.workspaceId,
          );
          const allowed =
            announcementChannelsAvailable &&
            announcementCapability &&
            principal.kind === "human" &&
            principal.role === "owner";
          if (!allowed) {
            auditAnnouncement(this.hooks, {
              operation: "channel.create",
              outcome: "rejected",
              actorUserId: identity.currentUser.user.id,
              workspaceId: identity.currentUser.workspaceId,
              correlationId,
              reason: "not_authorized",
            });
            throw new ApiError(403, "FORBIDDEN", "Only workspace owners can create announcements");
          }
        }
        const created = await client
          .query<ConversationRow>(
            `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, channel_access, channel_mode, created_by,
            agent_membership_required, human_only)
         VALUES ($1, $2, 'channel', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              input.name,
              input.slug,
              input.topic,
              storedAccess,
              channelMode,
              identity.currentUser.user.id,
              defaultAgentAgencyEnabled,
              input.access === "humans",
            ],
          )
          .catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "23505") {
              throw new ApiError(409, "CONFLICT", "A channel with that slug already exists");
            }
            throw error;
          });
        const row = created.rows[0];
        if (row === undefined) throw new Error("Channel insert returned no row");
        if (input.access === "members" || principal.kind === "agent") {
          await client.query(
            `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')
           ON CONFLICT (conversation_id, user_id) DO UPDATE
             SET role = 'owner',
                 left_at = NULL,
                 updated_at = clock_timestamp()`,
            [row.id, row.workspace_id, identity.currentUser.user.id],
          );
        }
        const audienceUserIds = await conversationAudience(client, row);
        const event = await this.events.insert(client, identity, {
          type: "channel.created",
          conversation: row,
          payload: {
            conversation: mapStoredConversation(row),
            participantIds: audienceUserIds,
          },
          audienceUserIds,
        });
        if (channelMode === "announcement") {
          acceptedAnnouncementId = row.id;
        }
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, row),
          syncCursor: event.workspaceSequence,
        });
      };
      if (idempotencyKey === undefined) return create();
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: "/v1/channels",
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: conversationMutationResponseSchema,
        },
        create,
      );
    });
    if (acceptedAnnouncementId !== undefined) {
      auditAnnouncement(this.hooks, {
        operation: "channel.create",
        outcome: "accepted",
        actorUserId: identity.currentUser.user.id,
        workspaceId: identity.currentUser.workspaceId,
        conversationId: acceptedAnnouncementId,
        correlationId,
      });
    }
    return response;
  }

  async listChannelMembers(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ChannelMembersResponse> {
    const client = await this.pool.connect();
    try {
      const conversation = await requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
      );
      if (conversation.kind !== "channel") {
        throw new ApiError(404, "NOT_FOUND", "Channel not found");
      }
      return this.#channelMembers(client, identity, conversation);
    } finally {
      client.release();
    }
  }

  async upsertChannelMember(
    identity: AuthenticatedIdentity,
    conversationId: string,
    memberId: string,
    input: UpsertChannelMemberRequest,
  ): Promise<ChannelMembershipMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const conversation = await this.#requireManagedChannel(client, identity, conversationId);
      const target = await client.query(
        `SELECT 1
           FROM workspace_memberships AS membership
           JOIN users AS user_account ON user_account.id = membership.user_id
          WHERE membership.workspace_id = $1
            AND membership.user_id = $2
            AND membership.status = 'active'
            AND user_account.kind IN ('human', 'agent')`,
        [identity.currentUser.workspaceId, memberId],
      );
      if (target.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Member not found");

      await lockIdempotencyScope(client, `channel-membership:${conversationId}:${memberId}`);

      const existing = await client.query<ConversationMembershipRow>(
        `SELECT *
           FROM conversation_memberships
          WHERE conversation_id = $1
            AND user_id = $2
          FOR UPDATE`,
        [conversationId, memberId],
      );
      const current = existing.rows[0];
      if (current?.left_at === null && current.role === input.role) {
        return channelMembershipMutationResponseSchema.parse({
          channelMembers: await this.#channelMembers(client, identity, conversation),
          syncCursor: await readWorkspaceSequence(client, identity.currentUser.workspaceId),
        });
      }
      if (current?.left_at === null && current.role === "owner" && input.role === "member") {
        await this.#requireAnotherChannelOwner(client, conversationId, memberId);
      }
      const audienceBefore = await conversationAudience(client, conversation);
      await client.query(
        `INSERT INTO conversation_memberships
           (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET role = EXCLUDED.role,
               joined_at = CASE
                 WHEN conversation_memberships.left_at IS NULL
                   THEN conversation_memberships.joined_at
                 ELSE clock_timestamp()
               END,
               left_at = NULL,
               updated_at = clock_timestamp()`,
        [conversationId, identity.currentUser.workspaceId, memberId, input.role],
      );
      const audienceAfter = await conversationAudience(client, conversation);
      const action = current === undefined || current.left_at !== null ? "added" : "updated";
      const event = await this.events.insert(client, identity, {
        type: "channel.membership_changed",
        conversation,
        payload: { memberId, action },
        audienceUserIds: [...new Set([...audienceBefore, ...audienceAfter])],
      });
      return channelMembershipMutationResponseSchema.parse({
        channelMembers: await this.#channelMembers(client, identity, conversation),
        syncCursor: event.workspaceSequence,
      });
    });
  }

  async removeChannelMember(
    identity: AuthenticatedIdentity,
    conversationId: string,
    memberId: string,
  ): Promise<ChannelMembershipMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const conversation = await this.#requireManagedChannel(client, identity, conversationId);
      await this.hooks.afterRemoveChannelMemberConversationLocked?.();
      await lockIdempotencyScope(client, `channel-membership:${conversationId}:${memberId}`);
      const existing = await client.query<ConversationMembershipRow>(
        `SELECT *
           FROM conversation_memberships
          WHERE conversation_id = $1
            AND user_id = $2
            AND left_at IS NULL
          FOR UPDATE`,
        [conversationId, memberId],
      );
      const current = existing.rows[0];
      if (current === undefined) {
        return channelMembershipMutationResponseSchema.parse({
          channelMembers: await this.#channelMembers(client, identity, conversation),
          syncCursor: await readWorkspaceSequence(client, identity.currentUser.workspaceId),
        });
      }
      if (current.role === "owner") {
        await this.#requireAnotherChannelOwner(client, conversationId, memberId);
      }
      const audienceBefore = await conversationAudience(client, conversation);
      await client.query(
        `UPDATE conversation_memberships
            SET left_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE conversation_id = $1
            AND user_id = $2`,
        [conversationId, memberId],
      );
      const audienceAfter = await conversationAudience(client, conversation);
      const unassigned = await client.query<TaskRow>(
        `UPDATE tasks
            SET assignee_id = NULL,
                version = version + 1,
                updated_by = $3,
                updated_at = clock_timestamp()
          WHERE conversation_id = $1
            AND assignee_id = $2
          RETURNING *`,
        [conversationId, memberId, identity.currentUser.user.id],
      );
      for (const row of unassigned.rows) {
        const task = mapTask(row);
        await this.events.insert(client, identity, {
          type: "task.updated",
          conversation,
          entityVersion: task.version,
          payload: { task },
          audienceUserIds: audienceAfter,
        });
      }
      const event = await this.events.insert(client, identity, {
        type: "channel.membership_changed",
        conversation,
        payload: { memberId, action: "removed" },
        audienceUserIds: [...new Set([...audienceBefore, ...audienceAfter])],
      });
      return channelMembershipMutationResponseSchema.parse({
        channelMembers: await this.#channelMembers(client, identity, conversation),
        syncCursor: event.workspaceSequence,
      });
    });
  }

  /**
   * Create each built-in channel a workspace is missing and post any release notes it has not
   * received yet.
   *
   * This is the "auditable service publisher" path: it is deliberately unreachable from any route,
   * so the human-owner bulletin gate in {@link sendMessage} stays the only way an API request can
   * publish. Every channel and bulletin it writes is reported through the announcement audit hook
   * under the system publisher's own user id.
   *
   * Seeding is idempotent across restarts and concurrent nodes: `system_bulletins` claims each
   * (workspace, channel, bulletin) exactly once, and channel creation relies on the slug's unique
   * index. Failures are reported per workspace and never abort the remaining work.
   */
  async seedSystemChannels(
    definitions: readonly BuiltInChannelDefinition[],
    onError?: (error: unknown, context: { workspaceId: string; slug: string }) => void,
  ): Promise<void> {
    if (definitions.length === 0) return;
    const workspaces = await this.pool.query<{ id: string } & QueryResultRow>(
      `SELECT id FROM workspaces ORDER BY id`,
    );
    if (workspaces.rows.length === 0) return;

    const bulletinsBySlug = new Map<string, readonly SystemBulletin[]>();
    for (const definition of definitions) {
      bulletinsBySlug.set(definition.slug, await definition.loadBulletins());
    }

    for (const workspace of workspaces.rows) {
      if (!(await this.#systemChannelsAvailable(workspace.id))) continue;
      for (const definition of definitions) {
        try {
          const conversation = await this.#ensureSystemChannel(workspace.id, definition);
          for (const bulletin of bulletinsBySlug.get(definition.slug) ?? []) {
            await this.#publishSystemBulletin(conversation, definition.slug, bulletin);
          }
        } catch (error) {
          onError?.(error, { workspaceId: workspace.id, slug: definition.slug });
        }
      }
    }
  }

  /**
   * Request and read the one-way built-in channel cutover for a workspace.
   *
   * Unlike the announcement and humans-only helpers this takes no row lock: the seeder must lock a
   * conversation before the workspace row to match message delivery's order, so locking the
   * workspace first here could deadlock against a member replying in the same channel. The flip is
   * an idempotent one-way UPDATE, so an unlocked read is sufficient.
   *
   * Announcement availability is flipped alongside it. A built-in channel is an announcement
   * channel, so a workspace that can hold one must already be able to represent announcement mode
   * in its stored events.
   */
  async #systemChannelsAvailable(workspaceId: string): Promise<boolean> {
    if (this.systemChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET system_channels_available = true,
                announcement_channels_available = true
          WHERE id = $1
            AND (system_channels_available = false OR announcement_channels_available = false)`,
        [workspaceId],
      );
    }
    const result = await this.pool.query<{ system_channels_available: boolean } & QueryResultRow>(
      `SELECT system_channels_available FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return result.rows[0]?.system_channels_available ?? false;
  }

  async #ensureSystemChannel(
    workspaceId: string,
    definition: BuiltInChannelDefinition,
  ): Promise<ConversationRow> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      // The publisher needs a membership row because messages.author_id references one. It stays
      // `invited` so it never occupies an active seat, never appears in the member directory, and
      // never joins an event audience.
      await client.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'invited')
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, SYSTEM_USER_ID],
      );
      const created = await client.query<ConversationRow>(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, channel_access, channel_mode, is_system,
            created_by)
         VALUES ($1, $2, 'channel', $3, $4, $5, 'workspace', 'announcement', true, $6)
         ON CONFLICT (workspace_id, slug) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          workspaceId,
          definition.name,
          definition.slug,
          definition.topic,
          SYSTEM_USER_ID,
        ],
      );
      const row = created.rows[0];
      if (row === undefined) {
        const existing = await client.query<ConversationRow>(
          `SELECT * FROM conversations WHERE workspace_id = $1 AND slug = $2`,
          [workspaceId, definition.slug],
        );
        const found = existing.rows[0];
        if (found === undefined) throw new Error("Built-in channel could not be resolved");
        return found;
      }
      const audienceUserIds = await conversationAudience(client, row);
      await insertSyncEvent(client, {
        workspaceId,
        actorUserId: SYSTEM_USER_ID,
        type: "channel.created",
        conversationId: row.id,
        payload: {
          conversation: mapStoredConversation(row),
          participantIds: audienceUserIds,
        },
        audienceUserIds,
      });
      auditAnnouncement(this.hooks, {
        operation: "channel.create",
        outcome: "accepted",
        actorUserId: SYSTEM_USER_ID,
        workspaceId,
        conversationId: row.id,
      });
      return row;
    });
  }

  /** Returns true when this call delivered the bulletin, false when it was already present. */
  async #publishSystemBulletin(
    conversation: ConversationRow,
    channelSlug: string,
    bulletin: SystemBulletin,
  ): Promise<boolean> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      // Same lock order as message delivery: the conversation row first, the workspace sequence
      // last. Taking the conversation lock also serializes two nodes seeding the same channel.
      const locked = await client.query<ConversationRow>(
        `SELECT * FROM conversations WHERE id = $1 FOR UPDATE`,
        [conversation.id],
      );
      const current = locked.rows[0];
      if (current === undefined) return false;

      const messageId = randomUUID();
      const claimed = await client.query(
        `INSERT INTO system_bulletins (workspace_id, channel_slug, bulletin_key, message_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, channel_slug, bulletin_key) DO NOTHING`,
        [current.workspace_id, channelSlug, bulletin.key, messageId],
      );
      if (claimed.rowCount === 0) return false;

      const conversationSequenceResult = await client.query<{ next: string } & QueryResultRow>(
        `UPDATE conversations
            SET last_message_sequence = last_message_sequence + 1,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING last_message_sequence::text AS next`,
        [current.id],
      );
      const conversationSequence = conversationSequenceResult.rows[0]?.next;
      if (conversationSequence === undefined)
        throw new Error("Could not allocate bulletin sequence");

      const workspaceSequence = await nextWorkspaceSequence(client, current.workspace_id);
      const inserted = await client.query<MessageRow>(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, conversation_sequence,
           committed_workspace_sequence, client_message_id, request_fingerprint,
           author_id, thread_root_id, body, body_format
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 'hype_comms_markdown_v1')
         RETURNING *`,
        [
          messageId,
          current.workspace_id,
          current.id,
          conversationSequence,
          workspaceSequence,
          randomUUID(),
          createHash("sha256")
            .update(`${current.workspace_id}:${channelSlug}:${bulletin.key}`)
            .digest(),
          SYSTEM_USER_ID,
          bulletin.body,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Bulletin insert returned no row");

      const audienceUserIds = await conversationAudience(client, current);
      // Availability was confirmed before seeding, so stored events keep their channel mode.
      await insertSyncEventWithSequence(client, workspaceSequence, {
        workspaceId: current.workspace_id,
        actorUserId: SYSTEM_USER_ID,
        type: "message.created",
        conversationId: current.id,
        conversationSequence,
        payload: { message: mapMessage(row), mentionedUserIds: [] },
        audienceUserIds,
        stripChannelMode: false,
      });
      auditAnnouncement(this.hooks, {
        operation: "bulletin.publish",
        outcome: "accepted",
        actorUserId: SYSTEM_USER_ID,
        workspaceId: current.workspace_id,
        conversationId: current.id,
      });
      return true;
    });
  }

  async archiveChannel(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const locked = await client.query<ConversationRow>(
        `SELECT *
           FROM conversations AS conversation
          WHERE conversation.id = $1
            AND conversation.workspace_id = $2
            AND conversation.kind = 'channel'
            AND conversation.slug <> 'general'
            AND NOT conversation.is_system
            AND ${conversationVisibilitySql("conversation", "$3")}
          FOR UPDATE`,
        [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const current = locked.rows[0];
      if (current === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Channel not found or cannot be archived");
      }
      await this.hooks.afterArchiveConversationLocked?.();
      const principal = await requireActivePrincipal(client, identity);
      if (principal.kind !== "human" || principal.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only the workspace owner can archive channels");
      }
      if (current.is_archived) {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, current),
          syncCursor: await readWorkspaceSequence(client, identity.currentUser.workspaceId),
        });
      }
      const updated = await client.query<ConversationRow>(
        `UPDATE conversations
            SET is_archived = true, updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [conversationId],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Channel archive returned no row");
      const audienceUserIds = await conversationAudience(client, row);
      const event = await this.events.insert(client, identity, {
        type: "channel.archived",
        conversation: row,
        payload: {
          conversation: mapStoredConversation(row),
          participantIds: audienceUserIds,
        },
        audienceUserIds,
      });
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, row),
        syncCursor: event.workspaceSequence,
      });
    });
  }

  async createDirectConversation(
    identity: AuthenticatedIdentity,
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      await this.#requireActiveConversationParticipants(client, identity, [input.memberId]);
      const { low, high } = directMessagePair(identity.currentUser.user.id, input.memberId);
      const inserted = await client.query<ConversationRow>(
        `INSERT INTO conversations
           (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
         VALUES ($1, $2, 'direct_message', $3, $4, $5)
         ON CONFLICT (workspace_id, dm_user_low_id, dm_user_high_id) DO NOTHING
         RETURNING *`,
        [randomUUID(), identity.currentUser.workspaceId, low, high, identity.currentUser.user.id],
      );
      let row = inserted.rows[0];
      let syncCursor: string;
      if (row === undefined) {
        const existing = await client.query<ConversationRow>(
          `SELECT *
             FROM conversations
            WHERE workspace_id = $1
              AND dm_user_low_id = $2
              AND dm_user_high_id = $3`,
          [identity.currentUser.workspaceId, low, high],
        );
        row = existing.rows[0];
        if (row === undefined) throw new Error("Direct conversation conflict returned no row");
        syncCursor = await readWorkspaceSequence(client, identity.currentUser.workspaceId);
      } else {
        const participantIds = participants(row);
        const event = await this.events.insert(client, identity, {
          type: "direct_conversation.created",
          conversation: row,
          payload: {
            conversation: mapStoredConversation(row),
            participantIds,
          },
          audienceUserIds: participantIds,
        });
        syncCursor = event.workspaceSequence;
      }
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, row),
        syncCursor,
      });
    });
  }

  async createGroupDirectConversation(
    identity: AuthenticatedIdentity,
    input: GroupDirectConversationRequest,
    idempotencyKey: string,
  ): Promise<ConversationMutationResponse> {
    const memberIds = [...input.memberIds].sort();
    if (memberIds.includes(identity.currentUser.user.id)) {
      throw new ApiError(400, "BAD_REQUEST", "The caller is already a group participant");
    }
    return runWorkspaceTransaction(this.pool, async (client) => {
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: "/v1/group-direct-conversations",
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest({ memberIds }),
          responseStatus: 201,
          responseSchema: conversationMutationResponseSchema,
        },
        async () => {
          await this.#requireActiveConversationParticipants(client, identity, memberIds);
          const inserted = await client.query<ConversationRow>(
            `INSERT INTO conversations
               (id, workspace_id, kind, created_by)
             VALUES ($1, $2, 'group_direct_message', $3)
             RETURNING *`,
            [randomUUID(), identity.currentUser.workspaceId, identity.currentUser.user.id],
          );
          const conversation = inserted.rows[0];
          if (conversation === undefined) {
            throw new Error("Group direct conversation insert returned no row");
          }
          const participantIds = [identity.currentUser.user.id, ...memberIds].sort();
          await client.query(
            `INSERT INTO conversation_memberships
               (conversation_id, workspace_id, user_id, role)
             SELECT $1,
                    $2,
                    participant.user_id,
                    CASE WHEN participant.user_id = $3 THEN 'owner' ELSE 'member' END
               FROM unnest($4::uuid[]) AS participant(user_id)`,
            [
              conversation.id,
              identity.currentUser.workspaceId,
              identity.currentUser.user.id,
              participantIds,
            ],
          );
          await client.query(
            `UPDATE conversations
                SET group_memberships_locked = true
              WHERE id = $1
                AND workspace_id = $2
                AND kind = 'group_direct_message'`,
            [conversation.id, identity.currentUser.workspaceId],
          );
          const event = await this.events.insert(client, identity, {
            type: "direct_conversation.created",
            conversation,
            payload: { conversation: mapStoredConversation(conversation), participantIds },
            audienceUserIds: participantIds,
          });
          return conversationMutationResponseSchema.parse({
            conversation: await this.#conversationSummary(client, identity, conversation),
            syncCursor: event.workspaceSequence,
          });
        },
      );
    });
  }

  async findDirectConversation(
    identity: AuthenticatedIdentity,
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse | null> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const { low, high } = directMessagePair(identity.currentUser.user.id, input.memberId);
        const existing = await client.query<ConversationRow>(
          `SELECT conversation.*
             FROM conversations AS conversation
            WHERE conversation.workspace_id = $1
              AND conversation.kind = 'direct_message'
              AND conversation.dm_user_low_id = $2
              AND conversation.dm_user_high_id = $3
              AND EXISTS (
                SELECT 1
                  FROM workspace_memberships AS actor_membership
                  JOIN users AS actor ON actor.id = actor_membership.user_id
                 WHERE actor_membership.workspace_id = conversation.workspace_id
                   AND actor_membership.user_id = $4
                   AND actor_membership.status = 'active'
                   AND actor.kind IN ('human', 'agent')
              )
              AND EXISTS (
                SELECT 1
                  FROM workspace_memberships AS target_membership
                  JOIN users AS target ON target.id = target_membership.user_id
                 WHERE target_membership.workspace_id = conversation.workspace_id
                   AND target_membership.user_id = $5
                   AND target_membership.status = 'active'
                   AND target.kind IN ('human', 'agent')
              )`,
          [
            identity.currentUser.workspaceId,
            low,
            high,
            identity.currentUser.user.id,
            input.memberId,
          ],
        );
        const row = existing.rows[0];
        if (row === undefined) return null;
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, row),
          syncCursor: await readWorkspaceSequence(client, identity.currentUser.workspaceId),
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  history(
    ...args: Parameters<WorkspaceMessageOperations["history"]>
  ): ReturnType<WorkspaceMessageOperations["history"]> {
    return this.messages.history(...args);
  }

  contextHistory(
    ...args: Parameters<WorkspaceMessageOperations["contextHistory"]>
  ): ReturnType<WorkspaceMessageOperations["contextHistory"]> {
    return this.messages.contextHistory(...args);
  }

  thread(
    ...args: Parameters<WorkspaceMessageOperations["thread"]>
  ): ReturnType<WorkspaceMessageOperations["thread"]> {
    return this.messages.thread(...args);
  }

  messageById(
    ...args: Parameters<WorkspaceMessageOperations["messageById"]>
  ): ReturnType<WorkspaceMessageOperations["messageById"]> {
    return this.messages.messageById(...args);
  }

  async createFileUpload(
    identity: AuthenticatedIdentity,
    input: CreateFileUploadRequest,
    idempotencyKey: string,
  ): Promise<CreateFileUploadResponse> {
    const fileName = sanitizeFileName(input.fileName);
    const contentType = input.contentType.trim();
    if (isRejectedAttachment(fileName, contentType)) {
      throw new ApiError(400, "BAD_REQUEST", "Executable files are not allowed");
    }
    if (input.sizeBytes > ATTACHMENT_MAX_BYTES) {
      throw new ApiError(400, "BAD_REQUEST", "File exceeds the 25 MiB limit");
    }
    this.#attachmentStore();
    return runWorkspaceTransaction(this.pool, async (client) => {
      await requireVisibleConversation(client, identity, input.conversationId, true);
      await requireActivePrincipal(client, identity);
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: "/v1/files/uploads",
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: createFileUploadResponseSchema,
        },
        async () => {
          const inserted = await client.query<AttachmentRow>(
            `INSERT INTO attachments (
               id, workspace_id, conversation_id, uploaded_by, file_name, content_type,
               size_bytes, content_sha256, status, upload_expires_at
             )
             VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, 'pending',
               clock_timestamp() + ($9::bigint * interval '1 millisecond')
             )
             RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              input.conversationId,
              identity.currentUser.user.id,
              fileName,
              contentType,
              input.sizeBytes,
              sha256Buffer(input.contentSha256),
              ATTACHMENT_UPLOAD_TTL_MS,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error("Attachment insert returned no row");
          if (row.upload_expires_at === null) {
            throw new Error("Attachment upload was created without an expiry");
          }
          return createFileUploadResponseSchema.parse({
            attachment: mapAttachment(row),
            expiresAt: iso(row.upload_expires_at),
          });
        },
      );
    });
  }

  async putFileContent(
    identity: AuthenticatedIdentity,
    attachmentId: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const store = this.#attachmentStore();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<UploadAttachmentRow>(
        `SELECT *,
                coalesce(upload_expires_at <= clock_timestamp(), true) AS upload_expired
           FROM attachments
          WHERE id = $1
            AND workspace_id = $2
          FOR UPDATE`,
        [attachmentId, identity.currentUser.workspaceId],
      );
      const row = locked.rows[0];
      if (row === undefined || row.uploaded_by !== identity.currentUser.user.id) {
        throw new ApiError(404, "NOT_FOUND", "Upload not found");
      }
      if (row.status !== "pending") {
        throw new ApiError(409, "CONFLICT", "This upload can no longer receive content");
      }
      if (row.upload_expired) {
        throw new ApiError(400, "BAD_REQUEST", "This upload has expired");
      }
      if (row.content_type !== contentType.trim()) {
        throw new ApiError(400, "BAD_REQUEST", "Content type must match the staged upload");
      }
      if (Number(row.size_bytes) !== bytes.byteLength) {
        throw new ApiError(400, "BAD_REQUEST", "File size must match the staged upload");
      }
      if (sha256Hex(bytes) !== row.content_sha256.toString("hex")) {
        throw new ApiError(400, "BAD_REQUEST", "File hash must match the staged upload");
      }
      await store.write(identity.currentUser.workspaceId, attachmentId, bytes);
      await client.query(
        `UPDATE attachments
            SET content_received_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [attachmentId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeFileUpload(
    identity: AuthenticatedIdentity,
    attachmentId: string,
    input: CompleteFileUploadRequest,
    idempotencyKey: string,
  ): Promise<CompleteFileUploadResponse> {
    const store = this.#attachmentStore();
    return runWorkspaceTransaction(this.pool, async (client) => {
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: `/v1/files/${attachmentId}/complete`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 200,
          responseSchema: completeFileUploadResponseSchema,
        },
        async () => {
          const locked = await client.query<UploadAttachmentRow>(
            `SELECT *,
                    coalesce(upload_expires_at <= clock_timestamp(), true) AS upload_expired
               FROM attachments
              WHERE id = $1
                AND workspace_id = $2
              FOR UPDATE`,
            [attachmentId, identity.currentUser.workspaceId],
          );
          const row = locked.rows[0];
          if (row === undefined || row.uploaded_by !== identity.currentUser.user.id) {
            throw new ApiError(404, "NOT_FOUND", "Upload not found");
          }
          if (row.status === "ready") {
            return completeFileUploadResponseSchema.parse({ attachment: mapAttachment(row) });
          }
          if (row.status !== "pending") {
            throw new ApiError(409, "CONFLICT", "This upload can no longer be completed");
          }
          if (row.upload_expired) {
            throw new ApiError(400, "BAD_REQUEST", "This upload has expired");
          }
          if (row.content_received_at === null) {
            throw new ApiError(400, "BAD_REQUEST", "Upload the file before completing it");
          }
          if (
            Number(row.size_bytes) !== input.sizeBytes ||
            row.content_sha256.toString("hex") !== input.contentSha256
          ) {
            throw new ApiError(
              400,
              "BAD_REQUEST",
              "Completed file does not match the staged upload",
            );
          }
          const stored = await store.read(identity.currentUser.workspaceId, attachmentId);
          if (stored.byteLength !== input.sizeBytes || sha256Hex(stored) !== input.contentSha256) {
            throw new ApiError(
              400,
              "BAD_REQUEST",
              "Completed file does not match the staged upload",
            );
          }
          const updated = await client.query<AttachmentRow>(
            `UPDATE attachments
                SET status = 'ready',
                    updated_at = clock_timestamp()
              WHERE id = $1
              RETURNING *`,
            [attachmentId],
          );
          const ready = updated.rows[0];
          if (ready === undefined) throw new Error("Attachment complete returned no row");
          return completeFileUploadResponseSchema.parse({ attachment: mapAttachment(ready) });
        },
      );
    });
  }

  async listConversationFiles(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    limit: number,
  ): Promise<ConversationFilesResponse> {
    const client = await this.pool.connect();
    try {
      await requireVisibleConversation(client, identity, conversationId, false);
      const cursor = decodeFilesCursor(before);
      if (before !== undefined && cursor === null) {
        throw new ApiError(400, "BAD_REQUEST", "Invalid files cursor");
      }
      const result = await client.query<AttachmentRow>(
        `SELECT attachment.*
           FROM attachments AS attachment
           JOIN messages AS message ON message.id = attachment.message_id
          WHERE attachment.conversation_id = $1
            AND attachment.workspace_id = $2
            AND attachment.status = 'ready'
            AND attachment.message_id IS NOT NULL
            AND message.deleted_at IS NULL
            AND (
              $3::timestamptz IS NULL
              OR attachment.created_at < $3::timestamptz
              OR (attachment.created_at = $3::timestamptz AND attachment.id < $4::uuid)
            )
          ORDER BY attachment.created_at DESC, attachment.id DESC
          LIMIT $5`,
        [
          conversationId,
          identity.currentUser.workspaceId,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          Math.min(limit, CONVERSATION_FILES_MAX_LIMIT) + 1,
        ],
      );
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0, limit);
      const oldest = selected.at(-1);
      return conversationFilesResponseSchema.parse({
        files: selected.map(mapAttachment),
        nextCursor:
          hasMore && oldest !== undefined
            ? encodeFilesCursor(iso(oldest.created_at), oldest.id)
            : null,
        hasMore,
      });
    } finally {
      client.release();
    }
  }

  async listMessageAttachments(
    identity: AuthenticatedIdentity,
    messageIds: readonly string[],
  ): Promise<ListMessageAttachmentsResponse> {
    const ids = [...new Set(messageIds)];
    if (
      ids.length === 0 ||
      ids.length !== messageIds.length ||
      ids.length > MESSAGE_HISTORY_MAX_LIMIT
    ) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid attachment message IDs");
    }
    const client = await this.pool.connect();
    try {
      const visible = await client.query<{ id: string } & QueryResultRow>(
        `SELECT message.id
           FROM messages AS message
           JOIN conversations AS conversation ON conversation.id = message.conversation_id
          WHERE message.id = ANY($1::uuid[])
            AND message.workspace_id = $2
            AND conversation.workspace_id = $2
            AND message.deleted_at IS NULL
            AND ${conversationVisibilitySql("conversation", "$3")}`,
        [ids, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      if (visible.rows.length !== ids.length) {
        throw new ApiError(404, "NOT_FOUND", "One or more messages were not found");
      }
      const attachments = await attachmentsForMessages(client, ids);
      return listMessageAttachmentsResponseSchema.parse({ attachments });
    } finally {
      client.release();
    }
  }

  async readFileContent(
    identity: AuthenticatedIdentity,
    attachmentId: string,
    supportsGroupDirectMessages: boolean,
  ): Promise<{
    readonly attachment: Attachment;
    readonly bytes: Buffer;
    readonly contentSha256: string;
  }> {
    const store = this.#attachmentStore();
    const client = await this.pool.connect();
    try {
      const result = await client.query<ReadableAttachmentRow>(
        `SELECT attachment.*, conversation.kind AS conversation_kind
           FROM attachments AS attachment
           JOIN conversations AS conversation
             ON conversation.id = attachment.conversation_id
          WHERE attachment.id = $1
            AND attachment.workspace_id = $2
            AND conversation.workspace_id = $2
            AND attachment.status = 'ready'
            AND (
              (
                attachment.message_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM messages AS message
                   WHERE message.id = attachment.message_id
                     AND message.deleted_at IS NULL
                )
              )
              OR (
                $4::boolean
                AND attachment.message_id IS NULL
                AND attachment.uploaded_by = $3
              )
            )
            AND ${conversationVisibilitySql("conversation", "$3")}`,
        [
          attachmentId,
          identity.currentUser.workspaceId,
          identity.currentUser.user.id,
          identity.principalKind === "human" ||
            identity.authorizationScopes?.includes("attachments:write") === true,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiError(404, "NOT_FOUND", "File not found");
      if (!supportsGroupDirectMessages && row.conversation_kind === "group_direct_message") {
        throw new GroupDirectClientUpgradeRequiredError();
      }
      const bytes = await store.read(identity.currentUser.workspaceId, attachmentId);
      const contentSha256 = row.content_sha256.toString("hex");
      if (bytes.byteLength !== Number(row.size_bytes) || sha256Hex(bytes) !== contentSha256) {
        throw new ApiError(500, "INTERNAL_ERROR", "Stored file failed its integrity check");
      }
      return {
        attachment: mapAttachment(row),
        bytes,
        contentSha256,
      };
    } finally {
      client.release();
    }
  }

  listMessageReactions(
    ...args: Parameters<WorkspaceMessageOperations["listMessageReactions"]>
  ): ReturnType<WorkspaceMessageOperations["listMessageReactions"]> {
    return this.messages.listMessageReactions(...args);
  }

  addReaction(
    ...args: Parameters<WorkspaceMessageOperations["addReaction"]>
  ): ReturnType<WorkspaceMessageOperations["addReaction"]> {
    return this.messages.addReaction(...args);
  }

  removeReaction(
    ...args: Parameters<WorkspaceMessageOperations["removeReaction"]>
  ): ReturnType<WorkspaceMessageOperations["removeReaction"]> {
    return this.messages.removeReaction(...args);
  }

  searchMessages(
    ...args: Parameters<WorkspaceMessageOperations["searchMessages"]>
  ): ReturnType<WorkspaceMessageOperations["searchMessages"]> {
    return this.messages.searchMessages(...args);
  }

  listConversationTasks(
    ...args: Parameters<WorkspaceTaskOperations["listConversationTasks"]>
  ): ReturnType<WorkspaceTaskOperations["listConversationTasks"]> {
    return this.tasks.listConversationTasks(...args);
  }

  listMyTasks(
    ...args: Parameters<WorkspaceTaskOperations["listMyTasks"]>
  ): ReturnType<WorkspaceTaskOperations["listMyTasks"]> {
    return this.tasks.listMyTasks(...args);
  }

  listChannelTasks(
    ...args: Parameters<WorkspaceTaskOperations["listChannelTasks"]>
  ): ReturnType<WorkspaceTaskOperations["listChannelTasks"]> {
    return this.tasks.listChannelTasks(...args);
  }

  getTask(
    ...args: Parameters<WorkspaceTaskOperations["getTask"]>
  ): ReturnType<WorkspaceTaskOperations["getTask"]> {
    return this.tasks.getTask(...args);
  }

  getChannelTaskByNumber(
    ...args: Parameters<WorkspaceTaskOperations["getChannelTaskByNumber"]>
  ): ReturnType<WorkspaceTaskOperations["getChannelTaskByNumber"]> {
    return this.tasks.getChannelTaskByNumber(...args);
  }

  createTask(
    ...args: Parameters<WorkspaceTaskOperations["createTask"]>
  ): ReturnType<WorkspaceTaskOperations["createTask"]> {
    return this.tasks.createTask(...args);
  }

  createChannelTask(
    ...args: Parameters<WorkspaceTaskOperations["createChannelTask"]>
  ): ReturnType<WorkspaceTaskOperations["createChannelTask"]> {
    return this.tasks.createChannelTask(...args);
  }

  updateTask(
    ...args: Parameters<WorkspaceTaskOperations["updateTask"]>
  ): ReturnType<WorkspaceTaskOperations["updateTask"]> {
    return this.tasks.updateTask(...args);
  }

  moveTask(
    ...args: Parameters<WorkspaceTaskOperations["moveTask"]>
  ): ReturnType<WorkspaceTaskOperations["moveTask"]> {
    return this.tasks.moveTask(...args);
  }

  sendMessage(
    ...args: Parameters<WorkspaceMessageOperations["sendMessage"]>
  ): ReturnType<WorkspaceMessageOperations["sendMessage"]> {
    return this.messages.sendMessage(...args);
  }

  retractMessage(
    ...args: Parameters<WorkspaceMessageOperations["retractMessage"]>
  ): ReturnType<WorkspaceMessageOperations["retractMessage"]> {
    return this.messages.retractMessage(...args);
  }

  advanceReadCursor(
    ...args: Parameters<WorkspaceMessageOperations["advanceReadCursor"]>
  ): ReturnType<WorkspaceMessageOperations["advanceReadCursor"]> {
    return this.messages.advanceReadCursor(...args);
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

  async deleteExpiredState(): Promise<readonly AttachmentCleanupFailure[]> {
    await this.pool.query(
      `DELETE FROM sync_events
        WHERE created_at < clock_timestamp() - make_interval(days => $1)`,
      [SYNC_RETENTION_DAYS],
    );
    await this.pool.query(
      `DELETE FROM realtime_tickets
        WHERE expires_at < clock_timestamp() - interval '1 hour'`,
    );
    return [
      ...(await this.#deleteExpiredAttachments("pending")),
      ...(await this.#deleteExpiredAttachments("unclaimed-ready")),
    ];
  }

  async #deleteExpiredAttachments(
    kind: "pending" | "unclaimed-ready",
  ): Promise<AttachmentCleanupFailure[]> {
    const store = this.hooks.attachmentStore;
    if (store === undefined) return [];

    const failures: AttachmentCleanupFailure[] = [];

    while (true) {
      const batch = await runWorkspaceTransaction(this.pool, async (client) => {
        const expired =
          kind === "pending"
            ? await client.query<ExpiredAttachmentRow>(
                `SELECT id, workspace_id
                   FROM attachments
                  WHERE status = 'pending'
                    AND upload_expires_at <= clock_timestamp()
                  ORDER BY upload_expires_at, id
                  LIMIT $1
                  FOR UPDATE SKIP LOCKED`,
                [ATTACHMENT_CLEANUP_BATCH_SIZE],
              )
            : await client.query<ExpiredAttachmentRow>(
                `SELECT id, workspace_id
                   FROM attachments
                  WHERE status = 'ready'
                    AND message_id IS NULL
                    AND content_received_at <= clock_timestamp() - make_interval(secs => $1)
                  ORDER BY content_received_at, id
                  LIMIT $2
                  FOR UPDATE SKIP LOCKED`,
                [UNCLAIMED_READY_ATTACHMENT_RETENTION_MS / 1_000, ATTACHMENT_CLEANUP_BATCH_SIZE],
              );
        if (expired.rows.length === 0) {
          return { deleted: 0, selected: 0, failures: [] satisfies AttachmentCleanupFailure[] };
        }

        const deleted: string[] = [];
        const batchFailures: AttachmentCleanupFailure[] = [];
        for (const attachment of expired.rows) {
          try {
            // Keep the row until byte removal succeeds, so a later pass can retry safely.
            await store.remove(attachment.workspace_id, attachment.id);
            deleted.push(attachment.id);
          } catch (error) {
            batchFailures.push({
              attachmentId: attachment.id,
              workspaceId: attachment.workspace_id,
              error,
            });
          }
        }
        if (deleted.length > 0) {
          await client.query("DELETE FROM attachments WHERE id = ANY($1::uuid[])", [deleted]);
        }
        return { deleted: deleted.length, selected: expired.rows.length, failures: batchFailures };
      });
      failures.push(...batch.failures);
      if (batch.selected < ATTACHMENT_CLEANUP_BATCH_SIZE || batch.deleted === 0) {
        return failures;
      }
    }
  }

  async #members(client: PoolClient, workspaceId: string) {
    const result = await client.query<UserRow>(
      `SELECT user_account.id, user_account.kind, user_account.username, user_account.display_name,
              user_account.avatar_url, user_account.title, user_account.created_at,
              user_account.updated_at
         FROM users AS user_account
         JOIN workspace_memberships AS membership
           ON membership.user_id = user_account.id
        WHERE membership.workspace_id = $1
          AND membership.status = 'active'
        ORDER BY lower(user_account.display_name), user_account.id`,
      [workspaceId],
    );
    return result.rows.map(mapUser);
  }

  /**
   * One page of the member's visible conversations.
   *
   * The listing is keyset-paginated over the existing deterministic ordering
   * `(kind, lower(coalesce(name, '')), created_at, id)`. Because that tuple ends in the primary
   * key it is a total order, so the row-value comparison against the anchor row walks every
   * conversation exactly once with no duplicates and no skips. `LIMIT pageLimit + 1` is what
   * detects a further page. Summary details are read in batches for the selected IDs only.
   *
   * The page size is clamped to the contract's maximum as well as validated at the route, so no
   * caller can ever produce a response too large for its own schema to accept.
   */
  async #conversationSummaries(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    after: string | null,
    limit: number,
    includeGroupDirectMessages: boolean,
    includeSystemChannels: boolean,
  ): Promise<ConversationPage> {
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_PAGE_MAX_LIMIT);
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations AS conversation
        WHERE conversation.workspace_id = $1
          AND ${conversationVisibilitySql("conversation", "$2")}
          AND ($4::boolean OR conversation.kind <> 'group_direct_message')
          AND ($6::boolean OR NOT conversation.is_system)
          AND (
            $3::uuid IS NULL
            OR (
              conversation.kind,
              lower(coalesce(conversation.name, '')),
              conversation.created_at,
              conversation.id
            ) >
               (
                 SELECT anchor.kind,
                        lower(coalesce(anchor.name, '')),
                        anchor.created_at,
                        anchor.id
                   FROM conversations AS anchor
                  WHERE anchor.id = $3::uuid
                    AND anchor.workspace_id = $1
                    AND ($4::boolean OR anchor.kind <> 'group_direct_message')
                    AND ($6::boolean OR NOT anchor.is_system)
                    AND (
                      ${conversationVisibilitySql("anchor", "$2")}
                      OR (
                        anchor.kind = 'channel'
                        AND anchor.channel_access = 'members'
                        AND NOT anchor.human_only
                        AND EXISTS (
                          SELECT 1
                            FROM conversation_memberships AS anchor_membership
                           WHERE anchor_membership.conversation_id = anchor.id
                             AND anchor_membership.user_id = $2
                        )
                      )
                    )
               )
          )
        ORDER BY conversation.kind, lower(coalesce(conversation.name, '')),
                 conversation.created_at, conversation.id
        LIMIT $5`,
      [
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        after,
        includeGroupDirectMessages,
        pageLimit + 1,
        includeSystemChannels,
      ],
    );
    const rows = result.rows.slice(0, pageLimit);
    const summaries = await readConversationSummaries(client, identity.currentUser.user.id, rows);
    const last = rows.at(-1);
    const nextCursor =
      result.rows.length > pageLimit && last !== undefined
        ? encodeConversationCursor(last.id)
        : null;
    return { conversations: summaries, nextCursor, hasMore: nextCursor !== null };
  }

  async #conversationSummary(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<ConversationSummary> {
    const [summary] = await readConversationSummaries(client, identity.currentUser.user.id, [
      conversation,
    ]);
    if (summary === undefined) throw new Error("Conversation summary is missing");
    return summary;
  }

  async #requireHumansOnlyCreator(
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

  async #requireActiveConversationParticipants(
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

  async #requireManagedChannel(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationRow> {
    // Membership mutations take message delivery's canonical conversation row lock before
    // inspecting or changing conversation_memberships.
    const conversation = await requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    await requireActivePrincipal(client, identity);
    if (
      conversation.kind !== "channel" ||
      conversation.channel_access !== "members" ||
      conversation.human_only
    ) {
      throw new ApiError(404, "NOT_FOUND", "Managed channel not found");
    }
    const role = await this.#membershipRole(client, identity, conversation);
    if (role !== "owner") {
      throw new ApiError(403, "FORBIDDEN", "Only a channel owner can manage members");
    }
    return conversation;
  }

  async #requireAnotherChannelOwner(
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

  async #channelMembers(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<ChannelMembersResponse> {
    const result = conversation.human_only
      ? await client.query<ChannelMemberRow>(
          `SELECT user_account.id, user_account.kind, user_account.username,
                    user_account.display_name, user_account.avatar_url, user_account.title,
                    user_account.created_at, user_account.updated_at,
                    'member'::text AS role, workspace_membership.created_at AS joined_at
               FROM workspace_memberships AS workspace_membership
               JOIN users AS user_account ON user_account.id = workspace_membership.user_id
              WHERE workspace_membership.workspace_id = $1
                AND workspace_membership.status = 'active'
                AND user_account.kind = 'human'
              ORDER BY lower(user_account.display_name), user_account.id`,
          [conversation.workspace_id],
        )
      : conversation.channel_access === "workspace"
        ? await client.query<ChannelMemberRow>(
            `SELECT user_account.id, user_account.kind, user_account.username,
                    user_account.display_name,
                    user_account.avatar_url, user_account.title, user_account.created_at,
                    user_account.updated_at,
                    CASE
                      WHEN user_account.kind = 'human' AND user_account.id = $2 THEN 'owner'
                      WHEN user_account.kind = 'agent' THEN public_membership.role
                      ELSE 'member'
                    END AS role,
                    CASE
                      WHEN user_account.kind = 'human' THEN workspace_membership.created_at
                      WHEN user_account.kind = 'agent' THEN public_membership.joined_at
                      ELSE bot_grant.created_at
                    END AS joined_at
               FROM users AS user_account
               JOIN workspace_memberships AS workspace_membership
                 ON workspace_membership.user_id = user_account.id
               LEFT JOIN conversation_memberships AS public_membership
                 ON public_membership.conversation_id = $3
                AND public_membership.user_id = user_account.id
                AND public_membership.left_at IS NULL
               LEFT JOIN bot_channel_grants AS bot_grant
                 ON bot_grant.conversation_id = $3
                AND bot_grant.bot_user_id = user_account.id
              WHERE workspace_membership.workspace_id = $1
                AND workspace_membership.status = 'active'
                AND (
                  user_account.kind = 'human'
                  OR (
                    user_account.kind = 'agent'
                    AND public_membership.user_id IS NOT NULL
                  )
                  OR bot_grant.bot_user_id IS NOT NULL
                )
              ORDER BY lower(user_account.display_name), user_account.id`,
            [conversation.workspace_id, conversation.created_by, conversation.id],
          )
        : await client.query<ChannelMemberRow>(
            `SELECT audience.*
               FROM (
                 SELECT user_account.id, user_account.kind, user_account.username,
                        user_account.display_name, user_account.avatar_url, user_account.title,
                        user_account.created_at, user_account.updated_at,
                        membership.role, membership.joined_at
                   FROM conversation_memberships AS membership
                   JOIN workspace_memberships AS workspace_membership
                     ON workspace_membership.workspace_id = membership.workspace_id
                    AND workspace_membership.user_id = membership.user_id
                   JOIN users AS user_account ON user_account.id = membership.user_id
                  WHERE membership.conversation_id = $1
                    AND membership.left_at IS NULL
                    AND workspace_membership.status = 'active'
                    AND user_account.kind IN ('human', 'agent')
                    AND (NOT $2::boolean OR user_account.kind = 'human')
                 UNION ALL
                 SELECT user_account.id, user_account.kind, user_account.username,
                        user_account.display_name, user_account.avatar_url, user_account.title,
                        user_account.created_at, user_account.updated_at,
                        'member'::text AS role, grant_record.created_at AS joined_at
                   FROM bot_channel_grants AS grant_record
                   JOIN workspace_memberships AS workspace_membership
                     ON workspace_membership.workspace_id = grant_record.workspace_id
                    AND workspace_membership.user_id = grant_record.bot_user_id
                   JOIN users AS user_account ON user_account.id = grant_record.bot_user_id
                  WHERE grant_record.conversation_id = $1
                    AND workspace_membership.status = 'active'
                    AND user_account.kind = 'bot'
                    AND NOT $2::boolean
               ) AS audience
              ORDER BY lower(audience.display_name), audience.id`,
            [conversation.id, conversation.human_only],
          );
    const role = await this.#membershipRole(client, identity, conversation);
    return channelMembersResponseSchema.parse({
      conversationId: conversation.id,
      access: conversation.human_only ? "humans" : conversation.channel_access,
      members: result.rows.map((row) => ({
        user: mapUser(row),
        role: row.role,
        joinedAt: iso(row.joined_at),
      })),
      canManage:
        conversation.channel_access === "members" && !conversation.human_only && role === "owner",
    });
  }

  #attachmentStore(): AttachmentStore {
    const store = this.hooks.attachmentStore;
    if (store === undefined) {
      throw new ApiError(400, "BAD_REQUEST", "Attachments are not available yet");
    }
    return store;
  }

  async #membershipRole(
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

  async #humansOnlyChannelsAvailable(client: PoolClient, workspaceId: string): Promise<boolean> {
    if (this.humansOnlyChannelsEnabled) {
      await client.query(
        `UPDATE workspaces
            SET humans_only_channels_available = true
          WHERE id = $1
            AND humans_only_channels_available = false`,
        [workspaceId],
      );
    }
    const result = await client.query<{ humans_only_channels_available: boolean } & QueryResultRow>(
      `SELECT humans_only_channels_available
         FROM workspaces
        WHERE id = $1
        FOR UPDATE`,
      [workspaceId],
    );
    const workspace = result.rows[0];
    if (workspace === undefined) throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
    return workspace.humans_only_channels_available;
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
