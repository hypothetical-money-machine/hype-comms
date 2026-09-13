import { useEffect, useState } from "react";
import type {
  Attachment,
  Message,
  Reaction,
  ReactionEmoji,
  TimestampFormatPreference,
  User,
} from "@hype-comms/contracts";
import { Avatar } from "./avatar";
import { missingAuthorName } from "./built-in-channels";
import type { ChannelReferenceTarget } from "./channel-references";
import { MessageBody } from "./message-body";
import { MessageReactions } from "./message-reactions";
import { canRetractOwnMessage, retractWindowRemainingMs } from "./message-retract";
import type { OutboxItem } from "./workspace-cache";

const messageTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function messageTimeFormatter(
  format: TimestampFormatPreference,
  locale?: Intl.LocalesArgument,
): Intl.DateTimeFormat {
  const key = `${format}\u0000${locale === undefined ? "" : JSON.stringify(locale)}`;
  const cached = messageTimeFormatters.get(key);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(format === "system"
      ? {}
      : { hourCycle: format === "12-hour" ? ("h12" as const) : ("h23" as const) }),
  });
  messageTimeFormatters.set(key, formatter);
  return formatter;
}

export function formatMessageTime(
  value: string,
  format: TimestampFormatPreference,
  locale?: Intl.LocalesArgument,
): string {
  return messageTimeFormatter(format, locale).format(new Date(value));
}

const PARTICIPANT_COLOR_COUNT = 8;

export function participantColorIndex(userId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % PARTICIPANT_COLOR_COUNT;
}

