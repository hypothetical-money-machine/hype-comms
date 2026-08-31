import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS,
  AGENT_CONTEXT_PACK_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_MESSAGE_MAX,
  CONVERSATION_FILES_MAX_LIMIT,
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  MESSAGE_HISTORY_MAX_LIMIT,
  MESSAGE_SEARCH_MAX_LIMIT,
  POSTGRES_BIGINT_MAX,
  REACTIONS_PER_MEMBER_PER_MESSAGE_MAX,
  REACTIONS_PER_MESSAGE_MAX,
  TASK_PAGE_MAX_LIMIT,
  addReactionResponseSchema,
  agentWakeBootstrapResponseSchema,
  agentContextHistoryResponseSchema,
  attachmentSchema,
  completeFileUploadResponseSchema,
  conversationFilesResponseSchema,
  createFileUploadResponseSchema,
  listMessageAttachmentsResponseSchema,
  advanceReadCursorResponseSchema,
  channelMembershipMutationResponseSchema,
  channelMembersResponseSchema,
  COMMUNICATION_PATHS_MAX_PATHS,
  communicationPathsResponseSchema,
  conversationMutationResponseSchema,
  conversationSchema,
  conversationSummarySchema,
  listConversationsResponseSchema,
  listPublicChannelsResponseSchema,
  listMessageReactionsResponseSchema,
  listMembersResponseSchema,
  messageHistoryResponseSchema,
  messageByIdResponseSchema,
  messageSearchResponseSchema,
  messageSchema,
  messageThreadResponseSchema,
  reactionEmojiSchema,
  reactionSchema,
  readCursorSchema,
  realtimeTicketResponseSchema,
  removeReactionResponseSchema,
  retractMessageResponseSchema,
  sendMessageResponseSchema,
  syncResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  taskRecordListResponseSchema,
  taskRecordMutationResponseSchema,
  taskRecordResponseSchema,
  taskRecordSchema,
  taskSchema,
  userSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  injectionSafeCompactJsonByteLength,
  isPostgresBigintString,
  type AdvanceReadCursorResponse,
  type AddReactionResponse,
  type AgentWakeBootstrapResponse,
  type AgentContextAuthor,
  type AgentContextHistoryResponse,
  type AgentContextLocation,
  type AgentContextMessage,
  type Attachment,
  type CompleteFileUploadRequest,
  type CompleteFileUploadResponse,
  type ConversationFilesResponse,
  type CreateFileUploadRequest,
  type CreateFileUploadResponse,
  type ListMessageAttachmentsResponse,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type CommunicationPathsResponse,
  type Conversation,
  type ChannelAccess,
  type ConversationMutationResponse,
  type ConversationSummary,
  type CreateChannelRequest,
  type CreateTaskRequest,
  type DirectConversationRequest,
  type GroupDirectConversationRequest,
  type ListConversationsResponse,
  type ListPublicChannelsResponse,
  type ListMessageReactionsResponse,
  type ListMembersResponse,
  type Message,
  type MessageHistoryResponse,
  type MessageByIdResponse,
  type MessageSearchResponse,
  type MessageThreadResponse,
  type MessageThreadSummary,
  type Reaction,
  type ReactionEmoji,
  type RemoveReactionResponse,
  type RetractMessageResponse,
  type SendConversationMessageRequest,
  type SendMessageResponse,
  type SyncResponse,
  type Task,
  type TaskListFilters,
  type TaskListResponse,
  type TaskMutationResponse,
  type TaskNumber,
  type TaskRecord,
  type TaskRecordListResponse,
  type TaskRecordMutationResponse,
  type TaskRecordResponse,
  type TaskStatus,
  type MoveTaskRequest,
  type UpdateTaskRequest,
  type UpsertChannelMemberRequest,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";
import {
  ATTACHMENT_UPLOAD_TTL_MS,
  isRejectedAttachment,
  sanitizeFileName,
  sha256Buffer,
  sha256Hex,
  type AttachmentStore,
} from "./file-store.js";
import type { AuthenticatedBotIdentity } from "../bots/service.js";
import type { AuthenticatedAgentIdentity, AuthenticatedIdentity } from "../identity/service.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
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
const POSTGRES_REAL_MAX = 3.4028234663852886e38;
const TASK_RANK_STEP = 1_024n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuthenticatedTaskIdentity = AuthenticatedIdentity | AuthenticatedBotIdentity;

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

interface UserRow extends QueryResultRow {
  id: string;
  kind: "human" | "bot" | "agent";
  username: string;
  display_name: string;
  avatar_url: string | null;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConversationRow extends QueryResultRow {
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

interface AgentWakeConversationRow extends QueryResultRow {
  id: string;
  kind: "channel" | "direct_message";
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

interface MessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  conversation_sequence: string;
  committed_workspace_sequence: string;
  version: number;
  client_message_id: string;
  request_fingerprint: Buffer;
  author_id: string;
  thread_root_id: string | null;
  body: string;
  body_format: "hype_comms_markdown_v1";
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AgentContextMessageRow extends MessageRow {
  author_kind: "human" | "bot" | "agent";
  author_username: string;
  author_display_name: string;
  mentioned_you: boolean;
}

interface AttachmentRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string | null;
  uploaded_by: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  content_sha256: Buffer;
  status: "pending" | "ready" | "failed";
  upload_expires_at: Date | string | null;
  content_received_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReadableAttachmentRow extends AttachmentRow {
  conversation_kind: Conversation["kind"];
}

interface MessageAuthorizationRow extends QueryResultRow {
  conversation_visible: boolean;
  is_archived: boolean;
}

interface WorkspaceMembershipAuthorizationRow extends QueryResultRow {
  workspace_active: boolean;
  role: "owner" | "member";
  kind: "human" | "bot" | "agent";
}

interface SearchMessageRow extends MessageRow {
  search_rank: string;
}

interface ThreadSummaryRow extends MessageRow {
  summarized_thread_root_id: string;
  reply_count: string;
}

interface ReactionRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: Date | string;
}

interface TaskRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  number: string;
  version: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Task["priority"];
  assignee_id: string | null;
  due_on: Date | string | null;
  source_message_id: string | null;
  rank: string;
  created_by: string;
  updated_by: string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ReactionCountRow extends QueryResultRow {
  total: string;
  member_total: string;
}

interface ReadCursorRow extends QueryResultRow {
  conversation_id: string;
  user_id: string;
  last_read_message_id: string | null;
  last_read_conversation_sequence: string;
  last_read_at: Date | string | null;
  updated_at: Date | string;
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

interface UnreadCounts {
  readonly unreadCount: number;
  readonly mentionCount: number;
}

export interface WorkspaceRepositoryHooks {
  /**
   * Test seam for deterministically interleaving a committed write after bootstrap establishes
   * its transaction snapshot.
   */
  readonly afterBootstrapCursorRead?: () => Promise<void>;
  /** Test seam after the wake bootstrap establishes its high-water snapshot. */
  readonly afterAgentWakeBootstrapCursorRead?: () => Promise<void>;
  /** Requests the one-way cluster cutover; persisted availability remains authoritative afterward. */
  readonly announcementChannelsEnabled?: boolean;
  /** Requests the one-way cluster cutover; persisted availability remains authoritative afterward. */
  readonly humansOnlyChannelsEnabled?: boolean;
  /** Structured operational record; message bodies are deliberately never included. */
  readonly onAnnouncementAudit?: (record: AnnouncementAuditRecord) => void;
  /** Test seam for holding the message-delivery conversation lock. */
  readonly afterConversationLocked?: () => Promise<void>;
  /** Test seam for holding message delivery after its authorization locks and reads. */
  readonly afterMessageAuthorizationLocked?: () => Promise<void>;
  /** Test seam for holding the conversation lock before an archive commits. */
  readonly afterArchiveConversationLocked?: () => Promise<void>;
  /** Test seam for holding the conversation lock before a member removal commits. */
  readonly afterRemoveChannelMemberConversationLocked?: () => Promise<void>;
  /** Local or remote object bytes for staged attachments. */
  readonly attachmentStore?: AttachmentStore;
}

export interface AnnouncementAuditRecord {
  readonly operation: "channel.create" | "bulletin.publish";
  readonly outcome: "accepted" | "rejected";
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly conversationId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly reason?: string | undefined;
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
}

export type WorkspaceClientCapabilities = Omit<WorkspacePrincipal, "workspaceId" | "userId">;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

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

function mapUser(row: UserRow) {
  return userSchema.parse({
    id: row.id,
    // Agent administration and self-authentication expose the distinct `agent` principal kind,
    // but workspace member projections stay readable by the immediately previous desktop schema
    // (`human | bot`). Existing clients already treated these non-email members as ordinary
    // mention/DM targets, which is exactly the behavior this directory shape needs.
    kind: row.kind === "agent" ? "human" : row.kind,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    title: row.title,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapConversation(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    topic: row.topic,
    access: row.human_only ? "humans" : row.channel_access,
    channelMode: row.kind === "channel" ? (row.channel_mode ?? "chat") : null,
    isArchived: row.is_archived,
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
    isArchived: row.is_archived,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function conversationVisibilitySql(
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

/**
 * The projection every `AgentContextMessageRow` is read through.
 *
 * `mapAgentContextMessage` depends on this exact column set, so both the page query and the
 * thread-root lookup select it from here rather than repeating it.
 */
function agentContextMessageSql(mentionParameter: string): string {
  return `SELECT message.*,
                 author.kind AS author_kind,
                 author.username AS author_username,
                 author.display_name AS author_display_name,
                 EXISTS (
                   SELECT 1
                     FROM message_mentions AS mention
                    WHERE mention.message_id = message.id
                      AND mention.mentioned_user_id = ${mentionParameter}
                 ) AS mentioned_you
            FROM messages AS message
            JOIN users AS author ON author.id = message.author_id`;
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

function participants(row: ConversationRow): string[] {
  if (row.dm_user_low_id === null || row.dm_user_high_id === null) return [];
  return row.dm_user_low_id === row.dm_user_high_id
    ? [row.dm_user_low_id]
    : [row.dm_user_low_id, row.dm_user_high_id];
}

function mapMessage(row: MessageRow): Message {
  return messageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    conversationSequence: row.conversation_sequence,
    version: row.version,
    clientMessageId: row.client_message_id,
    authorId: row.author_id,
    threadRootId: row.thread_root_id,
    body: row.body,
    bodyFormat: row.body_format,
    editedAt: nullableIso(row.edited_at),
    deletedAt: nullableIso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapAgentContextAuthor(row: UserRow): AgentContextAuthor {
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    displayName: row.display_name,
  };
}

function mapAgentContextMessage(row: AgentContextMessageRow): AgentContextMessage {
  return {
    id: row.id,
    conversationSequence: row.conversation_sequence,
    createdAt: iso(row.created_at),
    body: row.body,
    author: {
      id: row.author_id,
      kind: row.author_kind,
      username: row.author_username,
      displayName: row.author_display_name,
    },
    mentionedYou: row.mentioned_you,
    threadRootId: row.thread_root_id,
  };
}

function mapAttachment(row: AttachmentRow): Attachment {
  return attachmentSchema.parse({
    id: row.id,
    messageId: row.message_id,
    uploadedBy: row.uploaded_by,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    downloadUrl: null,
    createdAt: iso(row.created_at),
  });
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

function mapReaction(row: ReactionRow): Reaction {
  return reactionSchema.parse({
    id: row.id,
    messageId: row.message_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: iso(row.created_at),
  });
}

function taskDueOn(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function mapTask(row: TaskRow): Task {
  return taskSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    number: row.number,
    version: row.version,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    dueOn: taskDueOn(row.due_on),
    sourceMessageId: row.source_message_id,
    rank: row.rank,
    createdBy: row.created_by,
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapTaskRecord(row: TaskRow): TaskRecord {
  return taskRecordSchema.parse({ ...mapTask(row), updatedBy: row.updated_by });
}

function mapReadCursor(row: ReadCursorRow) {
  return readCursorSchema.parse({
    conversationId: row.conversation_id,
    userId: row.user_id,
    lastReadMessageId: row.last_read_message_id,
    lastReadConversationSequence: row.last_read_conversation_sequence,
    lastReadAt: nullableIso(row.last_read_at),
    updatedAt: iso(row.updated_at),
  });
}

function encodeHistoryCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ sequence }), "utf8").toString("base64url");
}

function decodeHistoryCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("sequence" in parsed) ||
      typeof parsed.sequence !== "string" ||
      !/^[1-9]\d*$/.test(parsed.sequence) ||
      !isPostgresBigintString(parsed.sequence)
    ) {
      throw new Error("Invalid cursor");
    }
    return parsed.sequence;
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid history cursor");
  }
}

interface SearchCursor {
  readonly queryHash: string;
  readonly rank: number;
  readonly workspaceSequence: string;
  readonly id: string;
}

function searchQueryHash(query: string): string {
  return createHash("sha256").update(query).digest("base64url");
}

function encodeSearchCursor(row: SearchMessageRow, queryHash: string): string {
  return Buffer.from(
    JSON.stringify({
      queryHash,
      rank: Number(row.search_rank),
      workspaceSequence: row.committed_workspace_sequence,
      id: row.id,
    } satisfies SearchCursor),
    "utf8",
  ).toString("base64url");
}

function decodeSearchCursor(cursor: string | undefined, queryHash: string): SearchCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("queryHash" in parsed) ||
      typeof parsed.queryHash !== "string" ||
      parsed.queryHash !== queryHash ||
      !("rank" in parsed) ||
      typeof parsed.rank !== "number" ||
      !Number.isFinite(parsed.rank) ||
      parsed.rank < 0 ||
      parsed.rank > POSTGRES_REAL_MAX ||
      !("workspaceSequence" in parsed) ||
      typeof parsed.workspaceSequence !== "string" ||
      !/^[1-9]\d*$/.test(parsed.workspaceSequence) ||
      !isPostgresBigintString(parsed.workspaceSequence) ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error("Invalid cursor");
    }
    return {
      queryHash: parsed.queryHash,
      rank: parsed.rank,
      workspaceSequence: parsed.workspaceSequence,
      id: parsed.id,
    };
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid search cursor");
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

interface TaskCursor {
  readonly createdAt: string;
  readonly id: string;
  readonly filterHash: string;
}

function taskFilterHash(filters: TaskListFilters): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        status: filters.status ?? null,
        priority: filters.priority ?? null,
        assignee: filters.assignee ?? null,
        dueAfter: filters.dueAfter ?? null,
        dueBefore: filters.dueBefore ?? null,
        updatedAfter: filters.updatedAfter ?? null,
        updatedBy: filters.updatedBy ?? null,
      }),
    )
    .digest("base64url");
}

