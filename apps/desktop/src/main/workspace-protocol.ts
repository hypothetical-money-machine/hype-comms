import {
  isWorkspaceProtocolMismatch,
  WORKSPACE_PROTOCOL_UPGRADE_MESSAGE,
} from "@hype-comms/contracts";

export class WorkspaceProtocolError extends Error {
  constructor() {
    super(WORKSPACE_PROTOCOL_UPGRADE_MESSAGE);
    this.name = "WorkspaceProtocolError";
  }
}

export async function requireWorkspaceProtocol(response: Response): Promise<Response> {
  if (!isWorkspaceProtocolMismatch(response)) return response;
  await response.body?.cancel().catch(() => undefined);
  throw new WorkspaceProtocolError();
}
