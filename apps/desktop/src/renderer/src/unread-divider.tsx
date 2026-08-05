import { useEffect, useState } from "react";

import type { ConversationSummary, Message } from "@hmm-chat/contracts";

interface UnreadBoundary {
  readonly conversationId: string | null;
  readonly messageId: string | null;
}

export function firstUnreadMessageId(
  messages: readonly Message[],
  summary: ConversationSummary | undefined,
): string | null {
  if (summary === undefined || summary.unreadCount === 0) return null;
  const conversationId = summary.conversation.id;
  const lastReadSequence = summary.readCursor?.lastReadConversationSequence;
  let earliest: Message | undefined;
  for (const message of messages) {
    if (message.conversationId !== conversationId) continue;
    if (
      lastReadSequence !== undefined &&
      BigInt(message.conversationSequence) <= BigInt(lastReadSequence)
    ) {
      continue;
    }
    if (
      earliest === undefined ||
      BigInt(message.conversationSequence) < BigInt(earliest.conversationSequence)
    ) {
      earliest = message;
    }
  }
  return earliest?.id ?? null;
}

export function useUnreadDividerMessageId(
  conversationId: string | null,
  messages: readonly Message[],
  summary: ConversationSummary | undefined,
): string | null {
  const candidate = firstUnreadMessageId(messages, summary);
  const [boundary, setBoundary] = useState<UnreadBoundary>(() => ({
    conversationId,
    messageId: candidate,
  }));
  const boundaryIsVisible =
    boundary.messageId === null || messages.some((message) => message.id === boundary.messageId);

  useEffect(() => {
    setBoundary((current) => {
      if (current.conversationId !== conversationId) {
        return { conversationId, messageId: candidate };
      }
      if ((current.messageId === null && candidate !== null) || !boundaryIsVisible) {
        return { conversationId, messageId: candidate };
      }
      return current;
    });
  }, [boundaryIsVisible, candidate, conversationId]);

  return boundary.conversationId === conversationId ? boundary.messageId : candidate;
}

export function UnreadDivider({ conversationId }: { readonly conversationId: string }) {
  return (
    <div
      className="unread-divider"
      id={`unread-${conversationId}`}
      role="separator"
      aria-label="New messages"
    >
      <span>New messages</span>
    </div>
  );
}
