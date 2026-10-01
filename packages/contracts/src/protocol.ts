/** First-party clients and the server are released together for each workspace protocol major. */
export const WORKSPACE_PROTOCOL_MAJOR = 2;
export const WORKSPACE_PROTOCOL_PREFIX = "/v2";
export const WORKSPACE_PROTOCOL_HEADER = "x-hype-comms-protocol";
export const WORKSPACE_PROTOCOL_UPGRADE_MESSAGE =
  "Update Hype Comms to continue. The client and server versions are incompatible.";

/** Old servers return an unmarked 404; an unmarked gateway failure remains retryable. */
export function isWorkspaceProtocolMismatch(response: {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
}): boolean {
  const major = response.headers.get(WORKSPACE_PROTOCOL_HEADER);
  return (
    response.status === 426 ||
    (major !== null
      ? major !== String(WORKSPACE_PROTOCOL_MAJOR)
      : response.status === 404 || (response.status >= 200 && response.status < 300))
  );
}
