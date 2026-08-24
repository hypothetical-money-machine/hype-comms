import type { ChannelAccess, ChannelMode } from "@hype-comms/contracts";

export function ChannelIcon({
  access,
  channelMode,
}: {
  readonly access: ChannelAccess | null;
  readonly channelMode: ChannelMode | null;
}) {
  return (
    <>
      <span className="conversation-type-icon channel-icon" aria-hidden="true">
        {channelMode === "announcement" ? "📣" : access === "members" ? "🔒" : "#"}
      </span>
      {channelMode === "announcement" && <span className="sr-only">Announcement channel: </span>}
    </>
  );
}

export function DirectMessageIcon({ className = "" }: { readonly className?: string }) {
  const classes = ["conversation-type-icon", "direct-message-avatar", className]
    .filter((value) => value !== "")
    .join(" ");
  return (
    <span className={classes} aria-hidden="true">
      <svg viewBox="0 0 20 20" width="16" height="16" focusable="false">
        <circle cx="10" cy="7" r="3" fill="currentColor" />
        <path
          d="M4.5 16c.5-3.1 2.4-4.7 5.5-4.7s5 1.6 5.5 4.7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </svg>
    </span>
  );
}

export function GroupDirectMessageIcon({ className = "" }: { readonly className?: string }) {
  const classes = [
    "conversation-type-icon",
    "direct-message-avatar",
    "group-direct-message-avatar",
    className,
  ]
    .filter((value) => value !== "")
    .join(" ");
  return (
    <span className={classes} aria-hidden="true">
      <svg viewBox="0 0 20 20" width="16" height="16" focusable="false">
        <circle cx="7" cy="7" r="2.4" fill="currentColor" />
        <circle cx="13" cy="7.5" r="2.2" fill="currentColor" />
        <path
          d="M2.8 15.6c.4-2.7 1.9-4.1 4.5-4.1 2.5 0 4 1.4 4.4 4.1M11 12c.6-.3 1.3-.5 2.1-.5 2.3 0 3.7 1.3 4.1 3.7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
        />
      </svg>
    </span>
  );
}

export function ConversationBadge({
  unreadCount,
  mentionCount,
}: {
  readonly unreadCount: number;
  readonly mentionCount: number;
}) {
  if (unreadCount <= 0 && mentionCount <= 0) return null;

  const isMention = mentionCount > 0;
  const count = isMention ? mentionCount : unreadCount;
  const label = `${String(count)} ${isMention ? (count === 1 ? "mention" : "mentions") : count === 1 ? "unread message" : "unread messages"}`;
  return (
    <span
      className={`badge conversation-badge ${isMention ? "conversation-badge-mention" : "conversation-badge-unread"}`}
      aria-label={label}
      title={label}
    >
      {isMention ? `@${String(count)}` : count}
    </span>
  );
}
