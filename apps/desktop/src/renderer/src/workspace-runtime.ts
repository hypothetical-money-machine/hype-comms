import {
  sendMessageOperationSchema,
  type CacheCryptoStatus,
  type CacheScope,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type ChannelAccess,
  type ChatSessionState,
  type ConversationSummary,
  type Message,
  type MessageSearchResponse,
  type MessageSearchResult,
  type MessageThreadSummary,
  type ProductRealtimeEvent,
  type Reaction,
  type ReactionEmoji,
  type SyncAttemptResult,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type User,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hmm-chat/contracts";

import type { DesktopApi, RealtimeConnectionState } from "../../shared/desktop-api";
import {
  clearPersistentWorkspaceCache,
  compareConversations,
  compareMembers,
  compareTasks,
  MemoryWorkspaceCache,
  PersistentWorkspaceCache,
  type CachedWorkspaceState,
  type OutboxItem,
  type OutboxStatus,
  type WorkspaceCache,
} from "./workspace-cache";

/** Why the encrypted cache fell back to memory. Derived so a new crypto reason cannot drift. */
export type CacheFallbackReason = Extract<CacheCryptoStatus, { mode: "memory_only" }>["reason"];

export interface WorkspaceRuntimeState {
  readonly bootstrap: WorkspaceSnapshot | null;
  readonly messages: readonly Message[];
  readonly threadSummaries: readonly MessageThreadSummary[];
  readonly threadsSupported: boolean;
  readonly reactions: readonly Reaction[];
  readonly tasks: readonly Task[];
  readonly outbox: readonly OutboxItem[];
  readonly selectedConversationId: string | null;
  readonly focusedMessageId: string | null;
  readonly selectedThreadRootId: string | null;
  readonly focusedThreadMessageId: string | null;
  readonly threadLoading: boolean;
  readonly threadError: string | null;
  readonly connection: RealtimeConnectionState;
  readonly cacheMode: "persistent" | "memory_only" | null;
  readonly cacheFallbackReason: CacheFallbackReason | null;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly tasksBusy: boolean;
  readonly taskError: string | null;
  readonly error: string | null;
}

export interface WorkspaceRuntimeOptions {
  /** Test seam: lets a test observe cache traffic without reaching for IndexedDB. */
  readonly createCache?: (status: CacheCryptoStatus) => WorkspaceCache;
}

interface OutboxUpdate {
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly failureReason: string | null;
}

/**
 * How many resync demands in one chain this client answers before it stops re-downloading the
 * workspace. A server that rejects the cursor it just issued — an inconsistent restore whose
 * `last_event_sequence` sits below the oldest retained event, for instance — answers every
 * handshake with `system.resync_required`, and re-downloading the whole workspace on each one is
 * worse for the user than being told to reset the local cache. Only demands count against this: a
 * download that fails while a resync runs is transient, and is retried with backoff instead.
 */
const MAX_CONSECUTIVE_RESYNCS = 3;

/**
 * How long the resync in place has to hold up before the next demand starts a chain of its own
 * rather than extending the current one. `system.connected` cannot end a chain: the server sends it
 * on every socket whose first flush drains and can still send `system.resync_required` from a later
 * flush on that same socket, so resetting the counter there would disarm the bound in steady state.
 * Chained attempts are at most one 30-second backoff apart, so a minute of connected time is a
 * genuinely healthy stretch and not a repeat of the demand the last resync answered.
 */
const RESYNC_CHAIN_RESET_MS = 60_000;

const INITIAL_STATE: WorkspaceRuntimeState = {
  bootstrap: null,
  messages: [],
  threadSummaries: [],
  // Conservative until history negotiation succeeds: previous servers keep replies inline.
  threadsSupported: false,
  reactions: [],
  tasks: [],
  outbox: [],
  selectedConversationId: null,
  focusedMessageId: null,
  selectedThreadRootId: null,
  focusedThreadMessageId: null,
  threadLoading: false,
  threadError: null,
  connection: "offline",
  cacheMode: null,
  cacheFallbackReason: null,
  stale: true,
  busy: false,
  tasksBusy: false,
  taskError: null,
  error: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function firstConversation(snapshot: WorkspaceSnapshot): string | null {
  return (
    snapshot.conversations.find(
      (summary) =>
        summary.conversation.kind === "channel" && summary.conversation.slug === "general",
    )?.conversation.id ??
    snapshot.conversations[0]?.conversation.id ??
    null
  );
}

/** Full jitter between one second and 30 seconds, per the delivery contract. */
function retryDelay(attempt: number): number {
  const maximum = Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
  return Math.max(1_000, Math.floor(Math.random() * maximum));
}

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

/**
 * Merges server-derived messages into the in-memory projection using the same ordering the cache
 * uses, so incremental application and a cold `load()` agree.
 */
function mergeMessages(
  messages: readonly Message[],
  incoming: readonly Message[],
): readonly Message[] {
  if (incoming.length === 0) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) =>
    compareSequence(left.conversationSequence, right.conversationSequence),
  );
}

