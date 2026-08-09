import { useEffect, useMemo, useRef } from "react";

import type { ConversationSummary } from "@hmm-chat/contracts";

/**
 * Calls `onNewActivity` when unread or mention counts grow in a conversation other than the
 * selected one. Each conversation is compared against its own baseline, so a count dropping in
 * one conversation (read on another device) cannot mask a simultaneous arrival in another.
 * Switching conversations moves the old selection's count into the watched set; that is a
 * baseline change, not new activity, so it never signals.
 */
export function useBackgroundUnreadSignal(
  conversations: readonly ConversationSummary[] | null,
  selectedConversationId: string | null,
  onNewActivity: () => void,
): void {
  const counts = useMemo(() => {
    if (conversations === null) return null;
    const next = new Map<string, number>();
    for (const summary of conversations) {
      next.set(summary.conversation.id, summary.unreadCount + summary.mentionCount);
    }
    return next;
  }, [conversations]);
  const previous = useRef<{ counts: Map<string, number> | null; conversationId: string | null }>({
    counts: null,
    conversationId: null,
  });

  useEffect(() => {
    const before = previous.current;
    previous.current = { counts, conversationId: selectedConversationId };
    if (counts === null || before.counts === null) return;
    if (before.conversationId !== selectedConversationId) return;
    for (const [conversationId, count] of counts) {
      if (conversationId === selectedConversationId) continue;
      if (count > (before.counts.get(conversationId) ?? 0)) {
        onNewActivity();
        return;
      }
    }
  }, [counts, selectedConversationId, onNewActivity]);
}
