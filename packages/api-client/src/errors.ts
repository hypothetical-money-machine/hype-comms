import {
  isWorkspaceProtocolMismatch,
  WORKSPACE_PROTOCOL_UPGRADE_MESSAGE,
} from "@hype-comms/contracts";

export type ApiFailureKind = "request" | "network" | "contract" | "redirect" | "http";

/** Internal typed errors. Callers map them to their UI or process exit codes. */
export class ApiClientError extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    message: string,
    readonly response?: Response,
    readonly body?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiClientError";
  }
}

export class WorkspaceProtocolError extends Error {
  constructor(readonly response?: Response) {
    super(WORKSPACE_PROTOCOL_UPGRADE_MESSAGE);
    this.name = "WorkspaceProtocolError";
  }
}

export async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function requireWorkspaceProtocol(response: Response): Promise<Response> {
  if (!isWorkspaceProtocolMismatch(response)) return response;
  await cancelResponse(response);
  throw new WorkspaceProtocolError(response);
}

export function retryAfterMs(response: Response, maximum = 86_400_000): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.round(seconds * 1000), maximum)
    : null;
}
