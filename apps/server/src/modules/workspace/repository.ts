import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  MESSAGE_HISTORY_MAX_LIMIT,
  MESSAGE_SEARCH_MAX_LIMIT,
  REACTIONS_PER_MEMBER_PER_MESSAGE_MAX,
  REACTIONS_PER_MESSAGE_MAX,
  addReactionResponseSchema,
  advanceReadCursorResponseSchema,
  channelMembershipMutationResponseSchema,
  channelMembersResponseSchema,
  conversationMutationResponseSchema,
  conversationSchema,
  conversationSummarySchema,
  listConversationsResponseSchema,
  listMessageReactionsResponseSchema,
  listMembersResponseSchema,
  messageHistoryResponseSchema,
  messageSearchResponseSchema,
  messageSchema,
  reactionEmojiSchema,
  reactionSchema,
  readCursorSchema,
  realtimeTicketResponseSchema,
  removeReactionResponseSchema,
  sendMessageResponseSchema,
  syncResponseSchema,
  userSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  type AdvanceReadCursorResponse,
  type AddReactionResponse,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type Conversation,
  type ConversationMutationResponse,
  type ConversationSummary,
  type CreateChannelRequest,
  type DirectConversationRequest,
  type ListConversationsResponse,
  type ListMessageReactionsResponse,
  type ListMembersResponse,
  type Message,
  type MessageHistoryResponse,
  type MessageSearchResponse,
  type Reaction,
  type ReactionEmoji,
  type RemoveReactionResponse,
  type SendConversationMessageRequest,
  type SendMessageResponse,
  type SyncResponse,
  type UpsertChannelMemberRequest,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hmm-chat/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
import {
  fingerprintApiRequest,
  lockIdempotencyScope,
  runIdempotentMutation,
} from "./idempotency.js";

const REALTIME_TICKET_TTL_MS = 30_000;
const SYNC_RETENTION_DAYS = 90;
const POSTGRES_REAL_MAX = 3.4028234663852886e38;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkspaceRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_event_sequence: string;
}

interface UserRow extends QueryResultRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ConversationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  kind: "channel" | "direct_message";
  name: string | null;
  slug: string | null;
  topic: string | null;
  channel_access: "workspace" | "members" | null;
  is_archived: boolean;
  created_by: string | null;
  dm_user_low_id: string | null;
  dm_user_high_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
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
  body_format: "hmm_markdown_v1";
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SearchMessageRow extends MessageRow {
  search_rank: string;
}

interface ReactionRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: Date | string;
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
}

interface TicketRow extends QueryResultRow {
  workspace_id: string;
  user_id: string;
  device_session_id: string;
  reaction_events: boolean;
  read_state_events: boolean;
}

interface RealtimeSessionRow extends QueryResultRow {
  revoked: boolean;
  expired: boolean;
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
}

export interface ConsumedRealtimeTicket {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceSessionId: string;
  readonly reactionEvents: boolean;
  readonly readStateEvents: boolean;
}

