export {
  conversationVisibilitySql,
  requireVisibleConversation,
  requireVisibleChannelBySlug,
} from "./authorization.js";
import type { PoolClient, QueryResultRow } from "pg";
import { participants, type ConversationRow } from "./records.js";

export async function conversationAudience(
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
