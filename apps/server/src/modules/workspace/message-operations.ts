import { positionForRetainedSequence } from "./protocol-epoch.js";
import type { SyncPosition } from "@hype-comms/contracts";
import {
  addReactionResponseSchema,
  advanceReadCursorResponseSchema,
  AGENT_CONTEXT_PACK_MAX_BYTES,
  agentContextHistoryResponseSchema,
  ATTACHMENTS_PER_MESSAGE_MAX,
  injectionSafeCompactJsonByteLength,
  isPostgresBigintString,
  listMessageReactionsResponseSchema,
  MESSAGE_HISTORY_MAX_LIMIT,
  MESSAGE_SEARCH_MAX_LIMIT,
  messageByIdResponseSchema,
  messageHistoryResponseSchema,
  messageSearchResponseSchema,
  messageThreadResponseSchema,
  reactionEmojiSchema,
  REACTIONS_PER_MEMBER_PER_MESSAGE_MAX,
  REACTIONS_PER_MESSAGE_MAX,
  reactionSchema,
  removeReactionResponseSchema,
  retractMessageResponseSchema,
  sendMessageResponseSchema,
  type AddReactionResponse,
  type AdvanceReadCursorResponse,
  type AgentContextAuthor,
  type AgentContextHistoryResponse,
  type AgentContextLocation,
  type AgentContextMessage,
  type Attachment,
  type ListMessageReactionsResponse,
  type Message,
  type MessageByIdResponse,
  type MessageHistoryResponse,
  type MessageSearchResponse,
  type MessageThreadResponse,
  type MessageThreadSummary,
  type Reaction,
  type ReactionEmoji,
  type RemoveReactionResponse,
  type RetractMessageResponse,
  type SendConversationMessageRequest,
  type SendMessageResponse,
} from "@hype-comms/contracts";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { attachmentsForMessages } from "./attachment-queries.js";
import { mapAttachment, type AttachmentRow } from "./attachment-records.js";
import {
  conversationAudience,
  conversationVisibilitySql,
  requireVisibleConversation,
} from "./conversation-access.js";
import type { ConversationEventWriter } from "./conversation-events.js";
import { readUnreadCounts } from "./conversation-summary-reader.js";
import { UUID_PATTERN } from "./pagination.js";
import {
  iso,
  mapMessage,
  mapReadCursor,
  type ConversationRow,
  type MessageRow,
  type ReadCursorRow,
} from "./records.js";
import { nextWorkspaceSequence } from "./sync-events.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { type UserRow } from "./user-records.js";
import { requireActivePrincipal } from "./workspace-access.js";
import { auditAnnouncement, type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import type { AuthenticatedTaskIdentity } from "./workspace-identity.js";
import { readWorkspacePosition } from "./workspace-sequence.js";

const POSTGRES_REAL_MAX = 3.4028234663852886e38;

interface AgentContextMessageRow extends MessageRow {
  author_kind: "human" | "bot" | "agent";
  author_username: string;
  author_display_name: string;
  mentioned_you: boolean;
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

interface ReactionCountRow extends QueryResultRow {
  total: string;
  member_total: string;
}

interface UnreadCounts {
  readonly unreadCount: number;
  readonly mentionCount: number;
}

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

function mapReaction(row: ReactionRow): Reaction {
  return reactionSchema.parse({
    id: row.id,
    messageId: row.message_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: iso(row.created_at),
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
    throw new DomainError("invalid_input", "Invalid history cursor");
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
    throw new DomainError("invalid_input", "Invalid search cursor");
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

/** Owns message, reaction, and read-state transactions and their committed events. */
export class WorkspaceMessageOperations {
  constructor(
    private readonly pool: Pool,
    private readonly events: ConversationEventWriter,
    private readonly hooks: Pick<
      WorkspaceRepositoryHooks,
      "afterConversationLocked" | "afterMessageAuthorizationLocked" | "onAnnouncementAudit"
    > = {},
  ) {}
  async history(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    limit: number,
  ): Promise<MessageHistoryResponse> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        await requireVisibleConversation(client, identity, conversationId, false);
        const beforeSequence = decodeHistoryCursor(before);
        const result = await client.query<MessageRow>(
          `SELECT *
           FROM messages
          WHERE conversation_id = $1
            AND thread_root_id IS NULL
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
          snapshotPosition: await readWorkspacePosition(client, identity.currentUser.workspaceId),
          reactions: await this.#reactionsForMessages(client, messages),
          messages,
          attachments: await attachmentsForMessages(
            client,
            messages.map((message) => message.id),
          ),
          threadSummaries: await this.#threadSummaries(
            client,
            messages.map((message) => message.id),
          ),
          threadsSupported: true,
          nextCursor:
            hasMore && oldest !== undefined
              ? encodeHistoryCursor(oldest.conversation_sequence)
              : null,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async contextHistory(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    throughMessageId: string | undefined,
    limit: number,
  ): Promise<AgentContextHistoryResponse> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const conversation = await requireVisibleConversation(
          client,
          identity,
          conversationId,
          false,
        );
        const beforeSequence = decodeHistoryCursor(before);
        let throughSequence: string | null = null;
        if (throughMessageId !== undefined) {
          const through = await client.query<
            {
              conversation_sequence: string;
            } & QueryResultRow
          >(
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
            throw new DomainError("not_found", "Message not found");
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
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
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
          throw new DomainError("not_found", "Thread not found");
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
          snapshotPosition: await readWorkspacePosition(client, identity.currentUser.workspaceId),
          reactions: await this.#reactionsForMessages(client, [rootMessage, ...replies]),
          root: rootMessage,
          replies,
          attachments: await attachmentsForMessages(client, [
            rootMessage.id,
            ...replies.map((message) => message.id),
          ]),
          nextCursor:
            hasMore && oldest !== undefined
              ? encodeHistoryCursor(oldest.conversation_sequence)
              : null,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
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
      throw new DomainError("not_found", "Message not found");
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

  async #reactionsForMessages(
    client: PoolClient,
    messages: readonly Message[],
  ): Promise<Reaction[]> {
    const ids = messages
      .filter((message) => message.deletedAt === null)
      .map((message) => message.id);
    if (ids.length === 0) return [];
    const reactions = await client.query<ReactionRow>(
      "SELECT * FROM message_reactions WHERE message_id = ANY($1::uuid[]) ORDER BY created_at, id",
      [ids],
    );
    return reactions.rows.map(mapReaction);
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
      throw new DomainError("invalid_input", "Invalid reaction message IDs");
    }
    const client = await this.pool.connect();
    try {
      const visible = await client.query<
        {
          id: string;
        } & QueryResultRow
      >(
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
        throw new DomainError("not_found", "One or more messages were not found");
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
    return runWorkspaceTransaction(this.pool, async (client) => {
      const { conversation, message } = await this.#reactionTarget(client, identity, messageId);
      await requireActivePrincipal(client, identity);
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
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
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
        throw new DomainError(
          "conflict",
          `A member can add at most ${REACTIONS_PER_MEMBER_PER_MESSAGE_MAX} reactions to one message`,
        );
      }
      if (Number(count?.total ?? "0") >= REACTIONS_PER_MESSAGE_MAX) {
        throw new DomainError(
          "conflict",
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
      const event = await this.events.insert(client, identity, {
        type: "reaction.added",
        conversation,
        conversationSequence: message.conversation_sequence,
        payload: { reaction },
        audienceUserIds: await conversationAudience(client, conversation),
      });
      return addReactionResponseSchema.parse({ reaction, syncCursor: event.position });
    });
  }

  async removeReaction(
    identity: AuthenticatedIdentity,
    messageId: string,
    input: ReactionEmoji,
  ): Promise<RemoveReactionResponse> {
    const emoji = this.#reactionEmoji(input);
    return runWorkspaceTransaction(this.pool, async (client) => {
      const { conversation, message } = await this.#reactionTarget(client, identity, messageId);
      await requireActivePrincipal(client, identity);
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
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      }
      const event = await this.events.insert(client, identity, {
        type: "reaction.removed",
        conversation,
        conversationSequence: message.conversation_sequence,
        payload: { reaction: mapReaction(row) },
        audienceUserIds: await conversationAudience(client, conversation),
      });
      return removeReactionResponseSchema.parse({
        removed: true,
        syncCursor: event.position,
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
    identity: AuthenticatedTaskIdentity,
    conversationId: string,
    input: SendConversationMessageRequest,
    correlationId?: string,
  ): Promise<SendMessageResponse> {
    if (input.attachmentIds.length !== new Set(input.attachmentIds).size) {
      throw new DomainError("invalid_input", "Attachment IDs must be unique");
    }
    if (input.attachmentIds.length > ATTACHMENTS_PER_MESSAGE_MAX) {
      throw new DomainError("invalid_input", "A message may include at most 10 files");
    }
    const fingerprint = fingerprintMessage(conversationId, input);
    let bulletinAccepted = false;
    const response = await runWorkspaceTransaction(this.pool, async (client) => {
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
        throw new DomainError("not_found", "Conversation not found");
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
        throw new DomainError("authentication_required", "Authentication required");
      }

      if (principal.kind === "bot") {
        if (identity.principalKind !== "bot") {
          throw new DomainError("authentication_required", "Authentication required");
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
          throw new DomainError("authentication_required", "Webhook URL is invalid or disabled");
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
        throw new DomainError("not_found", "Conversation not found");
      }
      if (!access.conversation_visible) {
        throw new DomainError("not_found", "Conversation not found");
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
          throw new DomainError("not_found", "Message not found");
        }
        if (!sameBuffer(replay.request_fingerprint, fingerprint)) {
          throw new DomainError(
            "conflict",
            "The client message ID was already used for different content",
          );
        }
        return sendMessageResponseSchema.parse({
          message: mapMessage(replay),
          attachments: await attachmentsForMessages(client, [replay.id]),
          syncCursor: await positionForRetainedSequence(
            client,
            identity.currentUser.workspaceId,
            replay.committed_workspace_sequence,
          ),
        });
      }
      if (access.is_archived) {
        throw new DomainError("not_found", "Conversation not found");
      }
      if (conversation.channel_mode === "announcement" && input.threadRootId === null) {
        // A built-in channel is published by the server alone. No API principal may write a root
        // message there, including a workspace owner on a fully capable client; members still
        // reply in threads and react through the paths below.
        if (conversation.is_system) {
          auditAnnouncement(this.hooks, {
            operation: "bulletin.publish",
            outcome: "rejected",
            actorUserId: identity.currentUser.user.id,
            workspaceId: identity.currentUser.workspaceId,
            conversationId,
            correlationId,
            reason: "built_in_channel",
          });
          throw new DomainError("access_denied", "Only Hype Comms posts in this channel");
        }
        if (principal.kind !== "human" || principal.role !== "owner") {
          auditAnnouncement(this.hooks, {
            operation: "bulletin.publish",
            outcome: "rejected",
            actorUserId: identity.currentUser.user.id,
            workspaceId: identity.currentUser.workspaceId,
            conversationId,
            correlationId,
            reason: "not_authorized",
          });
          throw new DomainError("access_denied", "Only workspace owners can post bulletins");
        }
      }
      if (input.threadRootId !== null) {
        const root = await client.query<
          {
            id: string;
          } & QueryResultRow
        >(
          `SELECT id
             FROM messages
            WHERE id = $1
              AND conversation_id = $2
              AND thread_root_id IS NULL`,
          [input.threadRootId, conversationId],
        );
        if (root.rows[0] === undefined) {
          throw new DomainError("not_found", "Thread root not found");
        }
      }
      await this.#validateMentions(client, identity, conversation, input);
      const attachments = await this.#claimAttachments(
        client,
        identity,
        conversationId,
        input.attachmentIds,
      );
      const conversationSequenceResult = await client.query<
        {
          next: string;
        } & QueryResultRow
      >(
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
      const workspaceSequence = await nextWorkspaceSequence(
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
      const audienceUserIds = await conversationAudience(client, conversation);
      const event = await this.events.insertWithSequence(client, identity, workspaceSequence, {
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
        syncCursor: event.position,
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
      auditAnnouncement(this.hooks, {
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
    return runWorkspaceTransaction(this.pool, async (client) => {
      const located = await client.query<
        {
          conversation_id: string;
        } & QueryResultRow
      >(
        `SELECT conversation_id
           FROM messages
          WHERE id = $1
            AND workspace_id = $2`,
        [messageId, identity.currentUser.workspaceId],
      );
      const conversationId = located.rows[0]?.conversation_id;
      if (conversationId === undefined) throw new DomainError("not_found", "Message not found");

      const conversation = await requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
        true,
      );
      await requireActivePrincipal(client, identity);
      const locked = await client.query<
        MessageRow & {
          retract_window_elapsed: boolean;
        }
      >(
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
      if (message === undefined) throw new DomainError("not_found", "Message not found");
      if (message.author_id !== identity.currentUser.user.id) {
        throw new DomainError("access_denied", "Only the author can retract this message");
      }
      if (message.deleted_at !== null) {
        return retractMessageResponseSchema.parse({
          message: mapMessage(message),
          syncCursor: await positionForRetainedSequence(
            client,
            identity.currentUser.workspaceId,
            message.committed_workspace_sequence,
          ),
        });
      }
      if (message.retract_window_elapsed) {
        throw new DomainError("conflict", "This message can no longer be retracted");
      }

      const workspaceSequence = await nextWorkspaceSequence(
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
        throw new DomainError("conflict", "This message can no longer be retracted");
      }
      const tombstone = mapMessage(retracted);
      if (tombstone.deletedAt === null) {
        throw new Error("Retract committed without a deletedAt tombstone");
      }
      const event = await this.events.insertWithSequence(client, identity, workspaceSequence, {
        type: "message.retracted",
        conversation,
        conversationSequence: retracted.conversation_sequence,
        entityVersion: tombstone.version,
        payload: {
          messageId: tombstone.id,
          deletedAt: tombstone.deletedAt,
        },
        audienceUserIds: await conversationAudience(client, conversation),
      });
      return retractMessageResponseSchema.parse({
        message: tombstone,
        syncCursor: event.position,
      });
    });
  }

  async advanceReadCursor(
    identity: AuthenticatedIdentity,
    conversationId: string,
    messageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const conversation = await requireVisibleConversation(
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
      if (message === undefined) throw new DomainError("not_found", "Message not found");
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
      let syncCursor: SyncPosition;
      if (cursor !== undefined) {
        // Allocate the read event's sequence before counting. Every message allocates its sequence
        // under the same workspace-row lock, so messages ordered before this event are visible to
        // these counts and messages ordered after it will be projected by their own events.
        const workspaceSequence = await nextWorkspaceSequence(
          client,
          identity.currentUser.workspaceId,
        );
        const counts = await this.#unreadCounts(
          client,
          identity.currentUser.user.id,
          conversationId,
        );
        const event = await this.events.insertWithSequence(client, identity, workspaceSequence, {
          type: "read_cursor.updated",
          conversation,
          payload: { readCursor: mapReadCursor(cursor), ...counts },
          audienceUserIds: [identity.currentUser.user.id],
        });
        syncCursor = event.position;
      } else {
        const current = await client.query<ReadCursorRow>(
          `SELECT *
             FROM conversation_read_cursors
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, identity.currentUser.user.id],
        );
        cursor = current.rows[0];
        syncCursor = await readWorkspacePosition(client, identity.currentUser.workspaceId);
      }
      if (cursor === undefined) throw new Error("Read cursor was not persisted");
      return advanceReadCursorResponseSchema.parse({
        readCursor: mapReadCursor(cursor),
        syncCursor,
      });
    });
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
    const counts = await readUnreadCounts(client, userId, [conversationId]);
    return counts.get(conversationId) ?? { unreadCount: 0, mentionCount: 0 };
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
      throw new DomainError("invalid_input", "One or more attachments were not found");
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
        throw new DomainError("invalid_input", "One or more attachments cannot be attached");
      }
      claimed.push(mapAttachment(row));
    }
    return claimed;
  }

  #reactionEmoji(input: string): ReactionEmoji {
    const parsed = reactionEmojiSchema.safeParse(input);
    if (!parsed.success) throw new DomainError("invalid_input", "Invalid reaction emoji");
    return parsed.data;
  }

  async #reactionTarget(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    messageId: string,
  ): Promise<{
    readonly conversation: ConversationRow;
    readonly message: MessageRow;
  }> {
    const target = await client.query<
      {
        conversation_id: string;
      } & QueryResultRow
    >(
      `SELECT conversation_id
         FROM messages
        WHERE id = $1
          AND workspace_id = $2`,
      [messageId, identity.currentUser.workspaceId],
    );
    const conversationId = target.rows[0]?.conversation_id;
    if (conversationId === undefined) throw new DomainError("not_found", "Message not found");

    // Locking the conversation serializes reaction capacity checks and prevents an archive or
    // membership removal from committing between authorization and the reaction event audience.
    const conversation = await requireVisibleConversation(
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
      throw new DomainError("not_found", "Message not found");
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
      throw new DomainError("invalid_input", "Mentioned members must be unique");
    }
    if (ids.length === 0) return;
    const audience = new Set(await conversationAudience(client, conversation));
    if (ids.some((id) => !audience.has(id))) {
      throw new DomainError("invalid_input", "A mentioned member cannot access this conversation");
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
      throw new DomainError("invalid_input", "A mentioned member is unavailable");
    }
    for (const user of result.rows) {
      if (!mentionPattern(user.username).test(input.body)) {
        throw new DomainError("invalid_input", `The message does not contain @${user.username}`);
      }
    }
  }
}
