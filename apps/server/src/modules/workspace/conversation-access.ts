import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import { participants, type ConversationRow } from "./records.js";
import type { AuthenticatedTaskIdentity } from "./workspace-identity.js";

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

export async function requireVisibleConversation(
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
  if (row === undefined) throw new DomainError("not_found", "Conversation not found");
  return row;
}

export async function requireVisibleChannelBySlug(
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
    [identity.currentUser.workspaceId, channelSlug, identity.currentUser.user.id, requireWritable],
  );
  const row = result.rows[0];
  if (row === undefined) throw new DomainError("not_found", "Channel not found");
  return row;
}

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
