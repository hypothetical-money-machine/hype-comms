import type { ChatSession } from "./chat-session";
import type { OwnedWorkspaceSession } from "./workspace-session-owner";

/** Bind networking and passive sign-out to the lifetime that initiated the request. */
export function scopedWorkspaceSession(
  chat: Pick<ChatSession, "fetch" | "markSignedOut">,
  lifetime: Pick<OwnedWorkspaceSession<object>, "signal" | "assertActive">,
): Pick<ChatSession, "fetch" | "markSignedOut"> {
  return {
    fetch: async (url, init = {}) => {
      lifetime.assertActive();
      const signal =
        init.signal == null ? lifetime.signal : AbortSignal.any([lifetime.signal, init.signal]);
      const response = await chat.fetch(url, { ...init, signal });
      try {
        lifetime.assertActive();
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      return response;
    },
    markSignedOut: (isCurrent = () => true) =>
      chat.markSignedOut(() => !lifetime.signal.aborted && isCurrent()),
  };
}