export function MessageRow({
  message,
  members,
  reactions,
  attachments = [],
  currentUserId,
  reactionsDisabled,
  onAddReaction,
  onRemoveReaction,
  onOpenAttachment,
  onCreateTask,
  onRetract,
  highlighted,
  continuation,
  onOpenThread,
  replyCount = 0,
  domIdPrefix = "message",
  channelReferences,
  onOpenChannel,
  timestampFormat = "system",
}: {
  readonly message: Message;
  readonly members: readonly User[];
  readonly reactions: readonly Reaction[];
  readonly attachments?: readonly Attachment[];
  readonly currentUserId: string;
  readonly reactionsDisabled: boolean;
  readonly onAddReaction: (emoji: ReactionEmoji) => Promise<void>;
  readonly onRemoveReaction: (emoji: ReactionEmoji) => Promise<void>;
  readonly onOpenAttachment?: (attachmentId: string) => Promise<void>;
  readonly onCreateTask?: (() => Promise<void>) | undefined;
  readonly onRetract?: () => Promise<void>;
  readonly highlighted: boolean;
  readonly continuation: boolean;
  readonly onOpenThread?: (() => void) | undefined;
  readonly replyCount?: number | undefined;
  readonly domIdPrefix?: string | undefined;
  readonly channelReferences?: readonly ChannelReferenceTarget[];
  readonly onOpenChannel?: (conversationId: string) => void;
  readonly timestampFormat?: TimestampFormatPreference;
}) {
  const author = members.find((member) => member.id === message.authorId);
  const authorName = author?.displayName ?? missingAuthorName(message.authorId);
  const participantId = message.authorId ?? "former-member";
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [retracting, setRetracting] = useState(false);
  const [retractError, setRetractError] = useState("");
  const retractVisible =
    onRetract !== undefined && canRetractOwnMessage(message, currentUserId, nowMs);
  useEffect(() => {
    if (!retractVisible) return;
    const remaining = retractWindowRemainingMs(message.createdAt, nowMs);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [message.createdAt, nowMs, retractVisible]);
  const threadActionLabel =
    replyCount === 0
      ? "Reply in thread"
      : `Open thread with ${String(replyCount)} ${replyCount === 1 ? "reply" : "replies"}`;
  const threadSummaryLabel = `${String(replyCount)} ${replyCount === 1 ? "reply" : "replies"}`;
  const threadSummaryAccessibilityLabel = `Open thread with ${threadSummaryLabel} for message from ${authorName}`;
  return (
    <article
      className={`message participant-color-${String(participantColorIndex(participantId))}${continuation ? " message-continuation" : ""}${
        highlighted ? " search-target" : ""
      }`}
      id={`${domIdPrefix}-${message.id}`}
      data-message-id={message.id}
      data-message-sequence={message.conversationSequence}
    >
      {continuation ? (
        <time className="message-continuation-time" dateTime={message.createdAt} aria-hidden="true">
          {formatMessageTime(message.createdAt, timestampFormat)}
        </time>
      ) : (
        <Avatar user={author} />
      )}
      <div>
        <header className={continuation ? "sr-only" : undefined}>
          <strong>{authorName}</strong>
          {author?.title != null && <span className="message-author-title">{author.title}</span>}
          <time dateTime={message.createdAt}>
            {formatMessageTime(message.createdAt, timestampFormat)}
          </time>
        </header>
        <MessageBody
          body={message.body}
          channels={channelReferences}
          members={members}
          onOpenChannel={onOpenChannel}
        />
        {attachments.length > 0 && (
          <ul className="message-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  type="button"
                  className="message-attachment"
                  onClick={() => void onOpenAttachment?.(attachment.id)}
                >
                  <span>{attachment.fileName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <MessageReactions
          reactions={reactions}
          members={members}
          currentUserId={currentUserId}
          disabled={reactionsDisabled}
          onAdd={onAddReaction}
          onRemove={onRemoveReaction}
          leadingActions={
            onOpenThread === undefined ? undefined : (
              <button
                className="message-reply-action"
                type="button"
                aria-label={threadActionLabel}
                title={threadActionLabel}
                onClick={onOpenThread}
              >
                <svg aria-hidden="true" viewBox="0 0 20 20">
                  <path d="M4 4.5h12v8H9l-4 3v-3H4z" />
                  <path d="M7 8.5h6" />
                </svg>
                {replyCount > 0 && <span aria-hidden="true">{replyCount}</span>}
              </button>
            )
          }
          trailingActions={
            onCreateTask === undefined && !retractVisible ? undefined : (
              <>
                {onCreateTask === undefined ? undefined : (
                  <button
                    className="message-task-action"
                    type="button"
                    onClick={() => void onCreateTask()}
                  >
                    + Task
                  </button>
                )}
                {retractVisible ? (
                  <button
                    className="message-retract-action"
                    type="button"
                    disabled={retracting}
                    aria-label="Retract message"
                    title="Retract this message. It disappears for everyone. Available for five minutes."
                    onClick={() => {
                      if (onRetract === undefined || retracting) return;
                      setRetracting(true);
                      setRetractError("");
                      void onRetract()
                        .catch((caught: unknown) => {
                          setRetractError(
                            caught instanceof Error && caught.message !== ""
                              ? caught.message
                              : "Could not retract the message",
                          );
                        })
                        .finally(() => setRetracting(false));
                    }}
                  >
                    Retract
                  </button>
                ) : null}
              </>
            )
          }
        />
        {replyCount > 0 && onOpenThread !== undefined && (
          <button
            className="thread-summary"
            type="button"
            aria-label={threadSummaryAccessibilityLabel}
            onClick={onOpenThread}
          >
            {threadSummaryLabel}
          </button>
        )}
        {retractError !== "" && (
          <p className="retract-error" role="alert">
            {retractError}
          </p>
        )}
      </div>
    </article>
  );
}

export function PendingMessageRow({
  item,
  currentUser,
  members = [],
  continuation,
  editing,
  onEdit,
  onRetry,
  onDiscard,
  mutationsDisabled = false,
  channelReferences,
  onOpenChannel,
  timestampFormat = "system",
}: {
  readonly item: OutboxItem;
  readonly currentUser: User;
  readonly members?: readonly User[];
  readonly continuation: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
  readonly mutationsDisabled?: boolean;
  readonly channelReferences?: readonly ChannelReferenceTarget[];
  readonly onOpenChannel?: (conversationId: string) => void;
  readonly timestampFormat?: TimestampFormatPreference;
}) {
  const pendingStatus = editing ? "editing" : item.status.replaceAll("_", " ");
  return (
    <article
      className={`message participant-color-${String(participantColorIndex(currentUser.id))} pending-message${continuation ? " message-continuation" : ""}`}
    >
      {continuation ? (
        <time className="message-continuation-time" dateTime={item.createdAt} aria-hidden="true">
          {formatMessageTime(item.createdAt, timestampFormat)}
        </time>
      ) : (
        <Avatar user={currentUser} />
      )}
      <div>
        <header className={continuation ? "sr-only" : undefined}>
          <strong>{currentUser.displayName}</strong>
          <span>{pendingStatus}</span>
        </header>
        <MessageBody
          body={item.operation.message.body}
          channels={channelReferences}
          members={members}
          onOpenChannel={onOpenChannel}
          suffix={
            continuation ? <span className="pending-status"> · {pendingStatus}</span> : undefined
          }
        />
        {item.status === "permanent_failure" && (
          <div className="message-actions">
            <button type="button" disabled={mutationsDisabled} onClick={onEdit}>
              Edit
            </button>
            <button type="button" disabled={mutationsDisabled} onClick={onRetry}>
              Retry
            </button>
            <button type="button" onClick={onDiscard}>
              Discard
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
