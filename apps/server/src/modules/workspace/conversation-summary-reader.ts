import { conversationSummarySchema, type ConversationSummary } from "@hype-comms/contracts";
import type { PoolClient } from "pg";

import {
  mapConversation,
  mapMessage,
  mapReadCursor,
  participants,
  type ConversationRow,
  type MessageRow,
  type ReadCursorRow,
} from "./records.js";

interface UnreadCounts {
  readonly unreadCount: number;
  readonly mentionCount: number;
}

export async function readUnreadCounts(
  client: PoolClient,
  userId: string,
  conversationIds: readonly string[],
): Promise<Map<string, UnreadCounts>> {
  if (conversationIds.length === 0) return new Map();
  const result = await client.query<{
    conversation_id: string;
    unread_count: string;
    mention_count: string;
  }>(
    `SELECT message.conversation_id,
            count(*)::text AS unread_count,
            count(mention.message_id)::text AS mention_count
       FROM messages AS message
       LEFT JOIN conversation_read_cursors AS cursor
         ON cursor.conversation_id = message.conversation_id AND cursor.user_id = $2
       LEFT JOIN message_mentions AS mention
         ON mention.message_id = message.id AND mention.mentioned_user_id = $2
      WHERE message.conversation_id = ANY($1::uuid[])
        AND message.author_id <> $2
        AND message.deleted_at IS NULL
        AND message.conversation_sequence > coalesce(cursor.last_read_conversation_sequence, 0)
      GROUP BY message.conversation_id`,
    [conversationIds, userId],
  );
  return new Map(
    result.rows.map((row) => [
      row.conversation_id,
      { unreadCount: Number(row.unread_count), mentionCount: Number(row.mention_count) },
    ]),
  );
}

/** Reads details for already-authorized conversation rows using the caller's transaction. */
export async function readConversationSummaries(
  client: PoolClient,
  userId: string,
  conversations: readonly ConversationRow[],
): Promise<ConversationSummary[]> {
  if (conversations.length === 0) return [];
  const ids = conversations.map((conversation) => conversation.id);
  const latest = await client.query<MessageRow>(
    `SELECT latest.*
       FROM unnest($1::uuid[]) AS selected(id)
       CROSS JOIN LATERAL (
         SELECT * FROM messages
          WHERE conversation_id = selected.id AND deleted_at IS NULL
          ORDER BY conversation_sequence DESC LIMIT 1
       ) AS latest`,
    [ids],
  );
  const cursors = await client.query<ReadCursorRow>(
    `SELECT * FROM conversation_read_cursors
      WHERE conversation_id = ANY($1::uuid[]) AND user_id = $2`,
    [ids, userId],
  );
  const counts = await readUnreadCounts(client, userId, ids);
  const memberships = await client.query<{
    conversation_id: string;
    role: "owner" | "member";
  }>(
    `SELECT conversation_id, role FROM conversation_memberships
      WHERE conversation_id = ANY($1::uuid[]) AND user_id = $2 AND left_at IS NULL`,
    [ids, userId],
  );
  const participantRows = await client.query<{ conversation_id: string; user_id: string }>(
    `SELECT conversation.id AS conversation_id, workspace_member.user_id
       FROM conversations AS conversation
       JOIN workspace_memberships AS workspace_member
         ON workspace_member.workspace_id = conversation.workspace_id
       JOIN users AS user_account ON user_account.id = workspace_member.user_id
       LEFT JOIN conversation_memberships AS member
         ON member.conversation_id = conversation.id
        AND member.user_id = workspace_member.user_id AND member.left_at IS NULL
       LEFT JOIN bot_channel_grants AS bot_grant
         ON bot_grant.conversation_id = conversation.id
        AND bot_grant.bot_user_id = workspace_member.user_id
      WHERE conversation.id = ANY($1::uuid[])
        AND conversation.kind = 'channel'
        AND workspace_member.status = 'active'
        AND CASE
          WHEN conversation.human_only THEN user_account.kind = 'human'
          WHEN conversation.channel_access = 'workspace' THEN
            user_account.kind = 'human'
            OR (user_account.kind = 'agent' AND member.user_id IS NOT NULL)
            OR bot_grant.bot_user_id IS NOT NULL
          ELSE
            (user_account.kind IN ('human', 'agent') AND member.user_id IS NOT NULL)
            OR (user_account.kind = 'bot' AND bot_grant.bot_user_id IS NOT NULL)
        END
     UNION ALL
     SELECT conversation.id AS conversation_id, member.user_id
       FROM conversations AS conversation
       JOIN conversation_memberships AS member ON member.conversation_id = conversation.id
       JOIN users AS user_account ON user_account.id = member.user_id
      WHERE conversation.id = ANY($1::uuid[])
        AND conversation.kind = 'group_direct_message'
        AND member.left_at IS NULL
        AND user_account.kind IN ('human', 'agent')
      ORDER BY conversation_id, user_id`,
    [ids],
  );
  // Group participants are fixed history: disabled members remain listed, unlike channel audiences.
  const participantsByConversation = new Map<string, string[]>();
  for (const row of participantRows.rows) {
    const values = participantsByConversation.get(row.conversation_id) ?? [];
    values.push(row.user_id);
    participantsByConversation.set(row.conversation_id, values);
  }
  const latestByConversation = new Map(latest.rows.map((row) => [row.conversation_id, row]));
  const cursorsByConversation = new Map(cursors.rows.map((row) => [row.conversation_id, row]));
  const rolesByConversation = new Map(
    memberships.rows.map((row) => [row.conversation_id, row.role]),
  );
  return conversations.map((conversation) => {
    const lastMessage = latestByConversation.get(conversation.id);
    const readCursor = cursorsByConversation.get(conversation.id);
    return conversationSummarySchema.parse({
      conversation: mapConversation(conversation),
      participantIds:
        conversation.kind === "direct_message"
          ? participants(conversation)
          : (participantsByConversation.get(conversation.id) ?? []),
      membershipRole:
        conversation.kind === "direct_message"
          ? null
          : (rolesByConversation.get(conversation.id) ?? null),
      lastMessage: lastMessage === undefined ? null : mapMessage(lastMessage),
      ...(counts.get(conversation.id) ?? { unreadCount: 0, mentionCount: 0 }),
      readCursor: readCursor === undefined ? null : mapReadCursor(readCursor),
    });
  });
}