export interface WorkspacePrincipal {
  readonly workspaceId: string;
  readonly userId: string;
  readonly reactionEvents?: boolean;
  readonly readStateEvents?: boolean;
}

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
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
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
    access: row.channel_access,
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
      ${alias}.kind = 'channel'
      AND ${alias}.channel_access = 'workspace'
    )
    OR (
      ${alias}.kind = 'channel'
      AND ${alias}.channel_access = 'members'
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
  )`;
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

function mapReaction(row: ReactionRow): Reaction {
  return reactionSchema.parse({
    id: row.id,
    messageId: row.message_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: iso(row.created_at),
  });
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
      !/^[1-9]\d*$/.test(parsed.sequence)
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
      BigInt(parsed.workspaceSequence) > POSTGRES_BIGINT_MAX ||
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

  async bootstrap(identity: AuthenticatedIdentity): Promise<WorkspaceBootstrapResponse> {
    return this.#transaction(
      async (client) => {
        const workspaceResult = await client.query<WorkspaceRow>(
          `SELECT id, name, slug, created_by, created_at, updated_at, last_event_sequence
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

  async listConversations(
    identity: AuthenticatedIdentity,
    after: string | undefined,
    limit: number,
  ): Promise<ListConversationsResponse> {
    const anchorId = decodeConversationCursor(after);
    const client = await this.pool.connect();
    try {
      const page = await this.#conversationSummaries(client, identity, anchorId, limit);
      return listConversationsResponseSchema.parse({
        conversations: page.conversations,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } finally {
      client.release();
    }
  }

  async createChannel(
    identity: AuthenticatedIdentity,
    input: CreateChannelRequest,
    idempotencyKey?: string,
  ): Promise<ConversationMutationResponse> {
    return this.#transaction(async (client) => {
      const create = async (): Promise<ConversationMutationResponse> => {
        const created = await client
          .query<ConversationRow>(
            `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, channel_access, created_by)
         VALUES ($1, $2, 'channel', $3, $4, $5, $6, $7)
         RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              input.name,
              input.slug,
              input.topic,
              input.access,
              identity.currentUser.user.id,
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
        if (input.access === "members") {
          await client.query(
            `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')`,
            [row.id, row.workspace_id, identity.currentUser.user.id],
          );
        }
        const audienceUserIds = await this.#conversationAudience(client, row);
        const event = await this.#insertEvent(client, identity, {
          type: "channel.created",
          conversation: row,
          payload: {
            conversation: mapConversation(row),
            participantIds: audienceUserIds,
          },
          audienceUserIds,
        });
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
           FROM workspace_memberships
          WHERE workspace_id = $1
            AND user_id = $2
            AND status = 'active'`,
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
    if (identity.currentUser.role !== "owner") {
      throw new ApiError(403, "FORBIDDEN", "Only the workspace owner can archive channels");
    }
    return this.#transaction(async (client) => {
      const updated = await client.query<ConversationRow>(
        `UPDATE conversations AS conversation
            SET is_archived = true, updated_at = clock_timestamp()
          WHERE conversation.id = $1
            AND conversation.workspace_id = $2
            AND conversation.kind = 'channel'
            AND conversation.slug <> 'general'
            AND conversation.is_archived = false
            AND ${conversationVisibilitySql("conversation", "$3")}
          RETURNING *`,
        [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      let row = updated.rows[0];
      if (row === undefined) {
        const replay = await client.query<ConversationRow>(
          `SELECT *
             FROM conversations AS conversation
            WHERE conversation.id = $1
              AND conversation.workspace_id = $2
              AND conversation.kind = 'channel'
              AND conversation.slug <> 'general'
              AND conversation.is_archived = true
              AND ${conversationVisibilitySql("conversation", "$3")}`,
          [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
        );
        row = replay.rows[0];
      }
      if (row === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Channel not found or cannot be archived");
      }
      if (row.is_archived && updated.rows[0] === undefined) {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, row),
          syncCursor: await this.#highWater(client, identity.currentUser.workspaceId),
        });
      }
      const audienceUserIds = await this.#conversationAudience(client, row);
      const event = await this.#insertEvent(client, identity, {
        type: "channel.archived",
        conversation: row,
        payload: {
          conversation: mapConversation(row),
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
      const target = await client.query(
        `SELECT 1
           FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
        [identity.currentUser.workspaceId, input.memberId],
      );
      if (target.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Member not found");
      const pair = [identity.currentUser.user.id, input.memberId].sort();
      const low = pair[0];
      const high = pair[1];
      if (low === undefined || high === undefined) throw new Error("Invalid direct-message pair");
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
            conversation: mapConversation(row),
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

  async history(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    limit: number,
  ): Promise<MessageHistoryResponse> {
    const client = await this.pool.connect();
    try {
      await this.#requireVisibleConversation(client, identity, conversationId, false);
      const beforeSequence = decodeHistoryCursor(before);
      const result = await client.query<MessageRow>(
        `SELECT *
           FROM messages
          WHERE conversation_id = $1
            AND ($2::bigint IS NULL OR conversation_sequence < $2::bigint)
          ORDER BY conversation_sequence DESC, id DESC
          LIMIT $3`,
        [conversationId, beforeSequence, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0, limit);
      const oldest = selected.at(-1);
      return messageHistoryResponseSchema.parse({
        messages: selected.reverse().map(mapMessage),
        nextCursor:
          hasMore && oldest !== undefined
            ? encodeHistoryCursor(oldest.conversation_sequence)
            : null,
      });
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

  async sendMessage(
    identity: AuthenticatedIdentity,
    conversationId: string,
    input: SendConversationMessageRequest,
  ): Promise<SendMessageResponse> {
    if (input.threadRootId !== null || input.attachmentIds.length > 0) {
      throw new ApiError(400, "BAD_REQUEST", "Threads and attachments are not available yet");
    }
    const fingerprint = fingerprintMessage(conversationId, input);
    return this.#transaction(async (client) => {
      // Serialize attempts for the same author/key before checking for an existing message.
      // Without this lock, two requests that arrive together can both miss the initial lookup,
      // with the loser surfacing a unique-constraint error instead of the canonical response.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${identity.currentUser.user.id}:${input.clientMessageId}`,
      ]);
      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
      );
      const existing = await client.query<MessageRow>(
        `SELECT *
           FROM messages
          WHERE author_id = $1 AND client_message_id = $2`,
        [identity.currentUser.user.id, input.clientMessageId],
      );
      const replay = existing.rows[0];
      if (replay !== undefined) {
        if (!sameBuffer(replay.request_fingerprint, fingerprint)) {
          throw new ApiError(
            409,
            "CONFLICT",
            "The client message ID was already used for different content",
          );
        }
        return sendMessageResponseSchema.parse({
          message: mapMessage(replay),
          syncCursor: replay.committed_workspace_sequence,
        });
      }
      if (conversation.is_archived) {
        throw new ApiError(404, "NOT_FOUND", "Conversation not found");
      }
      await this.#validateMentions(client, identity, conversation, input);

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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10)
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
      const event = await this.#insertEventWithSequence(client, identity, workspaceSequence, {
        type: "message.created",
        conversation,
        conversationSequence,
        payload: {
          message: mapMessage(row),
          mentionedUserIds: [...new Set(input.mentionedUserIds)],
        },
        audienceUserIds: await this.#conversationAudience(client, conversation),
      });
      const response = sendMessageResponseSchema.parse({
        message: mapMessage(row),
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
      return response;
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
    reactionEvents = false,
    readStateEvents = false,
  ): Promise<SyncResponse> {
    return this.syncPrincipal(
      {
        workspaceId: identity.currentUser.workspaceId,
        userId: identity.currentUser.user.id,
        reactionEvents,
        readStateEvents,
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
                    )
                  )
                  AND (
                    $5::boolean
                    OR event.event_type NOT IN ('reaction.added', 'reaction.removed')
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
        ],
      );
      const scanned = rows.rows.slice(0, limit);
      const nextCursor = scanned.at(-1)?.workspace_sequence ?? after;
      return syncResponseSchema.parse({
        events: scanned
          .filter((row) => row.visible)
          .map((row) => this.#mapEvent(row, principal.readStateEvents ?? false)),
        nextCursor,
        highWaterCursor,
        hasMore: rows.rows.length > limit,
      });
    } finally {
      client.release();
    }
  }

  async issueRealtimeTicket(
    identity: AuthenticatedIdentity,
    reactionEvents = false,
    readStateEvents = false,
  ) {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest();
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_MS);
    await this.pool.query(
      `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, token_hash, expires_at, reaction_events,
          read_state_events)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        identity.sessionId,
        hash,
        expiresAt,
        reactionEvents,
        readStateEvents,
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
         RETURNING ticket.workspace_id, ticket.user_id, ticket.device_session_id,
                   ticket.reaction_events, ticket.read_state_events
       )
       SELECT ticket.workspace_id, ticket.user_id, ticket.device_session_id,
              ticket.reaction_events, ticket.read_state_events
         FROM consumed_ticket AS ticket
         JOIN device_sessions AS session
           ON session.id = ticket.device_session_id
          AND session.user_id = ticket.user_id
          AND session.revoked_at IS NULL
          AND session.expires_at > clock_timestamp()
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = ticket.workspace_id
          AND membership.user_id = ticket.user_id
          AND membership.status = 'active'`,
      [hash],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          workspaceId: row.workspace_id,
          userId: row.user_id,
          deviceSessionId: row.device_session_id,
          reactionEvents: row.reaction_events,
          readStateEvents: row.read_state_events,
        };
  }

  /**
   * Re-check a live realtime connection's device session and workspace membership.
   *
   * This is a read-only counterpart to {@link consumeRealtimeTicket}: it consumes nothing and
   * mutates nothing, so the realtime heartbeat can call it repeatedly. A socket authorized
   * minutes ago must not outlive a revoked session, an expired session, or a revoked membership.
   */
  async revalidateRealtimePrincipal(
    principal: RealtimePrincipal,
  ): Promise<RealtimePrincipalRevalidation> {
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
      `SELECT user_account.id, user_account.username, user_account.display_name,
              user_account.avatar_url, user_account.created_at, user_account.updated_at
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
  ): Promise<ConversationPage> {
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_PAGE_MAX_LIMIT);
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations AS conversation
        WHERE conversation.workspace_id = $1
          AND ${conversationVisibilitySql("conversation", "$2")}
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
                    AND (
                      ${conversationVisibilitySql("anchor", "$2")}
                      OR (
                        anchor.kind = 'channel'
                        AND anchor.channel_access = 'members'
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
        LIMIT $4`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id, after, pageLimit + 1],
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
      participantIds: await this.#conversationAudience(client, conversation),
      membershipRole: await this.#membershipRole(client, identity, conversation),
      lastMessage: latestResult.rows[0] === undefined ? null : mapMessage(latestResult.rows[0]),
      ...counts,
      readCursor: cursorResult.rows[0] === undefined ? null : mapReadCursor(cursorResult.rows[0]),
    });
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
          AND message.conversation_sequence
              > coalesce(cursor.last_read_conversation_sequence, 0)`,
      [conversationId, userId],
    );
    return {
      unreadCount: Number(unreadResult.rows[0]?.count ?? "0"),
      mentionCount: Number(mentionResult.rows[0]?.count ?? "0"),
    };
  }

  async #requireVisibleConversation(
    client: PoolClient,
    identity: AuthenticatedIdentity,
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

  async #requireManagedChannel(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationRow> {
    const conversation = await this.#requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    if (conversation.kind !== "channel" || conversation.channel_access !== "members") {
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
    const result =
      conversation.channel_access === "workspace"
        ? await client.query<ChannelMemberRow>(
            `SELECT user_account.id, user_account.username, user_account.display_name,
                    user_account.avatar_url, user_account.created_at, user_account.updated_at,
                    CASE WHEN user_account.id = $2 THEN 'owner' ELSE 'member' END AS role,
                    workspace_membership.created_at AS joined_at
               FROM users AS user_account
               JOIN workspace_memberships AS workspace_membership
                 ON workspace_membership.user_id = user_account.id
              WHERE workspace_membership.workspace_id = $1
                AND workspace_membership.status = 'active'
              ORDER BY lower(user_account.display_name), user_account.id`,
            [conversation.workspace_id, conversation.created_by],
          )
        : await client.query<ChannelMemberRow>(
            `SELECT user_account.id, user_account.username, user_account.display_name,
                    user_account.avatar_url, user_account.created_at, user_account.updated_at,
                    membership.role, membership.joined_at
               FROM conversation_memberships AS membership
               JOIN workspace_memberships AS workspace_membership
                 ON workspace_membership.workspace_id = membership.workspace_id
                AND workspace_membership.user_id = membership.user_id
               JOIN users AS user_account ON user_account.id = membership.user_id
              WHERE membership.conversation_id = $1
                AND membership.left_at IS NULL
                AND workspace_membership.status = 'active'
              ORDER BY lower(user_account.display_name), user_account.id`,
            [conversation.id],
          );
    const role = await this.#membershipRole(client, identity, conversation);
    return channelMembersResponseSchema.parse({
      conversationId: conversation.id,
      access: conversation.channel_access,
      members: result.rows.map((row) => ({
        user: mapUser(row),
        role: row.role,
        joinedAt: iso(row.joined_at),
      })),
      canManage: conversation.channel_access === "members" && role === "owner",
    });
  }

  async #conversationAudience(
    client: PoolClient,
    conversation: ConversationRow,
  ): Promise<string[]> {
    if (conversation.kind === "direct_message") return participants(conversation);
    if (conversation.channel_access === "workspace") {
      const result = await client.query<{ user_id: string } & QueryResultRow>(
        `SELECT user_id
           FROM workspace_memberships
          WHERE workspace_id = $1
            AND status = 'active'
          ORDER BY user_id`,
        [conversation.workspace_id],
      );
      return result.rows.map((row) => row.user_id);
    }
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `SELECT membership.user_id
         FROM conversation_memberships AS membership
         JOIN workspace_memberships AS workspace_membership
           ON workspace_membership.workspace_id = membership.workspace_id
          AND workspace_membership.user_id = membership.user_id
        WHERE membership.conversation_id = $1
          AND membership.left_at IS NULL
          AND workspace_membership.status = 'active'
        ORDER BY membership.user_id`,
      [conversation.id],
    );
    return result.rows.map((row) => row.user_id);
  }

  async #membershipRole(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<"owner" | "member" | null> {
    if (conversation.kind !== "channel" || conversation.channel_access !== "members") return null;
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
    if (message === undefined) throw new ApiError(404, "NOT_FOUND", "Message not found");
    return { conversation, message };
  }

  async #validateMentions(
    client: PoolClient,
    identity: AuthenticatedIdentity,
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
      `SELECT user_account.id, user_account.username, user_account.display_name,
              user_account.avatar_url, user_account.created_at, user_account.updated_at
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

  async #insertEvent(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    input: {
      readonly type: WorkspaceEvent["type"];
      readonly conversation: ConversationRow;
      readonly conversationSequence?: string;
      readonly payload: WorkspaceEvent["payload"];
      readonly audienceUserIds?: readonly string[];
    },
  ): Promise<WorkspaceEvent> {
    const sequence = await this.#nextWorkspaceSequence(client, identity.currentUser.workspaceId);
    return this.#insertEventWithSequence(client, identity, sequence, input);
  }

  async #insertEventWithSequence(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    sequence: string,
    input: {
      readonly type: WorkspaceEvent["type"];
      readonly conversation: ConversationRow;
      readonly conversationSequence?: string;
      readonly payload: WorkspaceEvent["payload"];
      readonly audienceUserIds?: readonly string[];
    },
  ): Promise<WorkspaceEvent> {
    const occurredAt = new Date().toISOString();
    const event = workspaceEventSchema.parse({
      version: 1,
      id: randomUUID(),
      type: input.type,
      occurredAt,
      workspaceId: identity.currentUser.workspaceId,
      conversationId: input.conversation.id,
      workspaceSequence: sequence,
      conversationSequence: input.conversationSequence ?? null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: input.payload,
    });
    await client.query(
      `INSERT INTO sync_events (
         id, workspace_id, workspace_sequence, conversation_id, conversation_sequence,
         event_type, actor_user_id, entity_version, payload, occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        event.id,
        event.workspaceId,
        event.workspaceSequence,
        event.conversationId,
        event.conversationSequence,
        event.type,
        identity.currentUser.user.id,
        event.entityVersion,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    if (input.audienceUserIds === undefined) {
      await client.query(
        `INSERT INTO sync_event_audiences (event_id, workspace_id, user_id)
         SELECT $1, $2, membership.user_id
           FROM workspace_memberships AS membership
          WHERE membership.workspace_id = $2
            AND membership.status = 'active'`,
        [event.id, event.workspaceId],
      );
    } else {
      await client.query(
        `INSERT INTO sync_event_audiences (event_id, workspace_id, user_id)
         SELECT $1, $2, unnest($3::uuid[])`,
        [event.id, event.workspaceId, [...input.audienceUserIds]],
      );
    }
    await client.query(`SELECT pg_notify('hmm_chat_events', $1)`, [
      `${event.workspaceId}:${event.workspaceSequence}`,
    ]);
    return event;
  }

  async #nextWorkspaceSequence(client: PoolClient, workspaceId: string): Promise<string> {
    const result = await client.query<{ next: string } & QueryResultRow>(
      `UPDATE workspaces
          SET last_event_sequence = last_event_sequence + 1,
              updated_at = clock_timestamp()
        WHERE id = $1
        RETURNING last_event_sequence::text AS next`,
      [workspaceId],
    );
    const sequence = result.rows[0]?.next;
    if (sequence === undefined) throw new Error("Could not allocate workspace event sequence");
    return sequence;
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

  #mapEvent(row: EventRow, readStateEvents: boolean): WorkspaceEvent {
    const event = workspaceEventSchema.parse({
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
    if (event.type !== "read_cursor.updated" || readStateEvents) return event;
    // Older clients validate v1 event payloads strictly. Keep the stored event canonical while
    // projecting its legacy shape for devices that did not negotiate read-state events.
    return {
      ...event,
      payload: { readCursor: event.payload.readCursor },
    };
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
