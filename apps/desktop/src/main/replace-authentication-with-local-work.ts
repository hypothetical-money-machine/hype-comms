import type { DesktopSessionLifecycle } from "./desktop-session-lifecycle";

/** Offline Claude has no online session owner, but must stop before credentials change. */
export function replaceAuthenticationWithLocalWork<T>(options: {
  lifecycle: Pick<DesktopSessionLifecycle<object>, "replaceAuthentication">;
  hasWorkspaceSession: boolean;
  suspendLocalWork: () => Promise<void>;
  operation: () => Promise<T>;
}): Promise<T> {
  const suspension = options.hasWorkspaceSession ? undefined : options.suspendLocalWork();
  const replacement = options.lifecycle.replaceAuthentication(async (assertCurrent) => {
    await suspension;
    assertCurrent();
    return options.operation();
  });
  void suspension?.catch(() => undefined);
  return replacement;
}
