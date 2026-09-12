import {
  compareSyncPositions,
  entityIdSchema,
  sameSyncPosition,
  syncPositionSchema,
  type Attachment,
  type Message,
  type MessageThreadSummary,
  type Reaction,
  type SyncPosition,
  type Task,
  type WorkspaceEvent,
} from "@hype-comms/contracts";
import {
  REALTIME_REPLAY_MAX_BYTES,
  REALTIME_REPLAY_MAX_EVENTS,
} from "@hype-comms/api-client/limits";
import { z } from "zod";
import {
  applyRetractReservation,
  mergeMessages,
  mergeReactions,
  mergeTasks,
  projectReplySummary,
  retractReplySummary,
} from "./workspace-projection";

export const collectionIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeline"), conversationId: entityIdSchema }).strict(),
  z
    .object({ kind: z.literal("thread"), conversationId: entityIdSchema, rootId: entityIdSchema })
    .strict(),
  z.object({ kind: z.literal("tasks"), conversationId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("my_tasks") }).strict(),
  z.object({ kind: z.literal("files"), conversationId: entityIdSchema }).strict(),
]);
export type CollectionIdentity = z.infer<typeof collectionIdentitySchema>;
export const collectionStateSchema = z
  .object({
    identity: collectionIdentitySchema,
    loaded: z.boolean(),
    snapshotPosition: syncPositionSchema.nullable(),
    nextCursor: z.string().max(2048).nullable(),
    invalidatedAt: syncPositionSchema.nullable(),
  })
  .strict();
export type CollectionState = z.infer<typeof collectionStateSchema>;

export function collectionKey(identity: CollectionIdentity): string {
  if (identity.kind === "my_tasks") return "my_tasks";
  return `${identity.kind}:${identity.conversationId}${identity.kind === "thread" ? `:${identity.rootId}` : ""}`;
}
export function unloadedCollection(identity: CollectionIdentity): CollectionState {
  return { identity, loaded: false, snapshotPosition: null, nextCursor: null, invalidatedAt: null };
}
export function parseCollectionStates(value: unknown): CollectionState[] {
  return value === undefined ? [] : z.array(collectionStateSchema).max(20000).parse(value);
}
export function putCollectionState(
  states: readonly CollectionState[],
  state: CollectionState,
): CollectionState[] {
  const key = collectionKey(state.identity);
  // Oldest query metadata may be forgotten: absence means not loaded and cannot certify an empty set.
  return [...states.filter((entry) => collectionKey(entry.identity) !== key).slice(-19999), state];
}
export function collectionAffected(identity: CollectionIdentity, event: WorkspaceEvent): boolean {
  if (identity.kind === "my_tasks")
    return event.type.startsWith("task.") || event.type === "channel.membership_changed";
  if (identity.conversationId !== event.conversationId) return false;
  if (event.type === "channel.membership_changed") return true;
  if (identity.kind === "tasks") return event.type.startsWith("task.");
  return event.type.startsWith("message.") || event.type.startsWith("reaction.");
}
export function invalidateCollections(
  states: readonly CollectionState[],
  event: WorkspaceEvent,
): CollectionState[] {
  let next = [...states];
  const identities: CollectionIdentity[] =
    event.conversationId === null
      ? []
      : [
          { kind: "timeline", conversationId: event.conversationId },
          { kind: "files", conversationId: event.conversationId },
          { kind: "tasks", conversationId: event.conversationId },
        ];
  if (event.type.startsWith("task.")) identities.push({ kind: "my_tasks" });
  for (const identity of identities) {
    if (
      collectionAffected(identity, event) &&
      !next.some((state) => collectionKey(state.identity) === collectionKey(identity))
    ) {
      next = putCollectionState(next, unloadedCollection(identity));
    }
  }
  return next.map((state) =>
    collectionAffected(state.identity, event) ? { ...state, invalidatedAt: event.position } : state,
  );
}

export interface CollectionCommit {
  readonly state: CollectionState;
  /** Applied global position observed immediately before the page's encrypted commit. Never advanced by this read. */
  readonly expectedPosition: SyncPosition | null;
  readonly requestCursor: string | null;
}
export class CollectionRetry extends Error {
  constructor(message = "The collection changed while its page was loading") {
    super(message);
  }
}
export function commitCollectionState(
  states: readonly CollectionState[],
  position: SyncPosition | null,
  commit: CollectionCommit,
): CollectionState[] {
  if (
    position === null
      ? commit.expectedPosition !== null
      : commit.expectedPosition === null || !sameSyncPosition(position, commit.expectedPosition)
  )
    throw new CollectionRetry();
  const state = collectionStateSchema.parse(commit.state);
  if (
    state.snapshotPosition === null ||
    (position !== null && position.epoch !== state.snapshotPosition.epoch)
  )
    throw new CollectionRetry("The collection belongs to another protocol epoch");
  const existing = states.find(
    (entry) => collectionKey(entry.identity) === collectionKey(state.identity),
  );
  if (
    commit.requestCursor !== null &&
    (existing?.loaded !== true || existing.nextCursor !== commit.requestCursor)
  )
    throw new CollectionRetry("The collection page cursor was superseded");
  if (
    existing?.snapshotPosition != null &&
    compareSyncPositions(existing.snapshotPosition, state.snapshotPosition) > 0
  )
    throw new CollectionRetry();
  const snapshotPosition =
    commit.requestCursor === null
      ? state.snapshotPosition
      : (existing?.snapshotPosition ?? state.snapshotPosition);
  const invalidatedAt = existing?.invalidatedAt;
  return putCollectionState(states, {
    ...state,
    snapshotPosition,
    invalidatedAt:
      invalidatedAt != null && compareSyncPositions(invalidatedAt, snapshotPosition) > 0
        ? invalidatedAt
        : null,
  });
}

