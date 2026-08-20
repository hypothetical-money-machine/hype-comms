import type {
  ChannelAccess,
  ChannelMode,
  ConversationKind,
  ConversationSummary,
} from "@hype-comms/contracts";

export type UnreadSection = "mention" | "unread";

export interface UnreadConversationItem {
  readonly conversationId: string;
  readonly name: string;
  readonly kind: ConversationKind;
  readonly access: ChannelAccess | null;
  readonly channelMode: ChannelMode | null;
  readonly isArchived: boolean;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: string | null;
  readonly section: UnreadSection;
}

const PREVIEW_MAX_LENGTH = 120;

export function lastMessagePreview(body: string, deletedAt: string | null): string | null {
  if (deletedAt !== null) return null;
  const collapsed = body.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return null;
  if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function unreadConversationName(
  summary: ConversationSummary,
  conversationName: (summary: ConversationSummary) => string,
): string {
  if (summary.conversation.kind === "channel") {
    return summary.conversation.name ?? summary.conversation.slug ?? "channel";
  }
  return conversationName(summary);
}

function compareUnreadItems(left: UnreadConversationItem, right: UnreadConversationItem): number {
  if (left.section !== right.section) {
    return left.section === "mention" ? -1 : 1;
  }
  const leftAt = left.lastMessageAt ?? "";
  const rightAt = right.lastMessageAt ?? "";
  if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
  return left.name.localeCompare(right.name);
}

/**
 * Projects the server-authoritative conversation unread and mention counts into a catch-up list.
 * Mentions come first; ordinary unreads follow. This is not a second unread model.
 */
export function listUnreadConversations(
  summaries: readonly ConversationSummary[],
  conversationName: (summary: ConversationSummary) => string,
): readonly UnreadConversationItem[] {
  const items: UnreadConversationItem[] = [];
  for (const summary of summaries) {
    if (summary.unreadCount <= 0 && summary.mentionCount <= 0) continue;
    const last = summary.lastMessage;
    items.push({
      conversationId: summary.conversation.id,
      name: unreadConversationName(summary, conversationName),
      kind: summary.conversation.kind,
      access: summary.conversation.access,
      channelMode: summary.conversation.channelMode,
      isArchived: summary.conversation.isArchived,
      unreadCount: summary.unreadCount,
      mentionCount: summary.mentionCount,
      lastMessagePreview: last === null ? null : lastMessagePreview(last.body, last.deletedAt),
      lastMessageAt: last?.createdAt ?? summary.conversation.updatedAt,
      section: summary.mentionCount > 0 ? "mention" : "unread",
    });
  }
  return items.sort(compareUnreadItems);
}

export function unreadBadgeTotals(items: readonly UnreadConversationItem[]): {
  readonly unreadCount: number;
  readonly mentionCount: number;
} {
  let unreadCount = 0;
  let mentionCount = 0;
  for (const item of items) {
    unreadCount += item.unreadCount;
    mentionCount += item.mentionCount;
  }
  return { unreadCount, mentionCount };
}