const EMPTY_TASK_FILTER_HASH = taskFilterHash({});

function encodeTaskCursor(row: TaskRow, filterHash: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: iso(row.created_at), id: row.id, filterHash } satisfies TaskCursor),
    "utf8",
  ).toString("base64url");
}

function decodeTaskCursor(
  cursor: string | undefined,
  expectedFilterHash: string,
): TaskCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id) ||
      ("filterHash" in parsed &&
        (typeof parsed.filterHash !== "string" || parsed.filterHash !== expectedFilterHash)) ||
      (!("filterHash" in parsed) && expectedFilterHash !== EMPTY_TASK_FILTER_HASH)
    ) {
      throw new Error("Invalid cursor");
    }
    return {
      createdAt: new Date(parsed.createdAt).toISOString(),
      id: parsed.id,
      filterHash: expectedFilterHash,
    };
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid task cursor");
  }
}

function taskListFilterParameters(
  identity: AuthenticatedTaskIdentity,
  filters: TaskListFilters,
): readonly unknown[] {
  const assigneeFilter = filters.assignee;
  const assigneeId =
    assigneeFilter === "me"
      ? identity.currentUser.user.id
      : assigneeFilter === "unassigned" || assigneeFilter === undefined
        ? null
        : assigneeFilter;
  const updatedById =
    filters.updatedBy === "me" ? identity.currentUser.user.id : (filters.updatedBy ?? null);
  return [
    filters.status ?? null,
    filters.priority ?? null,
    assigneeFilter !== undefined,
    assigneeFilter === "unassigned",
    assigneeId,
    filters.dueAfter ?? null,
    filters.dueBefore ?? null,
    filters.updatedAfter ?? null,
    updatedById,
  ];
}

function taskListFilterSql(alias: "task", firstParameter: number): string {
  const parameter = (offset: number) => `$${firstParameter + offset}`;
  return `
    AND (${parameter(0)}::text IS NULL OR ${alias}.status = ${parameter(0)})
    AND (${parameter(1)}::text IS NULL OR ${alias}.priority = ${parameter(1)})
    AND (
      ${parameter(2)}::boolean = false
      OR (${parameter(3)}::boolean = true AND ${alias}.assignee_id IS NULL)
      OR (${parameter(3)}::boolean = false AND ${alias}.assignee_id = ${parameter(4)}::uuid)
    )
    AND (${parameter(5)}::date IS NULL OR ${alias}.due_on >= ${parameter(5)}::date)
    AND (${parameter(6)}::date IS NULL OR ${alias}.due_on <= ${parameter(6)}::date)
    AND (${parameter(7)}::timestamptz IS NULL OR ${alias}.updated_at > ${parameter(7)})
    AND (${parameter(8)}::uuid IS NULL OR ${alias}.updated_by = ${parameter(8)}::uuid)`;
}

function fingerprintMessage(conversationId: string, input: SendConversationMessageRequest): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify({
        conversationId,
        threadRootId: input.threadRootId,
        body: input.body,
        bodyFormat: input.bodyFormat,
        clientMessageId: input.clientMessageId,
        mentionedUserIds: [...input.mentionedUserIds].sort(),
        attachmentIds: [...input.attachmentIds].sort(),
      }),
    )
    .digest();
}