export function assertReactionSnapshotCurrent(
  position: SyncPosition | undefined,
  commit: CollectionCommit | undefined,
): void {
  const incoming = commit?.state.snapshotPosition;
  if (position !== undefined && incoming != null && compareSyncPositions(position, incoming) > 0)
    throw new CollectionRetry("A newer reaction snapshot already covers this message");
}

/** A fetch owns its journal. Overflow retires only this fetch; ordinary event delivery continues. */
export class CollectionJournal {
  readonly #abort = new AbortController();
  get signal(): AbortSignal {
    return this.#abort.signal;
  }
  assertValid(): void {
    if (this.#failure !== null) throw this.#failure;
  }
  readonly #events = new Map<string, WorkspaceEvent>();
  #bytes = 0;
  #failure: CollectionRetry | null = null;
  constructor(
    readonly startPosition: SyncPosition | null,
    readonly identity: CollectionIdentity,
  ) {}
  record(event: WorkspaceEvent): void {
    if (this.#failure !== null || this.#events.has(event.id)) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (
      this.#events.size >= REALTIME_REPLAY_MAX_EVENTS ||
      this.#bytes + bytes > REALTIME_REPLAY_MAX_BYTES
    ) {
      this.cancel("The collection event buffer overflowed");
      return;
    }
    this.#events.set(event.id, event);
    this.#bytes += bytes;
  }
  cancel(message: string): void {
    this.#failure = new CollectionRetry(message);
    this.#events.clear();
    this.#abort.abort(this.#failure);
  }
  newerThan(position: SyncPosition): WorkspaceEvent[] {
    if (this.#failure !== null) throw this.#failure;
    if (
      this.startPosition !== null &&
      (this.startPosition.epoch !== position.epoch ||
        compareSyncPositions(position, this.startPosition) < 0)
    )
      throw new CollectionRetry("The collection read predates the applied replica");
    return [...this.#events.values()]
      .filter((event) => {
        if (event.position.epoch !== position.epoch)
          throw new CollectionRetry("The protocol epoch changed during the collection read");
        return compareSyncPositions(event.position, position) > 0;
      })
      .sort((left, right) => compareSyncPositions(left.position, right.position));
  }
}

export interface CollectionRecords {
  readonly messages: readonly Message[];
  readonly reactions: readonly Reaction[];
  readonly tasks: readonly Task[];
  readonly attachments: readonly Attachment[];
  readonly threadSummaries: readonly MessageThreadSummary[];
}
/** Replays only page records. It never writes a cursor, acknowledges an event, or projects unread counters. */
export function replayCollectionPage(
  records: CollectionRecords,
  events: readonly WorkspaceEvent[],
): CollectionRecords {
  let { messages, reactions, tasks, attachments, threadSummaries } = records;
  for (const event of events) {
    if (event.type === "reaction.added") {
      if (
        messages.some(
          (message) =>
            message.id === event.payload.reaction.messageId && message.deletedAt === null,
        )
      )
        reactions = mergeReactions(reactions, [event.payload.reaction]);
    } else if (event.type === "reaction.removed") {
      reactions = reactions.filter((reaction) => reaction.id !== event.payload.reaction.id);
    } else if (event.type === "message.retracted") {
      const reservation = {
        messageId: event.payload.messageId,
        deletedAt: event.payload.deletedAt,
        entityVersion: event.entityVersion,
      };
      const source =
        messages.find((message) => message.id === reservation.messageId) ??
        threadSummaries.find((summary) => summary.latestReply.id === reservation.messageId)
          ?.latestReply;
      messages = messages.map((message) =>
        applyRetractReservation(message, new Map([[reservation.messageId, reservation]])),
      );
      reactions = reactions.filter((reaction) => reaction.messageId !== reservation.messageId);
      attachments = attachments.filter(
        (attachment) => attachment.messageId !== reservation.messageId,
      );
      if (source !== undefined)
        threadSummaries = retractReplySummary(
          threadSummaries,
          messages,
          applyRetractReservation(source, new Map([[reservation.messageId, reservation]])),
        );
      else
        threadSummaries = threadSummaries.filter(
          (summary) => summary.latestReply.conversationId !== event.conversationId,
        );
    } else if (event.type === "message.created") {
      const message = event.payload.message;
      // Existing rows are refreshed here. Newly created rows already reached the runtime and cache
      // through event commit; a page must not grow without bound or alter another page's membership.
      if (messages.some((current) => current.id === message.id))
        messages = mergeMessages(messages, [message]);
      if (
        message.threadRootId !== null &&
        threadSummaries.some((summary) => summary.threadRootId === message.threadRootId)
      )
        threadSummaries = projectReplySummary(threadSummaries, message, true);
    } else if (event.type === "task.created" || event.type === "task.updated") {
      if (tasks.some((task) => task.id === event.payload.task.id))
        tasks = mergeTasks(tasks, [event.payload.task]);
    }
  }
  return { messages, reactions, tasks, attachments, threadSummaries };
}
