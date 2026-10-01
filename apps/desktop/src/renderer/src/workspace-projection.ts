import {
  conversationSummarySchema,
  messageSchema,
  type ConversationSummary,
  type Message,
  type MessageThreadSummary,
  type Reaction,
  type Task,
  type User,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hype-comms/contracts";

/** Deterministic entity rules. Storage, retries, cancellation and event deduplication belong to callers. */
type MembershipChangedEvent = Extract<WorkspaceEvent, { type: "channel.membership_changed" }>;

/** Bounds tombstones retained to defeat stale responses after message eviction. */
export const MAX_RETRACT_RESERVATIONS = 20_000;

export interface RetractReservation {
  readonly messageId: string;
  readonly deletedAt: string;
  readonly entityVersion: number;
}

/** Called once per accepted event, after the caller's position and duplicate checks. */
export function projectCreatedMessageSummary(
  summary: ConversationSummary,
  message: Message,
  currentUserId: string,
  mentionedUserIds: readonly string[],
): ConversationSummary {
  if (message.deletedAt !== null) return summary;
  const fromAnotherMember = message.authorId !== currentUserId;
  return conversationSummarySchema.parse({
    ...summary,
    lastMessage: message,
    unreadCount: summary.unreadCount + (fromAnotherMember ? 1 : 0),
    mentionCount:
      summary.mentionCount +
      (fromAnotherMember && mentionedUserIds.includes(currentUserId) ? 1 : 0),
  });
}

export function projectReadCursorSummary(
  summary: ConversationSummary,
  event: Extract<WorkspaceEvent, { type: "read_cursor.updated" }>,
): ConversationSummary {
  return conversationSummarySchema.parse({
    ...summary,
    readCursor: event.payload.readCursor,
    unreadCount: event.payload.unreadCount ?? summary.unreadCount,
    mentionCount: event.payload.mentionCount ?? summary.mentionCount,
  });
}

export function projectConversationSummary(
  current: ConversationSummary | undefined | null,
  event: Extract<
    WorkspaceEvent,
    { type: "channel.created" | "channel.archived" | "direct_conversation.created" }
  >,
  currentUserId: string,
): ConversationSummary {
  return conversationSummarySchema.parse({
    conversation: event.payload.conversation,
    participantIds: event.payload.participantIds,
    membershipRole: membershipRoleForConversationEvent(
      event.payload.conversation,
      current?.membershipRole,
      currentUserId,
    ),
    lastMessage: current?.lastMessage ?? null,
    unreadCount: current?.unreadCount ?? 0,
    mentionCount: current?.mentionCount ?? 0,
    readCursor: current?.readCursor ?? null,
  });
}

/** Works on IndexedDB's indexed version as well as decrypted task records. */
export function acceptsTaskVersion(
  currentVersion: number | undefined,
  incomingVersion: number,
): boolean {
  return currentVersion === undefined || incomingVersion >= currentVersion;
}

export function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function projectConversationMembershipChange(
  summary: ConversationSummary,
  event: MembershipChangedEvent,
): ConversationSummary {
  const participantIds =
    event.payload.action === "added"
      ? [...new Set([...summary.participantIds, event.payload.memberId])].sort(compareText)
      : event.payload.action === "removed"
        ? summary.participantIds.filter((memberId) => memberId !== event.payload.memberId)
        : summary.participantIds;
  return conversationSummarySchema.parse({ ...summary, participantIds });
}

/**
 * Sequences are decimal strings, so IndexedDB's lexicographic index order is not the numeric
 * order the UI needs ("10" sorts before "9"). Every read therefore sorts numerically in JS; the
 * stored index exists for lookups, not for ordering.
 */
export function compareMessages(left: Message, right: Message): number {
  return compareSequence(left.conversationSequence, right.conversationSequence);
}

export function isUnreadMessage(
  summary: ConversationSummary,
  currentUserId: string,
  message: Message,
): boolean {
  return (
    message.authorId !== currentUserId &&
    (summary.readCursor === null ||
      compareSequence(
        message.conversationSequence,
        summary.readCursor.lastReadConversationSequence,
      ) > 0)
  );
}

export function newestLiveMessage(
  messages: readonly Message[],
  conversationId: string,
): Message | null {
  let newest: Message | null = null;
  for (const message of messages) {
    if (message.conversationId !== conversationId || message.deletedAt !== null) continue;
    if (
      newest === null ||
      compareSequence(message.conversationSequence, newest.conversationSequence) > 0
    ) {
      newest = message;
    }
  }
  return newest;
}

export function reconcileRetractedConversationSummary(
  summary: ConversationSummary,
  source: Message,
  messages: readonly Message[],
  currentUser: User | null,
  mentionedUserIds: readonly string[],
): ConversationSummary {
  // `applyEvent()` rejects duplicate event IDs and stale cursors before this runs. A history page
  // can have already supplied the tombstone, so the event—not `source.deletedAt`—is the
  // exactly-once boundary for its unread and mention contribution.
  const unread = currentUser !== null && isUnreadMessage(summary, currentUser.id, source);
  const mentioned = currentUser !== null && unread && mentionedUserIds.includes(currentUser.id);
  return conversationSummarySchema.parse({
    ...summary,
    ...(summary.lastMessage?.id === source.id
      ? { lastMessage: newestLiveMessage(messages, summary.conversation.id) }
      : {}),
    unreadCount: Math.max(0, summary.unreadCount - (unread ? 1 : 0)),
    mentionCount: Math.max(0, summary.mentionCount - (mentioned ? 1 : 0)),
  });
}

export function compareReactions(left: Reaction, right: Reaction): number {
  const byMessage = compareText(left.messageId, right.messageId);
  if (byMessage !== 0) return byMessage;
  const byCreatedAt = compareText(left.createdAt, right.createdAt);
  return byCreatedAt !== 0 ? byCreatedAt : compareText(left.id, right.id);
}

export function compareTasks(left: Task, right: Task): number {
  const byConversation = compareText(left.conversationId, right.conversationId);
  if (byConversation !== 0) return byConversation;
  const statuses: Record<Task["status"], number> = { todo: 0, in_progress: 1, done: 2 };
  const byStatus = statuses[left.status] - statuses[right.status];
  if (byStatus !== 0) return byStatus;
  const byRank = compareSequence(left.rank, right.rank);
  return byRank !== 0 ? byRank : compareText(left.id, right.id);
}

/**
 * Mirrors the server's `ORDER BY lower(display_name), id`. Exported so the runtime's in-memory
 * projection orders realtime-delivered rows the same way a cold `load()` does, instead of growing a
 * second ordering that drifts from this one.
 */
export function compareMembers(left: User, right: User): number {
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  const byName = leftName.localeCompare(rightName);
  return byName !== 0 ? byName : compareText(left.id, right.id);
}

/**
 * Mirrors the server's `ORDER BY kind, lower(coalesce(name, '')), created_at, id`. Exported for the
 * same reason as {@link compareMembers}.
 */
export function compareConversations(
  left: ConversationSummary,
  right: ConversationSummary,
): number {
  const byKind = compareText(left.conversation.kind, right.conversation.kind);
  if (byKind !== 0) return byKind;
  const leftName = (left.conversation.name ?? "").toLowerCase();
  const rightName = (right.conversation.name ?? "").toLowerCase();
  const byName = leftName.localeCompare(rightName);
  if (byName !== 0) return byName;
  const byCreatedAt = compareText(left.conversation.createdAt, right.conversation.createdAt);
  return byCreatedAt !== 0 ? byCreatedAt : compareText(left.conversation.id, right.conversation.id);
}

export function tombstoneMessage(
  message: Message,
  event: Extract<WorkspaceEvent, { type: "message.retracted" }>,
): Message {
  return messageSchema.parse({
    ...message,
    deletedAt: event.payload.deletedAt,
    version: event.entityVersion,
    updatedAt: event.payload.deletedAt,
  });
}

export function preferRetainedMessage(current: Message | undefined, incoming: Message): Message {
  if (current === undefined) return incoming;
  if (current.deletedAt !== null && incoming.deletedAt === null) return current;
  if (incoming.version < current.version) return current;
  return incoming;
}

export function retractReservationMap(
  reservations: readonly RetractReservation[],
): Map<string, RetractReservation> {
  return new Map(reservations.map((reservation) => [reservation.messageId, reservation]));
}

export function upsertRetractReservation(
  reservations: readonly RetractReservation[],
  reservation: RetractReservation,
): RetractReservation[] {
  const next = retractReservationMap(reservations);
  const current = next.get(reservation.messageId);
  if (current !== undefined && current.entityVersion > reservation.entityVersion) {
    return trimRetractReservations([...next.values()]);
  }
  next.delete(reservation.messageId);
  next.set(reservation.messageId, reservation);
  return trimRetractReservations([...next.values()]);
}

export function trimRetractReservations(
  reservations: readonly RetractReservation[],
): RetractReservation[] {
  if (reservations.length <= MAX_RETRACT_RESERVATIONS) return [...reservations];
  return reservations.slice(-MAX_RETRACT_RESERVATIONS);
}

/**
 * A DELETE response contains the same durable tombstone facts as a later realtime retract event.
 * Record them immediately so an in-flight history or snapshot response cannot bring the live body
 * back before that event reaches this device.
 */
export function reserveTombstonedMessages(
  reservations: readonly RetractReservation[],
  messages: readonly Message[],
): RetractReservation[] {
  let next = [...reservations];
  for (const message of messages) {
    if (message.deletedAt === null) continue;
    next = upsertRetractReservation(next, {
      messageId: message.id,
      deletedAt: message.deletedAt,
      entityVersion: message.version,
    });
  }
  return next;
}

export function retractedMessageIds(
  messages: readonly Message[],
  reservations: ReadonlyMap<string, RetractReservation>,
): ReadonlySet<string> {
  const ids = new Set(reservations.keys());
  for (const message of messages) {
    if (message.deletedAt !== null) ids.add(message.id);
  }
  return ids;
}

export function applyRetractReservation(
  message: Message,
  reservations: ReadonlyMap<string, RetractReservation>,
): Message {
  const reservation = reservations.get(message.id);
  if (reservation === undefined) return message;
  const tombstone = messageSchema.parse({
    ...message,
    deletedAt: reservation.deletedAt,
    version: reservation.entityVersion,
    updatedAt: reservation.deletedAt,
  });
  if (message.deletedAt !== null) return preferRetainedMessage(message, tombstone);
  return tombstone;
}

export function applyRetractReservationsToMessages(
  messages: readonly Message[],
  reservations: ReadonlyMap<string, RetractReservation>,
): Message[] {
  if (reservations.size === 0) return [...messages];
  return messages.map((message) => applyRetractReservation(message, reservations));
}

export function applyRetractReservationsToConversations(
  conversations: readonly ConversationSummary[],
  reservations: ReadonlyMap<string, RetractReservation>,
): ConversationSummary[] {
  if (reservations.size === 0) return [...conversations];
  return conversations.map((summary) => {
    if (summary.lastMessage === null) return summary;
    const lastMessage = applyRetractReservation(summary.lastMessage, reservations);
    return lastMessage === summary.lastMessage ? summary : { ...summary, lastMessage };
  });
}

export function mergeConversationProjection(
  incoming: ConversationSummary,
  current: ConversationSummary | null,
): ConversationSummary {
  if (current === null) return incoming;
  const currentLast = current.lastMessage;
  const incomingLast = incoming.lastMessage;
  const lastMessage =
    currentLast !== null &&
    (incomingLast === null ||
      compareSequence(currentLast.conversationSequence, incomingLast.conversationSequence) >= 0)
      ? currentLast
      : incomingLast;
  const currentRead = current.readCursor;
  const incomingRead = incoming.readCursor;
  const readCursor =
    currentRead !== null &&
    (incomingRead === null ||
      compareSequence(
        currentRead.lastReadConversationSequence,
        incomingRead.lastReadConversationSequence,
      ) >= 0)
      ? currentRead
      : incomingRead;
  return conversationSummarySchema.parse({
    ...incoming,
    lastMessage,
    unreadCount: current.unreadCount,
    mentionCount: current.mentionCount,
    readCursor,
  });
}

/** Group creation events have a fixed audience but no recipient-specific membership role. */
export function membershipRoleForConversationEvent(
  conversation: ConversationSummary["conversation"],
  retainedRole: ConversationSummary["membershipRole"] | null | undefined,
  currentUserId: string,
): ConversationSummary["membershipRole"] {
  if (retainedRole !== null && retainedRole !== undefined) return retainedRole;
  if (conversation.kind !== "group_direct_message") return null;
  return conversation.createdBy === currentUserId ? "owner" : "member";
}

/**
 * Merges server-derived messages into the in-memory projection using the same ordering the cache
 * uses, so incremental application and a cold `load()` agree.
 */
export function mergeMessages(
  messages: readonly Message[],
  incoming: readonly Message[],
): readonly Message[] {
  if (incoming.length === 0) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, preferRetainedMessage(byId.get(message.id), message));
  }
  return [...byId.values()].sort((left, right) =>
    compareSequence(left.conversationSequence, right.conversationSequence),
  );
}

