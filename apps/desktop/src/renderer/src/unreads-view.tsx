import { ChannelIcon, ConversationBadge, DirectMessageIcon } from "./conversation-indicators";
import type { UnreadConversationItem } from "./unread-conversations";

export function UnreadsIcon({ className = "unreads-nav-icon" }: { readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3.4 5.2h13.2v10.1H3.4z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M3.4 5.2 10 10.4l6.6-5.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function formatUnreadTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function kindCaption(item: UnreadConversationItem): string {
  if (item.kind === "channel") {
    if (item.isArchived) return "Archived channel";
    if (item.channelMode === "announcement") return "Announcement channel";
    return "Channel";
  }
  return "Direct message";
}

function UnreadRow({
  item,
  onOpen,
}: {
  readonly item: UnreadConversationItem;
  readonly onOpen: (conversationId: string) => void;
}) {
  const preview = item.lastMessagePreview;
  return (
    <button type="button" className="unreads-item" onClick={() => onOpen(item.conversationId)}>
      {item.kind === "channel" ? (
        <ChannelIcon access={item.access} channelMode={item.channelMode} />
      ) : (
        <DirectMessageIcon />
      )}
      <span className="unreads-item-copy">
        <strong>{item.name}</strong>
        <span className="unreads-item-kind">{kindCaption(item)}</span>
        {preview !== null && <span className="unreads-item-preview">{preview}</span>}
      </span>
      <span className="unreads-item-meta">
        {item.lastMessageAt !== null && (
          <time dateTime={item.lastMessageAt}>{formatUnreadTime(item.lastMessageAt)}</time>
        )}
        <ConversationBadge unreadCount={item.unreadCount} mentionCount={item.mentionCount} />
      </span>
    </button>
  );
}

function UnreadSection({
  heading,
  items,
  onOpen,
}: {
  readonly heading: string;
  readonly items: readonly UnreadConversationItem[];
  readonly onOpen: (conversationId: string) => void;
}) {
  return (
    <section className="unreads-section">
      <h3 className="unreads-section-heading">{heading}</h3>
      <ol className="unreads-section-list">
        {items.map((item) => (
          <li key={item.conversationId}>
            <UnreadRow item={item} onOpen={onOpen} />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function UnreadsView({
  items,
  active,
  onOpen,
}: {
  readonly items: readonly UnreadConversationItem[];
  readonly active: boolean;
  readonly onOpen: (conversationId: string) => void;
}) {
  const mentions = items.filter((item) => item.section === "mention");
  const unreads = items.filter((item) => item.section === "unread");

  return (
    <section
      className="unreads-view"
      aria-labelledby="unreads-title"
      hidden={!active}
      data-testid="unreads-view"
    >
      <header className="unreads-header">
        <div>
          <h2 id="unreads-title">Unreads</h2>
          <p className="unreads-subtitle">
            Conversations and mentions you have not read, using the workspace unread counts.
          </p>
        </div>
      </header>
      {items.length === 0 ? (
        <div className="empty-state unreads-empty-state">
          <h3>You&apos;re caught up</h3>
          <p>When a conversation or mention is unread, it will show up here.</p>
        </div>
      ) : (
        <div className="unreads-list" role="navigation" aria-label="Unread conversations">
          {mentions.length > 0 && (
            <UnreadSection heading="Mentions" items={mentions} onOpen={onOpen} />
          )}
          {unreads.length > 0 && <UnreadSection heading="Unread" items={unreads} onOpen={onOpen} />}
        </div>
      )}
    </section>
  );
}
