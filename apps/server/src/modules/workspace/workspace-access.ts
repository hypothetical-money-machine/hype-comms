import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";

export async function requireActivePrincipal(
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
    throw new DomainError("access_denied", "Workspace unavailable");
  }
  // Existing membership mutations take the membership row before the workspace sequence row.
  // This matches delivery and identity revocation, preventing a membership/workspace inversion.
  await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
    identity.currentUser.workspaceId,
  ]);
  return principal;
}