function mergeThreadSummaries(
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

function projectReplySummary(
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

function mergeReactions(
  reactions: readonly Reaction[],
  incoming: readonly Reaction[],
): readonly Reaction[] {
  if (incoming.length === 0) return reactions;
  const byId = new Map(reactions.map((reaction) => [reaction.id, reaction]));
  for (const reaction of incoming) byId.set(reaction.id, reaction);
  return [...byId.values()];
}

function mergeTasks(tasks: readonly Task[], incoming: readonly Task[]): readonly Task[] {
  if (incoming.length === 0) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of incoming) {
    const current = byId.get(task.id);
    if (current === undefined || task.version >= current.version) byId.set(task.id, task);
  }
  return [...byId.values()].sort(compareTasks);
}

function replaceMessageReactions(
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

function replaceConversation(
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

/** Mirrors the cache's own unread and mention accounting for one applied message event. */
function countMessage(
  snapshot: WorkspaceSnapshot,
  event: Extract<WorkspaceEvent, { type: "message.created" }>,
): WorkspaceSnapshot {
  const message = event.payload.message;
  const currentUserId = snapshot.currentUser.user.id;
  const fromAnotherMember = message.authorId !== currentUserId;
  const mentioned = fromAnotherMember && event.payload.mentionedUserIds.includes(currentUserId);
  return replaceConversation(snapshot, event.conversationId, (current) => {
    if (current === undefined) return null;
    return {
      ...current,
      lastMessage: message,
      unreadCount: current.unreadCount + (fromAnotherMember ? 1 : 0),
      mentionCount: current.mentionCount + (mentioned ? 1 : 0),
    };
  });
}

function syncFailureMessage(
  reason: Extract<SyncAttemptResult, { status: "permanent" }>["reason"],
): string {
  switch (reason) {
    case "forbidden":
      return "This device is no longer allowed to sync this workspace.";
    case "not_found":
      return "The workspace could not be found on the server.";
    case "invalid_response":
      return "The server sent a sync response this app cannot read.";
    default:
      return "The server rejected this device's sync request. Reset the local cache to recover.";
  }
}

/**
 * Copy for the recovery signal the cache crypto reports when it cannot use the stored key. A
 * missing credential store is already described in the connection line and cannot be repaired from
 * the app; every other reason is an unreadable key, which resetting the local cache does repair.
 */
export function cacheFallbackNotice(reason: CacheFallbackReason | null): string | null {
  if (reason === null || reason === "credential_store_unavailable") return null;
  return "The encrypted cache key could not be read. Reset the local cache to rebuild it.";
}

function nextDeliverable(outbox: readonly OutboxItem[], now: number): OutboxItem | undefined {
  const blockedConversations = new Set<string>();
  for (const item of outbox) {
    const conversationId = item.operation.conversationId;
    if (blockedConversations.has(conversationId)) continue;
    if (
      item.status === "permanent_failure" ||
      item.status === "paused_auth" ||
      (item.nextAttemptAt !== null && Date.parse(item.nextAttemptAt) > now)
    ) {
      blockedConversations.add(conversationId);
      continue;
    }
    return item;
  }
  return undefined;
}

function firstItemsByConversation(outbox: readonly OutboxItem[]): readonly OutboxItem[] {
  const seen = new Set<string>();
  return outbox.filter((item) => {
    const conversationId = item.operation.conversationId;
    if (seen.has(conversationId)) return false;
    seen.add(conversationId);
    return true;
  });
}

interface ReadTarget {
  readonly messageId: string;
  readonly conversationSequence: string;
  attempt: number;
  inFlight: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export class WorkspaceRuntime {
  readonly #listeners = new Set<(state: WorkspaceRuntimeState) => void>();
  readonly #client: DesktopApi;
  readonly #createCache: (status: CacheCryptoStatus) => WorkspaceCache;
  #state = INITIAL_STATE;
  #cache: WorkspaceCache | null = null;
  #generation = 0;
  #flushing = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #resyncTimer: ReturnType<typeof setTimeout> | null = null;
  #syncAttempt = 0;
  /** True until the current sync pass has fully repaired and reloaded the local projection. */
  #syncRecoveryPending = false;
  /**
   * Resync demands in the current chain. Only demands count: a failed download is retried without
   * touching this, and `system.connected` cannot reset it either, so the bound stays armed on a
   * server that accepts a handshake and then rejects the cursor it just issued.
   */
  #resyncAttempt = 0;
  /** Transient failures of the resync now in flight, so its backoff grows the usual way. */
  #resyncFailures = 0;
  /** True from a resync demand until its snapshot, sync pass, and realtime restart all succeed. */
  #resyncRecoveryPending = false;
  /** Monotonic demand id, so an older retry cannot settle a newer resync recovery. */
  #resyncRequest = 0;
  /** When the resync now in place restarted realtime; how a chain is told from a fresh demand. */
  #resyncSettledAt: number | null = null;
  /** The signed-in scope, kept past `stop()` so a sign-out reset knows whose cache to delete. */
  #scope: CacheScope | null = null;
  /** The highest workspace sequence this client has durably applied. */
  #syncCursor: string | null = null;
  /**
   * A `member.updated` invalidation has been seen and not yet answered by a successful refetch.
   * Cleared only on success, so a failed re-read is retried by the next sync pass instead of
   * silently leaving a disabled member in the directory until the app restarts.
   */
  #membersDirty = false;
  /** Monotonic refetch id, so a slow response cannot overwrite a newer directory. */
  #membersRequest = 0;
  /** Serializes durable replacements in the active cache generation without delaying reads. */
  #membersReplacementQueue: Promise<void> = Promise.resolve();
  #membersReplacementAbortController = new AbortController();
  #membersRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #membersAttempt = 0;
  #eventQueue: Promise<void> = Promise.resolve();
  #recoveryQueue: Promise<void> = Promise.resolve();
  /** Blocks delivery and cursor work from the instant a membership invalidation is observed. */
  #membershipRepairPending = false;
  /** Invalidates snapshot requests that began before the latest membership barrier. */
  #membershipEpoch = 0;
  /** Membership frames accepted by this renderer session but not yet durably repaired and acked. */
  readonly #acceptedMembershipRepairs = new Map<string, string>();
  /** Retires frames queued by the realtime session stopped for authoritative membership repair. */
  #realtimeEpoch = 0;
  readonly #historyCursors = new Map<string, string | null>();
  readonly #readTargets = new Map<string, ReadTarget>();
  readonly #threadCursors = new Map<string, string | null>();
  #unsubscribeEvent: (() => void) | null = null;
  #unsubscribeConnection: (() => void) | null = null;

  constructor(client: DesktopApi, options: WorkspaceRuntimeOptions = {}) {
    this.#client = client;
    this.#createCache =
      options.createCache ??
      ((status) =>
        status.mode === "persistent"
          ? new PersistentWorkspaceCache({ crypto: client, scope: status.scope })
          : new MemoryWorkspaceCache());
  }

  get state(): WorkspaceRuntimeState {
    return this.#state;
  }

  subscribe(listener: (state: WorkspaceRuntimeState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #setState(update: Partial<WorkspaceRuntimeState>): void {
    this.#state = { ...this.#state, ...update };
    for (const listener of this.#listeners) listener(this.#state);
  }

  /**
   * Runs renderer-initiated cache projections in the same order as realtime events. The caller
   * still observes a failure, while the shared queue remains usable for the next event or action.
   */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#eventQueue.then(operation);
    this.#eventQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Keeps sync and resync cache recovery mutually exclusive without blocking realtime events. */
  #serializeRecovery(operation: () => Promise<void>): Promise<void> {
    const result = this.#recoveryQueue.then(operation);
    this.#recoveryQueue = result.catch(() => undefined);
    return result;
  }

  async start(session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }>) {
    const generation = ++this.#generation;
    this.#retireMembersReplacementQueue();
    this.#recoveryQueue = Promise.resolve();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#clearMembersRetryTimer();
    this.#membersAttempt = 0;
    this.#resetResyncState();
    this.#syncAttempt = 0;
    this.#syncRecoveryPending = false;
    this.#membershipRepairPending = false;
    this.#acceptedMembershipRepairs.clear();
    this.#realtimeEpoch += 1;
    // A fresh bootstrap answers any invalidation the previous session left unanswered.
    this.#membersDirty = false;
    this.#clearReadTargets();
    this.#setState({ busy: true, error: null });
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#eventQueue = Promise.resolve();
    this.#unsubscribeEvent = this.#client.onWorkspaceEvent((event) => {
      const realtimeEpoch = this.#realtimeEpoch;
      if (event.type === "channel.membership_changed") {
        // Acceptance happens before queueing. A repair ahead of this one may retire the socket,
        // but it must not retire this obligation or acknowledge a cursor that crosses it.
        this.#acceptedMembershipRepairs.set(event.id, event.workspaceSequence);
        this.#membershipRepairPending = true;
        this.#membershipEpoch += 1;
        this.#clearRetryTimer();
        this.#clearReadTargets();
        this.#beginMembershipBarrier(event);
      }
      const resyncRequest = event.type === "system.resync_required" ? ++this.#resyncRequest : null;
      if (resyncRequest !== null) {
        // Publish the demand as soon as it arrives. A timer-based attempt can currently be awaiting
        // network I/O on the recovery queue and must observe that a newer recovery owns staleness.
        this.#resyncRecoveryPending = true;
        this.#setState({ stale: true });
      }
      this.#eventQueue = this.#eventQueue
        .then(() => this.#handleRealtimeEvent(event, generation, resyncRequest, realtimeEpoch))
        .catch((error: unknown) => {
          if (generation === this.#generation) {
            this.#setState({
              stale: true,
              error: errorMessage(error, "Could not apply a realtime update"),
            });
          }
        });
    });
    this.#unsubscribeConnection = this.#client.onRealtimeStateChanged((connection) => {
      this.#setState({ connection });
    });

    const scope: CacheScope = {
      userId: session.userId,
      workspaceId: session.workspaceId,
    };
    // Kept on the runtime, not just in this call: `stop()` runs before the reset a sign-out does,
    // and that reset has to know which member's database it is allowed to delete.
    this.#scope = scope;
    try {
      const cryptoStatus = await this.#client.initializeCacheCrypto(scope);
      this.#cache = this.#createCache(cryptoStatus);
      const cached = await this.#cache.load();
      if (generation !== this.#generation) return;
      this.#membershipRepairPending =
        cached.repairMarker !== null || this.#acceptedMembershipRepairs.size > 0;
      this.#syncCursor = cached.syncCursor;
      this.#setState({
        bootstrap: cached.bootstrap,
        messages: cached.messages,
        reactions: cached.reactions,
        tasks: cached.tasks,
        outbox: cached.outbox,
        selectedConversationId:
          this.#state.selectedConversationId ??
          (cached.bootstrap === null ? null : firstConversation(cached.bootstrap)),
        cacheMode: cryptoStatus.mode,
        cacheFallbackReason: cryptoStatus.mode === "memory_only" ? cryptoStatus.reason : null,
        stale: true,
      });

      await this.#refreshSnapshot(generation);
      if (generation !== this.#generation || this.#cache === null) return;
      await this.#repairAndFlush(generation);
      if (generation !== this.#generation || this.#cache === null) return;
      await this.#restartRealtime(generation);
      this.#setState({ busy: false });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#setState({
        busy: false,
        stale: true,
        error: errorMessage(error, "Could not initialize the workspace"),
      });
    }
  }

  async stop(): Promise<void> {
    ++this.#generation;
    this.#retireMembersReplacementQueue();
    this.#recoveryQueue = Promise.resolve();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#clearMembersRetryTimer();
    this.#membersAttempt = 0;
    this.#resetResyncState();
    this.#syncRecoveryPending = false;
    this.#membershipRepairPending = false;
    this.#acceptedMembershipRepairs.clear();
    this.#realtimeEpoch += 1;
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeEvent = null;
    this.#unsubscribeConnection = null;
    await this.#client.stopWorkspaceRealtime();
    this.#cache = null;
    this.#syncCursor = null;
    this.#membersDirty = false;
    this.#clearReadTargets();
    this.#state = INITIAL_STATE;
    for (const listener of this.#listeners) listener(this.#state);
  }

  selectConversation(conversationId: string): void {
    this.#setState({
      selectedConversationId: conversationId,
      focusedMessageId: null,
      selectedThreadRootId: null,
      focusedThreadMessageId: null,
      threadLoading: false,
      threadError: null,
    });
  }

  openTaskSource(task: Task): void {
    this.#setState({
      selectedConversationId: task.conversationId,
      focusedMessageId: task.sourceMessageId,
      selectedThreadRootId: null,
      focusedThreadMessageId: null,
      threadLoading: false,
      threadError: null,
    });
  }

  markConversationReadThrough(conversationId: string, messageId: string): void {
    const message = this.#state.messages.find(
      (candidate) => candidate.id === messageId && candidate.conversationId === conversationId,
    );
    const summary = this.#state.bootstrap?.conversations.find(
      (candidate) => candidate.conversation.id === conversationId,
    );
    if (message === undefined || summary === undefined) return;
    const targetSequence = message.conversationSequence;
    const currentSequence = summary.readCursor?.lastReadConversationSequence;
    const tracked = this.#readTargets.get(conversationId);
    if (currentSequence !== undefined && BigInt(currentSequence) >= BigInt(targetSequence)) {
      if (
        tracked !== undefined &&
        BigInt(currentSequence) >= BigInt(tracked.conversationSequence)
      ) {
        if (tracked.retryTimer !== null) clearTimeout(tracked.retryTimer);
        this.#readTargets.delete(conversationId);
      }
      return;
    }
    if (tracked !== undefined && BigInt(tracked.conversationSequence) >= BigInt(targetSequence)) {
      return;
    }

    if (tracked !== undefined && tracked.retryTimer !== null) {
      clearTimeout(tracked.retryTimer);
    }
    const target: ReadTarget = {
      messageId,
      conversationSequence: targetSequence,
      attempt: 0,
      inFlight: false,
      retryTimer: null,
    };
    this.#readTargets.set(conversationId, target);
    this.#sendReadTarget(conversationId, target, this.#generation);
  }

  #sendReadTarget(conversationId: string, target: ReadTarget, generation: number): void {
    if (
      generation !== this.#generation ||
      this.#readTargets.get(conversationId) !== target ||
      target.inFlight
    ) {
      return;
    }
    target.inFlight = true;
    void this.#client
      .advanceReadCursor(conversationId, target.messageId)
      .then((result) => {
        if (generation !== this.#generation || this.#state.bootstrap === null) return;
        this.#setState({
          bootstrap: replaceConversation(this.#state.bootstrap, conversationId, (current) => {
            if (current === undefined) return null;
            const projectedSequence = result.readCursor.lastReadConversationSequence;
            const existingSequence = current.readCursor?.lastReadConversationSequence;
            if (
              existingSequence !== undefined &&
              BigInt(existingSequence) >= BigInt(projectedSequence)
            ) {
              return current;
            }
            return { ...current, readCursor: result.readCursor };
          }),
        });
        if (this.#readTargets.get(conversationId) === target) {
          this.#readTargets.delete(conversationId);
        }
      })
      .catch(() => {
        if (generation !== this.#generation || this.#readTargets.get(conversationId) !== target) {
          return;
        }
        target.inFlight = false;
        target.attempt += 1;
        target.retryTimer = setTimeout(() => {
          target.retryTimer = null;
          this.#sendReadTarget(conversationId, target, generation);
        }, retryDelay(target.attempt));
      });
  }

  async sendMessage(
    conversationId: string,
    body: string,
    mentionedUserIds: readonly string[],
    threadRootId: string | null = null,
  ): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    if (this.#membershipRepairPending) {
      throw new Error("Membership repair must complete before sending messages");
    }
    if (
      !this.#state.bootstrap?.conversations.some(
        (summary) => summary.conversation.id === conversationId,
      )
    ) {
      throw new Error("This conversation is no longer available");
    }
    const clientMessageId = crypto.randomUUID();
    const operation = sendMessageOperationSchema.parse({
      conversationId,
      idempotencyKey: clientMessageId,
      message: {
        threadRootId,
        body,
        bodyFormat: "hmm_markdown_v1",
        clientMessageId,
        mentionedUserIds: [...mentionedUserIds],
        attachmentIds: [],
      },
    });
    const createdAt = new Date().toISOString();
    await cache.enqueue(operation, createdAt);
    this.#setState({
      outbox: [
        ...this.#state.outbox,
        {
          operation,
          createdAt,
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: null,
          failureReason: null,
        },
      ],
    });
    void this.#flushOutbox(this.#generation);
  }

  async replaceFailedMessage(
    clientMessageId: string,
    body: string,
    mentionedUserIds: readonly string[],
  ): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const predecessor = this.#state.outbox.find(
      (item) => item.operation.message.clientMessageId === clientMessageId,
    );
    if (predecessor === undefined) throw new Error("The queued message is no longer available");
    if (predecessor.status !== "permanent_failure") {
      throw new Error("Only a permanently failed message can be replaced");
    }

    const replacementClientMessageId = crypto.randomUUID();
    const operation = sendMessageOperationSchema.parse({
      conversationId: predecessor.operation.conversationId,
      idempotencyKey: replacementClientMessageId,
      message: {
        ...predecessor.operation.message,
        body,
        clientMessageId: replacementClientMessageId,
        mentionedUserIds: [...mentionedUserIds],
      },
    });
    const replacement: OutboxItem = {
      operation,
      // Retaining the authored timestamp keeps the replacement in the predecessor's FIFO slot.
      createdAt: predecessor.createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    };

    // The replacement must exist durably before the predecessor can be removed. If either write
    // fails, at least one encrypted outbox record still contains the authored text.
    await cache.enqueue(operation, predecessor.createdAt);
    await cache.removeOutbox(clientMessageId);

    const outbox = [...this.#state.outbox];
    const predecessorIndex = outbox.findIndex(
      (item) => item.operation.message.clientMessageId === clientMessageId,
    );
    if (predecessorIndex === -1) {
      const insertionIndex = outbox.findIndex(
        (item) => item.createdAt.localeCompare(predecessor.createdAt) > 0,
      );
      outbox.splice(insertionIndex === -1 ? outbox.length : insertionIndex, 0, replacement);
    } else {
      outbox[predecessorIndex] = replacement;
    }
    this.#setState({ outbox });
    void this.#flushOutbox(this.#generation);
  }

  async searchMessages(query: string, after?: string): Promise<MessageSearchResponse> {
    return this.#client.searchMessages({
      query,
      ...(after === undefined ? {} : { after }),
      limit: 25,
    });
  }

  async loadConversationTasks(conversationId: string): Promise<void> {
    const cache = this.#cache;
    const generation = this.#generation;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const tasks: Task[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await this.#client.listConversationTasks(conversationId, {
          ...(after === undefined ? {} : { after }),
          limit: 200,
        });
        tasks.push(...page.tasks);
        if (!page.hasMore || page.nextCursor === null || page.nextCursor === after) break;
        after = page.nextCursor;
      }
      await this.#serialize(async () => {
        if (generation !== this.#generation || cache !== this.#cache) return;
        await cache.upsertTasks(tasks);
        this.#setState({ tasks: mergeTasks(this.#state.tasks, tasks) });
      });
    } catch (error) {
      if (generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not load this task board") });
      }
      throw error;
    } finally {
      if (generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async loadMyTasks(): Promise<void> {
    const cache = this.#cache;
    const generation = this.#generation;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const tasks: Task[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await this.#client.listMyTasks({
          ...(after === undefined ? {} : { after }),
          limit: 200,
        });
        tasks.push(...page.tasks);
        if (!page.hasMore || page.nextCursor === null || page.nextCursor === after) break;
        after = page.nextCursor;
      }
      await this.#serialize(async () => {
        if (generation !== this.#generation || cache !== this.#cache) return;
        await cache.upsertTasks(tasks);
        this.#setState({ tasks: mergeTasks(this.#state.tasks, tasks) });
      });
    } catch (error) {
      if (generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not load My Tasks") });
      }
      throw error;
    } finally {
      if (generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async createTask(input: {
    readonly conversationId: string;
    readonly title: string;
    readonly description?: string | null;
    readonly priority?: TaskPriority;
    readonly assigneeId?: string | null;
    readonly dueOn?: string | null;
    readonly sourceMessageId?: string | null;
  }): Promise<Task> {
    const cache = this.#cache;
    const generation = this.#generation;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const result = await this.#client.createTask({
        conversationId: input.conversationId,
        idempotencyKey: crypto.randomUUID(),
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? "none",
        assigneeId: input.assigneeId ?? null,
        dueOn: input.dueOn ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      });
      await this.#serialize(async () => {
        if (generation !== this.#generation || cache !== this.#cache) return;
        await cache.upsertTasks([result.task]);
        this.#setState({ tasks: mergeTasks(this.#state.tasks, [result.task]) });
      });
      return result.task;
    } catch (error) {
      if (generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not create the task") });
      }
      throw error;
    } finally {
      if (generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async updateTask(
    taskId: string,
    input: {
      readonly title: string;
      readonly description: string | null;
      readonly priority: TaskPriority;
      readonly assigneeId: string | null;
      readonly dueOn: string | null;
    },
  ): Promise<Task> {
    const cache = this.#cache;
    const generation = this.#generation;
    const current = this.#state.tasks.find((task) => task.id === taskId);
    if (cache === null || current === undefined) throw new Error("Task is unavailable");
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const result = await this.#client.updateTask({
        taskId,
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: current.version,
        ...input,
      });
      await this.#serialize(async () => {
        if (generation !== this.#generation || cache !== this.#cache) return;
        await cache.upsertTasks([result.task]);
        this.#setState({ tasks: mergeTasks(this.#state.tasks, [result.task]) });
      });
      return result.task;
    } catch (error) {
      if (generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not update the task") });
      }
      throw error;
    } finally {
      if (generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async moveTask(taskId: string, status: TaskStatus, beforeTaskId: string | null): Promise<Task> {
    const cache = this.#cache;
    const generation = this.#generation;
    const current = this.#state.tasks.find((task) => task.id === taskId);
    if (cache === null || current === undefined) throw new Error("Task is unavailable");
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const result = await this.#client.moveTask({
        taskId,
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: current.version,
        status,
        beforeTaskId,
      });
      await this.#serialize(async () => {
        if (generation !== this.#generation || cache !== this.#cache) return;
        await cache.upsertTasks([result.task]);
        this.#setState({ tasks: mergeTasks(this.#state.tasks, [result.task]) });
      });
      return result.task;
    } catch (error) {
      if (generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not move the task") });
      }
      throw error;
    } finally {
      if (generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async openSearchResult(result: MessageSearchResult): Promise<void> {
    const cache = this.#cache;
    const snapshot = this.#state.bootstrap;
    const generation = this.#generation;
    if (cache === null || snapshot === null) throw new Error("Workspace is still loading");
    const conversationId = result.message.conversationId;
    if (!snapshot.conversations.some((summary) => summary.conversation.id === conversationId)) {
      throw new Error("This conversation is no longer available");
    }
    const threadRootId = this.#state.threadsSupported ? result.message.threadRootId : null;
    await this.#serialize(async () => {
      if (generation !== this.#generation || cache !== this.#cache) return;
      const currentSnapshot = this.#state.bootstrap;
      if (
        currentSnapshot === null ||
        !currentSnapshot.conversations.some((summary) => summary.conversation.id === conversationId)
      ) {
        throw new Error("This conversation is no longer available");
      }
      // Keep the query inside the event queue. Events already received are applied first, while
      // events committed during the query queue behind this projection and therefore win after it.
      const hydrated = await this.#client.listMessageReactions([result.message.id]);
      if (generation !== this.#generation || cache !== this.#cache) return;
      await cache.upsertHistory([result.message], hydrated.reactions);
      const messages = mergeMessages(this.#state.messages, [result.message]);
      this.#setState({
        messages,
        reactions: replaceMessageReactions(
          this.#state.reactions,
          [result.message.id],
          hydrated.reactions,
        ),
        selectedConversationId: conversationId,
        focusedMessageId: threadRootId === null ? result.message.id : null,
        selectedThreadRootId: threadRootId,
        focusedThreadMessageId: threadRootId === null ? null : result.message.id,
        threadLoading: threadRootId !== null,
        threadError: null,
      });
    });
    if (threadRootId !== null) await this.openThread(threadRootId, result.message.id);
  }

  async openThread(threadRootId: string, focusedMessageId: string | null = null): Promise<void> {
    if (!this.#state.threadsSupported) {
      throw new Error("Threads are unavailable on this server");
    }
    this.#threadCursors.delete(threadRootId);
    this.#setState({
      selectedThreadRootId: threadRootId,
      focusedThreadMessageId: focusedMessageId,
      threadLoading: true,
      threadError: null,
      focusedMessageId: null,
    });
    await this.#fetchThreadPage(threadRootId, undefined);
  }

  closeThread(): void {
    this.#setState({
      selectedThreadRootId: null,
      focusedThreadMessageId: null,
      threadLoading: false,
      threadError: null,
    });
  }

  async loadOlderThread(threadRootId: string): Promise<void> {
    const before = this.#threadCursors.get(threadRootId);
    if (before === null) return;
    this.#setState({ threadLoading: true, threadError: null });
    await this.#fetchThreadPage(threadRootId, before);
  }

  hasOlderThread(threadRootId: string): boolean {
    const cursor = this.#threadCursors.get(threadRootId);
    return cursor !== undefined && cursor !== null;
  }

  async #fetchThreadPage(threadRootId: string, before: string | undefined): Promise<void> {
    const cache = this.#cache;
    const generation = this.#generation;
    if (cache === null) {
      this.#setState({ threadLoading: false, threadError: "Workspace cache is unavailable" });
      return;
    }
    try {
      await this.#serialize(async () => {
        if (generation !== this.#generation || cache !== this.#cache) return;
        const thread = await this.#client.getMessageThread({
          messageId: threadRootId,
          ...(before === undefined ? {} : { before }),
          limit: 50,
        });
        if (generation !== this.#generation || cache !== this.#cache) return;
        const messages = [thread.root, ...thread.replies];
        const messageIds = messages.map((message) => message.id);
        const hydrated = await this.#client.listMessageReactions(messageIds);
        if (generation !== this.#generation || cache !== this.#cache) return;
        await cache.upsertHistory(messages, hydrated.reactions);
        this.#threadCursors.set(threadRootId, thread.nextCursor);
        this.#setState({
          messages: mergeMessages(this.#state.messages, messages),
          reactions: replaceMessageReactions(this.#state.reactions, messageIds, hydrated.reactions),
          ...(this.#state.selectedThreadRootId === threadRootId
            ? { threadLoading: false, threadError: null }
            : {}),
        });
      });
    } catch (error) {
      try {
        if (await this.#downgradeAfterThreadFailure(threadRootId, generation, cache)) return;
      } catch {
        // Preserve the original thread failure when capability renegotiation is also unavailable.
      }
      if (generation === this.#generation && this.#state.selectedThreadRootId === threadRootId) {
        this.#setState({
          threadLoading: false,
          threadError: errorMessage(error, "Could not load the thread"),
        });
      }
    }
  }

  async #downgradeAfterThreadFailure(
    threadRootId: string,
    generation: number,
    cache: WorkspaceCache,
  ): Promise<boolean> {
    if (!this.#state.threadsSupported) return true;
    const root = this.#state.messages.find(
      (message) => message.id === threadRootId && message.threadRootId === null,
    );
    if (root === undefined) return false;
    const history = await this.#client.getConversationMessages({
      conversationId: root.conversationId,
      limit: 50,
    });
    if (history.threadsSupported) return false;
    const messageIds = history.messages.map((message) => message.id);
    const hydrated =
      messageIds.length === 0
        ? { reactions: [] }
        : await this.#client.listMessageReactions(messageIds);
    await this.#serialize(async () => {
      if (generation !== this.#generation || cache !== this.#cache) return;
      this.#historyCursors.set(root.conversationId, history.nextCursor);
      await cache.upsertHistory(history.messages, hydrated.reactions);
      const selectedThreadRootId = this.#state.selectedThreadRootId;
      this.#setState({
        messages: mergeMessages(this.#state.messages, history.messages),
        threadSummaries: [],
        threadsSupported: false,
        reactions: replaceMessageReactions(this.#state.reactions, messageIds, hydrated.reactions),
        selectedThreadRootId: null,
        focusedThreadMessageId: null,
        threadLoading: false,
        threadError: null,
        ...(this.#state.selectedConversationId === root.conversationId
          ? { focusedMessageId: selectedThreadRootId ?? threadRootId }
          : {}),
      });
    });
    return generation === this.#generation && cache === this.#cache;
  }

  async retryMessage(clientMessageId: string): Promise<void> {
    await this.#patchOutbox(clientMessageId, {
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
    void this.#flushOutbox(this.#generation);
  }

  async discardMessage(clientMessageId: string): Promise<void> {
    await this.#cache?.removeOutbox(clientMessageId);
    this.#setState({ outbox: this.#withoutOutbox([clientMessageId]) });
  }

  async addReaction(messageId: string, emoji: ReactionEmoji): Promise<void> {
    const generation = this.#generation;
    const cache = this.#cache;
    if (cache === null || this.#state.bootstrap === null) {
      throw new Error("Workspace is still loading");
    }
    const conversationId =
      this.#state.messages.find((message) => message.id === messageId)?.conversationId ??
      this.#state.selectedConversationId;
    if (conversationId === null) throw new Error("Message is unavailable");
    const result = await this.#client.addMessageReaction(messageId, emoji);
    if (generation !== this.#generation || cache !== this.#cache) return;
    await this.#serialize(async () => {
      if (generation !== this.#generation || cache !== this.#cache) return;
      if (this.#syncCursor !== null && compareSequence(this.#syncCursor, result.syncCursor) >= 0) {
        return;
      }
      if (
        !this.#state.bootstrap?.conversations.some(
          (summary) => summary.conversation.id === conversationId,
        )
      ) {
        return;
      }
      await cache.upsertReaction(result.reaction, conversationId);
      if (generation !== this.#generation || cache !== this.#cache) return;
      this.#setState({ reactions: mergeReactions(this.#state.reactions, [result.reaction]) });
    });
  }

  async removeReaction(messageId: string, emoji: ReactionEmoji): Promise<void> {
    const generation = this.#generation;
    const cache = this.#cache;
    const currentUserId = this.#state.bootstrap?.currentUser.user.id;
    if (cache === null || currentUserId === undefined) {
      throw new Error("Workspace is still loading");
    }
    const existing = this.#state.reactions.find(
      (reaction) =>
        reaction.messageId === messageId &&
        reaction.userId === currentUserId &&
        reaction.emoji === emoji,
    );
    const result = await this.#client.removeMessageReaction(messageId, emoji);
    if (!result.removed || generation !== this.#generation || cache !== this.#cache) return;
    await this.#serialize(async () => {
      if (generation !== this.#generation || cache !== this.#cache) return;
      if (this.#syncCursor !== null && compareSequence(this.#syncCursor, result.syncCursor) >= 0) {
        return;
      }
      if (existing !== undefined) await cache.removeReaction(existing.id);
      if (generation !== this.#generation || cache !== this.#cache) return;
      this.#setState({
        reactions: this.#state.reactions.filter(
          (reaction) =>
            !(
              reaction.messageId === messageId &&
              reaction.userId === currentUserId &&
              reaction.emoji === emoji
            ),
        ),
      });
    });
  }

  async createChannel(
    name: string,
    slug: string,
    topic: string | null,
    access: ChannelAccess,
  ): Promise<void> {
    const generation = this.#generation;
    const cache = this.#cache;
    if (cache === null || this.#state.bootstrap === null) {
      throw new Error("Workspace is still loading");
    }
    const result = await this.#client.createChannel({
      name,
      slug,
      topic,
      access,
      idempotencyKey: crypto.randomUUID(),
    });
    if (generation !== this.#generation || cache !== this.#cache) return;
    const conversationId = result.conversation.conversation.id;

    // Join the same queue used by realtime so events that arrived while the request was in flight
    // are projected first. The response cursor is only a high-water mark; ordered realtime/sync is
    // still solely responsible for advancing and acknowledging it.
    const projection = this.#eventQueue.then(async () => {
      if (generation !== this.#generation || cache !== this.#cache) return;
      const snapshot = this.#state.bootstrap;
      if (snapshot === null) return;
      const projected = replaceConversation(snapshot, conversationId, (current) => ({
        ...result.conversation,
        lastMessage: current?.lastMessage ?? result.conversation.lastMessage,
        unreadCount: current?.unreadCount ?? result.conversation.unreadCount,
        mentionCount: current?.mentionCount ?? result.conversation.mentionCount,
        readCursor: current?.readCursor ?? result.conversation.readCursor,
      }));
      const summary = projected.conversations.find(
        (candidate) => candidate.conversation.id === conversationId,
      );
      if (summary === undefined) return;

      let repairError: string | null = null;
      try {
        await cache.upsertConversation(summary);
      } catch {
        repairError =
          "The channel was created, but its local cache needs repair. Reconnect to refresh it.";
      }
      if (generation !== this.#generation || cache !== this.#cache) return;
      this.#historyCursors.set(conversationId, null);
      this.#setState({
        bootstrap: projected,
        selectedConversationId: conversationId,
        focusedMessageId: null,
        selectedThreadRootId: null,
        focusedThreadMessageId: null,
        threadLoading: false,
        threadError: null,
        ...(repairError === null ? {} : { stale: true, error: repairError }),
      });
    });
    this.#eventQueue = projection;
    await projection;
  }

  async createDirectConversation(memberId: string): Promise<void> {
    const result = await this.#client.createDirectConversation({ memberId });
    await this.#refreshSnapshot(this.#generation);
    this.selectConversation(result.conversation.conversation.id);
  }

  async archiveChannel(conversationId: string): Promise<void> {
    await this.#client.archiveChannel(conversationId);
    await this.#refreshSnapshot(this.#generation);
  }

  async getChannelMembers(conversationId: string): Promise<ChannelMembersResponse> {
    return this.#client.getChannelMembers(conversationId);
  }

  async upsertChannelMember(
    conversationId: string,
    userId: string,
    role: "owner" | "member",
  ): Promise<ChannelMembershipMutationResponse> {
    const result = await this.#client.upsertChannelMember(conversationId, userId, role);
    await this.#refreshSnapshot(this.#generation);
    return result;
  }

  async removeChannelMember(
    conversationId: string,
    userId: string,
  ): Promise<ChannelMembershipMutationResponse> {
    const result = await this.#client.removeChannelMember(conversationId, userId);
    await this.#refreshSnapshot(this.#generation);
    return result;
  }

  async loadOlder(conversationId: string): Promise<void> {
    const cache = this.#cache;
    const generation = this.#generation;
    const before = this.#historyCursors.get(conversationId);
    if (cache === null || before === null) return;
    const history = await this.#client.getConversationMessages({
      conversationId,
      ...(before === undefined ? {} : { before }),
      limit: 50,
    });
    await this.#serialize(async () => {
      if (generation !== this.#generation || cache !== this.#cache) return;
      const messageIds = history.messages.map((message) => message.id);
      const hydrated =
        messageIds.length === 0
          ? { reactions: [] }
          : await this.#client.listMessageReactions(messageIds);
      if (generation !== this.#generation || cache !== this.#cache) return;
      this.#historyCursors.set(conversationId, history.nextCursor);
      await cache.upsertHistory(history.messages, hydrated.reactions);
      this.#setState({
        messages: mergeMessages(this.#state.messages, history.messages),
        threadSummaries: history.threadsSupported
          ? mergeThreadSummaries(this.#state.threadSummaries, history.threadSummaries)
          : [],
        threadsSupported: history.threadsSupported,
        ...(history.threadsSupported
          ? {}
          : {
              selectedThreadRootId: null,
              focusedThreadMessageId: null,
              threadLoading: false,
              threadError: null,
            }),
        reactions: replaceMessageReactions(this.#state.reactions, messageIds, hydrated.reactions),
      });
    });
  }

  hasOlder(conversationId: string): boolean {
    return this.#historyCursors.get(conversationId) !== null;
  }

  async resetLocalCache(): Promise<void> {
    ++this.#generation;
    this.#retireMembersReplacementQueue();
    this.#recoveryQueue = Promise.resolve();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#clearMembersRetryTimer();
    this.#membersAttempt = 0;
    this.#resetResyncState();
    this.#syncRecoveryPending = false;
    this.#membershipRepairPending = false;
    this.#acceptedMembershipRepairs.clear();
    this.#realtimeEpoch += 1;
    this.#clearReadTargets();
    const scope = this.#scope;
    await this.#client.stopWorkspaceRealtime();
    await this.#cache?.clearAll().catch(() => undefined);
    // Only the signed-in member's database goes. Another member of this OS account can still have
    // an encrypted cache and undelivered outbox on disk, and this runs on every sign-out, so
    // deleting every scope's database here silently destroys messages nobody agreed to discard.
    if (scope !== null) await clearPersistentWorkspaceCache(scope).catch(() => undefined);
    await this.#client.resetCacheCrypto();
    this.#cache = null;
    this.#syncCursor = null;
    this.#historyCursors.clear();
    this.#threadCursors.clear();
    this.#setState({ ...INITIAL_STATE, error: "Local cache reset. Rebuilding the workspace…" });
  }

  conversationName(summary: ConversationSummary): string {
    if (summary.conversation.kind === "channel") {
      return `# ${summary.conversation.name ?? summary.conversation.slug ?? "channel"}`;
    }
    const otherId = summary.participantIds.find(
      (id) => id !== this.#state.bootstrap?.currentUser.user.id,
    );
    if (otherId === undefined) {
      return this.#state.bootstrap?.currentUser.user.displayName ?? "Direct message";
    }
    return (
      this.#state.bootstrap?.members.find((member) => member.id === otherId)?.displayName ??
      "Direct message"
    );
  }

  /** Pages `/v1/conversations` until the server stops claiming more, per the bootstrap contract. */
  async #fetchSnapshot(): Promise<WorkspaceSnapshot> {
    const bootstrap = await this.#client.getWorkspaceBootstrap();
    const conversations = [...bootstrap.conversations];
    const seen = new Set(conversations.map((summary) => summary.conversation.id));
    let cursor = bootstrap.conversationsNextCursor;
    while (cursor !== null) {
      const page = await this.#client.listConversations({ after: cursor });
      const added = page.conversations.filter((summary) => !seen.has(summary.conversation.id));
      for (const summary of added) seen.add(summary.conversation.id);
      conversations.push(...added);
      // A server that claims another page without advancing must not spin the renderer.
      if (added.length === 0 || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    return {
      currentUser: bootstrap.currentUser,
      workspace: bootstrap.workspace,
      members: bootstrap.members,
      conversations,
      syncCursor: bootstrap.syncCursor,
      featureFlags: bootstrap.featureFlags,
    };
  }

  async #refreshSnapshot(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null) return;
    const membershipEpoch = this.#membershipEpoch;
    const openThreadRootId = this.#state.selectedThreadRootId;
    const openThreadConversationId = this.#state.selectedConversationId;
    const snapshot = await this.#fetchSnapshot();
    const messages: Message[] = [];
    const threadSummaries: MessageThreadSummary[] = [];
    const reactions: Reaction[] = [];
    let threadsSupported = true;
    this.#historyCursors.clear();
    this.#threadCursors.clear();
    for (const summary of snapshot.conversations) {
      const history = await this.#client.getConversationMessages({
        conversationId: summary.conversation.id,
        limit: 50,
      });
      this.#historyCursors.set(summary.conversation.id, history.nextCursor);
      messages.push(...history.messages);
      threadSummaries.push(...history.threadSummaries);
      threadsSupported &&= history.threadsSupported;
      if (history.messages.length > 0) {
        const hydrated = await this.#client.listMessageReactions(
          history.messages.map((message) => message.id),
        );
        reactions.push(...hydrated.reactions);
      }
    }
    const visibleConversationIds = new Set(
      snapshot.conversations.map((summary) => summary.conversation.id),
    );
    const queuedThreadRootIds = new Set(
      this.#state.outbox.flatMap((item) => {
        const threadRootId = item.operation.message.threadRootId;
        return threadRootId !== null && visibleConversationIds.has(item.operation.conversationId)
          ? [threadRootId]
          : [];
      }),
    );
    const preservedQueuedRoots = this.#state.messages.filter(
      (message) =>
        queuedThreadRootIds.has(message.id) &&
        message.threadRootId === null &&
        visibleConversationIds.has(message.conversationId),
    );
    const refreshedMessageIds = new Set(messages.map((message) => message.id));
    let refreshedMessages: readonly Message[] = mergeMessages(messages, preservedQueuedRoots);
    let refreshedReactions: readonly Reaction[] = mergeReactions(
      reactions,
      this.#state.reactions.filter(
        (reaction) =>
          queuedThreadRootIds.has(reaction.messageId) &&
          !refreshedMessageIds.has(reaction.messageId),
      ),
    );
    const selectedConversationStillVisible =
      openThreadConversationId !== null && visibleConversationIds.has(openThreadConversationId);
    if (threadsSupported && openThreadRootId !== null && selectedConversationStillVisible) {
      const thread = await this.#client.getMessageThread({
        messageId: openThreadRootId,
        limit: 50,
      });
      const threadMessages = [thread.root, ...thread.replies];
      const hydrated = await this.#client.listMessageReactions(
        threadMessages.map((message) => message.id),
      );
      this.#threadCursors.set(openThreadRootId, thread.nextCursor);
      refreshedMessages = mergeMessages(refreshedMessages, threadMessages);
      refreshedReactions = replaceMessageReactions(
        refreshedReactions,
        threadMessages.map((message) => message.id),
        hydrated.reactions,
      );
    }
    if (generation !== this.#generation || membershipEpoch !== this.#membershipEpoch) return;
    const retainedTasks = this.#state.tasks.filter((task) =>
      visibleConversationIds.has(task.conversationId),
    );
    await cache.replaceSnapshot(snapshot, refreshedMessages, refreshedReactions, retainedTasks);
    const loaded = await cache.load();
    if (generation !== this.#generation || membershipEpoch !== this.#membershipEpoch) return;
    this.#membershipRepairPending =
      loaded.repairMarker !== null || this.#acceptedMembershipRepairs.size > 0;
    this.#syncCursor = loaded.syncCursor;
    const loadedSnapshot = loaded.bootstrap;
    const currentSelection = this.#state.selectedConversationId;
    const selectedConversationId =
      loadedSnapshot !== null &&
      currentSelection !== null &&
      loadedSnapshot.conversations.some((summary) => summary.conversation.id === currentSelection)
        ? currentSelection
        : loadedSnapshot === null
          ? null
          : firstConversation(loadedSnapshot);
    const focusedMessageId =
      selectedConversationId === currentSelection ? this.#state.focusedMessageId : null;
    const selectedThreadRootId =
      threadsSupported && selectedConversationId === currentSelection
        ? this.#state.selectedThreadRootId
        : null;
    const focusedThreadMessageId =
      selectedThreadRootId === null ? null : this.#state.focusedThreadMessageId;
    this.#setState({
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      threadSummaries,
      threadsSupported,
      reactions: loaded.reactions,
      tasks: loaded.tasks,
      outbox: loaded.outbox,
      selectedConversationId,
      focusedMessageId,
      selectedThreadRootId,
      focusedThreadMessageId,
      ...(selectedThreadRootId === null ? { threadLoading: false, threadError: null } : {}),
      stale: this.#syncRecoveryPending || this.#resyncRecoveryPending,
      error: null,
    });
  }

  /**
   * Answers a `member.updated` invalidation by re-reading `GET /v1/members` and replacing the
   * member list outright.
   *
   * The event cannot be applied as a delta: its payload is a bare `User` with no status field, so
   * a disable would re-assert the disabled member rather than remove it. The server's directory is
   * already filtered to active memberships, so replacing the list is both the removal path and the
   * addition path. It is bounded at 25 members, unlike `#refreshSnapshot`, which re-downloads every
   * conversation's history.
   */
  async #refreshMembers(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    const request = ++this.#membersRequest;
    try {
      const response = await this.#client.listWorkspaceMembers();
      if (generation !== this.#generation || cache !== this.#cache) return;
      if (request !== this.#membersRequest) return;
      const replaced = await this.#replaceMembersIfCurrent(
        cache,
        generation,
        request,
        response.members,
      );
      if (!replaced) return;
      this.#membersDirty = false;
      // A read that recovers from an earlier failure clears the staleness that failure published.
      // `#repairAndFlush` does this for the sync path; the retry timer has no such drain.
      const recovered = this.#membersAttempt > 0;
      const clearsStale =
        recovered &&
        !this.#syncRecoveryPending &&
        !this.#resyncRecoveryPending &&
        this.#state.error === null;
      this.#membersAttempt = 0;
      this.#clearMembersRetryTimer();
      const snapshot = this.#state.bootstrap;
      if (snapshot === null) {
        if (clearsStale) this.#setState({ stale: false });
        return;
      }
      this.#setState({
        bootstrap: { ...snapshot, members: [...response.members].sort(compareMembers) },
        ...(clearsStale ? { stale: false } : {}),
      });
    } catch {
      if (
        generation !== this.#generation ||
        cache !== this.#cache ||
        request !== this.#membersRequest
      ) {
        return;
      }
      // `#membersDirty` stays set, and a retry is armed here rather than left to the next sync
      // pass. `#repairAndFlush` is the only drain site, and on a healthy realtime socket nothing
      // schedules one -- its retry timer is armed only when `/v1/sync` itself returns retryable.
      // Without this timer a single failed read would leave a disabled member resolvable until
      // the app restarts, which is exactly what this refetch exists to prevent.
      this.#setState({ stale: true });
      this.#scheduleMembersRetry(generation);
    }
  }

  /**
   * Commits directory replacements in order. A newer request may overtake an older network read,
   * but once an older response has entered the cache its transaction must finish before the newer
   * response writes. Otherwise the older transaction can finish last and leave stale members on
   * disk even though its in-memory projection is correctly discarded.
   */
  async #replaceMembersIfCurrent(
    cache: WorkspaceCache,
    generation: number,
    request: number,
    members: readonly User[],
  ): Promise<boolean> {
    let replaced = false;
    const signal = this.#membersReplacementAbortController.signal;
    const replacement = this.#membersReplacementQueue.then(async () => {
      if (
        generation !== this.#generation ||
        cache !== this.#cache ||
        request !== this.#membersRequest
      ) {
        return;
      }
      await cache.replaceMembers(members, signal);
      if (
        generation !== this.#generation ||
        cache !== this.#cache ||
        request !== this.#membersRequest
      ) {
        return;
      }
      replaced = true;
    });
    this.#membersReplacementQueue = replacement.catch(() => undefined);
    await replacement;
    return replaced;
  }

  /**
   * Detaches the next cache generation from writes that may still be waiting on an old cache's
   * storage or crypto. Those writes retain their generation guards, but can no longer stall a
   * current-session directory replacement indefinitely.
   */
  #retireMembersReplacementQueue(): void {
    this.#membersReplacementAbortController.abort();
    this.#membersReplacementAbortController = new AbortController();
    this.#membersReplacementQueue = Promise.resolve();
  }

  #scheduleMembersRetry(generation: number): void {
    this.#clearMembersRetryTimer();
    this.#membersAttempt += 1;
    this.#membersRetryTimer = setTimeout(() => {
      this.#membersRetryTimer = null;
      if (generation !== this.#generation || !this.#membersDirty) return;
      void this.#refreshMembers(generation);
    }, retryDelay(this.#membersAttempt));
  }

  #clearMembersRetryTimer(): void {
    if (this.#membersRetryTimer === null) return;
    clearTimeout(this.#membersRetryTimer);
    this.#membersRetryTimer = null;
  }

  async #repairAndFlush(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    this.#syncRecoveryPending = true;
    this.#clearSyncRetryTimer();
    let state = await cache.load();
    let cursor = state.syncCursor ?? "0";
    let resets = 0;
    for (;;) {
      const result = await this.#client.syncWorkspace(cursor);
      if (generation !== this.#generation) return;
      if (result.status === "authentication_required") return;
      if (result.status === "permanent") {
        // Retrying cannot help, so the failure must be visible instead of silently going stale.
        this.#setState({ stale: true, error: syncFailureMessage(result.reason) });
        return;
      }
      if (result.status === "retryable") {
        this.#setState({ stale: true });
        this.#scheduleSyncRetry(generation, result.retryAfterMs);
        return;
      }
      if (result.status === "reset_required") {
        if (resets > 0) {
          this.#setState({
            stale: true,
            error: "The server keeps asking this device to resync. Reset the local cache.",
          });
          return;
        }
        resets += 1;
        await cache.clearServerStatePreservingOutbox();
        this.#syncCursor = null;
        await this.#refreshSnapshot(generation);
        if (generation !== this.#generation) return;
        state = await cache.load();
        cursor = state.syncCursor ?? "0";
        continue;
      }
      let repairedMembership = false;
      for (const event of result.response.events) {
        // This loop deliberately bypasses `#applyWorkspaceEvent`, so the invalidation is recorded
        // here and drained once below. Without this the fix would only work while the app is
        // online, and a disable that landed during a backfill would survive the catch-up.
        if (event.type === "member.updated") this.#membersDirty = true;
        if (event.type === "channel.membership_changed") {
          const repaired = await this.#repairMembershipEvent(event, generation, false);
          if (generation !== this.#generation || cache !== this.#cache) return;
          if (repaired) {
            cursor = this.#syncCursor ?? event.workspaceSequence;
            repairedMembership = true;
            break;
          }
          continue;
        }
        await cache.applyEvent(event);
      }
      if (repairedMembership) continue;
      await cache.advanceCursor(result.response.nextCursor);
      await this.#client.acknowledgeWorkspaceEvent(result.response.nextCursor);
      this.#syncCursor = result.response.nextCursor;
      cursor = result.response.nextCursor;
      if (!result.response.hasMore) break;
    }
    this.#syncAttempt = 0;
    // Drained once for the whole backfill, and before the reload so the state this flush publishes
    // is the refreshed directory rather than the stale cached one. Also the retry site for a
    // realtime refetch that failed earlier.
    if (this.#membersDirty) await this.#refreshMembers(generation);
    await this.#reloadCache();
    this.#syncRecoveryPending = false;
    // A directory read that failed leaves the client genuinely stale, so the flush must not claim
    // otherwise just because the event page drained. A resync remains stale until realtime has
    // also restarted with the repaired cursor.
    this.#setState({ stale: this.#membersDirty || this.#resyncRecoveryPending });
    await this.#flushOutbox(generation);
  }

  async #handleRealtimeEvent(
    event: ProductRealtimeEvent,
    generation: number,
    resyncRequest: number | null,
    realtimeEpoch: number,
  ): Promise<void> {
    const acceptedMembershipRepair =
      event.type === "channel.membership_changed" && this.#acceptedMembershipRepairs.has(event.id);
    // Ordinary frames still belong to the socket epoch that delivered them. Membership repairs
    // recorded by the listener are obligations of this renderer generation, even when an earlier
    // repair restarted realtime before their queued turn arrived.
    if (
      generation !== this.#generation ||
      (realtimeEpoch !== this.#realtimeEpoch && !acceptedMembershipRepair) ||
      this.#cache === null
    ) {
      return;
    }
    if (event.type === "system.connected") {
      await this.#cache.advanceCursor(event.workspaceSequence);
      await this.#client.acknowledgeWorkspaceEvent(event.workspaceSequence);
      // A live socket makes a queued resync backoff pointless: the server took this cursor, so
      // dropping the cached workspace again would only cost another full download. A resync whose
      // download failed is a different matter — the cache has no workspace until it lands — so
      // that retry stays armed. The chain counter is deliberately *not* reset here: the server
      // sends this event on every socket whose first flush drains and can still demand a resync
      // from a later flush on that same socket, so resetting it here disarms the bound entirely.
      if (this.#resyncFailures === 0) this.#clearResyncTimer();
      this.#setState({ connection: "live" });
      return;
    }
    if (event.type === "system.resync_required") {
      if (resyncRequest !== null) await this.#resync(generation, resyncRequest);
      return;
    }
    await this.#applyWorkspaceEvent(event, generation);
  }

  /**
   * The server sends `system.resync_required` and then closes the socket, so realtime has to be
   * restarted with the cursor the fresh snapshot establishes. Reconnecting with the stale cursor
   * would be answered with another resync, and the client would re-download history forever, so
   * the first demand of a chain is answered at once and repeats wait for a backoff — then stop.
   */
  async #resync(generation: number, request: number): Promise<void> {
    if (
      this.#cache === null ||
      generation !== this.#generation ||
      request !== this.#resyncRequest
    ) {
      return;
    }
    this.#resyncRecoveryPending = true;
    await this.#client.stopWorkspaceRealtime();
    this.#setState({ stale: true });
    const settledAt = this.#resyncSettledAt;
    // A demand that arrives long after the last resync settled is a new problem rather than a
    // repeat of the one that resync answered, so it starts counting again. Elapsed connected time
    // is the signal, since the server sends `system.connected` on handshakes it then rejects.
    if (settledAt !== null && Date.now() - settledAt >= RESYNC_CHAIN_RESET_MS) {
      this.#resyncAttempt = 0;
    }
    this.#resyncAttempt += 1;
    if (this.#resyncAttempt > MAX_CONSECUTIVE_RESYNCS) {
      // Mirrors the reset guard in #repairAndFlush: another download cannot help, so the dead end
      // has to be visible instead of spinning behind a "cached state may be stale" note.
      this.#clearResyncTimer();
      this.#setState({
        stale: true,
        error: "The server keeps asking this device to resync. Reset the local cache.",
      });
      return;
    }
    if (this.#resyncAttempt === 1) {
      await this.#serializeRecovery(() => this.#attemptResync(generation, request));
      return;
    }
    this.#scheduleResync(generation, request, retryDelay(this.#resyncAttempt));
  }

  /**
   * One resync attempt: drop the server-derived stores, keep the outbox, re-download, resume the
   * sync loop, and restart realtime with the cursor that establishes. A failure here is transient —
   * a server that has not finished coming back up, most often — so it is retried with backoff and
   * does not count against the demand bound. Charging it there wedged the client for good: a few
   * seconds of downtime spent the whole budget, left no cached workspace behind, and reported a
   * server demanding resyncs it had never sent.
   */
  async #attemptResync(generation: number, request: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation || request !== this.#resyncRequest) {
      return;
    }
    try {
      await cache.clearServerStatePreservingOutbox();
      if (generation !== this.#generation || request !== this.#resyncRequest) return;
      this.#syncCursor = null;
      await this.#refreshSnapshot(generation);
      if (
        generation !== this.#generation ||
        this.#cache === null ||
        request !== this.#resyncRequest
      ) {
        return;
      }
      await this.#repairAndFlush(generation);
      if (
        generation !== this.#generation ||
        this.#cache === null ||
        request !== this.#resyncRequest
      ) {
        return;
      }
      // Stamped before the handshake goes out, because the demand that answers it arrives on the
      // socket this opens: a chain has to be measured from the handshake, not from a reply to it.
      this.#resyncSettledAt = Date.now();
      await this.#restartRealtime(generation);
      if (generation !== this.#generation || request !== this.#resyncRequest) return;
      this.#resyncFailures = 0;
      this.#resyncRecoveryPending = false;
      this.#setState({ stale: this.#membersDirty || this.#syncRecoveryPending });
    } catch (error) {
      if (generation !== this.#generation || request !== this.#resyncRequest) return;
      // Realtime is stopped and the server-derived stores are already gone, so without rearming
      // here the client sits offline with no cached workspace until the user presses Retry. The
      // notice is the failure that actually happened, never the server-keeps-demanding dead end.
      this.#resyncFailures += 1;
      this.#setState({ stale: true, error: errorMessage(error, "Could not resync the workspace") });
      this.#scheduleResync(generation, request, retryDelay(this.#resyncFailures));
    }
  }

  #scheduleResync(generation: number, request: number, delayMs: number): void {
    this.#clearResyncTimer();
    this.#resyncTimer = setTimeout(() => {
      this.#resyncTimer = null;
      // A newer resync demand can supersede this request while the timer waits, but recovery
      // remains independent from ordinary realtime events and never races another sync pass.
      void this.#serializeRecovery(() => this.#attemptResync(generation, request));
    }, delayMs);
  }

  async #restartRealtime(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    const loaded = await cache.load();
    if (generation !== this.#generation) return;
    this.#syncCursor = loaded.syncCursor;
    this.#realtimeEpoch += 1;
    await this.#client.startWorkspaceRealtime(loaded.syncCursor ?? "0");
  }

  async #repairMembershipEvent(
    event: Extract<WorkspaceEvent, { type: "channel.membership_changed" }>,
    generation: number,
    restartRealtime: boolean,
  ): Promise<boolean> {
    const cache = this.#cache;
    if (cache === null) return false;
    this.#membershipRepairPending = true;
    this.#membershipEpoch += 1;
    this.#clearRetryTimer();
    this.#clearReadTargets();
    this.#beginMembershipBarrier(event);

    // Begin shutdown immediately, but do not await it until the marker and purge have committed.
    // The converted result also prevents an early rejection from becoming unhandled while storage
    // work is still establishing the privacy boundary.
    const shutdown = this.#client.stopWorkspaceRealtime().then(
      () => null,
      (error: unknown) => error,
    );
    await cache.stageMembershipRepair(event);
    await cache.applyEvent(event);
    const purged = await cache.load();
    if (generation === this.#generation && cache === this.#cache) {
      this.#publishMembershipCache(purged, event.conversationId);
    }
    const repairedMembership = purged.repairMarker !== null;

    const shutdownError = await shutdown;
    if (shutdownError !== null) throw shutdownError;
    if (generation !== this.#generation || cache !== this.#cache) return repairedMembership;

    if (repairedMembership) {
      await this.#refreshSnapshot(generation);
      if (generation !== this.#generation || cache !== this.#cache) return true;
      const repaired = await cache.load();
      if (repaired.repairMarker !== null) {
        throw new Error("Membership repair did not clear its durable marker");
      }
    }

    const candidateCursor = this.#syncCursor ?? event.workspaceSequence;
    // A snapshot or mutation response may have advanced the local cursor beyond another accepted
    // repair. Cap this acknowledgement so a crash leaves that later event available for replay.
    const crossesAcceptedRepair = [...this.#acceptedMembershipRepairs].some(
      ([eventId, workspaceSequence]) =>
        eventId !== event.id && compareSequence(workspaceSequence, candidateCursor) <= 0,
    );
    await this.#client.acknowledgeWorkspaceEvent(
      crossesAcceptedRepair ? event.workspaceSequence : candidateCursor,
    );
    this.#acceptedMembershipRepairs.delete(event.id);
    if (generation !== this.#generation || cache !== this.#cache) return repairedMembership;
    if (restartRealtime) await this.#restartRealtime(generation);
    if (generation !== this.#generation || cache !== this.#cache) return repairedMembership;
    this.#membershipRepairPending = this.#acceptedMembershipRepairs.size > 0;
    if (!this.#membershipRepairPending) void this.#flushOutbox(generation);
    return repairedMembership;
  }

  #publishMembershipCache(state: CachedWorkspaceState, conversationId: string): void {
    const visibleConversationIds = new Set(
      state.bootstrap?.conversations.map((summary) => summary.conversation.id) ?? [],
    );
    const selectedConversationId =
      this.#state.selectedConversationId !== null &&
      visibleConversationIds.has(this.#state.selectedConversationId)
        ? this.#state.selectedConversationId
        : state.bootstrap === null
          ? null
          : firstConversation(state.bootstrap);
    const visibleMessageIds = new Set(state.messages.map((message) => message.id));
    for (const [rootId] of this.#threadCursors) {
      if (!visibleMessageIds.has(rootId)) this.#threadCursors.delete(rootId);
    }
    this.#historyCursors.delete(conversationId);
    this.#setState({
      bootstrap: state.bootstrap,
      messages: state.messages,
      threadSummaries: this.#state.threadSummaries.filter((summary) =>
        visibleMessageIds.has(summary.threadRootId),
      ),
      reactions: state.reactions,
      tasks: state.tasks,
      outbox: state.outbox,
      selectedConversationId,
      focusedMessageId:
        selectedConversationId === this.#state.selectedConversationId
          ? this.#state.focusedMessageId
          : null,
      selectedThreadRootId:
        this.#state.selectedThreadRootId !== null &&
        visibleMessageIds.has(this.#state.selectedThreadRootId)
          ? this.#state.selectedThreadRootId
          : null,
      focusedThreadMessageId:
        this.#state.focusedThreadMessageId !== null &&
        visibleMessageIds.has(this.#state.focusedThreadMessageId)
          ? this.#state.focusedThreadMessageId
          : null,
      stale: true,
    });
  }

  #beginMembershipBarrier(
    event: Extract<WorkspaceEvent, { type: "channel.membership_changed" }>,
  ): void {
    const snapshot = this.#state.bootstrap;
    if (
      event.payload.action !== "removed" ||
      event.payload.memberId !== snapshot?.currentUser.user.id
    ) {
      return;
    }
    const conversationId = event.conversationId;
    const messages = this.#state.messages.filter(
      (message) => message.conversationId !== conversationId,
    );
    const messageIds = new Set(messages.map((message) => message.id));
    const bootstrap = {
      ...snapshot,
      conversations: snapshot.conversations.filter(
        (summary) => summary.conversation.id !== conversationId,
      ),
    };
    const selectedConversationId =
      this.#state.selectedConversationId === conversationId
        ? firstConversation(bootstrap)
        : this.#state.selectedConversationId;
    this.#historyCursors.delete(conversationId);
    for (const [rootId] of this.#threadCursors) {
      if (!messageIds.has(rootId)) this.#threadCursors.delete(rootId);
    }
    this.#setState({
      bootstrap,
      messages,
      threadSummaries: this.#state.threadSummaries.filter((summary) =>
        messageIds.has(summary.threadRootId),
      ),
      reactions: this.#state.reactions.filter((reaction) => messageIds.has(reaction.messageId)),
      tasks: this.#state.tasks.filter((task) => task.conversationId !== conversationId),
      outbox: this.#state.outbox.filter((item) => item.operation.conversationId !== conversationId),
      selectedConversationId,
      focusedMessageId:
        selectedConversationId === this.#state.selectedConversationId
          ? this.#state.focusedMessageId
          : null,
      selectedThreadRootId:
        this.#state.selectedThreadRootId !== null &&
        messageIds.has(this.#state.selectedThreadRootId)
          ? this.#state.selectedThreadRootId
          : null,
      focusedThreadMessageId:
        this.#state.focusedThreadMessageId !== null &&
        messageIds.has(this.#state.focusedThreadMessageId)
          ? this.#state.focusedThreadMessageId
          : null,
      stale: true,
    });
  }

  async #applyWorkspaceEvent(event: WorkspaceEvent, generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null) return;
    if (event.type === "channel.membership_changed") {
      await this.#repairMembershipEvent(event, generation, true);
      return;
    }
    const applied = await cache.applyEvent(event);
    await this.#client.acknowledgeWorkspaceEvent(event.workspaceSequence);
    if (!applied) return;
    this.#syncCursor = event.workspaceSequence;
    if (event.type === "member.updated") {
      // Announces THAT the directory changed, never what it now is. Re-read it instead of
      // projecting the payload, or disabling a member would re-assert it as a mention target.
      this.#membersDirty = true;
      await this.#refreshMembers(generation);
      return;
    }
    // The event payload already carries everything the view needs, so the whole encrypted cache
    // does not have to be decrypted again for every message.
    this.#projectEvent(event);
  }

  #projectEvent(event: WorkspaceEvent): void {
    const snapshot = this.#state.bootstrap;
    if (event.type === "message.created") {
      const message = event.payload.message;
      const newlyObserved = !this.#state.messages.some((existing) => existing.id === message.id);
      this.#setState({
        messages: mergeMessages(this.#state.messages, [message]),
        threadSummaries: projectReplySummary(this.#state.threadSummaries, message, newlyObserved),
        outbox: this.#withoutOutbox([message.clientMessageId]),
        bootstrap: snapshot === null ? null : countMessage(snapshot, event),
      });
      return;
    }
    if (event.type === "reaction.added") {
      this.#setState({
        reactions: mergeReactions(this.#state.reactions, [event.payload.reaction]),
      });
      return;
    }
    if (event.type === "reaction.removed") {
      this.#setState({
        reactions: this.#state.reactions.filter(
          (reaction) => reaction.id !== event.payload.reaction.id,
        ),
      });
      return;
    }
    if (event.type === "task.created" || event.type === "task.updated") {
      this.#setState({ tasks: mergeTasks(this.#state.tasks, [event.payload.task]) });
      return;
    }
    if (snapshot === null) return;
    if (event.type === "read_cursor.updated") {
      const { readCursor, unreadCount, mentionCount } = event.payload;
      this.#setState({
        bootstrap: replaceConversation(snapshot, event.conversationId, (current) => {
          if (current === undefined) return null;
          return {
            ...current,
            readCursor,
            unreadCount: unreadCount ?? current.unreadCount,
            mentionCount: mentionCount ?? current.mentionCount,
          };
        }),
      });
      return;
    }
    // Both are invalidation signals rather than deltas: `#applyWorkspaceEvent` answers them with a
    // server re-read and never reaches this projection. `member.updated` in particular must have
    // no upsert path here — that is the whole reason a disable used to re-assert the disabled
    // member instead of removing it.
    if (event.type === "channel.membership_changed" || event.type === "member.updated") return;
    this.#setState({
      bootstrap: replaceConversation(snapshot, event.conversationId, (current) => ({
        conversation: event.payload.conversation,
        participantIds: [...event.payload.participantIds],
        membershipRole: current?.membershipRole ?? null,
        lastMessage: current?.lastMessage ?? null,
        unreadCount: current?.unreadCount ?? 0,
        mentionCount: current?.mentionCount ?? 0,
        readCursor: current?.readCursor ?? null,
      })),
    });
  }

  async #flushOutbox(generation: number): Promise<void> {
    const cache = this.#cache;
    if (
      this.#flushing ||
      this.#membershipRepairPending ||
      cache === null ||
      generation !== this.#generation
    ) {
      return;
    }
    this.#flushing = true;
    this.#clearRetryTimer();
    try {
      for (;;) {
        if (this.#membershipRepairPending) return;
        const next = nextDeliverable(this.#state.outbox, Date.now());
        if (next === undefined) {
          this.#scheduleNextRetry(this.#state.outbox, generation);
          break;
        }
        const id = next.operation.message.clientMessageId;
        const attempt = next.attemptCount + 1;
        await this.#patchOutbox(id, {
          status: "sending",
          attemptCount: attempt,
          nextAttemptAt: null,
          failureReason: null,
        });
        if (generation !== this.#generation || this.#membershipRepairPending) return;
        const result = await this.#client.sendConversationMessage(next.operation);
        if (generation !== this.#generation || this.#membershipRepairPending) return;
        if (result.status === "accepted") {
          // The send response's cursor is a whole-workspace sequence, so a peer event still in
          // flight can be below it. Record the message durably but keep this client's cursor at
          // what it has actually applied, and never acknowledge the send cursor to the server.
          await cache.upsertAcknowledgedMessage(result.response.message, this.#syncCursor ?? "0");
          if (generation !== this.#generation || this.#membershipRepairPending) return;
          this.#acceptMessage(result.response.message, id);
          continue;
        }
        if (result.status === "authentication_required") {
          await this.#patchOutbox(id, {
            status: "paused_auth",
            attemptCount: attempt,
            nextAttemptAt: null,
            failureReason: "Sign in to retry",
          });
          break;
        }
        if (result.status === "permanent") {
          await this.#patchOutbox(id, {
            status: "permanent_failure",
            attemptCount: attempt,
            nextAttemptAt: null,
            failureReason: result.reason,
          });
          continue;
        }
        const delay = result.retryAfterMs ?? retryDelay(attempt);
        await this.#patchOutbox(id, {
          status: "retry_wait",
          attemptCount: attempt,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          failureReason: result.reason,
        });
        // Without rearming here the message waits for a manual retry or a restart forever.
        this.#scheduleNextRetry(this.#state.outbox, generation);
        break;
      }
    } finally {
      this.#flushing = false;
    }
  }

  #acceptMessage(message: Message, clientMessageId: string): void {
    const snapshot = this.#state.bootstrap;
    const newlyObserved = !this.#state.messages.some((existing) => existing.id === message.id);
    const bootstrap =
      snapshot === null
        ? null
        : replaceConversation(snapshot, message.conversationId, (current) => {
            if (current === undefined) return null;
            return { ...current, lastMessage: message };
          });
    this.#setState({
      messages: mergeMessages(this.#state.messages, [message]),
      threadSummaries: projectReplySummary(this.#state.threadSummaries, message, newlyObserved),
      // Both ids are dropped so a server that does not echo the client id cannot leave the
      // delivered item queued and spin the flush loop.
      outbox: this.#withoutOutbox([clientMessageId, message.clientMessageId]),
      bootstrap,
    });
  }

  #withoutOutbox(clientMessageIds: readonly string[]): readonly OutboxItem[] {
    return this.#state.outbox.filter(
      (item) => !clientMessageIds.includes(item.operation.message.clientMessageId),
    );
  }

  async #patchOutbox(clientMessageId: string, update: OutboxUpdate): Promise<void> {
    await this.#cache?.updateOutbox(clientMessageId, update);
    this.#setState({
      outbox: this.#state.outbox.map((item) =>
        item.operation.message.clientMessageId === clientMessageId ? { ...item, ...update } : item,
      ),
    });
  }

  async #reloadCache(): Promise<void> {
    const cache = this.#cache;
    if (cache === null) return;
    const loaded = await cache.load();
    let threadSummaries = this.#state.threadSummaries;
    const knownMessageIds = new Set(this.#state.messages.map((message) => message.id));
    for (const message of loaded.messages) {
      if (message.threadRootId !== null) {
        threadSummaries = projectReplySummary(
          threadSummaries,
          message,
          !knownMessageIds.has(message.id),
        );
      }
      knownMessageIds.add(message.id);
    }
    this.#syncCursor = loaded.syncCursor;
    this.#setState({
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      threadSummaries,
      reactions: loaded.reactions,
      tasks: loaded.tasks,
      outbox: loaded.outbox,
    });
  }

  #scheduleSyncRetry(generation: number, retryAfterMs: number | null): void {
    this.#clearSyncRetryTimer();
    this.#syncAttempt += 1;
    const delay = retryAfterMs ?? retryDelay(this.#syncAttempt);
    this.#syncRetryTimer = setTimeout(() => {
      this.#syncRetryTimer = null;
      // A resync also runs the repair loop. Rejoin its dedicated queue so two passes cannot share
      // recovery flags or mutate the cache concurrently. A resync that already completed its own
      // repair resets the attempt and makes this queued retry redundant.
      void this.#serializeRecovery(async () => {
        if (generation !== this.#generation || this.#syncAttempt === 0) return;
        await this.#repairAndFlush(generation);
      }).catch((error: unknown) => {
        if (generation === this.#generation) {
          this.#setState({
            stale: true,
            error: errorMessage(error, "Could not sync the workspace"),
          });
        }
      });
    }, delay);
  }

  #scheduleNextRetry(outbox: readonly OutboxItem[], generation: number): void {
    const times = firstItemsByConversation(outbox)
      .filter((item) => item.status === "retry_wait" && item.nextAttemptAt !== null)
      .map((item) => Date.parse(item.nextAttemptAt as string))
      .filter(Number.isFinite);
    const next = times.length === 0 ? undefined : Math.min(...times);
    if (next === undefined) return;
    this.#clearRetryTimer();
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        void this.#flushOutbox(generation);
      },
      Math.max(0, next - Date.now()),
    );
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #clearSyncRetryTimer(): void {
    if (this.#syncRetryTimer !== null) {
      clearTimeout(this.#syncRetryTimer);
      this.#syncRetryTimer = null;
    }
  }

  #clearReadTargets(): void {
    for (const target of this.#readTargets.values()) {
      if (target.retryTimer !== null) clearTimeout(target.retryTimer);
    }
    this.#readTargets.clear();
  }

  #clearResyncTimer(): void {
    if (this.#resyncTimer !== null) {
      clearTimeout(this.#resyncTimer);
      this.#resyncTimer = null;
    }
  }

  /** Forgets the current resync chain, pending retry included. */
  #resetResyncState(): void {
    this.#clearResyncTimer();
    this.#resyncAttempt = 0;
    this.#resyncFailures = 0;
    this.#resyncRecoveryPending = false;
    this.#resyncRequest += 1;
    this.#resyncSettledAt = null;
  }
}
