import type { AuthCapabilities } from "@hype-comms/contracts";

export interface AuthKitSessionParts {
  readonly chatSession: object | null;
  readonly authKitFlow: object | null;
  readonly authKitPendingStore: object | null;
}

export function isAuthKitSessionComplete(parts: AuthKitSessionParts): boolean {
  return (
    parts.chatSession !== null && parts.authKitFlow !== null && parts.authKitPendingStore !== null
  );
}

/** Keeps the advertised capability consistent with the dependencies required by the start IPC. */
export function authCapabilitiesForSession(
  capabilities: AuthCapabilities,
  parts: AuthKitSessionParts,
  cancellationFenced: boolean,
): AuthCapabilities {
  if (!capabilities.authKit || cancellationFenced || !isAuthKitSessionComplete(parts)) {
    return { ...capabilities, authKit: false };
  }
  return capabilities;
}
