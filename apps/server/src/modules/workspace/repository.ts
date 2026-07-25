import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  advanceReadCursorResponseSchema,
  conversationMutationResponseSchema,
  conversationSchema,
  conversationSummarySchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  messageHistoryResponseSchema,
  messageSchema,
  readCursorSchema,
  realtimeTicketResponseSchema,
  sendMessageResponseSchema,
  syncResponseSchema,
  userSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  type AdvanceReadCursorResponse,
  type Conversation,
  type ConversationMutationResponse,
  type ConversationSummary,
  type CreateChannelRequest,
  type DirectConversationRequest,
  type ListConversationsResponse,
  type ListMembersResponse,
  type Message,
  type MessageHistoryResponse,
  type SendConversationMessageRequest,
  type SendMessageResponse,
  type SyncResponse,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hmm-chat/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";

const REALTIME_TICKET_TTL_MS = 30_000;
const SYNC_RETENTION_DAYS = 90;

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
  is_archived: boolean;
  created_by: string | null;
  dm_user_low_id: string | null;
  dm_user_high_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
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
}

export interface ConsumedRealtimeTicket {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceSessionId: string;
}

export interface WorkspacePrincipal {
  readonly workspaceId: string;
  readonly userId: string;
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
    isArchived: row.is_archived,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function participants(row: ConversationRow): string[] {
  return row.dm_user_low_id === null || row.dm_user_high_id === null
    ? []
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
  constructor(private readonly pool: Pool) {}

  async bootstrap(identity: AuthenticatedIdentity): Promise<WorkspaceBootstrapResponse> {
    const client = await this.pool.connect();
    try {
      const workspaceResult = await client.query<WorkspaceRow>(
        `SELECT id, name, slug, created_by, created_at, updated_at, last_event_sequence
           FROM workspaces
          WHERE id = $1`,
        [identity.currentUser.workspaceId],
      );
      const workspace = workspaceResult.rows[0];
      if (workspace === undefined) throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
      const members = await this.#members(client, workspace.id);
      const conversations = await this.#conversationSummaries(client, identity);
      return workspaceBootstrapResponseSchema.parse({
        currentUser: identity.currentUser,
        workspace: mapWorkspace(workspace),
        members,
        conversations,
        syncCursor: workspace.last_event_sequence,
        featureFlags: {
          channels: true,
          directMessages: true,
          mentions: true,
        },
      });
    } finally {
      client.release();
    }
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

  async listConversations(identity: AuthenticatedIdentity): Promise<ListConversationsResponse> {
    const client = await this.pool.connect();
    try {
      return listConversationsResponseSchema.parse({
        conversations: await this.#conversationSummaries(client, identity),
      });
    } finally {
      client.release();
    }
  }

  async createChannel(
    identity: AuthenticatedIdentity,
    input: CreateChannelRequest,
  ): Promise<ConversationMutationResponse> {
    return this.#transaction(async (client) => {
      const created = await client
        .query<ConversationRow>(
          `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, created_by)
         VALUES ($1, $2, 'channel', $3, $4, $5, $6)
         RETURNING *`,
          [
            randomUUID(),
            identity.currentUser.workspaceId,
            input.name,
            input.slug,
            input.topic,
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
      const event = await this.#insertEvent(client, identity, {
        type: "channel.created",
        conversation: row,
        payload: {
          conversation: mapConversation(row),
          participantIds: [],
        },
      });
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, row),
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
        `UPDATE conversations
            SET is_archived = true, updated_at = clock_timestamp()
          WHERE id = $1
            AND workspace_id = $2
            AND kind = 'channel'
            AND slug <> 'general'
          RETURNING *`,
        [conversationId, identity.currentUser.workspaceId],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new ApiError(404, "NOT_FOUND", "Channel not found or cannot be archived");
      }
      const event = await this.#insertEvent(client, identity, {
        type: "channel.archived",
        conversation: row,
        payload: {
          conversation: mapConversation(row),
          participantIds: [],
        },
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
    if (input.memberId === identity.currentUser.user.id) {
      throw new ApiError(400, "BAD_REQUEST", "A direct conversation requires another member");
    }
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
        const event = await this.#insertEvent(client, identity, {
          type: "direct_conversation.created",
          conversation: row,
          payload: {
            conversation: mapConversation(row),
            participantIds: [low, high],
          },
          audienceUserIds: [low, high],
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

      const conversation = await this.#requireVisibleConversation(
        client,
        identity,
        conversationId,
        true,
      );
      await this.#validateMentions(client, identity, input);

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
        ...(conversation.kind === "direct_message"
          ? { audienceUserIds: participants(conversation) }
          : {}),
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
      await this.#requireVisibleConversation(client, identity, conversationId, false);
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
      let syncCursor = await this.#highWater(client, identity.currentUser.workspaceId);
      if (cursor !== undefined) {
        const event = await this.#insertEvent(client, identity, {
          type: "read_cursor.updated",
          conversation: await this.#requireVisibleConversation(
            client,
            identity,
            conversationId,
            false,
          ),
          payload: { readCursor: mapReadCursor(cursor) },
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
      }
      if (cursor === undefined) throw new Error("Read cursor was not persisted");
      return advanceReadCursorResponseSchema.parse({
        readCursor: mapReadCursor(cursor),
        syncCursor,
      });
    });
  }

  async sync(identity: AuthenticatedIdentity, after: string, limit: number): Promise<SyncResponse> {
    return this.syncPrincipal(
      {
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
      if (BigInt(after) > BigInt(highWaterCursor)) {
        throw new ApiError(410, "CURSOR_EXPIRED", "The sync cursor is no longer valid");
      }
      const earliest = await client.query<{ sequence: string | null } & QueryResultRow>(
        `SELECT min(workspace_sequence)::text AS sequence
           FROM sync_events
          WHERE workspace_id = $1`,
        [principal.workspaceId],
      );
      const earliestSequence = earliest.rows[0]?.sequence ?? null;
      if (
        earliestSequence !== null &&
        BigInt(after) + 1n < BigInt(earliestSequence) &&
        BigInt(after) !== 0n
      ) {
        throw new ApiError(410, "CURSOR_EXPIRED", "The sync cursor has expired");
      }
      const rows = await client.query<EventRow>(
        `SELECT event.*,
                EXISTS (
                  SELECT 1
                    FROM sync_event_audiences AS audience
                   WHERE audience.event_id = event.id
                     AND audience.user_id = $2
                ) AS visible
           FROM sync_events AS event
          WHERE event.workspace_id = $1
            AND event.workspace_sequence > $3::bigint
          ORDER BY event.workspace_sequence
          LIMIT $4`,
        [principal.workspaceId, principal.userId, after, limit + 1],
      );
      const scanned = rows.rows.slice(0, limit);
      const nextCursor = scanned.at(-1)?.workspace_sequence ?? after;
      return syncResponseSchema.parse({
        events: scanned.filter((row) => row.visible).map((row) => this.#mapEvent(row)),
        nextCursor,
        highWaterCursor,
        hasMore: rows.rows.length > limit,
      });
    } finally {
      client.release();
    }
  }

  async issueRealtimeTicket(identity: AuthenticatedIdentity) {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest();
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_MS);
    await this.pool.query(
      `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        identity.sessionId,
        hash,
        expiresAt,
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
      `UPDATE realtime_tickets AS ticket
          SET consumed_at = clock_timestamp()
         FROM device_sessions AS session
        WHERE ticket.token_hash = $1
          AND ticket.consumed_at IS NULL
          AND ticket.expires_at > clock_timestamp()
          AND session.id = ticket.device_session_id
          AND session.revoked_at IS NULL
          AND session.expires_at > clock_timestamp()
        RETURNING ticket.workspace_id, ticket.user_id, ticket.device_session_id`,
      [hash],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          workspaceId: row.workspace_id,
          userId: row.user_id,
          deviceSessionId: row.device_session_id,
        };
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

  async #conversationSummaries(
    client: PoolClient,
    identity: AuthenticatedIdentity,
  ): Promise<ConversationSummary[]> {
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations
        WHERE workspace_id = $1
          AND (
            kind = 'channel'
            OR dm_user_low_id = $2
            OR dm_user_high_id = $2
          )
        ORDER BY kind, lower(coalesce(name, '')), created_at, id`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id],
    );
    const summaries: ConversationSummary[] = [];
    for (const row of result.rows) {
      summaries.push(await this.#conversationSummary(client, identity, row));
    }
    return summaries;
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
      [conversation.id, identity.currentUser.user.id],
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
      [conversation.id, identity.currentUser.user.id],
    );
    return conversationSummarySchema.parse({
      conversation: mapConversation(conversation),
      participantIds: participants(conversation),
      lastMessage: latestResult.rows[0] === undefined ? null : mapMessage(latestResult.rows[0]),
      unreadCount: Number(unreadResult.rows[0]?.count ?? "0"),
      mentionCount: Number(mentionResult.rows[0]?.count ?? "0"),
      readCursor: cursorResult.rows[0] === undefined ? null : mapReadCursor(cursorResult.rows[0]),
    });
  }

  async #requireVisibleConversation(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversationId: string,
    requireWritable: boolean,
  ): Promise<ConversationRow> {
    const result = await client.query<ConversationRow>(
      `SELECT *
         FROM conversations
        WHERE id = $1
          AND workspace_id = $2
          AND (
            kind = 'channel'
            OR dm_user_low_id = $3
            OR dm_user_high_id = $3
          )
          AND ($4::boolean = false OR is_archived = false)`,
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

  async #validateMentions(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    input: SendConversationMessageRequest,
  ): Promise<void> {
    const ids = [...new Set(input.mentionedUserIds)];
    if (ids.length !== input.mentionedUserIds.length) {
      throw new ApiError(400, "BAD_REQUEST", "Mentioned members must be unique");
    }
    if (ids.length === 0) return;
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

  #mapEvent(row: EventRow): WorkspaceEvent {
    return workspaceEventSchema.parse({
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
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
