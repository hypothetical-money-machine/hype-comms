import { WORKSPACE_PROTOCOL_HEADER, WORKSPACE_PROTOCOL_MAJOR } from "@hype-comms/contracts";

/** A response from the current server; mismatch tests construct an unmarked Response explicitly. */
export function serverResponse(
  body: ConstructorParameters<typeof Response>[0] = null,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set(WORKSPACE_PROTOCOL_HEADER, String(WORKSPACE_PROTOCOL_MAJOR));
  return new Response(body, { ...init, headers });
}