function sameBuffer(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function mentionPattern(username: string): RegExp {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}($|[^\\p{L}\\p{N}_])`, "iu");
}

export class WorkspaceRepository {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: WorkspaceRepositoryHooks = {},
  ) {}

  get announcementChannelsEnabled(): boolean {
    return this.hooks.announcementChannelsEnabled ?? false;
  }

  get humansOnlyChannelsEnabled(): boolean {
    return this.hooks.humansOnlyChannelsEnabled ?? false;
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
    return this.#transaction(
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

  /**
   * Establishes the future-only agent wake cursor and its visible conversation-kind projection in
   * one repeatable-read snapshot. The query deliberately selects no summaries, messages, or bodies.
   * The extra row distinguishes an exactly-full response from unsafe truncation.
   */
  async agentWakeBootstrap(
    identity: AuthenticatedAgentIdentity,
  ): Promise<AgentWakeBootstrapResponse> {
    return this.#transaction(
      async (client) => {
        const highWaterCursor = await this.#highWater(client, identity.currentUser.workspaceId);
        await this.hooks.afterAgentWakeBootstrapCursorRead?.();
        const result = await client.query<AgentWakeConversationRow>(
          `SELECT conversation.id, conversation.kind
             FROM conversations AS conversation
            WHERE conversation.workspace_id = $1
              AND ${conversationVisibilitySql("conversation", "$2")}
            ORDER BY conversation.id
            LIMIT $3`,
          [
            identity.currentUser.workspaceId,
            identity.currentUser.user.id,
            AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS + 1,
          ],
        );
        if (result.rows.length > AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS) {
          throw new ApiError(
            409,
            "CONFLICT",
            `Agent wake bootstrap exceeds ${AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS} visible conversations`,
          );
        }
        return agentWakeBootstrapResponseSchema.parse({
          agentUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          highWaterCursor,
          conversations: result.rows.map((conversation) => ({
            conversationId: conversation.id,
            kind: conversation.kind,
          })),
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
    return this.#transaction(
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
  ): Promise<ListConversationsResponse> {
    const anchorId = decodeConversationCursor(after);
    const client = await this.pool.connect();
    try {
      const page = await this.#conversationSummaries(
        client,
        identity,
        anchorId,
        limit,
        includeGroupDirectMessages,
      );
      return listConversationsResponseSchema.parse({
        conversations: page.conversations,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } finally {
      client.release();
    }
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
    return this.#transaction(async (client) => {
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
      const principal = await this.#requireActivePrincipal(client, identity);
      if (principal.kind === "human") {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, conversation),
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
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
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      }
      const audienceBefore = await this.#conversationAudience(client, conversation);
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
      const audienceAfter = await this.#conversationAudience(client, conversation);
      const event = await this.#insertEvent(client, identity, {
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
    const response = await this.#transaction(async (client) => {
      const create = async (): Promise<ConversationMutationResponse> => {
        const channelMode = input.channelMode ?? "chat";
        const principal =
          input.access === "humans"
            ? await this.#requireHumansOnlyCreator(client, identity)
            : await this.#requireActivePrincipal(client, identity);
        const storedAccess: Exclude<ChannelAccess, "humans"> =
          input.access === "humans" ? "members" : input.access;
        if (
          input.access === "humans" &&
          !(await this.#humansOnlyChannelsAvailable(client, identity.currentUser.workspaceId))
        ) {
          throw new ApiError(403, "FORBIDDEN", "Humans-only channels are unavailable");
        }
        if (channelMode === "announcement") {
          const announcementChannelsAvailable = await this.#announcementChannelsAvailable(
            client,
            identity.currentUser.workspaceId,
          );
          const allowed =
            announcementChannelsAvailable &&
            announcementCapability &&
            principal.kind === "human" &&
            principal.role === "owner";
          if (!allowed) {
            this.#auditAnnouncement({
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
        const audienceUserIds = await this.#conversationAudience(client, row);
        const event = await this.#insertEvent(client, identity, {
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
      this.#auditAnnouncement({
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
      const conversation = await this.#requireVisibleConversation(
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
    return this.#transaction(async (client) => {
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
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      }
      if (current?.left_at === null && current.role === "owner" && input.role === "member") {
        await this.#requireAnotherChannelOwner(client, conversationId, memberId);
      }
      const audienceBefore = await this.#conversationAudience(client, conversation);
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
      const audienceAfter = await this.#conversationAudience(client, conversation);
      const action = current === undefined || current.left_at !== null ? "added" : "updated";
      const event = await this.#insertEvent(client, identity, {
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
    return this.#transaction(async (client) => {
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
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      }
      if (current.role === "owner") {
        await this.#requireAnotherChannelOwner(client, conversationId, memberId);
      }
      const audienceBefore = await this.#conversationAudience(client, conversation);
      await client.query(
        `UPDATE conversation_memberships
            SET left_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE conversation_id = $1
            AND user_id = $2`,
        [conversationId, memberId],
      );
      const audienceAfter = await this.#conversationAudience(client, conversation);
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
        await this.#insertEvent(client, identity, {
          type: "task.updated",
          conversation,
          entityVersion: task.version,
          payload: { task },
          audienceUserIds: audienceAfter,
        });
      }
      const event = await this.#insertEvent(client, identity, {
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

  async archiveChannel(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationMutationResponse> {
    return this.#transaction(async (client) => {
      const locked = await client.query<ConversationRow>(
        `SELECT *
           FROM conversations AS conversation
          WHERE conversation.id = $1
            AND conversation.workspace_id = $2
            AND conversation.kind = 'channel'
            AND conversation.slug <> 'general'
            AND ${conversationVisibilitySql("conversation", "$3")}
          FOR UPDATE`,
        [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const current = locked.rows[0];
      if (current === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Channel not found or cannot be archived");
      }
      await this.hooks.afterArchiveConversationLocked?.();
      const principal = await this.#requireActivePrincipal(client, identity);
      if (principal.kind !== "human" || principal.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only the workspace owner can archive channels");
      }
      if (current.is_archived) {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, current),
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
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
      const audienceUserIds = await this.#conversationAudience(client, row);
      const event = await this.#insertEvent(client, identity, {
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
    return this.#transaction(async (client) => {
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
        syncCursor = await this.#highWater(client, identity.currentUser.workspaceId);
      } else {
        const participantIds = participants(row);
        const event = await this.#insertEvent(client, identity, {
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
    return this.#transaction(async (client) => {
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
          const event = await this.#insertEvent(client, identity, {
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
    return this.#transaction(
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
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async history(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    limit: number,
    includeThreadReplies = false,
  ): Promise<MessageHistoryResponse> {
    const client = await this.pool.connect();
    try {
      await this.#requireVisibleConversation(client, identity, conversationId, false);
      const beforeSequence = decodeHistoryCursor(before);
      const threadScope = includeThreadReplies ? "" : "AND thread_root_id IS NULL";
      const result = await client.query<MessageRow>(
        `SELECT *
           FROM messages
          WHERE conversation_id = $1
            ${threadScope}
            AND deleted_at IS NULL
            AND ($2::bigint IS NULL OR conversation_sequence < $2::bigint)
          ORDER BY conversation_sequence DESC, id DESC
          LIMIT $3`,
        [conversationId, beforeSequence, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0, limit);
      const oldest = selected.at(-1);
      const messages = selected.reverse().map(mapMessage);
      return messageHistoryResponseSchema.parse({
        messages,
        attachments: await this.#attachmentsForMessages(
          client,
          messages.map((message) => message.id),
        ),
        threadSummaries: includeThreadReplies
          ? []
          : await this.#threadSummaries(
              client,
              messages.map((message) => message.id),
            ),
        threadsSupported: !includeThreadReplies,
        nextCursor:
          hasMore && oldest !== undefined
            ? encodeHistoryCursor(oldest.conversation_sequence)
            : null,
      });
    } finally {
      client.release();
    }
  }

  async contextHistory(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    throughMessageId: string | undefined,
    limit: number,
  ): Promise<AgentContextHistoryResponse> {
    return this.#transaction(
      async (client) => {
        const conversation = await this.#requireVisibleConversation(
          client,
          identity,
          conversationId,
          false,
        );
        const beforeSequence = decodeHistoryCursor(before);
        let throughSequence: string | null = null;
        if (throughMessageId !== undefined) {
          const through = await client.query<{ conversation_sequence: string } & QueryResultRow>(
            `SELECT conversation_sequence
               FROM messages
              WHERE id = $1
                AND conversation_id = $2
                AND workspace_id = $3
                AND deleted_at IS NULL`,
            [throughMessageId, conversation.id, identity.currentUser.workspaceId],
          );
          throughSequence = through.rows[0]?.conversation_sequence ?? null;
          if (throughSequence === null) {
            // Missing, unauthorized, wrong-conversation, and retracted anchors share one response.
            throw new ApiError(404, "NOT_FOUND", "Message not found");
          }
        }

        const result = await client.query<AgentContextMessageRow>(
          `${agentContextMessageSql("$4")}
            WHERE message.conversation_id = $1
              AND message.deleted_at IS NULL
              AND ($2::bigint IS NULL OR message.conversation_sequence < $2::bigint)
              AND ($3::bigint IS NULL OR message.conversation_sequence <= $3::bigint)
            ORDER BY message.conversation_sequence DESC, message.id DESC
            LIMIT $5`,
          [
            conversation.id,
            beforeSequence,
            throughSequence,
            identity.currentUser.user.id,
            limit + 1,
          ],
        );
        const queryTruncated = result.rows.length > limit;
        const messages = result.rows.slice(0, limit).reverse().map(mapAgentContextMessage);
        const location = await this.#contextLocation(client, identity, conversation);
        // Trimming only ever drops from the front, so the newest message is the anchor for the
        // whole pass and everything derived from it is computed once here.
        const anchor = messages.at(-1);
        let canonicalThreadRoot: AgentContextMessage | null = null;
        if (
          location.kind === "channel" &&
          anchor?.threadRootId !== null &&
          anchor?.threadRootId !== undefined
        ) {
          canonicalThreadRoot = await this.#contextMessageById(
            client,
            identity.currentUser.user.id,
            conversation.id,
            anchor.threadRootId,
          );
        }

        const anchorMessageId = anchor?.id ?? null;
        const replyTarget =
          anchor === undefined
            ? null
            : location.kind === "direct_message"
              ? { kind: "flat" as const, conversationId: conversation.id }
              : {
                  kind: "thread" as const,
                  conversationId: conversation.id,
                  rootMessageId: anchor.threadRootId ?? anchor.id,
                };
        // The root is only carried separately once it has fallen out of the page. Membership can
        // only go selected -> dropped, so it is tracked incrementally instead of rebuilt per pass.
        const canonicalThreadRootId = canonicalThreadRoot?.id ?? null;
        let threadRootSelected =
          canonicalThreadRootId !== null &&
          messages.some((message) => message.id === canonicalThreadRootId);

        let droppedForSize = false;
        while (true) {
          const oldest = messages.at(0);
          const hasEarlier = anchor !== undefined && (queryTruncated || droppedForSize);
          const contextPack = {
            version: 1 as const,
            conversation: location,
            anchorMessageId,
            messages,
            threadRoot: threadRootSelected ? null : canonicalThreadRoot,
            replyTarget,
            readThroughMessageId: anchorMessageId,
            truncatedBefore: hasEarlier,
            nextCursor:
              hasEarlier && oldest !== undefined
                ? encodeHistoryCursor(oldest.conversationSequence)
                : null,
          };
          if (injectionSafeCompactJsonByteLength(contextPack) <= AGENT_CONTEXT_PACK_MAX_BYTES) {
            return agentContextHistoryResponseSchema.parse({ contextPack });
          }
          if (messages.length <= 1) {
            throw new Error("A single context message exceeded the context-pack byte cap");
          }
          const dropped = messages.shift();
          if (dropped !== undefined && dropped.id === canonicalThreadRootId) {
            threadRootSelected = false;
          }
          droppedForSize = true;
        }
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async thread(
    identity: AuthenticatedIdentity,
    threadRootId: string,
    before: string | undefined,
    limit: number,
  ): Promise<MessageThreadResponse> {
    const client = await this.pool.connect();
    try {
      const rootResult = await client.query<MessageRow>(
        `SELECT message.*
           FROM messages AS message
           JOIN conversations AS conversation ON conversation.id = message.conversation_id
          WHERE message.id = $1
            AND message.workspace_id = $2
            AND message.thread_root_id IS NULL
            AND (
              message.deleted_at IS NULL
              OR EXISTS (
                SELECT 1
                  FROM messages AS live_reply
                 WHERE live_reply.thread_root_id = message.id
                   AND live_reply.conversation_id = message.conversation_id
                   AND live_reply.deleted_at IS NULL
              )
            )
            AND conversation.workspace_id = $2
            AND ${conversationVisibilitySql("conversation", "$3")}`,
        [threadRootId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const root = rootResult.rows[0];
      if (root === undefined) {
        // Missing, unauthorized, and reply-less retracted roots deliberately share one response.
        throw new ApiError(404, "NOT_FOUND", "Thread not found");
      }

      const beforeSequence = decodeHistoryCursor(before);
      const result = await client.query<MessageRow>(
        `SELECT *
           FROM messages
          WHERE thread_root_id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL
            AND ($3::bigint IS NULL OR conversation_sequence < $3::bigint)
          ORDER BY conversation_sequence DESC, id DESC
          LIMIT $4`,
        [threadRootId, root.conversation_id, beforeSequence, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0, limit);
      const oldest = selected.at(-1);
      const replies = selected.reverse().map(mapMessage);
      const rootMessage = mapMessage(
        root.deleted_at === null ? root : { ...root, body: "Message retracted" },
      );
      return messageThreadResponseSchema.parse({
        root: rootMessage,
        replies,
        attachments: await this.#attachmentsForMessages(client, [
          rootMessage.id,
          ...replies.map((message) => message.id),
        ]),
        nextCursor:
          hasMore && oldest !== undefined
            ? encodeHistoryCursor(oldest.conversation_sequence)
            : null,
      });
    } finally {
      client.release();
    }
  }

  async messageById(
    identity: AuthenticatedIdentity,
    messageId: string,
  ): Promise<MessageByIdResponse> {
    const result = await this.pool.query<MessageRow>(
      `SELECT message.*
         FROM messages AS message
         JOIN conversations AS conversation ON conversation.id = message.conversation_id
        WHERE message.id = $1
          AND message.workspace_id = $2
          AND conversation.workspace_id = $2
          AND ${conversationVisibilitySql("conversation", "$3")}`,
      [messageId, identity.currentUser.workspaceId, identity.currentUser.user.id],
    );
    const message = result.rows[0];
    if (message === undefined || message.deleted_at !== null) {
      // Missing, unauthorized, and retracted targets deliberately share one response.
      throw new ApiError(404, "NOT_FOUND", "Message not found");
    }
    const attachments = await this.pool.query<AttachmentRow>(
      `SELECT attachment.*
         FROM attachments AS attachment
         JOIN messages AS parent ON parent.id = attachment.message_id
        WHERE attachment.message_id = $1
          AND attachment.status = 'ready'
          AND parent.deleted_at IS NULL
        ORDER BY attachment.created_at, attachment.id`,
      [messageId],
    );
    return messageByIdResponseSchema.parse({
      message: mapMessage(message),
      attachments: attachments.rows.map(mapAttachment),
    });
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
    return this.#transaction(async (client) => {
      await this.#requireVisibleConversation(client, identity, input.conversationId, true);
      await this.#requireActivePrincipal(client, identity);
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
          const expiresAt = new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_MS).toISOString();
          const inserted = await client.query<AttachmentRow>(
            `INSERT INTO attachments (
               id, workspace_id, conversation_id, uploaded_by, file_name, content_type,
               size_bytes, content_sha256, status, upload_expires_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
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
              expiresAt,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error("Attachment insert returned no row");
          return createFileUploadResponseSchema.parse({
            attachment: mapAttachment(row),
            expiresAt,
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
      const locked = await client.query<AttachmentRow>(
        `SELECT *
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
      if (
        row.upload_expires_at !== null &&
        new Date(iso(row.upload_expires_at)).getTime() <= Date.now()
      ) {
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
    return this.#transaction(async (client) => {
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
          const locked = await client.query<AttachmentRow>(
            `SELECT *
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
          if (
            row.upload_expires_at !== null &&
            new Date(iso(row.upload_expires_at)).getTime() <= Date.now()
          ) {
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
      await this.#requireVisibleConversation(client, identity, conversationId, false);
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
      const attachments = await this.#attachmentsForMessages(client, ids);
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

  async listMessageReactions(
    identity: AuthenticatedIdentity,
    messageIds: readonly string[],
  ): Promise<ListMessageReactionsResponse> {
    const ids = [...new Set(messageIds)];
    if (
      ids.length === 0 ||
      ids.length !== messageIds.length ||
      ids.length > MESSAGE_HISTORY_MAX_LIMIT
    ) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid reaction message IDs");
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
      const reactions = await client.query<ReactionRow>(
        `SELECT *
           FROM message_reactions
          WHERE message_id = ANY($1::uuid[])
          ORDER BY created_at, id`,
        [ids],
      );
      return listMessageReactionsResponseSchema.parse({
        reactions: reactions.rows.map(mapReaction),
      });
    } finally {
      client.release();
    }
  }

  async addReaction(
    identity: AuthenticatedIdentity,
    messageId: string,
    input: ReactionEmoji,
  ): Promise<AddReactionResponse> {
    const emoji = this.#reactionEmoji(input);
    return this.#transaction(async (client) => {
      const { conversation, message } = await this.#reactionTarget(client, identity, messageId);
      await this.#requireActivePrincipal(client, identity);
      const existing = await client.query<ReactionRow>(
        `SELECT *
           FROM message_reactions
          WHERE message_id = $1
            AND user_id = $2
            AND emoji = $3`,
        [messageId, identity.currentUser.user.id, emoji],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        return addReactionResponseSchema.parse({
          reaction: mapReaction(replay),
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      }

      const counts = await client.query<ReactionCountRow>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE user_id = $2)::text AS member_total
           FROM message_reactions
          WHERE message_id = $1`,
        [messageId, identity.currentUser.user.id],
      );
      const count = counts.rows[0];
      if (Number(count?.member_total ?? "0") >= REACTIONS_PER_MEMBER_PER_MESSAGE_MAX) {
        throw new ApiError(
          409,
          "CONFLICT",
          `A member can add at most ${REACTIONS_PER_MEMBER_PER_MESSAGE_MAX} reactions to one message`,
        );
      }
      if (Number(count?.total ?? "0") >= REACTIONS_PER_MESSAGE_MAX) {
        throw new ApiError(
          409,
          "CONFLICT",
          `A message can have at most ${REACTIONS_PER_MESSAGE_MAX} reactions`,
        );
      }

      const inserted = await client.query<ReactionRow>(
        `INSERT INTO message_reactions (id, workspace_id, message_id, user_id, emoji)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          randomUUID(),
          identity.currentUser.workspaceId,
          messageId,
          identity.currentUser.user.id,
          emoji,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Reaction insert returned no row");
      const reaction = mapReaction(row);
      const event = await this.#insertEvent(client, identity, {
        type: "reaction.added",
        conversation,
        conversationSequence: message.conversation_sequence,
        payload: { reaction },
        audienceUserIds: await this.#conversationAudience(client, conversation),
      });
      return addReactionResponseSchema.parse({ reaction, syncCursor: event.workspaceSequence });
    });
  }

  async removeReaction(
    identity: AuthenticatedIdentity,
    messageId: string,
    input: ReactionEmoji,
  ): Promise<RemoveReactionResponse> {
    const emoji = this.#reactionEmoji(input);
    return this.#transaction(async (client) => {
      const { conversation, message } = await this.#reactionTarget(client, identity, messageId);
      await this.#requireActivePrincipal(client, identity);
      const removed = await client.query<ReactionRow>(
        `DELETE FROM message_reactions
          WHERE message_id = $1
            AND user_id = $2
            AND emoji = $3
        RETURNING *`,
        [messageId, identity.currentUser.user.id, emoji],
      );
      const row = removed.rows[0];
      if (row === undefined) {
        return removeReactionResponseSchema.parse({
          removed: false,
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      }
      const event = await this.#insertEvent(client, identity, {
        type: "reaction.removed",
        conversation,
        conversationSequence: message.conversation_sequence,
        payload: { reaction: mapReaction(row) },
        audienceUserIds: await this.#conversationAudience(client, conversation),
      });
      return removeReactionResponseSchema.parse({
        removed: true,
        syncCursor: event.workspaceSequence,
      });
    });
  }

  async searchMessages(
    identity: AuthenticatedIdentity,
    query: string,
    after: string | undefined,
    limit: number,
    includeGroupDirectMessages = true,
  ): Promise<MessageSearchResponse> {
    const normalizedQuery = query.trim();
    const queryHash = searchQueryHash(normalizedQuery);
    const cursor = decodeSearchCursor(after, queryHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), MESSAGE_SEARCH_MAX_LIMIT);
    const client = await this.pool.connect();
    try {
      const result = await client.query<SearchMessageRow>(
        `WITH search_query AS (
           SELECT websearch_to_tsquery('simple', $3) AS value
         )
         SELECT message.*,
                ts_rank_cd(message.search_vector, search_query.value)::text AS search_rank
           FROM messages AS message
           JOIN conversations AS conversation ON conversation.id = message.conversation_id
          CROSS JOIN search_query
          WHERE message.workspace_id = $1
            AND ${conversationVisibilitySql("conversation", "$2")}
            AND ($8::boolean OR conversation.kind <> 'group_direct_message')
            AND message.deleted_at IS NULL
            AND message.search_vector @@ search_query.value
            AND (
              $4::real IS NULL
              OR (
                ts_rank_cd(message.search_vector, search_query.value),
                message.committed_workspace_sequence,
                message.id
              ) < ($4::real, $5::bigint, $6::uuid)
            )
          ORDER BY ts_rank_cd(message.search_vector, search_query.value) DESC,
                   message.committed_workspace_sequence DESC,
                   message.id DESC
          LIMIT $7`,
        [
          identity.currentUser.workspaceId,
          identity.currentUser.user.id,
          normalizedQuery,
          cursor?.rank ?? null,
          cursor?.workspaceSequence ?? null,
          cursor?.id ?? null,
          pageLimit + 1,
          includeGroupDirectMessages,
        ],
      );
      const hasMore = result.rows.length > pageLimit;
      const selected = result.rows.slice(0, pageLimit);
      const last = selected.at(-1);
      return messageSearchResponseSchema.parse({
        results: selected.map((row) => ({ message: mapMessage(row) })),
        nextCursor: hasMore && last !== undefined ? encodeSearchCursor(last, queryHash) : null,
      });
    } finally {
      client.release();
    }
  }

  async listConversationTasks(
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    after: string | undefined,
    limit: number,
    filters: TaskListFilters = {},
  ): Promise<TaskListResponse> {
    const filterHash = taskFilterHash(filters);
    const cursor = decodeTaskCursor(after, filterHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), TASK_PAGE_MAX_LIMIT);
    const client = await this.pool.connect();
    try {
      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
      );
      this.#requireTaskConversation(identity, conversation);
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
          WHERE task.conversation_id = $1
            AND (
              $2::timestamptz IS NULL
              OR (task.created_at, task.id) < ($2::timestamptz, $3::uuid)
            )
            ${taskListFilterSql("task", 4)}
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT $13`,
        [
          conversationId,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          ...taskListFilterParameters(identity, filters),
          pageLimit + 1,
        ],
      );
      const rows = result.rows.slice(0, pageLimit);
      const last = rows.at(-1);
      const nextCursor =
        result.rows.length > pageLimit && last !== undefined
          ? encodeTaskCursor(last, filterHash)
          : null;
      return taskListResponseSchema.parse({
        tasks: rows.map(mapTask),
        nextCursor,
        hasMore: nextCursor !== null,
      });
    } finally {
      client.release();
    }
  }

  async listMyTasks(
    identity: AuthenticatedTaskIdentity,
    after: string | undefined,
    limit: number,
    filters: TaskListFilters = {},
  ): Promise<TaskListResponse> {
    const filterHash = taskFilterHash(filters);
    const cursor = decodeTaskCursor(after, filterHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), TASK_PAGE_MAX_LIMIT);
    const client = await this.pool.connect();
    try {
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
           JOIN conversations AS conversation
             ON conversation.id = task.conversation_id
            AND conversation.workspace_id = task.workspace_id
          WHERE task.workspace_id = $1
            AND conversation.is_archived = false
            AND conversation.channel_mode IS DISTINCT FROM 'announcement'
            AND ${conversationVisibilitySql("conversation", "$2")}
            AND (
              task.assignee_id = $2
              OR (
                conversation.kind = 'direct_message'
                AND conversation.dm_user_low_id = $2
                AND conversation.dm_user_high_id = $2
              )
            )
            AND (
              $3::timestamptz IS NULL
              OR (task.created_at, task.id) < ($3::timestamptz, $4::uuid)
            )
            ${taskListFilterSql("task", 5)}
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT $14`,
        [
          identity.currentUser.workspaceId,
          identity.currentUser.user.id,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          ...taskListFilterParameters(identity, filters),
          pageLimit + 1,
        ],
      );
      const rows = result.rows.slice(0, pageLimit);
      const last = rows.at(-1);
      const nextCursor =
        result.rows.length > pageLimit && last !== undefined
          ? encodeTaskCursor(last, filterHash)
          : null;
      return taskListResponseSchema.parse({
        tasks: rows.map(mapTask),
        nextCursor,
        hasMore: nextCursor !== null,
      });
    } finally {
      client.release();
    }
  }

  async listChannelTasks(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    after: string | undefined,
    limit: number,
    filters: TaskListFilters = {},
  ): Promise<TaskRecordListResponse> {
    const filterHash = taskFilterHash(filters);
    const cursor = decodeTaskCursor(after, filterHash);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), TASK_PAGE_MAX_LIMIT);
    const client = await this.pool.connect();
    try {
      const conversation = await this.#requireVisibleChannelBySlug(
        client,
        identity,
        channelSlug,
        false,
      );
      this.#requireTaskConversation(identity, conversation);
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
          WHERE task.conversation_id = $1
            AND (
              $2::timestamptz IS NULL
              OR (task.created_at, task.id) < ($2::timestamptz, $3::uuid)
            )
            ${taskListFilterSql("task", 4)}
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT $13`,
        [
          conversation.id,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          ...taskListFilterParameters(identity, filters),
          pageLimit + 1,
        ],
      );
      const rows = result.rows.slice(0, pageLimit);
      const last = rows.at(-1);
      const nextCursor =
        result.rows.length > pageLimit && last !== undefined
          ? encodeTaskCursor(last, filterHash)
          : null;
      return taskRecordListResponseSchema.parse({
        tasks: rows.map(mapTaskRecord),
        nextCursor,
        hasMore: nextCursor !== null,
      });
    } finally {
      client.release();
    }
  }

  async getTask(identity: AuthenticatedTaskIdentity, taskId: string): Promise<TaskRecordResponse> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
           JOIN conversations AS conversation
             ON conversation.id = task.conversation_id
            AND conversation.workspace_id = task.workspace_id
          WHERE task.id = $1
            AND task.workspace_id = $2
            AND ${conversationVisibilitySql("conversation", "$3")}
            AND (
              conversation.kind = 'channel'
              OR (
                conversation.kind = 'direct_message'
                AND conversation.dm_user_low_id = $3
                AND conversation.dm_user_high_id = $3
              )
            )`,
        [taskId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Task not found");
      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        row.conversation_id,
        false,
      );
      this.#requireTaskConversation(identity, conversation);
      return taskRecordResponseSchema.parse({ task: mapTaskRecord(row) });
    } finally {
      client.release();
    }
  }

  async getChannelTaskByNumber(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    taskNumber: TaskNumber,
  ): Promise<TaskRecordResponse> {
    const client = await this.pool.connect();
    try {
      const conversation = await this.#requireVisibleChannelBySlug(
        client,
        identity,
        channelSlug,
        false,
      );
      this.#requireTaskConversation(identity, conversation);
      const result = await client.query<TaskRow>(
        `SELECT task.*
           FROM tasks AS task
          WHERE task.conversation_id = $1
            AND task.number = $2`,
        [conversation.id, taskNumber],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Task not found");
      return taskRecordResponseSchema.parse({ task: mapTaskRecord(row) });
    } finally {
      client.release();
    }
  }

  async createTask(
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    input: CreateTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskMutationResponse> {
    return this.#transaction(async (client) => {
      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        conversationId,
        true,
        true,
      );
      this.#requireTaskConversation(identity, conversation);
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: `/v1/conversations/${conversationId}/tasks`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: taskMutationResponseSchema,
        },
        async () => {
          await this.#validateTaskReferences(client, identity, conversation, input);
          const numberResult = await client.query<{ next: string } & QueryResultRow>(
            `UPDATE conversations
                SET last_task_number = last_task_number + 1,
                    updated_at = clock_timestamp()
              WHERE id = $1
              RETURNING last_task_number::text AS next`,
            [conversationId],
          );
          const number = numberResult.rows[0]?.next;
          if (number === undefined) throw new Error("Could not allocate task number");
          const rankResult = await client.query<{ next: string } & QueryResultRow>(
            `SELECT (coalesce(max(rank), 0) + $2::bigint)::text AS next
               FROM tasks
              WHERE conversation_id = $1
                AND status = 'todo'`,
            [conversationId, TASK_RANK_STEP.toString()],
          );
          const rank = rankResult.rows[0]?.next;
          if (rank === undefined) throw new Error("Could not allocate task rank");
          const inserted = await client.query<TaskRow>(
            `INSERT INTO tasks (
               id, workspace_id, conversation_id, number, title, description, status,
               priority, assignee_id, due_on, source_message_id, rank, created_by, updated_by
             )
             VALUES ($1, $2, $3, $4, $5, $6, 'todo', $7, $8, $9, $10, $11, $12, $12)
             RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              conversationId,
              number,
              input.title,
              input.description,
              input.priority,
              input.assigneeId,
              input.dueOn,
              input.sourceMessageId,
              rank,
              identity.currentUser.user.id,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error("Task insert returned no row");
          const task = mapTask(row);
          const event = await this.#insertEvent(client, identity, {
            type: "task.created",
            conversation,
            entityVersion: task.version,
            payload: { task },
            audienceUserIds: await this.#conversationAudience(client, conversation),
          });
          return taskMutationResponseSchema.parse({ task, syncCursor: event.workspaceSequence });
        },
      );
    });
  }

  async createChannelTask(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    input: CreateTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskRecordMutationResponse> {
    const conversationId = await this.#visibleChannelIdBySlug(identity, channelSlug, true);
    const created = await this.createTask(identity, conversationId, input, idempotencyKey);
    return taskRecordMutationResponseSchema.parse({
      task: { ...created.task, updatedBy: created.task.createdBy },
      syncCursor: created.syncCursor,
    });
  }

  async updateTask(
    identity: AuthenticatedTaskIdentity,
    taskId: string,
    input: UpdateTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskMutationResponse> {
    return this.#transaction(async (client) => {
      const { conversation, task: current } = await this.#requireTaskTarget(
        client,
        identity,
        taskId,
      );
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: `/v1/tasks/${taskId}`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 200,
          responseSchema: taskMutationResponseSchema,
        },
        async () => {
          if (current.version !== input.expectedVersion) {
            throw new ApiError(409, "CONFLICT", "The task changed on another device");
          }
          await this.#validateTaskReferences(client, identity, conversation, input);
          const updated = await client.query<TaskRow>(
            `UPDATE tasks
                SET title = $2,
                    description = $3,
                    priority = $4,
                    assignee_id = $5,
                    due_on = $6,
                    updated_by = $7,
                    version = version + 1,
                    updated_at = clock_timestamp()
              WHERE id = $1
              RETURNING *`,
            [
              taskId,
              input.title,
              input.description,
              input.priority,
              input.assigneeId,
              input.dueOn,
              identity.currentUser.user.id,
            ],
          );
          const row = updated.rows[0];
          if (row === undefined) throw new Error("Task update returned no row");
          const task = mapTask(row);
          const event = await this.#insertEvent(client, identity, {
            type: "task.updated",
            conversation,
            entityVersion: task.version,
            payload: { task },
            audienceUserIds: await this.#conversationAudience(client, conversation),
          });
          return taskMutationResponseSchema.parse({ task, syncCursor: event.workspaceSequence });
        },
      );
    });
  }

  async moveTask(
    identity: AuthenticatedTaskIdentity,
    taskId: string,
    input: MoveTaskRequest,
    idempotencyKey: string,
  ): Promise<TaskMutationResponse> {
    return this.#transaction(async (client) => {
      const { conversation, task: current } = await this.#requireTaskTarget(
        client,
        identity,
        taskId,
      );
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          route: `/v1/tasks/${taskId}/move`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 200,
          responseSchema: taskMutationResponseSchema,
        },
        async () => {
          if (current.version !== input.expectedVersion) {
            throw new ApiError(409, "CONFLICT", "The task changed on another device");
          }
          const orderedResult = await client.query<TaskRow>(
            `SELECT *
               FROM tasks
              WHERE conversation_id = $1
                AND status = $2
                AND id <> $3
              ORDER BY rank, id
              FOR UPDATE`,
            [conversation.id, input.status, taskId],
          );
          const ordered = orderedResult.rows;
          const insertionIndex =
            input.beforeTaskId === null
              ? ordered.length
              : ordered.findIndex((task) => task.id === input.beforeTaskId);
          if (insertionIndex < 0) {
            throw new ApiError(400, "BAD_REQUEST", "The Kanban destination is invalid");
          }
          const previousRank =
            insertionIndex === 0 ? 0n : BigInt(ordered[insertionIndex - 1]?.rank ?? "0");
          const nextRank =
            insertionIndex === ordered.length ? null : BigInt(ordered[insertionIndex]?.rank ?? "0");
          const canAppend =
            nextRank === null && previousRank <= POSTGRES_BIGINT_MAX - TASK_RANK_STEP;
          const hasGap = nextRank !== null && nextRank - previousRank > 1n;
          const changed: TaskRow[] = [];

          if (canAppend || hasGap) {
            const rank = canAppend
              ? previousRank + TASK_RANK_STEP
              : (previousRank + (nextRank ?? previousRank)) / 2n;
            const moved = await client.query<TaskRow>(
              `UPDATE tasks
                  SET status = $2,
                      rank = $3,
                      completed_at = CASE
                        WHEN $2 = 'done' THEN coalesce(completed_at, clock_timestamp())
                        ELSE NULL
                      END,
                      version = version + 1,
                      updated_by = $4,
                      updated_at = clock_timestamp()
                WHERE id = $1
                RETURNING *`,
              [taskId, input.status, rank.toString(), identity.currentUser.user.id],
            );
            const row = moved.rows[0];
            if (row === undefined) throw new Error("Task move returned no row");
            changed.push(row);
          } else {
            const ids = ordered.map((task) => task.id);
            ids.splice(insertionIndex, 0, taskId);
            for (const [index, id] of ids.entries()) {
              const rank = BigInt(index + 1) * TASK_RANK_STEP;
              const updated = await client.query<TaskRow>(
                `UPDATE tasks
                    SET status = CASE WHEN id = $1 THEN $2 ELSE status END,
                        rank = $3,
                        completed_at = CASE
                          WHEN id = $1 AND $2 = 'done' THEN coalesce(completed_at, clock_timestamp())
                          WHEN id = $1 THEN NULL
                          ELSE completed_at
                        END,
                        version = version + 1,
                        updated_by = $5,
                        updated_at = clock_timestamp()
                  WHERE id = $4
                  RETURNING *`,
                [taskId, input.status, rank.toString(), id, identity.currentUser.user.id],
              );
              const row = updated.rows[0];
              if (row === undefined) throw new Error("Task rebalance returned no row");
              changed.push(row);
            }
          }

          const audienceUserIds = await this.#conversationAudience(client, conversation);
          let syncCursor = "0";
          for (const row of changed) {
            const task = mapTask(row);
            const event = await this.#insertEvent(client, identity, {
              type: "task.updated",
              conversation,
              entityVersion: task.version,
              payload: { task },
              audienceUserIds,
            });
            syncCursor = event.workspaceSequence;
          }
          const moved = changed.find((row) => row.id === taskId);
          if (moved === undefined) throw new Error("Moved task was not returned");
          return taskMutationResponseSchema.parse({ task: mapTask(moved), syncCursor });
        },
      );
    });
  }

  async sendMessage(
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    input: SendConversationMessageRequest,
    correlationId?: string,
    announcementCapability = false,
  ): Promise<SendMessageResponse> {
    if (input.attachmentIds.length !== new Set(input.attachmentIds).size) {
      throw new ApiError(400, "BAD_REQUEST", "Attachment IDs must be unique");
    }
    if (input.attachmentIds.length > ATTACHMENTS_PER_MESSAGE_MAX) {
      throw new ApiError(400, "BAD_REQUEST", "A message may include at most 10 files");
    }
    const fingerprint = fingerprintMessage(conversationId, input);
    let bulletinAccepted = false;
    const response = await this.#transaction(async (client) => {
      // Global lock order for delivery and revocation is: per-message idempotency advisory lock,
      // conversation row, sender workspace-membership row, domain rows, then workspace sequence.
      // Archive and channel-membership mutations start with the same conversation row; identity
      // revocations lock the target workspace membership before the workspace sequence row.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${identity.currentUser.user.id}:${input.clientMessageId}`,
      ]);

      const locked = await client.query<ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE id = $1
            AND workspace_id = $2
          FOR UPDATE`,
        [conversationId, identity.currentUser.workspaceId],
      );
      const conversation = locked.rows[0];
      if (conversation === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Conversation not found");
      }
      await this.hooks.afterConversationLocked?.();

      // Run after any row-lock wait under READ COMMITTED. Request identity is only a routing hint;
      // authorization must reflect membership state committed while this transaction waited. The
      // share lock also prevents an active membership from being revoked before delivery commits.
      const workspaceAuthorization = await client.query<WorkspaceMembershipAuthorizationRow>(
        `SELECT membership.status = 'active'
                  AND actor.kind IN ('human', 'bot', 'agent') AS workspace_active,
                membership.role,
                actor.kind
           FROM workspace_memberships AS membership
           JOIN users AS actor ON actor.id = membership.user_id
          WHERE membership.workspace_id = $1
            AND membership.user_id = $2
          FOR SHARE OF membership`,
        [identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const principal = workspaceAuthorization.rows[0];
      if (!principal?.workspace_active) {
        throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
      }

      if (principal.kind === "bot") {
        if (identity.principalKind !== "bot") {
          throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
        }
        const credential = await client.query(
          `SELECT 1
             FROM bot_credentials AS credential
             JOIN channel_webhooks AS webhook
               ON webhook.current_credential_id = credential.id
              AND webhook.workspace_id = credential.workspace_id
              AND webhook.bot_user_id = credential.bot_user_id
            WHERE credential.id = $1
              AND credential.workspace_id = $2
              AND credential.bot_user_id = $3
              AND credential.revoked_at IS NULL
              AND credential.expires_at > clock_timestamp()
              AND 'messages:write' = ANY(credential.scopes)
              AND webhook.conversation_id = $4
              AND webhook.disabled_at IS NULL
            FOR SHARE OF credential, webhook`,
          [
            identity.credentialId,
            identity.currentUser.workspaceId,
            identity.currentUser.user.id,
            conversationId,
          ],
        );
        if (credential.rowCount !== 1) {
          throw new ApiError(401, "UNAUTHORIZED", "Webhook URL is invalid or disabled");
        }
      }

      const authorized = await client.query<MessageAuthorizationRow>(
        `SELECT conversation.is_archived,
                CASE
                  WHEN $4::text = 'bot' THEN
                    conversation.kind = 'channel'
                    AND NOT conversation.human_only
                    AND EXISTS (
                      SELECT 1
                        FROM bot_channel_grants AS grant_record
                       WHERE grant_record.conversation_id = conversation.id
                         AND grant_record.workspace_id = conversation.workspace_id
                         AND grant_record.bot_user_id = $2
                    )
                  WHEN conversation.kind = 'direct_message' THEN
                    conversation.dm_user_low_id = $2 OR conversation.dm_user_high_id = $2
                  WHEN conversation.kind = 'group_direct_message' THEN EXISTS (
                    SELECT 1
                      FROM conversation_memberships AS group_membership
                     WHERE group_membership.conversation_id = conversation.id
                       AND group_membership.user_id = $2
                       AND group_membership.left_at IS NULL
                  )
                  WHEN conversation.human_only THEN $4::text = 'human'
                  WHEN conversation.channel_access = 'workspace' THEN
                    $4::text = 'human' OR EXISTS (
                      SELECT 1
                        FROM conversation_memberships AS public_membership
                       WHERE public_membership.conversation_id = conversation.id
                         AND public_membership.user_id = $2
                         AND public_membership.left_at IS NULL
                    )
                  WHEN conversation.channel_access = 'members' THEN EXISTS (
                      SELECT 1
                        FROM conversation_memberships AS channel_membership
                     WHERE channel_membership.conversation_id = conversation.id
                         AND channel_membership.user_id = $2
                         AND channel_membership.left_at IS NULL
                    )
                  ELSE false
                END AS conversation_visible
           FROM conversations AS conversation
          WHERE conversation.id = $1
            AND conversation.workspace_id = $3`,
        [
          conversationId,
          identity.currentUser.user.id,
          identity.currentUser.workspaceId,
          principal.kind,
        ],
      );
      const access = authorized.rows[0];
      if (access === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Conversation not found");
      }
      if (!access.conversation_visible) {
        throw new ApiError(404, "NOT_FOUND", "Conversation not found");
      }
      await this.hooks.afterMessageAuthorizationLocked?.();

      // Authorization precedes reconciliation: archive does not hide a committed response from
      // an authorized sender, while revoked membership still prevents replay.
      const existing = await client.query<MessageRow>(
        `SELECT *
           FROM messages
          WHERE author_id = $1 AND client_message_id = $2`,
        [identity.currentUser.user.id, input.clientMessageId],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (replay.deleted_at !== null) {
          // Retraction wins over delivery idempotency: a retry must not rehydrate retained content.
          throw new ApiError(404, "NOT_FOUND", "Message not found");
        }
        if (!sameBuffer(replay.request_fingerprint, fingerprint)) {
          throw new ApiError(
            409,
            "CONFLICT",
            "The client message ID was already used for different content",
          );
        }
        return sendMessageResponseSchema.parse({
          message: mapMessage(replay),
          attachments: await this.#attachmentsForMessages(client, [replay.id]),
          syncCursor: replay.committed_workspace_sequence,
        });
      }
      if (access.is_archived) {
        throw new ApiError(404, "NOT_FOUND", "Conversation not found");
      }
      if (conversation.channel_mode === "announcement" && input.threadRootId === null) {
        if (principal.kind !== "human" || principal.role !== "owner") {
          this.#auditAnnouncement({
            operation: "bulletin.publish",
            outcome: "rejected",
            actorUserId: identity.currentUser.user.id,
            workspaceId: identity.currentUser.workspaceId,
            conversationId,
            correlationId,
            reason: "not_authorized",
          });
          throw new ApiError(403, "FORBIDDEN", "Only workspace owners can post bulletins");
        }
        if (!announcementCapability) {
          this.#auditAnnouncement({
            operation: "bulletin.publish",
            outcome: "rejected",
            actorUserId: identity.currentUser.user.id,
            workspaceId: identity.currentUser.workspaceId,
            conversationId,
            correlationId,
            reason: "capability_required",
          });
          throw new ApiError(403, "FORBIDDEN", "A compatible client is required to post bulletins");
        }
      }
      if (input.threadRootId !== null) {
        const root = await client.query<{ id: string } & QueryResultRow>(
          `SELECT id
             FROM messages
            WHERE id = $1
              AND conversation_id = $2
              AND thread_root_id IS NULL`,
          [input.threadRootId, conversationId],
        );
        if (root.rows[0] === undefined) {
          throw new ApiError(404, "NOT_FOUND", "Thread root not found");
        }
      }
      await this.#validateMentions(client, identity, conversation, input);
      const attachments = await this.#claimAttachments(
        client,
        identity,
        conversationId,
        input.attachmentIds,
      );

      const conversationSequenceResult = await client.query<{ next: string } & QueryResultRow>(
        `UPDATE conversations
            SET last_message_sequence = last_message_sequence + 1,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING last_message_sequence::text AS next`,
        [conversationId],
      );
      const conversationSequence = conversationSequenceResult.rows[0]?.next;
      if (conversationSequence === undefined)
        throw new Error("Could not allocate message sequence");

      // Keep workspace sequence allocation last among contended authorization/domain locks.
      const workspaceSequence = await this.#nextWorkspaceSequence(
        client,
        identity.currentUser.workspaceId,
      );
      const messageId = randomUUID();
      const inserted = await client.query<MessageRow>(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, conversation_sequence,
           committed_workspace_sequence, client_message_id, request_fingerprint,
           author_id, thread_root_id, body, body_format
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          messageId,
          identity.currentUser.workspaceId,
          conversationId,
          conversationSequence,
          workspaceSequence,
          input.clientMessageId,
          fingerprint,
          identity.currentUser.user.id,
          input.threadRootId,
          input.body,
          input.bodyFormat,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Message insert returned no row");
      for (const mentionedUserId of new Set(input.mentionedUserIds)) {
        await client.query(
          `INSERT INTO message_mentions (message_id, mentioned_user_id) VALUES ($1, $2)`,
          [messageId, mentionedUserId],
        );
      }
      if (attachments.length > 0) {
        await client.query(
          `UPDATE attachments
              SET message_id = $1,
                  updated_at = clock_timestamp()
            WHERE id = ANY($2::uuid[])
              AND workspace_id = $3
              AND conversation_id = $4
              AND uploaded_by = $5
              AND status = 'ready'
              AND message_id IS NULL`,
          [
            messageId,
            attachments.map((attachment) => attachment.id),
            identity.currentUser.workspaceId,
            conversationId,
            identity.currentUser.user.id,
          ],
        );
      }
      const audienceUserIds = await this.#conversationAudience(client, conversation);
      const event = await this.#insertEventWithSequence(client, identity, workspaceSequence, {
        type: "message.created",
        conversation,
        conversationSequence,
        payload: {
          message: mapMessage(row),
          mentionedUserIds: [...new Set(input.mentionedUserIds)],
        },
        audienceUserIds,
      });
      if (input.threadRootId !== null) {
        // The conversation lock serializes message commits. This query therefore freezes the root
        // author and every prior replier at this reply's commit boundary. Joining the event's
        // already-authorized audience excludes removed members, while the final predicate keeps
        // the reply author from notifying themselves. Deletion state is intentionally ignored
        // until message deletion gains its own participation contract.
        await client.query(
          `INSERT INTO sync_event_notification_reasons
             (event_id, workspace_id, user_id, reason)
           SELECT audience.event_id,
                  audience.workspace_id,
                  audience.user_id,
                  'participated_thread_reply'
             FROM sync_event_audiences AS audience
            WHERE audience.event_id = $1
              AND audience.workspace_id = $2
              AND audience.user_id <> $3
              AND EXISTS (
                SELECT 1
                  FROM messages AS participant_message
                 WHERE participant_message.conversation_id = $4
                   AND (
                     participant_message.id = $5
                     OR participant_message.thread_root_id = $5
                   )
                   AND participant_message.author_id = audience.user_id
              )`,
          [
            event.id,
            identity.currentUser.workspaceId,
            identity.currentUser.user.id,
            conversationId,
            input.threadRootId,
          ],
        );
      }
      const response = sendMessageResponseSchema.parse({
        message: mapMessage(row),
        attachments: attachments.map((attachment) => ({
          ...attachment,
          messageId,
        })),
        syncCursor: event.workspaceSequence,
      });
      await client.query(
        `INSERT INTO api_idempotency_records
           (actor_user_id, route, idempotency_key, request_fingerprint, response_status, response_body)
         VALUES ($1, $2, $3, $4, 201, $5::jsonb)`,
        [
          identity.currentUser.user.id,
          `/v1/conversations/${conversationId}/messages`,
          input.clientMessageId,
          fingerprint,
          JSON.stringify(response),
        ],
      );
      if (conversation.channel_mode === "announcement" && input.threadRootId === null) {
        bulletinAccepted = true;
      }
      return response;
    });
    if (bulletinAccepted) {
      this.#auditAnnouncement({
        operation: "bulletin.publish",
        outcome: "accepted",
        actorUserId: identity.currentUser.user.id,
        workspaceId: identity.currentUser.workspaceId,
        conversationId,
        correlationId,
      });
    }
    return response;
  }

  async retractMessage(
    identity: AuthenticatedIdentity,
    messageId: string,
  ): Promise<RetractMessageResponse> {
    return this.#transaction(async (client) => {
      const located = await client.query<{ conversation_id: string } & QueryResultRow>(
        `SELECT conversation_id
           FROM messages
          WHERE id = $1
            AND workspace_id = $2`,
        [messageId, identity.currentUser.workspaceId],
      );
      const conversationId = located.rows[0]?.conversation_id;
      if (conversationId === undefined) throw new ApiError(404, "NOT_FOUND", "Message not found");

      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
        true,
      );
      await this.#requireActivePrincipal(client, identity);

      const locked = await client.query<MessageRow & { retract_window_elapsed: boolean }>(
        `SELECT message.*,
                clock_timestamp() > (message.created_at + interval '5 minutes')
                  AS retract_window_elapsed
           FROM messages AS message
          WHERE message.id = $1
            AND message.conversation_id = $2
          FOR UPDATE OF message`,
        [messageId, conversationId],
      );
      const message = locked.rows[0];
      if (message === undefined) throw new ApiError(404, "NOT_FOUND", "Message not found");
      if (message.author_id !== identity.currentUser.user.id) {
        throw new ApiError(403, "FORBIDDEN", "Only the author can retract this message");
      }
      if (message.deleted_at !== null) {
        return retractMessageResponseSchema.parse({
          message: mapMessage(message),
          syncCursor: message.committed_workspace_sequence,
        });
      }
      if (message.retract_window_elapsed) {
        throw new ApiError(409, "CONFLICT", "This message can no longer be retracted");
      }

      const workspaceSequence = await this.#nextWorkspaceSequence(
        client,
        identity.currentUser.workspaceId,
      );
      const updated = await client.query<MessageRow>(
        `UPDATE messages
            SET deleted_at = clock_timestamp(),
                updated_at = clock_timestamp(),
                version = version + 1,
                committed_workspace_sequence = $3
          WHERE id = $1
            AND conversation_id = $2
            AND deleted_at IS NULL
            AND edited_at IS NULL
            AND author_id = $4
            AND clock_timestamp() <= created_at + interval '5 minutes'
          RETURNING *`,
        [messageId, conversationId, workspaceSequence, identity.currentUser.user.id],
      );
      const retracted = updated.rows[0];
      if (retracted === undefined || retracted.deleted_at === null) {
        throw new ApiError(409, "CONFLICT", "This message can no longer be retracted");
      }
      const tombstone = mapMessage(retracted);
      if (tombstone.deletedAt === null) {
        throw new Error("Retract committed without a deletedAt tombstone");
      }
      const event = await this.#insertEventWithSequence(client, identity, workspaceSequence, {
        type: "message.retracted",
        conversation,
        conversationSequence: retracted.conversation_sequence,
        entityVersion: tombstone.version,
        payload: {
          messageId: tombstone.id,
          deletedAt: tombstone.deletedAt,
        },
        audienceUserIds: await this.#conversationAudience(client, conversation),
      });
      return retractMessageResponseSchema.parse({
        message: tombstone,
        syncCursor: event.workspaceSequence,
      });
    });
  }

  async advanceReadCursor(
    identity: AuthenticatedIdentity,
    conversationId: string,
    messageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    return this.#transaction(async (client) => {
      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
      );
      const target = await client.query<MessageRow>(
        `SELECT *
           FROM messages
          WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId],
      );
      const message = target.rows[0];
      if (message === undefined) throw new ApiError(404, "NOT_FOUND", "Message not found");
      const updated = await client.query<ReadCursorRow>(
        `INSERT INTO conversation_read_cursors (
           conversation_id, workspace_id, user_id, last_read_message_id,
           last_read_conversation_sequence, last_read_at
         )
         VALUES ($1, $2, $3, $4, $5, clock_timestamp())
         ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET last_read_message_id = EXCLUDED.last_read_message_id,
               last_read_conversation_sequence = EXCLUDED.last_read_conversation_sequence,
               last_read_at = EXCLUDED.last_read_at,
               updated_at = clock_timestamp()
         WHERE conversation_read_cursors.last_read_conversation_sequence
               < EXCLUDED.last_read_conversation_sequence
         RETURNING *`,
        [
          conversationId,
          identity.currentUser.workspaceId,
          identity.currentUser.user.id,
          messageId,
          message.conversation_sequence,
        ],
      );
      let cursor = updated.rows[0];
      let syncCursor: string;
      if (cursor !== undefined) {
        // Allocate the read event's sequence before counting. Every message allocates its sequence
        // under the same workspace-row lock, so messages ordered before this event are visible to
        // these counts and messages ordered after it will be projected by their own events.
        const workspaceSequence = await this.#nextWorkspaceSequence(
          client,
          identity.currentUser.workspaceId,
        );
        const counts = await this.#unreadCounts(
          client,
          identity.currentUser.user.id,
          conversationId,
        );
        const event = await this.#insertEventWithSequence(client, identity, workspaceSequence, {
          type: "read_cursor.updated",
          conversation,
          payload: { readCursor: mapReadCursor(cursor), ...counts },
          audienceUserIds: [identity.currentUser.user.id],
        });
        syncCursor = event.workspaceSequence;
      } else {
        const current = await client.query<ReadCursorRow>(
          `SELECT *
             FROM conversation_read_cursors
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, identity.currentUser.user.id],
        );
        cursor = current.rows[0];
        syncCursor = await this.#highWater(client, identity.currentUser.workspaceId);
      }
      if (cursor === undefined) throw new Error("Read cursor was not persisted");
      return advanceReadCursorResponseSchema.parse({
        readCursor: mapReadCursor(cursor),
        syncCursor,
      });
    });
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
      const highWaterCursor = await this.#highWater(client, principal.workspaceId);
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
    } = capabilities;
    const deviceSessionId = identity.sessionId ?? null;
    const agentTokenId = identity.agentTokenId ?? null;
    if ((deviceSessionId === null) === (agentTokenId === null)) {
      throw new Error("Realtime tickets require exactly one authenticated credential");
    }
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest();
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_MS);
    await this.pool.query(
      `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, agent_token_id, token_hash, expires_at,
          reaction_events, read_state_events, task_events, announcement_channels,
          participated_thread_notifications, message_retract_events, member_profiles,
          ephemeral_activity, group_direct_messages, humans_only_channels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
      ],
    );
    return realtimeTicketResponseSchema.parse({
      ticket: token,
      expiresAt: expiresAt.toISOString(),
    });
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

  async deleteExpiredState(): Promise<void> {
    await this.pool.query(
      `DELETE FROM sync_events
        WHERE created_at < clock_timestamp() - make_interval(days => $1)`,
      [SYNC_RETENTION_DAYS],
    );
    await this.pool.query(
      `DELETE FROM realtime_tickets
        WHERE expires_at < clock_timestamp() - interval '1 hour'`,
    );
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

  async #contextLocation(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<AgentContextLocation> {
    if (conversation.kind === "channel") {
      if (conversation.slug === null) throw new Error("Channel is missing its canonical slug");
      return {
        id: conversation.id,
        kind: "channel",
        slug: conversation.slug,
        selector: `#${conversation.slug}`,
      };
    }

    const actorId = identity.currentUser.user.id;
    const low = conversation.dm_user_low_id;
    const high = conversation.dm_user_high_id;
    if (low === null || high === null) {
      throw new Error("Direct conversation is missing a participant");
    }
    const peerId = low === actorId ? high : high === actorId ? low : null;
    if (peerId === null) throw new Error("Visible direct conversation does not include its actor");
    const result = await client.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [peerId]);
    const peer = result.rows[0];
    if (peer === undefined) throw new Error("Direct-conversation peer does not exist");
    const author = mapAgentContextAuthor(peer);
    return {
      id: conversation.id,
      kind: "direct_message",
      selector: `@${author.username}`,
      peer: author,
      self: peerId === actorId,
    };
  }

  async #contextMessageById(
    client: PoolClient,
    actorId: string,
    conversationId: string,
    messageId: string,
  ): Promise<AgentContextMessage | null> {
    const result = await client.query<AgentContextMessageRow>(
      `${agentContextMessageSql("$3")}
        WHERE message.id = $1
          AND message.conversation_id = $2
          AND message.deleted_at IS NULL`,
      [messageId, conversationId, actorId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAgentContextMessage(row);
  }

  /**
   * One page of the member's visible conversations.
   *
   * The listing is keyset-paginated over the existing deterministic ordering
   * `(kind, lower(coalesce(name, '')), created_at, id)`. Because that tuple ends in the primary
   * key it is a total order, so the row-value comparison against the anchor row walks every
   * conversation exactly once with no duplicates and no skips. `LIMIT pageLimit + 1` is what
   * detects a further page, and bounding the page is also what bounds the per-conversation summary
   * queries below.
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
  ): Promise<ConversationPage> {
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_PAGE_MAX_LIMIT);
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations AS conversation
        WHERE conversation.workspace_id = $1
          AND ${conversationVisibilitySql("conversation", "$2")}
          AND ($4::boolean OR conversation.kind <> 'group_direct_message')
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
      ],
    );
    const rows = result.rows.slice(0, pageLimit);
    const summaries: ConversationSummary[] = [];
    for (const row of rows) {
      summaries.push(await this.#conversationSummary(client, identity, row));
    }
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
    const latestResult = await client.query<MessageRow>(
      `SELECT * FROM messages
        WHERE conversation_id = $1
          AND deleted_at IS NULL
        ORDER BY conversation_sequence DESC
        LIMIT 1`,
      [conversation.id],
    );
    const cursorResult = await client.query<ReadCursorRow>(
      `SELECT * FROM conversation_read_cursors
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, identity.currentUser.user.id],
    );
    const counts = await this.#unreadCounts(client, identity.currentUser.user.id, conversation.id);
    return conversationSummarySchema.parse({
      conversation: mapConversation(conversation),
      participantIds: await this.#conversationParticipants(client, conversation),
      membershipRole: await this.#membershipRole(client, identity, conversation),
      lastMessage: latestResult.rows[0] === undefined ? null : mapMessage(latestResult.rows[0]),
      ...counts,
      readCursor: cursorResult.rows[0] === undefined ? null : mapReadCursor(cursorResult.rows[0]),
    });
  }

  async #threadSummaries(
    client: PoolClient,
    threadRootIds: readonly string[],
  ): Promise<MessageThreadSummary[]> {
    if (threadRootIds.length === 0) return [];
    const result = await client.query<ThreadSummaryRow>(
      `SELECT latest.*, root.id AS summarized_thread_root_id, totals.reply_count
         FROM unnest($1::uuid[]) WITH ORDINALITY AS root(id, position)
        CROSS JOIN LATERAL (
          SELECT count(*)::text AS reply_count
            FROM messages AS reply
           WHERE reply.thread_root_id = root.id
             AND reply.deleted_at IS NULL
        ) AS totals
        CROSS JOIN LATERAL (
          SELECT reply.*
            FROM messages AS reply
           WHERE reply.thread_root_id = root.id
             AND reply.deleted_at IS NULL
           ORDER BY reply.conversation_sequence DESC, reply.id DESC
           LIMIT 1
        ) AS latest
        ORDER BY root.position`,
      [threadRootIds],
    );
    return result.rows.map((row) => ({
      threadRootId: row.summarized_thread_root_id,
      replyCount: Number(row.reply_count),
      latestReply: mapMessage(row),
    }));
  }

  async #unreadCounts(
    client: PoolClient,
    userId: string,
    conversationId: string,
  ): Promise<UnreadCounts> {
    const unreadResult = await client.query<{ count: string } & QueryResultRow>(
      `SELECT count(*)::text AS count
         FROM messages AS message
         LEFT JOIN conversation_read_cursors AS cursor
           ON cursor.conversation_id = message.conversation_id
          AND cursor.user_id = $2
        WHERE message.conversation_id = $1
          AND message.author_id <> $2
          AND message.deleted_at IS NULL
          AND message.conversation_sequence
              > coalesce(cursor.last_read_conversation_sequence, 0)`,
      [conversationId, userId],
    );
    const mentionResult = await client.query<{ count: string } & QueryResultRow>(
      `SELECT count(*)::text AS count
         FROM messages AS message
         JOIN message_mentions AS mention ON mention.message_id = message.id
         LEFT JOIN conversation_read_cursors AS cursor
           ON cursor.conversation_id = message.conversation_id
          AND cursor.user_id = $2
        WHERE message.conversation_id = $1
          AND mention.mentioned_user_id = $2
          AND message.author_id <> $2
          AND message.deleted_at IS NULL
          AND message.conversation_sequence
              > coalesce(cursor.last_read_conversation_sequence, 0)`,
      [conversationId, userId],
    );
    return {
      unreadCount: Number(unreadResult.rows[0]?.count ?? "0"),
      mentionCount: Number(mentionResult.rows[0]?.count ?? "0"),
    };
  }

  #requireTaskConversation(
    identity: AuthenticatedTaskIdentity,
    conversation: ConversationRow,
  ): void {
    if (conversation.kind === "channel" && conversation.channel_mode === "announcement") {
      throw new ApiError(404, "NOT_FOUND", "Tasks are not available in this channel");
    }
    if (conversation.kind === "channel") return;
    if (
      identity.principalKind === "human" &&
      conversation.dm_user_low_id === identity.currentUser.user.id &&
      conversation.dm_user_high_id === identity.currentUser.user.id
    ) {
      return;
    }
    throw new ApiError(404, "NOT_FOUND", "Tasks are available in channels and self messages");
  }

  async #requireTaskTarget(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    taskId: string,
  ): Promise<{ readonly conversation: ConversationRow; readonly task: TaskRow }> {
    const located = await client.query<{ conversation_id: string } & QueryResultRow>(
      `SELECT task.conversation_id
         FROM tasks AS task
         JOIN conversations AS conversation
           ON conversation.id = task.conversation_id
          AND conversation.workspace_id = task.workspace_id
        WHERE task.id = $1
          AND task.workspace_id = $2
          AND ${conversationVisibilitySql("conversation", "$3")}`,
      [taskId, identity.currentUser.workspaceId, identity.currentUser.user.id],
    );
    const conversationId = located.rows[0]?.conversation_id;
    if (conversationId === undefined) throw new ApiError(404, "NOT_FOUND", "Task not found");
    const conversation = await this.#requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    this.#requireTaskConversation(identity, conversation);
    const taskResult = await client.query<TaskRow>(
      `SELECT * FROM tasks WHERE id = $1 AND conversation_id = $2 FOR UPDATE`,
      [taskId, conversation.id],
    );
    const task = taskResult.rows[0];
    if (task === undefined) throw new ApiError(404, "NOT_FOUND", "Task not found");
    return { conversation, task };
  }

  async #validateTaskReferences(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    conversation: ConversationRow,
    input: {
      readonly assigneeId: string | null;
      readonly sourceMessageId?: string | null;
    },
  ): Promise<void> {
    if (input.assigneeId !== null) {
      const audience = new Set(await this.#conversationAudience(client, conversation));
      if (!audience.has(input.assigneeId)) {
        throw new ApiError(400, "BAD_REQUEST", "The assignee cannot access this task");
      }
    }
    if (input.sourceMessageId !== undefined && input.sourceMessageId !== null) {
      const source = await client.query(
        `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL`,
        [input.sourceMessageId, conversation.id],
      );
      if (source.rowCount !== 1) {
        throw new ApiError(400, "BAD_REQUEST", "The source message is unavailable");
      }
    }
    if (
      conversation.kind === "direct_message" &&
      input.assigneeId !== null &&
      input.assigneeId !== identity.currentUser.user.id
    ) {
      throw new ApiError(400, "BAD_REQUEST", "Personal tasks can only be assigned to you");
    }
  }

  async #requireVisibleConversation(
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

  async #requireActivePrincipal(
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

  #auditAnnouncement(record: AnnouncementAuditRecord): void {
    try {
      this.hooks.onAnnouncementAudit?.(record);
    } catch {
      // Audit delivery must not turn an otherwise valid or intentionally rejected request into a
      // different API outcome. The production hook is synchronous structured logging.
    }
  }

  async #visibleChannelIdBySlug(
    identity: AuthenticatedTaskIdentity,
    channelSlug: string,
    requireWritable: boolean,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      return (
        await this.#requireVisibleChannelBySlug(client, identity, channelSlug, requireWritable)
      ).id;
    } finally {
      client.release();
    }
  }

  async #requireVisibleChannelBySlug(
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

  async #requireManagedChannel(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationRow> {
    // Membership mutations take message delivery's canonical conversation row lock before
    // inspecting or changing conversation_memberships.
    const conversation = await this.#requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    await this.#requireActivePrincipal(client, identity);
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

  async #conversationAudience(
    client: PoolClient,
    conversation: ConversationRow,
  ): Promise<string[]> {
    if (conversation.kind === "direct_message") return participants(conversation);
    if (conversation.kind === "group_direct_message") {
      const result = await client.query<{ user_id: string } & QueryResultRow>(
        `SELECT membership.user_id
           FROM conversation_memberships AS membership
           JOIN workspace_memberships AS workspace_membership
             ON workspace_membership.workspace_id = membership.workspace_id
            AND workspace_membership.user_id = membership.user_id
           JOIN users AS user_account ON user_account.id = membership.user_id
          WHERE membership.conversation_id = $1
            AND membership.left_at IS NULL
            AND workspace_membership.status = 'active'
            AND user_account.kind IN ('human', 'agent')
          ORDER BY membership.user_id`,
        [conversation.id],
      );
      return result.rows.map((row) => row.user_id);
    }
    if (conversation.human_only) {
      const result = await client.query<{ user_id: string } & QueryResultRow>(
        `SELECT membership.user_id
           FROM workspace_memberships AS membership
           JOIN users AS user_account ON user_account.id = membership.user_id
          WHERE membership.workspace_id = $1
            AND membership.status = 'active'
            AND user_account.kind = 'human'
          ORDER BY membership.user_id`,
        [conversation.workspace_id],
      );
      return result.rows.map((row) => row.user_id);
    }
    if (conversation.channel_access === "workspace") {
      const result = await client.query<{ user_id: string } & QueryResultRow>(
        `SELECT membership.user_id
           FROM workspace_memberships AS membership
           JOIN users AS user_account ON user_account.id = membership.user_id
          WHERE membership.workspace_id = $1
            AND membership.status = 'active'
            AND (
              user_account.kind = 'human'
              OR (
                user_account.kind = 'agent'
                AND EXISTS (
                  SELECT 1
                    FROM conversation_memberships AS public_membership
                   WHERE public_membership.conversation_id = $2
                     AND public_membership.user_id = membership.user_id
                     AND public_membership.left_at IS NULL
                )
              )
              OR EXISTS (
                SELECT 1
                  FROM bot_channel_grants AS grant_record
                 WHERE grant_record.conversation_id = $2
                   AND grant_record.bot_user_id = membership.user_id
              )
            )
          ORDER BY membership.user_id`,
        [conversation.workspace_id, conversation.id],
      );
      return result.rows.map((row) => row.user_id);
    }
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `SELECT audience.user_id
         FROM (
           SELECT membership.user_id
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
           UNION
           SELECT grant_record.bot_user_id AS user_id
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
        ORDER BY audience.user_id`,
      [conversation.id, conversation.human_only],
    );
    return result.rows.map((row) => row.user_id);
  }

  async #conversationParticipants(
    client: PoolClient,
    conversation: ConversationRow,
  ): Promise<string[]> {
    if (conversation.kind !== "group_direct_message") {
      return this.#conversationAudience(client, conversation);
    }
    // Group membership is fixed history. Disabled members stop receiving events and cannot
    // authenticate, but remain participants in summaries so the group never collapses into a 1:1.
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `SELECT membership.user_id
         FROM conversation_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.conversation_id = $1
          AND membership.left_at IS NULL
          AND user_account.kind IN ('human', 'agent')
        ORDER BY membership.user_id`,
      [conversation.id],
    );
    return result.rows.map((row) => row.user_id);
  }

  #attachmentStore(): AttachmentStore {
    const store = this.hooks.attachmentStore;
    if (store === undefined) {
      throw new ApiError(400, "BAD_REQUEST", "Attachments are not available yet");
    }
    return store;
  }

  async #attachmentsForMessages(
    client: PoolClient,
    messageIds: readonly string[],
  ): Promise<Attachment[]> {
    if (messageIds.length === 0) return [];
    const result = await client.query<AttachmentRow>(
      `SELECT attachment.*
         FROM attachments AS attachment
         JOIN messages AS message ON message.id = attachment.message_id
        WHERE attachment.message_id = ANY($1::uuid[])
          AND attachment.status = 'ready'
          AND message.deleted_at IS NULL
        ORDER BY attachment.created_at, attachment.id`,
      [messageIds],
    );
    return result.rows.map(mapAttachment);
  }

  async #claimAttachments(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    attachmentIds: readonly string[],
  ): Promise<Attachment[]> {
    if (attachmentIds.length === 0) return [];
    const locked = await client.query<AttachmentRow>(
      `SELECT *
         FROM attachments
        WHERE id = ANY($1::uuid[])
          AND workspace_id = $2
        FOR UPDATE`,
      [attachmentIds, identity.currentUser.workspaceId],
    );
    if (locked.rows.length !== attachmentIds.length) {
      throw new ApiError(400, "BAD_REQUEST", "One or more attachments were not found");
    }
    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    const claimed: Attachment[] = [];
    for (const attachmentId of attachmentIds) {
      const row = byId.get(attachmentId);
      if (
        row === undefined ||
        row.conversation_id !== conversationId ||
        row.uploaded_by !== identity.currentUser.user.id ||
        row.status !== "ready" ||
        row.message_id !== null
      ) {
        throw new ApiError(400, "BAD_REQUEST", "One or more attachments cannot be attached");
      }
      claimed.push(mapAttachment(row));
    }
    return claimed;
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

  #reactionEmoji(input: string): ReactionEmoji {
    const parsed = reactionEmojiSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid reaction emoji");
    return parsed.data;
  }

  async #reactionTarget(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    messageId: string,
  ): Promise<{ readonly conversation: ConversationRow; readonly message: MessageRow }> {
    const target = await client.query<{ conversation_id: string } & QueryResultRow>(
      `SELECT conversation_id
         FROM messages
        WHERE id = $1
          AND workspace_id = $2`,
      [messageId, identity.currentUser.workspaceId],
    );
    const conversationId = target.rows[0]?.conversation_id;
    if (conversationId === undefined) throw new ApiError(404, "NOT_FOUND", "Message not found");

    // Locking the conversation serializes reaction capacity checks and prevents an archive or
    // membership removal from committing between authorization and the reaction event audience.
    const conversation = await this.#requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    const messageResult = await client.query<MessageRow>(
      `SELECT *
         FROM messages
        WHERE id = $1
          AND conversation_id = $2`,
      [messageId, conversationId],
    );
    const message = messageResult.rows[0];
    if (message === undefined || message.deleted_at !== null) {
      throw new ApiError(404, "NOT_FOUND", "Message not found");
    }
    return { conversation, message };
  }

  async #validateMentions(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    conversation: ConversationRow,
    input: SendConversationMessageRequest,
  ): Promise<void> {
    const ids = [...new Set(input.mentionedUserIds)];
    if (ids.length !== input.mentionedUserIds.length) {
      throw new ApiError(400, "BAD_REQUEST", "Mentioned members must be unique");
    }
    if (ids.length === 0) return;
    const audience = new Set(await this.#conversationAudience(client, conversation));
    if (ids.some((id) => !audience.has(id))) {
      throw new ApiError(400, "BAD_REQUEST", "A mentioned member cannot access this conversation");
    }
    const result = await client.query<UserRow>(
      `SELECT user_account.id, user_account.kind, user_account.username, user_account.display_name,
              user_account.avatar_url, user_account.title, user_account.created_at,
              user_account.updated_at
         FROM users AS user_account
         JOIN workspace_memberships AS membership
           ON membership.user_id = user_account.id
        WHERE membership.workspace_id = $1
          AND membership.status = 'active'
          AND user_account.id = ANY($2::uuid[])`,
      [identity.currentUser.workspaceId, ids],
    );
    if (result.rows.length !== ids.length) {
      throw new ApiError(400, "BAD_REQUEST", "A mentioned member is unavailable");
    }
    for (const user of result.rows) {
      if (!mentionPattern(user.username).test(input.body)) {
        throw new ApiError(400, "BAD_REQUEST", `The message does not contain @${user.username}`);
      }
    }
  }

  /**
   * Thin, conversation-flavored wrapper over the shared {@link insertSyncEvent} primitive (see
   * `./sync-events.ts`). Every workspace mutation in this repository publishes through a
   * `ConversationRow`, so the wrapper exists to keep those call sites unchanged; the actual
   * `sync_events` / `sync_event_audiences` / `pg_notify` mechanics live in the shared module so
   * the agent-lifecycle path (which has no conversation) can reuse them instead of duplicating
   * the SQL.
   */
  async #insertEvent(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    input: {
      readonly type: WorkspaceEvent["type"];
      readonly conversation: ConversationRow;
      readonly conversationSequence?: string;
      readonly entityVersion?: number;
      readonly payload: WorkspaceEvent["payload"];
      readonly audienceUserIds?: readonly string[];
    },
  ): Promise<WorkspaceEvent> {
    return insertSyncEvent(client, {
      workspaceId: identity.currentUser.workspaceId,
      actorUserId: identity.currentUser.user.id,
      type: input.type,
      conversationId: input.conversation.id,
      conversationSequence: input.conversationSequence,
      entityVersion: input.entityVersion,
      payload: input.payload,
      audienceUserIds: input.audienceUserIds,
      stripChannelMode: !(await this.#announcementChannelsAvailable(
        client,
        identity.currentUser.workspaceId,
      )),
    });
  }

  async #insertEventWithSequence(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    sequence: string,
    input: {
      readonly type: WorkspaceEvent["type"];
      readonly conversation: ConversationRow;
      readonly conversationSequence?: string;
      readonly entityVersion?: number;
      readonly payload: WorkspaceEvent["payload"];
      readonly audienceUserIds?: readonly string[];
    },
  ): Promise<WorkspaceEvent> {
    return insertSyncEventWithSequence(client, sequence, {
      workspaceId: identity.currentUser.workspaceId,
      actorUserId: identity.currentUser.user.id,
      type: input.type,
      conversationId: input.conversation.id,
      conversationSequence: input.conversationSequence,
      entityVersion: input.entityVersion,
      payload: input.payload,
      audienceUserIds: input.audienceUserIds,
      stripChannelMode: !(await this.#announcementChannelsAvailable(
        client,
        identity.currentUser.workspaceId,
      )),
    });
  }

  async #announcementChannelsAvailable(client: PoolClient, workspaceId: string): Promise<boolean> {
    if (this.announcementChannelsEnabled) {
      await client.query(
        `UPDATE workspaces
            SET announcement_channels_available = true
          WHERE id = $1
            AND announcement_channels_available = false`,
        [workspaceId],
      );
    }
    const result = await client.query<
      { announcement_channels_available: boolean } & QueryResultRow
    >(
      `SELECT announcement_channels_available
         FROM workspaces
        WHERE id = $1
        FOR UPDATE`,
      [workspaceId],
    );
    const workspace = result.rows[0];
    if (workspace === undefined) throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
    return workspace.announcement_channels_available;
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

  async #nextWorkspaceSequence(client: PoolClient, workspaceId: string): Promise<string> {
    return nextWorkspaceSequence(client, workspaceId);
  }

  async #highWater(client: PoolClient, workspaceId: string): Promise<string> {
    const result = await client.query<{ last_event_sequence: string } & QueryResultRow>(
      `SELECT last_event_sequence::text
         FROM workspaces
        WHERE id = $1`,
      [workspaceId],
    );
    const value = result.rows[0]?.last_event_sequence;
    if (value === undefined) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
    return value;
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

  #legacyMemberProfileEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "member.updated") return event;
    const member: Partial<typeof event.payload.member> = { ...event.payload.member };
    delete member.title;
    return { ...event, payload: { member } } as unknown as WorkspaceEvent;
  }

  async #transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    options: {
      readonly isolationLevel?: "repeatable_read";
      readonly readOnly?: boolean;
    } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      const isolation =
        options.isolationLevel === "repeatable_read" ? " ISOLATION LEVEL REPEATABLE READ" : "";
      const accessMode = options.readOnly === true ? " READ ONLY" : "";
      await client.query(`BEGIN TRANSACTION${isolation}${accessMode}`);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