export function mergeThreadSummaries(
  summaries: readonly MessageThreadSummary[],
  incoming: readonly MessageThreadSummary[],
): readonly MessageThreadSummary[] {
  if (incoming.length === 0) return summaries;
  const byRootId = new Map(summaries.map((summary) => [summary.threadRootId, summary]));
  for (const summary of incoming) {
    const existing = byRootId.get(summary.threadRootId);
    if (
      existing === undefined ||
      compareSequence(
        summary.latestReply.conversationSequence,
        existing.latestReply.conversationSequence,
      ) >= 0
    ) {
      byRootId.set(summary.threadRootId, summary);
    }
  }
  return [...byRootId.values()];
}

export function projectReplySummary(
  summaries: readonly MessageThreadSummary[],
  message: Message,
  newlyObserved: boolean,
): readonly MessageThreadSummary[] {
  const threadRootId = message.threadRootId;
  if (threadRootId === null) return summaries;
  const existing = summaries.find((summary) => summary.threadRootId === threadRootId);
  if (existing === undefined) {
    return [...summaries, { threadRootId, replyCount: 1, latestReply: message }];
  }
  // HTTP responses, realtime, and sync can expose distinct replies out of conversation order.
  // Identity decides whether the total grows; sequence decides only which reply is latest.
  const replacesLatest =
    compareSequence(message.conversationSequence, existing.latestReply.conversationSequence) > 0;
  const incrementsCount = newlyObserved && message.id !== existing.latestReply.id;
  if (!replacesLatest && !incrementsCount) return summaries;
  return summaries.map((summary) =>
    summary.threadRootId === threadRootId
      ? {
          ...summary,
          replyCount: summary.replyCount + (incrementsCount ? 1 : 0),
          latestReply: replacesLatest ? message : summary.latestReply,
        }
      : summary,
  );
}

