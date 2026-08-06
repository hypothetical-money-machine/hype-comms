const BOTTOM_THRESHOLD = 48;
const EDGE_TOLERANCE = 1;

export interface MessageVisibilityMemory {
  readonly observedStarts: Set<string>;
  readonly observedEnds: Set<string>;
}

export function isTimelineAtBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
}

export function lastReadEligibleMessageId(
  container: HTMLElement,
  memory: MessageVisibilityMemory,
  lastReadConversationSequence: string | null,
): string | null {
  const viewport = container.getBoundingClientRect();
  const lastReadSequence = BigInt(lastReadConversationSequence ?? "0");
  let lastVisible: string | null = null;
  for (const message of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const messageId = message.dataset.messageId;
    const conversationSequence = message.dataset.messageSequence;
    if (messageId === undefined || conversationSequence === undefined) continue;
    const bounds = message.getBoundingClientRect();
    if (
      bounds.top >= viewport.top - EDGE_TOLERANCE &&
      bounds.top < viewport.bottom + EDGE_TOLERANCE
    ) {
      memory.observedStarts.add(messageId);
    }
    if (bounds.bottom > viewport.top && bounds.bottom <= viewport.bottom + EDGE_TOLERANCE) {
      memory.observedEnds.add(messageId);
    }
    if (BigInt(conversationSequence) <= lastReadSequence) continue;
    if (!memory.observedStarts.has(messageId) || !memory.observedEnds.has(messageId)) break;
    lastVisible = messageId;
  }
  return lastVisible;
}
