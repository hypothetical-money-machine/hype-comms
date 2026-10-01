import type { SyncPosition } from "@hype-comms/contracts";
import type { PoolClient } from "pg";
import { readWorkspaceProtocol } from "./protocol-epoch.js";

export async function readWorkspacePosition(
  client: PoolClient,
  workspaceId: string,
): Promise<SyncPosition> {
  const { epoch, sequence } = await readWorkspaceProtocol(client, workspaceId);
  return { epoch, sequence };
}