export function mergeReactions(
  reactions: readonly Reaction[],
  incoming: readonly Reaction[],
): readonly Reaction[] {
  if (incoming.length === 0) return reactions;
  const byId = new Map(reactions.map((reaction) => [reaction.id, reaction]));
  for (const reaction of incoming) byId.set(reaction.id, reaction);
  return [...byId.values()];
}

export function mergeTasks(tasks: readonly Task[], incoming: readonly Task[]): readonly Task[] {
  if (incoming.length === 0) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of incoming) {
    const current = byId.get(task.id);
    if (acceptsTaskVersion(current?.version, task.version)) byId.set(task.id, task);
  }
  return [...byId.values()].sort(compareTasks);
}

export function replaceMessageReactions(
  reactions: readonly Reaction[],
  messageIds: readonly string[],
  incoming: readonly Reaction[],
): readonly Reaction[] {
  const replaced = new Set(messageIds);
  return mergeReactions(
    reactions.filter((reaction) => !replaced.has(reaction.messageId)),
    incoming,
  );
}

export function replaceConversation(
  snapshot: WorkspaceSnapshot,
  conversationId: string,
  update: (current: ConversationSummary | undefined) => ConversationSummary | null,
): WorkspaceSnapshot {
  const index = snapshot.conversations.findIndex(
    (summary) => summary.conversation.id === conversationId,
  );
  const next = update(snapshot.conversations[index]);
  if (next === null) return snapshot;
  const conversations = [...snapshot.conversations];
  if (index === -1) conversations.push(next);
  else conversations[index] = next;
  // A created conversation appends and a rename moves one, so re-sort instead of trusting the
  // previous positions: the sidebar renders this order directly and must agree with a cold load().
  return { ...snapshot, conversations: conversations.sort(compareConversations) };
}

