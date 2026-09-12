import type { ChatSessionState } from "@hype-comms/contracts";

/** Show the window first; a pending OS permission prompt must not hold up authentication. */
export async function startDesktopSession(options: {
  showWindow: () => Promise<unknown>;
  authorizeNotifications: () => Promise<unknown>;
  reportAuthorizationFailure: (error: unknown) => void;
  beforeRestore: () => Promise<unknown>;
  restore: () => Promise<ChatSessionState>;
}): Promise<ChatSessionState> {
  await options.showWindow();
  void Promise.resolve()
    .then(options.authorizeNotifications)
    .catch((error: unknown) => {
      try {
        options.reportAuthorizationFailure(error);
      } catch {
        /* Diagnostics cannot prevent restoration. */
      }
    });
  await options.beforeRestore();
  return options.restore();
}
