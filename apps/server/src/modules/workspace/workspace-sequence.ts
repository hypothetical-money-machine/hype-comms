import type { PoolClient, QueryResultRow } from "pg";
import { ApiError } from "../../errors.js";

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
  if (value === undefined) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
  return value;
}