export function newestLiveReply(
  messages: readonly Message[],
  threadRootId: string,
): Message | null {
  let newest: Message | null = null;
  for (const message of messages) {
    if (message.threadRootId !== threadRootId || message.deletedAt !== null) continue;
    if (
      newest === null ||
      compareSequence(message.conversationSequence, newest.conversationSequence) > 0
    ) {
      newest = message;
    }
  }
  return newest;
}

export function retractReplySummary(
  summaries: readonly MessageThreadSummary[],
  messages: readonly Message[],
  tombstone: Message,
): readonly MessageThreadSummary[] {
  // Deleted roots are omitted from fresh history, so their summaries must disappear with them.
  if (tombstone.threadRootId === null) {
    return summaries.filter((summary) => summary.threadRootId !== tombstone.id);
  }
  const summary = summaries.find((candidate) => candidate.threadRootId === tombstone.threadRootId);
  if (summary === undefined) return summaries;
  if (summary.latestReply.id !== tombstone.id) {
    return summaries.map((candidate) =>
      candidate.threadRootId === tombstone.threadRootId
        ? { ...candidate, replyCount: Math.max(1, candidate.replyCount - 1) }
        : candidate,
    );
  }
  const remainingReplyCount = summary.replyCount - 1;
  if (remainingReplyCount === 0) {
    return summaries.filter((candidate) => candidate.threadRootId !== tombstone.threadRootId);
  }
  const retainedLiveReplyCount = messages.filter(
    (message) => message.threadRootId === tombstone.threadRootId && message.deletedAt === null,
  ).length;
  // A partial page cannot prove which surviving server reply is latest. Drop its summary until a
  // refresh can replace it instead of promoting a reply that is known to be incomplete.
  if (retainedLiveReplyCount !== remainingReplyCount) {
    return summaries.filter((candidate) => candidate.threadRootId !== tombstone.threadRootId);
  }
  const latestReply = newestLiveReply(messages, tombstone.threadRootId);
  if (latestReply === null) {
    return summaries.filter((candidate) => candidate.threadRootId !== tombstone.threadRootId);
  }
  return summaries.map((candidate) =>
    candidate.threadRootId === tombstone.threadRootId
      ? {
          ...candidate,
          replyCount: remainingReplyCount,
          latestReply,
        }
      : candidate,
  );
}
