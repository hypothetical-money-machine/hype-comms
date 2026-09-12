import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";

export async function readWorkspaceSequence(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const result = await client.query<{ last_event_sequence: string } & QueryResultRow>(
    `SELECT last_event_sequence::text
         FROM workspaces
        WHERE id = $1`,
    [workspaceId],
  );
  const value = result.rows[0]?.last_event_sequence;
  if (value === undefined) throw new DomainError("not_found", "Workspace not found");
  return value;
}
