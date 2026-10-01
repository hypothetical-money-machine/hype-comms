import { Fragment, memo, useMemo, type ComponentProps } from "react";
import type {
  Attachment,
  Message,
  Reaction,
  TimestampFormatPreference,
  User,
} from "@hype-comms/contracts";
import type { ChannelReferenceTarget } from "./channel-references";
import { MessageDateSeparator, shouldShowDateSeparator } from "./message-date-separator";
import { isMessageContinuation, messageGroupFlags } from "./message-grouping";
import { MessageRow, PendingMessageRow } from "./message-row";
import { UnreadDivider } from "./unread-divider";
import type { OutboxItem } from "./workspace-cache";
import type { WorkspaceRuntime } from "./workspace-runtime";

export interface MessageTimelineContext {
  readonly members: readonly User[];
  readonly currentUser: User;
  readonly reactions: ReadonlyMap<string, readonly Reaction[]>;
  readonly attachments: ReadonlyMap<string, readonly Attachment[]>;
  readonly archived: boolean;
  readonly timestampFormat: TimestampFormatPreference;
  readonly channelReferences: readonly ChannelReferenceTarget[];
  readonly onOpenChannel: (conversationId: string) => void;
  readonly actions: Pick<
    WorkspaceRuntime,
    | "openFile"
    | "addReaction"
    | "removeReaction"
    | "retractMessage"
    | "retryMessage"
    | "discardMessage"
    | "openThread"
  >;
}

const NO_REACTIONS: readonly Reaction[] = [];
const NO_ATTACHMENTS: readonly Attachment[] = [];

type TimelineMessageRowProps = Omit<
  ComponentProps<typeof MessageRow>,
  | "onAddReaction"
  | "onRemoveReaction"
  | "onOpenAttachment"
  | "onCreateTask"
  | "onRetract"
  | "onOpenThread"
> & {
  readonly runtime: Pick<
    WorkspaceRuntime,
    "addReaction" | "removeReaction" | "openFile" | "retractMessage" | "openThread"
  >;
  readonly onCreateTask?: ((message: Message) => Promise<void>) | undefined;
  readonly threadAvailable: boolean;
};

// Bind row actions inside the memo boundary so composer and scroll state changes do not
// rerender unchanged message bodies and controls. All data and capability props stay compared.
export const TimelineMessageRow = memo(function TimelineMessageRow({
  runtime,
  onCreateTask,
  threadAvailable,
  ...props
}: TimelineMessageRowProps) {
  return (
    <MessageRow
      {...props}
      onOpenAttachment={(attachmentId) => runtime.openFile(attachmentId)}
      onAddReaction={(emoji) => runtime.addReaction(props.message.id, emoji)}
      onRemoveReaction={(emoji) => runtime.removeReaction(props.message.id, emoji)}
      onCreateTask={onCreateTask === undefined ? undefined : () => onCreateTask(props.message)}
      onRetract={() => runtime.retractMessage(props.message.id)}
      onOpenThread={threadAvailable ? () => void runtime.openThread(props.message.id) : undefined}
    />
  );
});

export function WorkspaceMessageRow({
  context,
  message,
  highlightedId,
  continuation = false,
  domIdPrefix = "message",
  onCreateTask,
  reply,
}: {
  readonly context: MessageTimelineContext;
  readonly message: Message;
  readonly highlightedId: string | null;
  readonly continuation?: boolean;
  readonly domIdPrefix?: "message" | "thread-message" | undefined;
  readonly onCreateTask?: ((message: Message) => Promise<void>) | undefined;
  readonly reply?: { readonly count: number; readonly available: boolean } | undefined;
}) {
  return (
    <TimelineMessageRow
      message={message}
      runtime={context.actions}
      members={context.members}
      reactions={context.reactions.get(message.id) ?? NO_REACTIONS}
      attachments={context.attachments.get(message.id) ?? NO_ATTACHMENTS}
      currentUserId={context.currentUser.id}
      reactionsDisabled={context.archived}
      onCreateTask={onCreateTask}
      highlighted={message.id === highlightedId}
      continuation={continuation}
      timestampFormat={context.timestampFormat}
      domIdPrefix={domIdPrefix}
      channelReferences={context.channelReferences}
      onOpenChannel={context.onOpenChannel}
      replyCount={reply?.count}
      threadAvailable={reply?.available ?? false}
    />
  );
}

/** Shared ordered rows. Root summaries, task creation, unread markers and draft editing are pane policy. */
export function MessageTimeline({
  context,
  messages,
  pending,
  groupConsecutive,
  highlightedId,
  editingId,
  onEditPending,
  domIdPrefix,
  unread,
  onCreateTask,
  replyFor,
  pendingTimestampFallback = null,
}: {
  readonly context: MessageTimelineContext;
  readonly messages: readonly Message[];
  readonly pending: readonly OutboxItem[];
  readonly groupConsecutive: boolean;
  readonly highlightedId: string | null;
  readonly editingId: string | null;
  readonly onEditPending: (item: OutboxItem) => void;
  readonly domIdPrefix?: "message" | "thread-message" | undefined;
  readonly unread?:
    { readonly conversationId: string; readonly messageId: string | null } | undefined;
  readonly onCreateTask?: ((message: Message) => Promise<void>) | undefined;
  readonly replyFor?: (message: Message) => {
    readonly count: number;
    readonly available: boolean;
  };
  readonly pendingTimestampFallback?: string | null;
}) {
  const timelineGrouping = useMemo(
    () => messageGroupFlags(messages, groupConsecutive),
    [messages, groupConsecutive],
  );
  return (
    <>
      {messages.map((message, index) => (
        <Fragment key={message.id}>
          {timelineGrouping[index]?.showDateSeparator === true && (
            <MessageDateSeparator value={message.createdAt} />
          )}
          {unread?.messageId === message.id && (
            <UnreadDivider conversationId={unread.conversationId} />
          )}
          <WorkspaceMessageRow
            context={context}
            message={message}
            highlightedId={highlightedId}
            continuation={timelineGrouping[index]?.continuation === true}
            domIdPrefix={domIdPrefix}
            onCreateTask={onCreateTask}
            reply={replyFor?.(message)}
          />
        </Fragment>
      ))}
      {pending.map((item, index) => {
        const previousPending = pending[index - 1];
        const previous =
          previousPending === undefined
            ? (messages.at(-1) ?? null)
            : {
                authorId: context.currentUser.id,
                createdAt: previousPending.createdAt,
                conversationSequence: null,
              };
        const previousTimestamp = previous?.createdAt ?? pendingTimestampFallback;
        return (
          <Fragment key={item.operation.message.clientMessageId}>
            {shouldShowDateSeparator(item.createdAt, previousTimestamp) && (
              <MessageDateSeparator value={item.createdAt} />
            )}
            <PendingMessageRow
              item={item}
              currentUser={context.currentUser}
              members={context.members}
              continuation={
                groupConsecutive &&
                isMessageContinuation(
                  {
                    authorId: context.currentUser.id,
                    createdAt: item.createdAt,
                    conversationSequence: null,
                  },
                  previous,
                )
              }
              timestampFormat={context.timestampFormat}
              editing={editingId === item.operation.message.clientMessageId}
              mutationsDisabled={context.archived}
              onEdit={() => onEditPending(item)}
              onRetry={() =>
                void context.actions.retryMessage(item.operation.message.clientMessageId)
              }
              onDiscard={() =>
                void context.actions.discardMessage(item.operation.message.clientMessageId)
              }
              channelReferences={context.channelReferences}
              onOpenChannel={context.onOpenChannel}
            />
          </Fragment>
        );
      })}
    </>
  );
}
