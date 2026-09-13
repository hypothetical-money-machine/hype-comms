import type { PoolClient } from "pg";
import { mapUser, type UserRow } from "./user-records.js";

export async function readWorkspaceMembers(client: PoolClient, workspaceId: string) {
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
