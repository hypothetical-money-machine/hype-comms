import {
  compareSyncPositions,
  sendMessageOperationSchema,
  WORKSPACE_PROTOCOL_UPGRADE_MESSAGE,
  type Attachment,
  type AuthenticatedSessionContext,
  type CacheCryptoStatus,
  type CacheScope,
  type ChannelAccess,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type ChannelMode,
  type ConversationSummary,
  type Message,
  type MessageSearchResponse,
  type MessageSearchResult,
  type MessageThreadSummary,
  type NotificationAction,
  type NotificationContext,
  type PresenceState,
  type ProductRealtimeEvent,
  type Reaction,
  type ReactionEmoji,
  type RealtimeSessionScope,
  type ScopedEphemeralActivityFrame,
  type ScopedProductRealtimeEvent,
  type SyncAttemptResult,
  type SyncPosition,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type User,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hype-comms/contracts";

import type { AttachmentUploadResult } from "../../shared/attachment-upload";
import type { DesktopApi, RealtimeConnectionState } from "../../shared/desktop-api";
import {
  applyRetractReservation,
  compareMembers,
  mergeMessages,
  mergeReactions,
  mergeTasks,
  mergeThreadSummaries,
  projectReplySummary,
  reconcileRetractedConversationSummary,
  replaceConversation,
  replaceMessageReactions,
  retractReplySummary,
  retractReservationMap,
  retractedMessageIds,
  type RetractReservation,
  upsertRetractReservation,
} from "./workspace-projection";
import type { CacheEventResult } from "./workspace-cache-changes";

import {
  CollectionJournal,
  CollectionRetry,
  collectionKey,
  invalidateCollections,
  replayCollectionPage,
  unloadedCollection,
  type CollectionIdentity,
  type CollectionRecords,
  type CollectionState,
} from "./workspace-collections";

import { mentionedMemberIds } from "./mentions";
import {
  clearPersistentWorkspaceCache,
  MemoryWorkspaceCache,
  PersistentWorkspaceCache,
  rememberCreatedMessageMentions,
  type CachedWorkspaceState,
  type MembershipRepairMarker,
  type OutboxItem,
  type OutboxStatus,
  type OutboxUpdateExpectation,
  type WorkspaceCache,
} from "./workspace-cache";

/** Why the encrypted cache fell back to memory. Derived so a new crypto reason cannot drift. */
export type CacheFallbackReason = Extract<CacheCryptoStatus, { mode: "memory_only" }>["reason"];

export interface WorkspaceRuntimeState {
  readonly collections: readonly CollectionState[];
  readonly bootstrap: WorkspaceSnapshot | null;
  readonly messages: readonly Message[];
  readonly threadSummaries: readonly MessageThreadSummary[];
  readonly threadsSupported: boolean;
  readonly reactions: readonly Reaction[];
  readonly attachments: readonly Attachment[];
  readonly conversationFiles: readonly Attachment[];
  readonly conversationFilesBusy: boolean;
  readonly conversationFilesError: string | null;
  readonly tasks: readonly Task[];
  readonly outbox: readonly OutboxItem[];
  readonly selectedConversationId: string | null;
  readonly focusedMessageId: string | null;
  readonly selectedThreadRootId: string | null;
  readonly focusedThreadMessageId: string | null;
  readonly threadLoading: boolean;
  readonly threadError: string | null;
  readonly connection: RealtimeConnectionState;
  /** Ephemeral only: absent members are offline, and neither map is written to the cache. */
  readonly presenceByUser: Readonly<Record<string, PresenceState>>;
  readonly typingByConversation: Readonly<Record<string, readonly string[]>>;
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

export interface WorkspaceStartOptions {
  /** Opens only the already-authorized encrypted replica and performs no product network I/O. */
  readonly offline?: boolean;
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

/** Body-free copy for a missing, revoked, or invalid notification target. */
const NOTIFICATION_TARGET_UNAVAILABLE = "That notification is no longer available.";

const SOURCE_LESS_RETRACT_METADATA_ERROR =
  "Could not refresh unread counts after a message was deleted.";

/** Mirrors the encrypted replica's `workspaceSnapshotSchema` conversation bound. */
const WORKSPACE_CONVERSATION_LIMIT = 5_000;

// Live creates retain exact mention IDs until a retract arrives. Eviction falls back to the
// message-body scan, but this map must not grow for the lifetime of a busy desktop session.
const MAX_LOCAL_RETRACT_EFFECTS = 20_000;

/**
 * Maximum records accepted by one on-demand task collection load. Individual page commits never
 * advance the global replay position; a failure leaves the collection invalidated for retry.
 */
export const WORKSPACE_TASK_COLLECTION_LIMIT = 20_000;

const INITIAL_STATE: WorkspaceRuntimeState = {
  collections: [],
  bootstrap: null,
  messages: [],
  threadSummaries: [],
  // Conservative until history negotiation succeeds: previous servers keep replies inline.
  threadsSupported: false,
  reactions: [],
  attachments: [],
  conversationFiles: [],
  conversationFilesBusy: false,
  conversationFilesError: null,
  tasks: [],
  outbox: [],
  selectedConversationId: null,
  focusedMessageId: null,
  selectedThreadRootId: null,
  focusedThreadMessageId: null,
  threadLoading: false,
  threadError: null,
  connection: "offline",
  presenceByUser: {},
  typingByConversation: {},
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

/** The unique 1:1 (or self) DM for `memberId` already present in the local catalog. */
function isDirectConversationWith(
  summary: ConversationSummary,
  currentUserId: string,
  memberId: string,
): boolean {
  if (summary.conversation.kind !== "direct_message") return false;
  const participants = new Set(summary.participantIds);
  if (memberId === currentUserId) {
    return participants.size === 1 && participants.has(currentUserId);
  }
  return participants.size === 2 && participants.has(currentUserId) && participants.has(memberId);
}

/** Full jitter between one second and 30 seconds, per the delivery contract. */
function retryDelay(attempt: number): number {
  const maximum = Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
  return Math.max(1_000, Math.floor(Math.random() * maximum));
}

function isSelfMembershipChange(
  event: ProductRealtimeEvent,
  userId: string | null,
): event is Extract<WorkspaceEvent, { type: "channel.membership_changed" }> {
  return (
    event.type === "channel.membership_changed" &&
    (userId === null || event.payload.memberId === userId)
  );
}

function mergeAttachments(
  attachments: readonly Attachment[],
  incoming: readonly Attachment[],
): readonly Attachment[] {
  if (incoming.length === 0) return attachments;
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  for (const attachment of incoming) byId.set(attachment.id, attachment);
  return [...byId.values()];
}

function replaceMessageAttachments(
  attachments: readonly Attachment[],
  messageIds: readonly string[],
  incoming: readonly Attachment[],
): readonly Attachment[] {
  const replaced = new Set(messageIds);
  return mergeAttachments(
    attachments.filter(
      (attachment) => attachment.messageId === null || !replaced.has(attachment.messageId),
    ),
    incoming,
  );
}

function attachedConversationFiles(attachments: readonly Attachment[]): readonly Attachment[] {
  return attachments.filter(
    (attachment) => attachment.status === "ready" && attachment.messageId !== null,
  );
}

function liveMessageIds(messages: readonly Message[]): ReadonlySet<string> {
  return new Set(
    messages.filter((message) => message.deletedAt === null).map((message) => message.id),
  );
}

function retainReactionsForLiveMessages(
  reactions: readonly Reaction[],
  messages: readonly Message[],
): readonly Reaction[] {
  const liveIds = liveMessageIds(messages);
  return reactions.filter((reaction) => liveIds.has(reaction.messageId));
}

function retainAttachmentsForLiveMessages(
  attachments: readonly Attachment[],
  messages: readonly Message[],
): readonly Attachment[] {
  const liveIds = liveMessageIds(messages);
  return attachments.filter(
    (attachment) => attachment.messageId === null || liveIds.has(attachment.messageId),
  );
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

function sameRealtimeScope(left: RealtimeSessionScope, right: RealtimeSessionScope): boolean {
  return (
    left.epoch === right.epoch &&
    left.userId === right.userId &&
    left.workspaceId === right.workspaceId
  );
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

interface ProjectionGuard {
  readonly cache: WorkspaceCache;
  readonly generation: number;
  readonly membershipEpoch: number;
  readonly signal: AbortSignal;
}

export class WorkspaceRuntime {
  readonly #listeners = new Set<(state: WorkspaceRuntimeState) => void>();
  readonly #client: DesktopApi;
  readonly #createCache: (status: CacheCryptoStatus) => WorkspaceCache;
  #state = INITIAL_STATE;
  #cache: WorkspaceCache | null = null;
  #generation = 0;
  #offlineOnly = false;
  #protocolBlocked = false;
  /** The current projection owns one flush; a rotated barrier may supersede a hung old worker. */
  #outboxFlushOwner: ProjectionGuard | null = null;
  #outboxFlushRequested = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #sourceLessRetractMetadataRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #sourceLessRetractMetadataAttempt = 0;
  #sourceLessRetractMetadataVersion = 0;
  #sourceLessRetractMetadataPending = false;
  #resyncTimer: ReturnType<typeof setTimeout> | null = null;
  #syncAttempt = 0;
  /** True until the current sync pass has fully repaired and reloaded the local projection. */
  #syncRecoveryPending = false;
  /** A cached replica is still completing its pre-snapshot HTTP catch-up. */
  #startupReplicaCatchUpPending = false;
  /** A startup whose durable HTTP catch-up has not yet opened renderer realtime delivery. */
  #startupRealtimePending = false;
  #startupMetadataPending = false;
  #catalogPending = false;
  #catalogConfirmedIds: Set<string> | null = null;
  #catalogRequest = 0;
  #cacheProjectionQueue: Promise<void> = Promise.resolve();
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
  #syncCursor: SyncPosition | null = null;
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
  /** Aborts every non-event projection before a membership barrier or retired generation wins. */
  #projectionAbortController = new AbortController();
  #membersRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #membersAttempt = 0;
  #eventQueue: Promise<void> = Promise.resolve();
  #recoveryQueue: Promise<void> = Promise.resolve();
  /** Blocks delivery and cursor work from the instant a membership invalidation is observed. */
  #membershipRepairPending = false;
  /** Invalidates snapshot requests that began before the latest membership barrier. */
  #membershipEpoch = 0;
  /** Membership frames accepted by this renderer session but not yet durably repaired and acked. */
  readonly #acceptedMembershipRepairs = new Map<string, SyncPosition>();
  /** Retires frames queued by the realtime session stopped for authoritative membership repair. */
  #realtimeEpoch = 0;
  /** The immutable main-process scope currently authorized to mutate this renderer cache. */
  #realtimeScope: RealtimeSessionScope | null = null;
  readonly #collectionJournals = new Set<CollectionJournal>();
  readonly #collectionLoads = new Map<string, Promise<void>>();
  readonly #threadSummaryPositions = new Map<string, SyncPosition>();
  readonly #historyCursors = new Map<string, string | null>();
  /** In-flight first-page hydrations so opening the same conversation does not stack fetches. */
  readonly #historyHydrations = new Map<string, Promise<void>>();
  readonly #readTargets = new Map<string, ReadTarget>();
  readonly #threadCursors = new Map<string, string | null>();
  /** Conversations whose aggregate thread counts need a full snapshot before they are reliable. */
  readonly #invalidatedThreadSummaryConversationIds = new Set<string>();
  #retractReservations: RetractReservation[] = [];
  readonly #retractedMessageIds = new Set<string>();
  /** Exact mention IDs from live creates, retained while retraction can still reach the message. */
  readonly #createdMessageMentions = new Map<string, readonly string[]>();
  /** Local DELETE responses already changed the renderer before their realtime echo arrives. */
  readonly #locallyProjectedRetracts = new Set<string>();
  #unsubscribeEvent: (() => void) | null = null;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeActivity: (() => void) | null = null;
  readonly #presenceExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #typingExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  #pruneCreatedMessageMentions(
    messages: readonly Message[],
    bootstrap: WorkspaceSnapshot | null,
    threadSummaries: readonly MessageThreadSummary[],
  ): void {
    const retainedMessageIds = new Set(messages.map((message) => message.id));
    for (const summary of bootstrap?.conversations ?? []) {
      if (summary.lastMessage !== null) retainedMessageIds.add(summary.lastMessage.id);
    }
    for (const summary of threadSummaries) retainedMessageIds.add(summary.latestReply.id);
    for (const messageId of this.#createdMessageMentions.keys()) {
      if (!retainedMessageIds.has(messageId)) this.#createdMessageMentions.delete(messageId);
    }
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

  /** Collection and metadata commits share record publication, including during startup. */
  #commitCacheProjection<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#cacheProjectionQueue.then(operation);
    this.#cacheProjectionQueue = result.then(
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

  async start(session: AuthenticatedSessionContext, options: WorkspaceStartOptions = {}) {
    const scope: CacheScope = {
      userId: session.userId,
      workspaceId: session.workspaceId,
    };
    const scopeChanged =
      this.#scope === null ||
      this.#scope.userId !== scope.userId ||
      this.#scope.workspaceId !== scope.workspaceId;
    const generation = ++this.#generation;
    this.#rotateProjectionBarrier();
    this.#cacheProjectionQueue = Promise.resolve();
    this.#historyHydrations.clear();
    this.#collectionLoads.clear();
    this.#offlineOnly = options.offline === true;
    this.#startupMetadataPending = !this.#offlineOnly;
    this.#catalogPending = false;
    this.#catalogConfirmedIds = null;
    this.#catalogRequest += 1;
    this.#protocolBlocked = false;
    this.#retireMembersReplacementQueue();
    this.#recoveryQueue = Promise.resolve();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#resetSourceLessRetractMetadataRefresh();
    this.#clearMembersRetryTimer();
    this.#membersAttempt = 0;
    this.#resetResyncState();
    this.#syncAttempt = 0;
    this.#syncRecoveryPending = false;
    this.#membershipRepairPending = false;
    this.#acceptedMembershipRepairs.clear();
    this.#realtimeEpoch += 1;
    this.#startupReplicaCatchUpPending = false;
    this.#startupRealtimePending = false;
    this.#clearActivity(true);
    // A fresh bootstrap answers any invalidation the previous session left unanswered.
    this.#membersDirty = false;
    this.#clearReadTargets();
    this.#locallyProjectedRetracts.clear();
    // ChatSession may transition directly from one signed-in identity to another. Retire every
    // visible and writable reference to the old scope before the first async cache/bootstrap step;
    // otherwise old messages could remain rendered under the replacement session boundary.
    this.#scope = scope;
    if (scopeChanged) {
      this.#cache = null;
      this.#syncCursor = null;
      this.#historyCursors.clear();
      this.#threadSummaryPositions.clear();
      this.#collectionLoads.clear();
      this.#historyHydrations.clear();
      this.#threadCursors.clear();
      this.#invalidatedThreadSummaryConversationIds.clear();
      this.#retractReservations = [];
      this.#retractedMessageIds.clear();
      this.#createdMessageMentions.clear();
      this.#setState({ ...INITIAL_STATE, busy: true });
    } else {
      this.#setState({ busy: true, error: null });
    }
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeActivity?.();
    this.#eventQueue = Promise.resolve();
    this.#realtimeScope = null;
    // Stop the preceding generation before replacing its snapshot or reopening the same cache.
    await this.#client.stopWorkspaceRealtime();
    if (generation !== this.#generation) return;
    this.#unsubscribeEvent = this.#client.onWorkspaceEvent((frame: ScopedProductRealtimeEvent) => {
      if (
        !this.#isActiveRealtimeScope(frame.scope, generation) ||
        frame.event.workspaceId !== frame.scope.workspaceId ||
        (frame.event.type === "system.connected" &&
          frame.event.payload.userId !== frame.scope.userId)
      ) {
        console.error("Dropped a renderer realtime frame from a superseded scope");
        return;
      }
      const event = frame.event;
      const realtimeEpoch = this.#realtimeEpoch;
      if (isSelfMembershipChange(event, frame.scope.userId)) {
        // Abort cache transactions synchronously, before the event queue can wait behind the
        // projection they must roll back. The repair itself receives the fresh signal.
        this.#rotateProjectionBarrier();
        // Acceptance happens before queueing. A repair ahead of this one may retire the socket,
        // but it must not retire this obligation or acknowledge a cursor that crosses it.
        this.#acceptedMembershipRepairs.set(event.id, event.position);
        this.#membershipRepairPending = true;
        this.#membershipEpoch += 1;
        this.#clearRetryTimer();
        this.#clearReadTargets();
        this.#beginMembershipBarrier(event);
      }
      const resyncRequest = event.type === "system.resync_required" ? ++this.#resyncRequest : null;
      if (resyncRequest !== null) {
        this.#cancelCollectionLoads("The workspace requires a new snapshot");
        // Publish the demand as soon as it arrives. A timer-based attempt can currently be awaiting
        // network I/O on the recovery queue and must observe that a newer recovery owns staleness.
        this.#resyncRecoveryPending = true;
        this.#setState({ stale: true });
      }
      this.#eventQueue = this.#eventQueue
        .then(() =>
          this.#handleRealtimeEvent(event, frame.scope, generation, resyncRequest, realtimeEpoch),
        )
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
      if (generation !== this.#generation || this.#realtimeScope === null || this.#protocolBlocked)
        return;
      if (connection === "incompatible") {
        this.#requireProtocolUpgrade();
        return;
      }
      if (connection !== "live") this.#clearActivity(true);
      this.#setState({ connection });
    });
    this.#unsubscribeActivity =
      this.#client.onWorkspaceActivity?.((frame: ScopedEphemeralActivityFrame) => {
        if (
          !this.#isActiveRealtimeScope(frame.scope, generation) ||
          frame.activity.workspaceId !== frame.scope.workspaceId
        ) {
          return;
        }
        this.#applyActivity(frame, generation);
      }) ?? null;

    // Kept on the runtime, not just in this call: `stop()` runs before the reset a sign-out does,
    // and that reset has to know which member's database it is allowed to delete.
    try {
      const cryptoStatus = await this.#client.initializeCacheCrypto();
      if (generation !== this.#generation || scope !== this.#scope) return;
      if (
        cryptoStatus.scope.userId !== scope.userId ||
        cryptoStatus.scope.workspaceId !== scope.workspaceId
      ) {
        throw new Error("The encrypted cache scope did not match the signed-in session");
      }
      // A same-account transition to offline mode must retain the only copy of a memory outbox.
      const cache =
        !scopeChanged &&
        this.#cache !== null &&
        this.#state.cacheMode === "memory_only" &&
        cryptoStatus.mode === "memory_only"
          ? this.#cache
          : this.#createCache(cryptoStatus);
      this.#cache = cache;
      let cached = await cache.load();
      if (generation !== this.#generation || scope !== this.#scope || cache !== this.#cache) return;
      if (
        cached.bootstrap !== null &&
        (cached.bootstrap.currentUser.user.id !== scope.userId ||
          cached.bootstrap.workspace.id !== scope.workspaceId)
      ) {
        // A correctly scoped encrypted database cannot contain another identity. Treat any such
        // projection as corrupt, remove it before first paint, and rebuild only while online.
        await cache.clearAll();
        cached = await cache.load();
        if (generation !== this.#generation || scope !== this.#scope || cache !== this.#cache)
          return;
      }
      this.#hydrateRetractReservations(cached.retractReservations, cached.messages);
      this.#membershipRepairPending =
        cached.repairMarker !== null || this.#acceptedMembershipRepairs.size > 0;
      this.#syncCursor = cached.syncCursor;
      this.#pruneCreatedMessageMentions(
        cached.messages,
        cached.bootstrap,
        this.#state.threadSummaries,
      );
      this.#setState({
        collections: cached.collections.filter((state) => state.identity.kind !== "files"),
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
        ...(this.#offlineOnly
          ? {
              busy: false,
              connection: "offline" as const,
              error:
                cached.bootstrap === null
                  ? "No encrypted workspace is available for this signed-in account."
                  : null,
            }
          : {}),
      });

      if (this.#offlineOnly) return;

      if (cached.syncCursor !== null) await this.#prepareRealtime(generation, cached.syncCursor);
      if (generation !== this.#generation || this.#cache !== cache) return;

      const replicaAvailable = cached.bootstrap !== null;
      if (cached.repairMarker !== null) {
        await this.#recoverDurableMembershipMarker(
          generation,
          cache,
          cached.repairMarker,
          cached.repairMarker.position,
        );
        return;
      }

      if (replicaAvailable) {
        // A recreated window first catches up from the encrypted replica cursor. Main may have
        // observed events for notifications while no renderer existed, but that observation never
        // became UI progress. Only this HTTP pass may bridge that interval before the normal
        // authoritative snapshot and its final catch-up open a fresh realtime epoch.
        this.#startupReplicaCatchUpPending = true;
        await this.#repairAndFlush(generation, false);
        if (generation !== this.#generation || this.#cache === null) return;
        if (this.#syncRecoveryPending) {
          this.#setState({ busy: false, stale: true });
          return;
        }
        await this.#completeStartupAfterReplicaCatchUp(generation);
        return;
      }
      const refreshed = await this.#refreshSnapshot(generation);
      if (!refreshed || generation !== this.#generation || this.#cache === null) return;
      await this.#completeStartupAfterSnapshot(generation);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#startupReplicaCatchUpPending = false;
      this.#startupRealtimePending = false;
      this.#setState({
        busy: false,
        stale: true,
        error: errorMessage(error, "Could not initialize the workspace"),
      });
    }
  }

  async stop(): Promise<void> {
    ++this.#generation;
    this.#rotateProjectionBarrier();
    this.#cacheProjectionQueue = Promise.resolve();
    this.#historyHydrations.clear();
    this.#collectionLoads.clear();
    this.#offlineOnly = false;
    this.#retireMembersReplacementQueue();
    this.#recoveryQueue = Promise.resolve();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#resetSourceLessRetractMetadataRefresh();
    this.#clearMembersRetryTimer();
    this.#membersAttempt = 0;
    this.#resetResyncState();
    this.#syncRecoveryPending = false;
    this.#membershipRepairPending = false;
    this.#acceptedMembershipRepairs.clear();
    this.#realtimeEpoch += 1;
    this.#startupReplicaCatchUpPending = false;
    this.#startupRealtimePending = false;
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeActivity?.();
    this.#unsubscribeEvent = null;
    this.#unsubscribeConnection = null;
    this.#unsubscribeActivity = null;
    this.#clearActivity(false);
    const realtimeScope = this.#realtimeScope;
    this.#realtimeScope = null;
    if (realtimeScope === null) await this.#client.stopWorkspaceRealtime();
    else await this.#client.stopWorkspaceRealtime(realtimeScope);
    this.#cache = null;
    this.#syncCursor = null;
    this.#retractReservations = [];
    this.#retractedMessageIds.clear();
    this.#createdMessageMentions.clear();
    this.#locallyProjectedRetracts.clear();
    this.#invalidatedThreadSummaryConversationIds.clear();
    this.#membersDirty = false;
    this.#historyCursors.clear();
    this.#threadSummaryPositions.clear();
    this.#collectionLoads.clear();
    this.#historyHydrations.clear();
    this.#clearReadTargets();
    this.#state = INITIAL_STATE;
    for (const listener of this.#listeners) listener(this.#state);
  }

  #isActiveRealtimeScope(candidate: RealtimeSessionScope, generation: number): boolean {
    return (
      generation === this.#generation &&
      this.#scope !== null &&
      candidate.userId === this.#scope.userId &&
      candidate.workspaceId === this.#scope.workspaceId &&
      this.#realtimeScope !== null &&
      sameRealtimeScope(candidate, this.#realtimeScope)
    );
  }

  /** Best-effort renderer command; main owns throttling, coalescing, and local expiry. */
  setTyping(conversationId: string, typing: boolean): void {
    const scope = this.#realtimeScope;
    if (scope === null || this.#client.setWorkspaceTyping === undefined) return;
    void this.#client.setWorkspaceTyping({ scope, conversationId, typing }).catch(() => undefined);
  }

  #applyActivity(frame: ScopedEphemeralActivityFrame, generation: number): void {
    const activity = frame.activity;
    if (activity.type === "activity.presence") {
      const existing = this.#presenceExpiryTimers.get(activity.userId);
      if (existing !== undefined) clearTimeout(existing);
      const presenceByUser = { ...this.#state.presenceByUser };
      if (activity.state === "offline") {
        delete presenceByUser[activity.userId];
        this.#presenceExpiryTimers.delete(activity.userId);
      } else {
        presenceByUser[activity.userId] = activity.state;
        const timer = setTimeout(() => {
          if (
            generation !== this.#generation ||
            this.#presenceExpiryTimers.get(activity.userId) !== timer
          ) {
            return;
          }
          this.#presenceExpiryTimers.delete(activity.userId);
          const next = { ...this.#state.presenceByUser };
          delete next[activity.userId];
          this.#setState({ presenceByUser: next });
        }, 45_000);
        this.#presenceExpiryTimers.set(activity.userId, timer);
      }
      this.#setState({ presenceByUser });
      return;
    }

    const key = `${activity.conversationId}:${activity.userId}`;
    const existing = this.#typingExpiryTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.#setTypingMember(activity.conversationId, activity.userId, activity.typing);
    if (!activity.typing) {
      this.#typingExpiryTimers.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      if (generation !== this.#generation || this.#typingExpiryTimers.get(key) !== timer) {
        return;
      }
      this.#typingExpiryTimers.delete(key);
      this.#setTypingMember(activity.conversationId, activity.userId, false);
    }, 8_000);
    this.#typingExpiryTimers.set(key, timer);
  }

  #setTypingMember(conversationId: string, userId: string, typing: boolean): void {
    const current = this.#state.typingByConversation[conversationId] ?? [];
    const members = new Set(current);
    if (typing) members.add(userId);
    else members.delete(userId);
    const typingByConversation = { ...this.#state.typingByConversation };
    if (members.size === 0) delete typingByConversation[conversationId];
    else typingByConversation[conversationId] = [...members].sort();
    this.#setState({ typingByConversation });
  }

  #clearActivity(publish: boolean): void {
    for (const timer of this.#presenceExpiryTimers.values()) clearTimeout(timer);
    for (const timer of this.#typingExpiryTimers.values()) clearTimeout(timer);
    this.#presenceExpiryTimers.clear();
    this.#typingExpiryTimers.clear();
    if (
      publish &&
      (Object.keys(this.#state.presenceByUser).length > 0 ||
        Object.keys(this.#state.typingByConversation).length > 0)
    ) {
      this.#setState({ presenceByUser: {}, typingByConversation: {} });
    }
  }

  async #acknowledgeCurrentScope(cursor: SyncPosition, generation: number): Promise<void> {
    const scope = this.#realtimeScope;
    if (scope === null || !this.#isActiveRealtimeScope(scope, generation)) return;
    await this.#client.acknowledgeWorkspaceEvent({ scope, cursor });
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
    // First paint uses whatever the encrypted replica already has. History for a conversation
    // that this session has not hydrated yet is fetched after the selection is published.
    this.#ensureConversationHistory(conversationId);
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
    if (this.#offlineOnly) return;
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
    attachmentIds: readonly string[] = [],
  ): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) {
      throw new Error("This conversation is no longer available");
    }
    const summary = this.#state.bootstrap?.conversations.find(
      (candidate) => candidate.conversation.id === conversationId,
    );
    if (summary === undefined) {
      throw new Error("This conversation is no longer available");
    }
    if (
      threadRootId === null &&
      summary.conversation.channelMode === "announcement" &&
      this.#state.bootstrap?.currentUser.role !== "owner"
    ) {
      throw new Error("Only workspace owners can post bulletins");
    }
    const clientMessageId = crypto.randomUUID();
    const operation = sendMessageOperationSchema.parse({
      conversationId,
      idempotencyKey: clientMessageId,
      message: {
        threadRootId,
        body,
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId,
        mentionedUserIds: [...mentionedUserIds],
        attachmentIds: [...attachmentIds],
      },
    });
    const createdAt = new Date().toISOString();
    const queued = await cache.enqueue(operation, createdAt, projection.signal);
    if (!queued || !this.#isProjectionCurrent(projection, conversationId)) return;
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
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, predecessor.operation.conversationId)) {
      throw new Error("This conversation is no longer available");
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

    const replaced = await cache.replaceOutbox(
      clientMessageId,
      operation,
      predecessor.createdAt,
      projection.signal,
    );
    if (!replaced || !this.#isProjectionCurrent(projection, predecessor.operation.conversationId)) {
      return;
    }

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
    const cache = this.#cache;
    if (cache === null) return { results: [], nextCursor: null };
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection)) return { results: [], nextCursor: null };
    const response = await this.#client.searchMessages({
      query,
      ...(after === undefined ? {} : { after }),
      limit: 25,
    });
    if (!this.#isProjectionCurrent(projection)) return { results: [], nextCursor: null };
    return {
      ...response,
      results: response.results.filter((result) =>
        this.#isConversationAuthorized(result.message.conversationId),
      ),
    };
  }

  /** Checks whether a notification can navigate in the current workspace without changing state. */
  canHandleNotificationAction(
    action: NotificationAction,
    currentContext: NotificationContext,
  ): boolean {
    return this.#isNotificationActionNavigable(action, currentContext, this.#generation);
  }

  /**
   * Reauthorizes and hydrates one exact body-free native-notification target.
   *
   * Main's action is bound to a session generation, while this runtime also has its own local
   * generation. Both are checked before and after network work so a sign-out, scope replacement,
   * or renderer restart cannot project an old response into the new workspace.
   */
  async handleNotificationAction(
    action: NotificationAction,
    currentContext: NotificationContext,
  ): Promise<"discarded" | "fallback" | "opened"> {
    const generation = this.#generation;
    if (!this.#isNotificationActionNavigable(action, currentContext, generation)) {
      return "discarded";
    }
    if (this.#isRetractedMessage(action.messageId)) {
      return (await this.#fallbackNotificationAction(action, currentContext, generation))
        ? "fallback"
        : "discarded";
    }

    let message = this.#state.messages.find((candidate) => candidate.id === action.messageId);
    if (message === undefined) {
      try {
        ({ message } = await this.#client.getMessageById(action.messageId));
      } catch {
        return (await this.#fallbackNotificationAction(action, currentContext, generation))
          ? "fallback"
          : "discarded";
      }
    }
    if (!this.#isCurrentNotificationAction(action, currentContext, generation)) return "discarded";
    if (
      message.id !== action.messageId ||
      message.conversationId !== action.conversationId ||
      message.threadRootId !== action.threadRootId ||
      message.deletedAt !== null ||
      this.#isRetractedMessage(action.messageId)
    ) {
      return (await this.#fallbackNotificationAction(action, currentContext, generation))
        ? "fallback"
        : "discarded";
    }

    try {
      // Search-result navigation already owns exact message/thread focus, authorized conversation
      // rechecks, reaction hydration, cache projection, and the legacy no-threads fallback.
      await this.openSearchResult({ message });
    } catch {
      return (await this.#fallbackNotificationAction(action, currentContext, generation))
        ? "fallback"
        : "discarded";
    }
    if (!this.#isCurrentNotificationAction(action, currentContext, generation)) return "discarded";
    if (this.#isRetractedMessage(action.messageId)) {
      return (await this.#fallbackNotificationAction(action, currentContext, generation))
        ? "fallback"
        : "discarded";
    }
    this.#setState({ error: null });
    return "opened";
  }

  #isCurrentNotificationAction(
    action: NotificationAction,
    currentContext: NotificationContext,
    generation: number,
  ): boolean {
    const snapshot = this.#state.bootstrap;
    return (
      currentContext.status === "active" &&
      generation === this.#generation &&
      this.#cache !== null &&
      this.#scope?.userId === currentContext.userId &&
      this.#scope.workspaceId === currentContext.workspaceId &&
      snapshot?.currentUser.user.id === currentContext.userId &&
      snapshot.workspace.id === currentContext.workspaceId &&
      action.sessionGeneration === currentContext.sessionGeneration &&
      action.userId === currentContext.userId &&
      action.workspaceId === currentContext.workspaceId
    );
  }

  #isNotificationActionNavigable(
    action: NotificationAction,
    currentContext: NotificationContext,
    generation: number,
  ): boolean {
    return (
      this.#isCurrentNotificationAction(action, currentContext, generation) &&
      this.#isConversationAuthorized(action.conversationId)
    );
  }

  #isConversationAuthorized(conversationId: string): boolean {
    return (
      this.#state.bootstrap?.conversations.some(
        (summary) => summary.conversation.id === conversationId,
      ) ?? false
    );
  }

  #isRetractedMessage(messageId: string): boolean {
    return this.#retractedMessageIds.has(messageId);
  }

  #captureProjection(cache: WorkspaceCache): ProjectionGuard {
    return {
      cache,
      generation: this.#generation,
      membershipEpoch: this.#membershipEpoch,
      signal: this.#projectionAbortController.signal,
    };
  }

  #isProjectionCurrent(guard: ProjectionGuard, conversationId?: string): boolean {
    return (
      guard.generation === this.#generation &&
      guard.cache === this.#cache &&
      guard.membershipEpoch === this.#membershipEpoch &&
      !guard.signal.aborted &&
      !this.#membershipRepairPending &&
      (conversationId === undefined || this.#isConversationAuthorized(conversationId))
    );
  }

  #isOutboxFlushOwnerCurrent(owner: ProjectionGuard, conversationId?: string): boolean {
    return (
      !this.#catalogPending &&
      !this.#startupMetadataPending &&
      this.#outboxFlushOwner === owner &&
      this.#isProjectionCurrent(owner, conversationId)
    );
  }

  #cancelCollectionLoads(message: string, conversationId?: string): void {
    for (const journal of this.#collectionJournals) {
      if (
        conversationId === undefined ||
        (journal.identity.kind !== "my_tasks" && journal.identity.conversationId === conversationId)
      )
        journal.cancel(message);
    }
  }

  collectionState(identity: CollectionIdentity): CollectionState {
    return (
      this.#state.collections.find(
        (state) => collectionKey(state.identity) === collectionKey(identity),
      ) ?? unloadedCollection(identity)
    );
  }

  #rotateProjectionBarrier(): void {
    this.#cancelCollectionLoads("The workspace projection was replaced");
    this.#projectionAbortController.abort();
    this.#projectionAbortController = new AbortController();
  }

  async #projectTasks(projection: ProjectionGuard, tasks: readonly Task[]): Promise<void> {
    this.#cancelCollectionLoads("A task mutation superseded the collection read");
    if (!this.#isProjectionCurrent(projection)) return;
    const accepted = await projection.cache.upsertTasks(tasks, projection.signal);
    if (!this.#isProjectionCurrent(projection)) return;
    const authorized = accepted.filter((task) =>
      this.#isConversationAuthorized(task.conversationId),
    );
    if (authorized.length > 0) {
      this.#setState({ tasks: mergeTasks(this.#state.tasks, authorized) });
    }
  }

  async #fallbackNotificationAction(
    action: NotificationAction,
    currentContext: NotificationContext,
    generation: number,
  ): Promise<boolean> {
    let applied = false;
    await this.#serialize(async () => {
      if (!this.#isCurrentNotificationAction(action, currentContext, generation)) return;
      const authorized = this.#isConversationAuthorized(action.conversationId);
      if (!authorized) return;
      this.#setState({
        selectedConversationId: action.conversationId,
        focusedMessageId: null,
        selectedThreadRootId: null,
        focusedThreadMessageId: null,
        threadLoading: false,
        threadError: null,
        error: NOTIFICATION_TARGET_UNAVAILABLE,
      });
      applied = true;
    });
    return applied;
  }

  async #loadCollection(
    identity: CollectionIdentity,
    requestCursor: string | null,
    fetchPage: () => Promise<{
      readonly snapshotPosition: SyncPosition;
      readonly nextCursor: string | null;
      readonly records: CollectionRecords;
    }>,
    publish: (records: CollectionRecords) => void,
  ): Promise<void> {
    const key = collectionKey(identity);
    const inFlight = this.#collectionLoads.get(key);
    if (inFlight !== undefined) return inFlight;
    const generation = this.#generation;
    const load = async (): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const cache = this.#cache;
        if (cache === null || generation !== this.#generation) return;
        const projection = this.#captureProjection(cache);
        const conversationId = identity.kind === "my_tasks" ? undefined : identity.conversationId;
        if (!this.#isProjectionCurrent(projection, conversationId)) return;
        const journal = new CollectionJournal(this.#syncCursor, identity);
        this.#collectionJournals.add(journal);
        const signal = AbortSignal.any([projection.signal, journal.signal]);
        try {
          const page = await fetchPage();
          if (!this.#isProjectionCurrent(projection, conversationId)) return;
          await this.#serialize(() =>
            this.#commitCacheProjection(async () => {
              if (!this.#isProjectionCurrent(projection, conversationId)) return;
              const records = replayCollectionPage(
                page.records,
                journal.newerThan(page.snapshotPosition),
              );
              const state: CollectionState = {
                identity,
                loaded: true,
                snapshotPosition: page.snapshotPosition,
                nextCursor: page.nextCursor,
                invalidatedAt: null,
              };
              const commit = { state, expectedPosition: this.#syncCursor, requestCursor };
              if (identity.kind === "timeline" || identity.kind === "thread") {
                if (
                  !(await cache.upsertHistory(
                    identity.conversationId,
                    records.messages,
                    records.reactions,
                    signal,
                    commit,
                  ))
                ) {
                  journal.assertValid();
                  return;
                }
              } else if (identity.kind === "tasks" || identity.kind === "my_tasks") {
                await cache.upsertTasks(records.tasks, signal, commit);
              } else {
                await cache.commitCollectionMetadata(commit, signal);
              }
              if (!this.#isProjectionCurrent(projection, conversationId)) return;
              // The queue excludes runtime event commits during encryption. Recheck the journal for
              // a synchronous reset/retirement before publishing any request-local view state.
              journal.newerThan(page.snapshotPosition);
              const collections = await cache.readCollections();
              if (!this.#isProjectionCurrent(projection, conversationId)) return;
              journal.assertValid();
              this.#setState({ collections });
              if (identity.kind === "timeline") {
                this.#historyCursors.set(identity.conversationId, page.nextCursor);
                for (const message of records.messages)
                  this.#threadSummaryPositions.set(message.id, page.snapshotPosition);
              } else if (identity.kind === "thread")
                this.#threadCursors.set(identity.rootId, page.nextCursor);
              publish(records);
            }),
          );
          return;
        } catch (error) {
          if (!this.#isProjectionCurrent(projection, conversationId)) return;
          if (this.#resyncRecoveryPending) return;
          if (!(error instanceof CollectionRetry) || attempt === 2) throw error;
        } finally {
          this.#collectionJournals.delete(journal);
        }
      }
    };
    const pending = load().finally(() => {
      if (this.#collectionLoads.get(key) === pending) this.#collectionLoads.delete(key);
    });
    this.#collectionLoads.set(key, pending);
    return pending;
  }

  async loadConversationFiles(conversationId: string): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    this.#setState({ conversationFilesBusy: true, conversationFilesError: null });
    try {
      const identity: CollectionIdentity = { kind: "files", conversationId };
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let pages = 0; pages < 400; pages += 1) {
        await this.#loadCollection(
          identity,
          cursor,
          async () => {
            const page = await this.#client.listConversationFiles(conversationId, {
              ...(cursor === null ? {} : { before: cursor }),
              limit: 50,
            });
            if (page.hasMore !== (page.nextCursor !== null))
              throw new Error("The collection has inconsistent pagination");
            return {
              ...page,
              records: {
                messages: [],
                reactions: [],
                tasks: [],
                attachments: page.files,
                threadSummaries: [],
              },
            };
          },
          (records) => {
            const retractedIds = retractedMessageIds(
              this.#state.messages,
              retractReservationMap(this.#retractReservations),
            );
            const files =
              cursor === null
                ? records.attachments
                : mergeAttachments(this.#state.conversationFiles, records.attachments);
            this.#setState({
              conversationFiles: files.filter(
                (attachment) =>
                  attachment.messageId === null || !retractedIds.has(attachment.messageId),
              ),
            });
          },
        );
        if (!this.#isProjectionCurrent(projection)) return;
        const next = this.collectionState(identity).nextCursor;
        if (next === null) return;
        if (seen.has(next) || next === cursor)
          throw new Error("The collection cursor did not advance");
        seen.add(next);
        cursor = next;
      }
      throw new Error("The collection exceeded local capacity");
    } catch (error) {
      if (projection.generation === this.#generation) {
        this.#setState({
          conversationFilesError: errorMessage(error, "Could not load shared files"),
        });
      }
      throw error;
    } finally {
      if (projection.generation === this.#generation) {
        this.#setState({ conversationFilesBusy: false });
      }
    }
  }

  async attachFiles(conversationId: string, maxFiles: number): Promise<AttachmentUploadResult> {
    return this.#client.chooseAndUploadConversationFiles(conversationId, maxFiles);
  }

  async openFile(attachmentId: string): Promise<void> {
    await this.#client.openConversationFile(attachmentId);
  }

  openAttachmentSource(attachment: Attachment): void {
    if (attachment.messageId === null) return;
    const message = this.#state.messages.find((candidate) => candidate.id === attachment.messageId);
    this.#setState({
      selectedConversationId: message?.conversationId ?? this.#state.selectedConversationId,
      focusedMessageId:
        message === undefined || message.threadRootId === null ? attachment.messageId : null,
      selectedThreadRootId: message?.threadRootId ?? null,
      focusedThreadMessageId:
        message !== undefined && message.threadRootId !== null ? attachment.messageId : null,
      threadLoading: false,
      threadError: null,
    });
  }

  async loadConversationTasks(conversationId: string): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const identity: CollectionIdentity = { kind: "tasks", conversationId };
      let cursor: string | null = null;
      const seen = new Set<string>();
      const seenTasks = new Set<string>();
      for (let pages = 0; pages < 400; pages += 1) {
        await this.#loadCollection(
          identity,
          cursor,
          async () => {
            const page = await this.#client.listConversationTasks(conversationId, {
              ...(cursor === null ? {} : { after: cursor }),
              limit: 200,
            });
            if (page.hasMore !== (page.nextCursor !== null))
              throw new Error("The workspace task catalog had inconsistent pagination");
            if ((cursor !== null || page.hasMore) && page.tasks.length === 0)
              throw new Error("The workspace task catalog did not make progress");
            if (seenTasks.size + page.tasks.length > WORKSPACE_TASK_COLLECTION_LIMIT)
              throw new Error("The workspace task catalog exceeded local capacity");
            const pageIds = new Set<string>();
            for (const task of page.tasks) {
              if (task.workspaceId !== this.#scope?.workspaceId)
                throw new Error("The workspace task catalog crossed workspace scope");
              if (task.conversationId !== conversationId)
                throw new Error("The workspace task catalog crossed conversation scope");
              if (seenTasks.has(task.id) || pageIds.has(task.id))
                throw new Error("The workspace task catalog repeated a task");
              pageIds.add(task.id);
            }
            if (
              page.nextCursor !== null &&
              (page.nextCursor === cursor || seen.has(page.nextCursor))
            )
              throw new Error("The workspace task catalog did not advance its cursor");
            return {
              ...page,
              records: {
                messages: [],
                reactions: [],
                tasks: page.tasks,
                attachments: [],
                threadSummaries: [],
              },
            };
          },
          (records) => {
            for (const task of records.tasks) seenTasks.add(task.id);
            this.#setState({ tasks: mergeTasks(this.#state.tasks, records.tasks) });
          },
        );
        if (!this.#isProjectionCurrent(projection)) return;
        const next = this.collectionState(identity).nextCursor;
        if (next === null) return;
        if (seenTasks.size >= WORKSPACE_TASK_COLLECTION_LIMIT)
          throw new Error("The workspace task catalog exceeded local capacity");
        if (seen.has(next) || next === cursor)
          throw new Error("The collection cursor did not advance");
        seen.add(next);
        cursor = next;
      }
      throw new Error("The collection exceeded local capacity");
    } catch (error) {
      if (projection.generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not load this task board") });
      }
      throw error;
    } finally {
      if (projection.generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async loadMyTasks(): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection)) return;
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const identity: CollectionIdentity = { kind: "my_tasks" };
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let pages = 0; pages < 400; pages += 1) {
        await this.#loadCollection(
          identity,
          cursor,
          async () => {
            const page = await this.#client.listMyTasks({
              ...(cursor === null ? {} : { after: cursor }),
              limit: 200,
            });
            if (page.hasMore !== (page.nextCursor !== null))
              throw new Error("The collection has inconsistent pagination");
            return {
              ...page,
              records: {
                messages: [],
                reactions: [],
                tasks: page.tasks,
                attachments: [],
                threadSummaries: [],
              },
            };
          },
          (records) => {
            this.#setState({ tasks: mergeTasks(this.#state.tasks, records.tasks) });
          },
        );
        if (!this.#isProjectionCurrent(projection)) return;
        const next = this.collectionState(identity).nextCursor;
        if (next === null) return;
        if (seen.has(next) || next === cursor)
          throw new Error("The collection cursor did not advance");
        seen.add(next);
        cursor = next;
      }
      throw new Error("The collection exceeded local capacity");
    } catch (error) {
      if (projection.generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not load My Tasks") });
      }
      throw error;
    } finally {
      if (projection.generation === this.#generation) this.#setState({ tasksBusy: false });
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
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, input.conversationId)) {
      throw new Error("This conversation is no longer available");
    }
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
        await this.#projectTasks(projection, [result.task]);
      });
      return result.task;
    } catch (error) {
      if (projection.generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not create the task") });
      }
      throw error;
    } finally {
      if (projection.generation === this.#generation) this.#setState({ tasksBusy: false });
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
    const current = this.#state.tasks.find((task) => task.id === taskId);
    if (cache === null || current === undefined) throw new Error("Task is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, current.conversationId)) {
      throw new Error("This conversation is no longer available");
    }
    this.#setState({ tasksBusy: true, taskError: null });
    try {
      const result = await this.#client.updateTask({
        taskId,
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: current.version,
        ...input,
      });
      await this.#serialize(async () => {
        await this.#projectTasks(projection, [result.task]);
      });
      return result.task;
    } catch (error) {
      if (projection.generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not update the task") });
      }
      throw error;
    } finally {
      if (projection.generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async moveTask(taskId: string, status: TaskStatus, beforeTaskId: string | null): Promise<Task> {
    const cache = this.#cache;
    const current = this.#state.tasks.find((task) => task.id === taskId);
    if (cache === null || current === undefined) throw new Error("Task is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, current.conversationId)) {
      throw new Error("This conversation is no longer available");
    }
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
        await this.#projectTasks(projection, [result.task]);
      });
      return result.task;
    } catch (error) {
      if (projection.generation === this.#generation) {
        this.#setState({ taskError: errorMessage(error, "Could not move the task") });
      }
      throw error;
    } finally {
      if (projection.generation === this.#generation) this.#setState({ tasksBusy: false });
    }
  }

  async openSearchResult(result: MessageSearchResult): Promise<void> {
    const cache = this.#cache;
    const snapshot = this.#state.bootstrap;
    if (cache === null || snapshot === null) throw new Error("Workspace is still loading");
    const conversationId = result.message.conversationId;
    if (!snapshot.conversations.some((summary) => summary.conversation.id === conversationId)) {
      throw new Error("This conversation is no longer available");
    }
    const projection = this.#captureProjection(cache);
    const threadRootId = this.#state.threadsSupported ? result.message.threadRootId : null;
    let projected = false;
    await this.#serialize(async () => {
      if (!this.#isProjectionCurrent(projection, conversationId)) return;
      // Keep the query inside the event queue. Events already received are applied first, while
      // events committed during the query queue behind this projection and therefore win after it.
      // The exact search/notification target is already authorized. Reaction and attachment
      // hydration improve its presentation, but a transient failure there must not turn the whole
      // message into an unavailable target.
      const [hydrated, files] = await Promise.all([
        this.#client.listMessageReactions([result.message.id]).catch(() => null),
        this.#client.listMessageAttachments([result.message.id]).catch(() => null),
      ]);
      if (!this.#isProjectionCurrent(projection, conversationId)) return;
      const persisted = await cache.upsertHistory(
        conversationId,
        [result.message],
        hydrated?.reactions,
        projection.signal,
      );
      if (!persisted || !this.#isProjectionCurrent(projection, conversationId)) return;
      const retainedMessages = this.#retainMessages([result.message]);
      const messages = mergeMessages(this.#state.messages, retainedMessages);
      this.#setState({
        messages,
        ...(hydrated === null
          ? {}
          : {
              reactions: replaceMessageReactions(
                this.#state.reactions,
                [result.message.id],
                retainReactionsForLiveMessages(hydrated.reactions, retainedMessages),
              ),
            }),
        ...(files === null
          ? {}
          : {
              attachments: replaceMessageAttachments(
                this.#state.attachments,
                [result.message.id],
                retainAttachmentsForLiveMessages(files.attachments, retainedMessages),
              ),
            }),
        selectedConversationId: conversationId,
        focusedMessageId: threadRootId === null ? result.message.id : null,
        selectedThreadRootId: threadRootId,
        focusedThreadMessageId: threadRootId === null ? null : result.message.id,
        threadLoading: threadRootId !== null,
        threadError: null,
      });
      projected = true;
    });
    // The serialized projection can retire quietly when a session replacement wins during an
    // awaited reaction read. Do not let its continuation open an old thread in the new scope.
    if (!projected || !this.#isProjectionCurrent(projection, conversationId)) return;
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
    if (cache === null) {
      this.#setState({ threadLoading: false, threadError: "Workspace cache is unavailable" });
      return;
    }
    const projection = this.#captureProjection(cache);
    try {
      const conversationId =
        this.#state.messages.find((message) => message.id === threadRootId)?.conversationId ??
        this.#state.selectedConversationId ??
        (await this.#client.getMessageById(threadRootId)).message.conversationId;
      await this.#loadCollection(
        { kind: "thread", conversationId, rootId: threadRootId },
        before ?? null,
        async () => {
          const thread = await this.#client.getMessageThread({
            messageId: threadRootId,
            ...(before === undefined ? {} : { before }),
            limit: 50,
          });
          if (thread.root.id !== threadRootId || thread.root.conversationId !== conversationId)
            throw new Error(
              "The thread response did not match the requested conversation and root",
            );
          const messages = [thread.root, ...thread.replies];
          return {
            ...thread,
            records: {
              messages,
              reactions: thread.reactions,
              tasks: [],
              attachments: thread.attachments,
              threadSummaries: [],
            },
          };
        },
        (records) => {
          const messageIds = records.messages.map((message) => message.id);
          const retainedMessages = this.#retainMessages(records.messages);
          this.#setState({
            messages: mergeMessages(this.#state.messages, retainedMessages),
            reactions: replaceMessageReactions(
              this.#state.reactions,
              messageIds,
              retainReactionsForLiveMessages(records.reactions, retainedMessages),
            ),
            attachments: replaceMessageAttachments(
              this.#state.attachments,
              messageIds,
              retainAttachmentsForLiveMessages(records.attachments, retainedMessages),
            ),
            ...(this.#state.selectedThreadRootId === threadRootId
              ? { threadLoading: false, threadError: null }
              : {}),
          });
        },
      );
    } catch (error) {
      try {
        if (await this.#downgradeAfterThreadFailure(threadRootId, projection.generation, cache)) {
          return;
        }
      } catch {
        // Preserve the original thread failure when capability renegotiation is also unavailable.
      }
      if (
        projection.generation === this.#generation &&
        this.#state.selectedThreadRootId === threadRootId
      ) {
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
    const projection = this.#captureProjection(cache);
    if (
      projection.generation !== generation ||
      !this.#isProjectionCurrent(projection, root.conversationId)
    ) {
      return true;
    }
    const history = await this.#client.getConversationMessages({
      conversationId: root.conversationId,
      limit: 50,
    });
    if (history.threadsSupported) return false;
    const messageIds = history.messages.map((message) => message.id);
    const hydrated = { reactions: history.reactions };
    await this.#serialize(async () => {
      if (!this.#isProjectionCurrent(projection, root.conversationId)) return;
      const persisted = await cache.upsertHistory(
        root.conversationId,
        history.messages,
        hydrated.reactions,
        projection.signal,
      );
      if (!persisted || !this.#isProjectionCurrent(projection, root.conversationId)) return;
      const retainedMessages = this.#retainMessages(history.messages);
      this.#historyCursors.set(root.conversationId, history.nextCursor);
      const selectedThreadRootId = this.#state.selectedThreadRootId;
      this.#setState({
        messages: mergeMessages(this.#state.messages, retainedMessages),
        threadSummaries: [],
        threadsSupported: false,
        reactions: replaceMessageReactions(
          this.#state.reactions,
          messageIds,
          retainReactionsForLiveMessages(hydrated.reactions, retainedMessages),
        ),
        attachments: replaceMessageAttachments(
          this.#state.attachments,
          messageIds,
          retainAttachmentsForLiveMessages(history.attachments ?? [], retainedMessages),
        ),
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
    const current = this.#state.outbox.find(
      (item) => item.operation.message.clientMessageId === clientMessageId,
    );
    if (current === undefined) return;
    await this.#patchOutbox(
      clientMessageId,
      {
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: null,
        failureReason: null,
      },
      undefined,
      undefined,
      { status: current.status, attemptCount: current.attemptCount },
    );
    void this.#flushOutbox(this.#generation);
  }

  async discardMessage(clientMessageId: string): Promise<void> {
    await this.#cache?.removeOutbox(clientMessageId);
    this.#setState({ outbox: this.#withoutOutbox([clientMessageId]) });
  }

  async retractMessage(messageId: string): Promise<void> {
    const cache = this.#cache;
    if (cache === null || this.#state.bootstrap === null) {
      throw new Error("Workspace is still loading");
    }
    const current = this.#state.messages.find((message) => message.id === messageId);
    const conversationId = current?.conversationId ?? this.#state.selectedConversationId;
    if (conversationId === null) throw new Error("Message is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    const cachedMentionedUserIds = await cache.getCreatedMessageMentions(messageId);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    const result = await this.#client.retractMessage(messageId);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    await this.#serialize(async () => {
      if (!this.#isProjectionCurrent(projection, conversationId)) return;
      const persisted = await cache.upsertHistory(
        conversationId,
        [result.message],
        undefined,
        projection.signal,
      );
      if (!persisted || !this.#isProjectionCurrent(projection, conversationId)) return;
      const source = this.#retractedMessageSource(result.message.id, conversationId);
      const applyRetractEffects = source?.deletedAt === null || source === undefined;
      this.#applyRetractedMessage(result.message, applyRetractEffects, cachedMentionedUserIds);
      if (applyRetractEffects) this.#rememberLocallyProjectedRetract(result.message);
    });
  }

  async addReaction(messageId: string, emoji: ReactionEmoji): Promise<void> {
    const cache = this.#cache;
    if (cache === null || this.#state.bootstrap === null) {
      throw new Error("Workspace is still loading");
    }
    const conversationId =
      this.#state.messages.find((message) => message.id === messageId)?.conversationId ??
      this.#state.selectedConversationId;
    if (conversationId === null) throw new Error("Message is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    const result = await this.#client.addMessageReaction(messageId, emoji);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    await this.#serialize(async () => {
      if (!this.#isProjectionCurrent(projection, conversationId)) return;
      if (
        this.#syncCursor !== null &&
        this.#syncCursor.epoch === result.syncCursor.epoch &&
        compareSyncPositions(this.#syncCursor, result.syncCursor) >= 0
      ) {
        return;
      }
      this.#cancelCollectionLoads("A reaction mutation superseded the collection read");
      const persisted = await cache.upsertReaction(
        result.reaction,
        conversationId,
        projection.signal,
      );
      if (!persisted || !this.#isProjectionCurrent(projection, conversationId)) return;
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
      if (
        this.#syncCursor !== null &&
        this.#syncCursor.epoch === result.syncCursor.epoch &&
        compareSyncPositions(this.#syncCursor, result.syncCursor) >= 0
      ) {
        return;
      }
      this.#cancelCollectionLoads("A reaction mutation superseded the collection read");
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
    channelMode: ChannelMode = "chat",
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
      ...(channelMode === "announcement" ? { channelMode } : {}),
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
    const existingId = this.#directConversationId(memberId);
    if (existingId !== null) {
      this.selectConversation(existingId);
      return;
    }

    const generation = this.#generation;
    const cache = this.#cache;
    if (cache === null || this.#state.bootstrap === null) {
      throw new Error("Workspace is still loading");
    }
    const result = await this.#client.createDirectConversation({ memberId });
    const snapshotAfterCreate = this.#state.bootstrap;
    if (generation !== this.#generation || cache !== this.#cache || snapshotAfterCreate === null) {
      return;
    }
    const conversationId = result.conversation.conversation.id;
    if (
      snapshotAfterCreate.conversations.some(
        (summary) => summary.conversation.id === conversationId,
      )
    ) {
      this.selectConversation(conversationId);
      return;
    }

    // Same projection path as channel creation: publish the conversation and select it without
    // re-downloading every conversation's history. First paint uses the mutation summary plus any
    // already-cached messages; `#ensureConversationHistory` lazy-hydrates this thread only.
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
          "The conversation was opened, but its local cache needs repair. Reconnect to refresh it.";
      }
      if (generation !== this.#generation || cache !== this.#cache) return;
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
    if (generation === this.#generation && cache === this.#cache) {
      this.#ensureConversationHistory(conversationId);
    }
  }

  async archiveChannel(conversationId: string): Promise<void> {
    await this.#client.archiveChannel(conversationId);
    await this.#refreshSnapshot(this.#generation);
  }

  async getChannelMembers(conversationId: string): Promise<ChannelMembersResponse> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) {
      throw new Error("This conversation is no longer available");
    }
    const response = await this.#client.getChannelMembers(conversationId);
    if (
      !this.#isProjectionCurrent(projection, conversationId) ||
      response.conversationId !== conversationId
    ) {
      throw new Error("This conversation is no longer available");
    }
    return response;
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

  async updateProfileTitle(title: string | null): Promise<void> {
    const generation = this.#generation;
    const updated = await this.#client.updateProfile(title);
    if (generation !== this.#generation || this.#state.bootstrap === null) return;
    // The desktop only edits human profiles; cast the returned public user back to the human-only
    // current-user shape the snapshot expects.
    const updatedUser = { ...updated, kind: "human" as const };
    const currentUser = { ...this.#state.bootstrap.currentUser, user: updatedUser };
    const members = this.#state.bootstrap.members
      .map((member) => (member.id === updated.id ? updated : member))
      .sort(compareMembers);
    this.#setState({ bootstrap: { ...this.#state.bootstrap, currentUser, members } });
  }

  async loadOlder(conversationId: string): Promise<void> {
    const cache = this.#cache;
    const before = this.#historyCursors.get(conversationId);
    if (cache === null || before === null) return;
    const projection = this.#captureProjection(cache);
    if (!this.#isProjectionCurrent(projection, conversationId)) return;
    let threadsSupported = this.#state.threadsSupported;
    await this.#loadCollection(
      { kind: "timeline", conversationId },
      before ?? null,
      async () => {
        const history = await this.#client.getConversationMessages({
          conversationId,
          ...(before === undefined ? {} : { before }),
          limit: 50,
        });
        threadsSupported = history.threadsSupported;
        return {
          ...history,
          records: {
            messages: history.messages,
            reactions: history.reactions,
            tasks: [],
            attachments: history.attachments,
            threadSummaries: history.threadSummaries,
          },
        };
      },
      (records) => {
        const messageIds = records.messages.map((message) => message.id);
        const retainedMessages = this.#retainMessages(records.messages);
        this.#setState({
          messages: mergeMessages(this.#state.messages, retainedMessages),
          threadSummaries:
            threadsSupported && !this.#invalidatedThreadSummaryConversationIds.has(conversationId)
              ? mergeThreadSummaries(this.#state.threadSummaries, records.threadSummaries)
              : threadsSupported
                ? this.#withoutConversationThreadSummaries(conversationId)
                : [],
          threadsSupported,
          ...(threadsSupported
            ? {}
            : {
                selectedThreadRootId: null,
                focusedThreadMessageId: null,
                threadLoading: false,
                threadError: null,
              }),
          reactions: replaceMessageReactions(
            this.#state.reactions,
            messageIds,
            retainReactionsForLiveMessages(records.reactions, retainedMessages),
          ),
          attachments: replaceMessageAttachments(
            this.#state.attachments,
            messageIds,
            retainAttachmentsForLiveMessages(records.attachments, retainedMessages),
          ),
        });
      },
    );
  }

  hasOlder(conversationId: string): boolean {
    return this.#historyCursors.get(conversationId) !== null;
  }

  #directConversationId(memberId: string): string | null {
    const snapshot = this.#state.bootstrap;
    const currentUserId = snapshot?.currentUser.user.id;
    if (snapshot === null || currentUserId === undefined) return null;
    return (
      snapshot.conversations.find((summary) =>
        isDirectConversationWith(summary, currentUserId, memberId),
      )?.conversation.id ?? null
    );
  }

  /**
   * Fetches the first history page only when this session has not already hydrated the
   * conversation. Selection must already be published so the pane can paint cached messages first.
   */
  #ensureConversationHistory(conversationId: string): void {
    if (
      this.#offlineOnly ||
      (this.#catalogConfirmedIds !== null && !this.#catalogConfirmedIds.has(conversationId)) ||
      this.#historyCursors.has(conversationId) ||
      this.#historyHydrations.has(conversationId)
    ) {
      return;
    }
    const generation = this.#generation;
    const hydration = this.loadOlder(conversationId)
      .catch((error: unknown) => {
        if (generation === this.#generation)
          this.#setState({ error: errorMessage(error, "Could not load this conversation") });
      })
      .finally(() => {
        if (this.#historyHydrations.get(conversationId) === hydration)
          this.#historyHydrations.delete(conversationId);
      });
    this.#historyHydrations.set(conversationId, hydration);
  }

  async resetLocalCache(): Promise<void> {
    ++this.#generation;
    this.#retireMembersReplacementQueue();
    this.#recoveryQueue = Promise.resolve();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#resetSourceLessRetractMetadataRefresh();
    this.#clearMembersRetryTimer();
    this.#membersAttempt = 0;
    this.#resetResyncState();
    this.#syncRecoveryPending = false;
    this.#membershipRepairPending = false;
    this.#acceptedMembershipRepairs.clear();
    this.#realtimeEpoch += 1;
    this.#clearReadTargets();
    this.#clearActivity(false);
    const scope = this.#scope;
    const realtimeScope = this.#realtimeScope;
    this.#realtimeScope = null;
    if (realtimeScope === null) await this.#client.stopWorkspaceRealtime();
    else await this.#client.stopWorkspaceRealtime(realtimeScope);
    await this.#cache?.clearAll().catch(() => undefined);
    // Only the signed-in member's database goes. Another member of this OS account can still have
    // an encrypted cache and undelivered outbox on disk, and this runs on every sign-out, so
    // deleting every scope's database here silently destroys messages nobody agreed to discard.
    if (scope !== null) await clearPersistentWorkspaceCache(scope).catch(() => undefined);
    await this.#client.resetCacheCrypto();
    this.#cache = null;
    this.#syncCursor = null;
    this.#retractReservations = [];
    this.#retractedMessageIds.clear();
    this.#createdMessageMentions.clear();
    this.#locallyProjectedRetracts.clear();
    this.#historyCursors.clear();
    this.#threadSummaryPositions.clear();
    this.#collectionLoads.clear();
    this.#historyHydrations.clear();
    this.#threadCursors.clear();
    this.#invalidatedThreadSummaryConversationIds.clear();
    this.#setState({ ...INITIAL_STATE, error: "Local cache reset. Rebuilding the workspace…" });
  }

  conversationName(summary: ConversationSummary): string {
    if (summary.conversation.kind === "channel") {
      const icon = summary.conversation.channelMode === "announcement" ? "📣" : "#";
      return `${icon} ${summary.conversation.name ?? summary.conversation.slug ?? "channel"}`;
    }
    const currentUserId = this.#state.bootstrap?.currentUser.user.id;
    const otherIds = summary.participantIds.filter((id) => id !== currentUserId);
    if (summary.conversation.kind === "group_direct_message") {
      if (otherIds.length === 0) return "Group conversation";
      const names = otherIds.map(
        (id) =>
          this.#state.bootstrap?.members.find((member) => member.id === id)?.displayName ??
          "Former member",
      );
      const visibleNames = names.slice(0, 3);
      const remaining = names.length - visibleNames.length;
      return `${visibleNames.join(", ")}${remaining > 0 ? ` +${String(remaining)}` : ""}`;
    }
    const otherId = otherIds[0];
    if (otherId === undefined) {
      return this.#state.bootstrap?.currentUser.user.displayName ?? "Direct message";
    }
    return (
      this.#state.bootstrap?.members.find((member) => member.id === otherId)?.displayName ??
      "Direct message"
    );
  }

  /** Pages `/v2/conversations` until the server stops claiming more, per the bootstrap contract. */
  async #fetchSnapshot(
    onPage?: (page: WorkspaceSnapshot) => Promise<void>,
  ): Promise<WorkspaceSnapshot> {
    const bootstrap = await this.#client.getWorkspaceBootstrap();
    const conversations: ConversationSummary[] = [];
    const seenConversationIds = new Set<string>();
    const seenCursors = new Set<string>();

    const validateCursor = (hasMore: boolean, nextCursor: string | null): string | null => {
      if (hasMore !== (nextCursor !== null)) {
        throw new Error("The workspace conversation catalog had inconsistent pagination");
      }
      return nextCursor;
    };
    const appendPage = (
      summaries: readonly ConversationSummary[],
      requireProgress: boolean,
    ): void => {
      if (requireProgress && summaries.length === 0) {
        throw new Error("The workspace conversation catalog did not make progress");
      }
      if (conversations.length + summaries.length > WORKSPACE_CONVERSATION_LIMIT) {
        throw new Error("The workspace conversation catalog exceeded local capacity");
      }
      const pageIds = new Set<string>();
      for (const summary of summaries) {
        if (summary.conversation.workspaceId !== bootstrap.workspace.id) {
          throw new Error("The workspace conversation catalog crossed workspace scope");
        }
        const conversationId = summary.conversation.id;
        if (seenConversationIds.has(conversationId) || pageIds.has(conversationId)) {
          throw new Error("The workspace conversation catalog repeated a conversation");
        }
        pageIds.add(conversationId);
      }
      for (const summary of summaries) {
        seenConversationIds.add(summary.conversation.id);
        conversations.push(summary);
      }
    };

    let cursor = validateCursor(bootstrap.conversationsHasMore, bootstrap.conversationsNextCursor);
    appendPage(bootstrap.conversations, bootstrap.conversationsHasMore);
    if (cursor !== null) {
      if (conversations.length >= WORKSPACE_CONVERSATION_LIMIT) {
        throw new Error("The workspace conversation catalog exceeded local capacity");
      }
      seenCursors.add(cursor);
    }
    await onPage?.({ ...bootstrap, conversations: bootstrap.conversations });
    while (cursor !== null) {
      const page = await this.#client.listConversations({ after: cursor });
      const nextCursor = validateCursor(page.hasMore, page.nextCursor);
      appendPage(page.conversations, true);
      if (nextCursor !== null) {
        if (nextCursor === cursor || seenCursors.has(nextCursor)) {
          throw new Error("The workspace conversation catalog did not advance its cursor");
        }
        if (conversations.length >= WORKSPACE_CONVERSATION_LIMIT) {
          throw new Error("The workspace conversation catalog exceeded local capacity");
        }
        seenCursors.add(nextCursor);
      }
      await onPage?.({ ...bootstrap, conversations: page.conversations });
      cursor = nextCursor;
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

  async #resetProtocolReplica(generation: number): Promise<boolean> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return false;
    this.#retireMembersReplacementQueue();
    this.#membersRequest += 1;
    this.#membersDirty = false;
    this.#clearMembersRetryTimer();
    this.#membershipEpoch += 1;
    this.#realtimeEpoch += 1;
    this.#acceptedMembershipRepairs.clear();
    const scope = this.#realtimeScope;
    this.#realtimeScope = null;
    await this.#client.stopWorkspaceRealtime(scope ?? undefined);
    if (cache !== this.#cache || generation !== this.#generation) return false;
    await cache.resetProtocolReplica();
    if (cache !== this.#cache || generation !== this.#generation) return false;
    this.#acceptedMembershipRepairs.clear();
    this.#membershipRepairPending = false;
    this.#syncCursor = null;
    this.#retractReservations = [];
    this.#retractedMessageIds.clear();
    this.#createdMessageMentions.clear();
    this.#historyCursors.clear();
    this.#threadSummaryPositions.clear();
    this.#collectionLoads.clear();
    this.#historyHydrations.clear();
    this.#threadCursors.clear();
    this.#clearRetryTimer();
    this.#clearReadTargets();
    this.#clearActivity(true);
    this.#setState({
      bootstrap: null,
      messages: [],
      reactions: [],
      attachments: [],
      tasks: [],
      threadSummaries: [],
      conversationFiles: [],
      stale: true,
    });
    return true;
  }

  #publishMetadataPage(
    page: WorkspaceSnapshot,
    confirmed: Set<string>,
    loadSelected: boolean,
  ): void {
    const pageIds = new Set(page.conversations.map((summary) => summary.conversation.id));
    for (const id of pageIds) confirmed.add(id);
    const conversations = [
      ...(this.#state.bootstrap?.conversations ?? []).filter(
        (summary) => !pageIds.has(summary.conversation.id),
      ),
      ...page.conversations,
    ];
    const bootstrap: WorkspaceSnapshot = {
      currentUser: page.currentUser,
      workspace: page.workspace,
      members: page.members,
      featureFlags: page.featureFlags,
      syncCursor: page.syncCursor,
      conversations,
    };
    const selectedConversationId =
      this.#state.selectedConversationId ?? firstConversation(bootstrap);
    this.#setState({ bootstrap, selectedConversationId, busy: false, stale: true });
    if (loadSelected && selectedConversationId !== null)
      this.#ensureConversationHistory(selectedConversationId);
  }

  async #refreshSnapshot(
    generation: number,
    minimumCursor?: SyncPosition,
    prefetched?: WorkspaceSnapshot,
  ): Promise<boolean> {
    const cache = this.#cache;
    const scope = this.#scope;
    if (cache === null || scope === null || generation !== this.#generation) return false;
    const membershipEpoch = this.#membershipEpoch;
    const signal = this.#projectionAbortController.signal;
    const request = ++this.#catalogRequest;
    const confirmed = new Set<string>();
    this.#catalogConfirmedIds = confirmed;
    this.#catalogPending = true;
    this.#cancelCollectionLoads("Workspace metadata is being refreshed");
    this.#historyCursors.clear();
    this.#threadCursors.clear();
    const isCurrent = (): boolean =>
      generation === this.#generation &&
      cache === this.#cache &&
      scope === this.#scope &&
      membershipEpoch === this.#membershipEpoch &&
      request === this.#catalogRequest &&
      !signal.aborted;
    const validate = (snapshot: WorkspaceSnapshot): void => {
      if (
        snapshot.currentUser.user.id !== scope.userId ||
        snapshot.workspace.id !== scope.workspaceId
      )
        throw new Error("The workspace catalog did not match the signed-in session");
      if (
        minimumCursor !== undefined &&
        minimumCursor.epoch === snapshot.syncCursor.epoch &&
        compareSyncPositions(snapshot.syncCursor, minimumCursor) < 0
      )
        throw new Error("The workspace catalog has not caught up to the membership change");
    };
    const publishPage = async (page: WorkspaceSnapshot): Promise<void> => {
      if (!isCurrent()) return;
      validate(page);
      const previousEpoch = this.#syncCursor?.epoch ?? this.#state.bootstrap?.syncCursor.epoch;
      // Epoch reset and durable membership repair require a complete catalog before publication.
      if (
        (previousEpoch !== undefined && previousEpoch !== page.syncCursor.epoch) ||
        this.#membershipRepairPending
      )
        return;
      if (!(await cache.stageMetadataPage(page, signal)) || !isCurrent()) return;
      this.#publishMetadataPage(page, confirmed, this.#startupMetadataPending);
    };
    try {
      const snapshot = prefetched ?? (await this.#fetchSnapshot(publishPage));
      if (!isCurrent()) return false;
      validate(snapshot);
      const previousEpoch = this.#syncCursor?.epoch ?? this.#state.bootstrap?.syncCursor.epoch;
      if (previousEpoch !== undefined && previousEpoch !== snapshot.syncCursor.epoch) {
        if (!(await this.#resetProtocolReplica(generation))) return false;
        return this.#refreshSnapshot(generation, undefined, snapshot);
      }
      if (prefetched !== undefined) await publishPage(snapshot);
      if (!isCurrent()) return false;
      return await this.#commitCacheProjection(async () => {
        if (!isCurrent()) return false;
        const installed = await cache.installMetadataSnapshot(snapshot, signal);
        if (!isCurrent()) return false;
        if (!(await this.#reloadCache(generation, cache, true)) || !isCurrent()) return false;
        const visible = new Set(
          this.#state.bootstrap?.conversations.map((summary) => summary.conversation.id),
        );
        const oldSelection = this.#state.selectedConversationId;
        const selectedConversationId =
          oldSelection !== null && visible.has(oldSelection)
            ? oldSelection
            : this.#state.bootstrap === null
              ? null
              : firstConversation(this.#state.bootstrap);
        const selectedThreadRootId =
          selectedConversationId === oldSelection ? this.#state.selectedThreadRootId : null;
        this.#catalogPending = false;
        this.#catalogConfirmedIds = null;
        this.#setState({
          selectedConversationId,
          selectedThreadRootId,
          focusedMessageId:
            selectedConversationId === oldSelection ? this.#state.focusedMessageId : null,
          focusedThreadMessageId:
            selectedThreadRootId === null ? null : this.#state.focusedThreadMessageId,
          attachments: retainAttachmentsForLiveMessages(
            this.#state.attachments,
            this.#state.messages,
          ),
          conversationFiles:
            selectedConversationId === oldSelection ? this.#state.conversationFiles : [],
          threadSummaries: this.#state.threadSummaries.filter((summary) =>
            visible.has(summary.latestReply.conversationId),
          ),
          stale:
            this.#startupMetadataPending ||
            this.#syncRecoveryPending ||
            this.#resyncRecoveryPending,
          ...(installed ? { error: null } : {}),
        });
        if (selectedConversationId !== null)
          this.#ensureConversationHistory(selectedConversationId);
        if (selectedThreadRootId !== null)
          void this.#fetchThreadPage(selectedThreadRootId, undefined);
        return true;
      });
    } catch (error) {
      if (isCurrent()) {
        this.#setState({
          busy: false,
          stale: true,
          error: errorMessage(error, "Could not refresh the workspace catalog"),
        });
        if (this.#membershipRepairPending) throw error;
      }
      return false;
    }
  }

  /**
   * Answers a `member.updated` invalidation by re-reading `GET /v2/members` and replacing the
   * member list outright.
   *
   * The event cannot be applied as a delta: its payload is a bare `User` with no status field, so
   * a disable would re-assert the disabled member rather than remove it. The server's directory is
   * already filtered to active memberships, so replacing the list is both the removal path and the
   * addition path. It is bounded at 25 members and does not fetch conversation collections.
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
      // schedules one -- its retry timer is armed only when `/v2/sync` itself returns retryable.
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
   * storage or crypto. Member writes can no longer stall the current queue, and a snapshot
   * transaction observes the aborted signal before it can replace the new scope.
   */
  #retireMembersReplacementQueue(): void {
    this.#membersReplacementAbortController.abort();
    this.#membersReplacementAbortController = new AbortController();
    this.#rotateProjectionBarrier();
    this.#collectionLoads.clear();
    this.#collectionJournals.clear();
    this.#historyHydrations.clear();
    this.#membersReplacementQueue = Promise.resolve();
  }

  #scheduleMembersRetry(generation: number): void {
    if (this.#protocolBlocked) return;
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

  async #repairAndFlush(
    generation: number,
    flushOutbox = true,
    refreshSourceLessRetracts = true,
  ): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation || this.#protocolBlocked) return;
    this.#syncRecoveryPending = true;
    this.#clearSyncRetryTimer();
    let state = await cache.load();
    let cursor = state.syncCursor;
    if (cursor === null) throw new Error("Sync requires an authoritative workspace position");
    let resets = 0;
    let sourceLessRetractApplied = false;
    for (;;) {
      const result = await this.#client.syncWorkspace(cursor);
      if (generation !== this.#generation) return;
      if (result.status === "upgrade_required") {
        this.#requireProtocolUpgrade();
        return;
      }
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
        if (result.reason === "epoch_mismatch") {
          if (!(await this.#resetProtocolReplica(generation))) return;
        } else {
          await cache.clearServerStatePreservingOutbox();
        }
        this.#syncCursor = null;
        await this.#refreshSnapshot(generation);
        if (generation !== this.#generation) return;
        state = await cache.load();
        cursor = state.syncCursor;
        if (cursor === null) throw new Error("Bootstrap did not establish a sync position");
        continue;
      }
      let repairedMembership = false;
      for (const event of result.response.events) {
        // This loop deliberately bypasses `#applyWorkspaceEvent`, so the invalidation is recorded
        // here and drained once below. Without this the fix would only work while the app is
        // online, and a disable that landed during a backfill would survive the catch-up.
        if (event.type === "member.updated") this.#membersDirty = true;
        if (isSelfMembershipChange(event, this.#scope?.userId ?? null)) {
          const repaired = await this.#repairMembershipEvent(event, generation, false);
          if (generation !== this.#generation || cache !== this.#cache) return;
          if (repaired) {
            cursor = this.#syncCursor ?? event.position;
            repairedMembership = true;
            break;
          }
          continue;
        }
        const projection = this.#captureProjection(cache);
        if (!this.#isProjectionCurrent(projection)) return;
        const retractSource =
          event.type === "message.retracted"
            ? this.#retractedMessageSource(event.payload.messageId, event.conversationId)
            : undefined;
        let applied: CacheEventResult;
        try {
          applied = await cache.applyEvent(event, projection.signal, retractSource);
        } catch (error) {
          if (!this.#isProjectionCurrent(projection)) return;
          throw error;
        }
        if (!this.#isProjectionCurrent(projection)) return;
        if (applied.status === "applied")
          for (const journal of this.#collectionJournals) journal.record(event);
        if (
          event.type === "message.retracted" &&
          retractSource === undefined &&
          applied.status === "applied"
        ) {
          sourceLessRetractApplied = true;
          this.#setState({
            threadSummaries: this.#invalidateConversationThreadSummaries(event.conversationId),
          });
        }
      }
      if (repairedMembership) continue;
      if (generation !== this.#generation || cache !== this.#cache) return;
      await cache.advanceCursor(result.response.nextCursor);
      if (generation !== this.#generation || cache !== this.#cache) return;
      await this.#acknowledgeCurrentScope(result.response.nextCursor, generation);
      if (generation !== this.#generation || cache !== this.#cache) return;
      if (
        this.#syncCursor === null ||
        compareSyncPositions(result.response.nextCursor, this.#syncCursor) > 0
      ) {
        this.#syncCursor = result.response.nextCursor;
      }
      cursor = result.response.nextCursor;
      if (!result.response.hasMore) break;
    }
    this.#syncAttempt = 0;
    // Drained once for the whole backfill, and before the reload so the state this flush publishes
    // is the refreshed directory rather than the stale cached one. Also the retry site for a
    // realtime refetch that failed earlier.
    if (this.#membersDirty) await this.#refreshMembers(generation);
    if (!(await this.#reloadCache(generation, cache))) return;
    this.#syncRecoveryPending = false;
    // A directory read that failed leaves the client genuinely stale, so the flush must not claim
    // otherwise just because the event page drained. A resync remains stale until realtime has
    // also restarted with the repaired cursor.
    this.#setState({ stale: this.#membersDirty || this.#resyncRecoveryPending });
    if (sourceLessRetractApplied && refreshSourceLessRetracts) {
      await this.#refreshSourceLessRetractMetadata(generation);
      if (generation !== this.#generation || cache !== this.#cache) return;
    }
    if (flushOutbox) await this.#flushOutbox(generation);
  }

  /**
   * Reads through one finite server high-water while a durable membership marker prevents every
   * cache mutation. The events are intentionally not projected: the complete snapshot fetched
   * immediately afterwards is their authorized representation, including a lazy history cursor
   * for messages outside its first hydrated page.
   */
  async #drainMembershipRepairGap(
    generation: number,
    startCursor: SyncPosition,
  ): Promise<
    | { readonly status: "ready"; readonly minimumCursor?: SyncPosition }
    | { readonly status: "retryable"; readonly retryAfterMs: number | null }
    | { readonly status: "blocked" }
  > {
    if (this.#protocolBlocked) return { status: "blocked" };
    let cursor = startCursor;
    let targetHighWater: SyncPosition | null = null;
    for (;;) {
      const result = await this.#client.syncWorkspace(cursor);
      if (generation !== this.#generation || this.#cache === null) {
        return { status: "blocked" };
      }
      if (result.status === "upgrade_required") {
        this.#requireProtocolUpgrade();
        return { status: "blocked" };
      }
      if (result.status === "authentication_required") return { status: "blocked" };
      if (result.status === "permanent") {
        this.#setState({ stale: true, error: syncFailureMessage(result.reason) });
        return { status: "blocked" };
      }
      if (result.status === "retryable") {
        this.#setState({ stale: true });
        return { status: "retryable", retryAfterMs: result.retryAfterMs };
      }
      if (result.status === "reset_required") {
        // The server has explicitly declared this cursor unrecoverable. One authoritative snapshot
        // may replace it; unlike ordinary pagination, this never loops on repeated reset replies.
        return { status: "ready" };
      }

      const { nextCursor, highWaterCursor } = result.response;
      if (
        compareSyncPositions(highWaterCursor, cursor) < 0 ||
        compareSyncPositions(nextCursor, cursor) < 0 ||
        compareSyncPositions(nextCursor, highWaterCursor) > 0
      ) {
        throw new Error("The workspace sync response crossed its recovery high-water");
      }
      targetHighWater ??= highWaterCursor;
      if (compareSyncPositions(cursor, targetHighWater) >= 0) {
        return { status: "ready", minimumCursor: cursor };
      }
      if (compareSyncPositions(nextCursor, cursor) <= 0) {
        throw new Error("The workspace sync response did not advance its recovery cursor");
      }
      cursor = nextCursor;
      if (compareSyncPositions(cursor, targetHighWater) >= 0) {
        return { status: "ready", minimumCursor: cursor };
      }
      if (!result.response.hasMore) {
        throw new Error("The workspace sync response ended before its recovery high-water");
      }
    }
  }

  async #handleRealtimeEvent(
    event: ProductRealtimeEvent,
    realtimeScope: RealtimeSessionScope,
    generation: number,
    resyncRequest: number | null,
    realtimeEpoch: number,
  ): Promise<void> {
    const acceptedMembershipRepair =
      event.type === "channel.membership_changed" && this.#acceptedMembershipRepairs.has(event.id);
    const sameSessionScope =
      this.#scope !== null &&
      realtimeScope.userId === this.#scope.userId &&
      realtimeScope.workspaceId === this.#scope.workspaceId;
    // Ordinary frames still belong to the socket epoch that delivered them. Membership repairs
    // recorded by the listener are obligations of this renderer generation, even when an earlier
    // repair restarted realtime before their queued turn arrived.
    if (
      generation !== this.#generation ||
      (realtimeEpoch !== this.#realtimeEpoch && !acceptedMembershipRepair) ||
      this.#cache === null ||
      !sameSessionScope
    ) {
      return;
    }
    if (event.type === "system.connected") {
      await this.#cache.advanceCursor(event.position);
      if (generation !== this.#generation || this.#cache === null) return;
      await this.#client.acknowledgeWorkspaceEvent({
        scope: realtimeScope,
        cursor: event.position,
      });
      if (generation !== this.#generation || this.#cache === null) return;
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
    await this.#applyWorkspaceEvent(
      event,
      realtimeScope,
      generation,
      realtimeEpoch,
      acceptedMembershipRepair,
    );
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
    const realtimeScope = this.#realtimeScope;
    this.#realtimeScope = null;
    if (realtimeScope === null) await this.#client.stopWorkspaceRealtime();
    else await this.#client.stopWorkspaceRealtime(realtimeScope);
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

  /**
   * Refreshes server-owned workspace and conversation metadata without downloading history,
   * reactions, tasks, or thread bodies for every conversation. If the metadata snapshot is ahead
   * of the durable cursor, its intervening events are applied first so replacing the catalog can
   * never skip message data.
   */
  async #refreshWorkspaceMetadata(
    generation: number,
    requireCurrentCatalog = false,
  ): Promise<boolean> {
    const cache = this.#cache;
    const scope = this.#scope;
    if (cache === null || scope === null || generation !== this.#generation) return false;
    const preview =
      this.#startupReplicaCatchUpPending && !requireCurrentCatalog ? new Set<string>() : null;
    const projection = this.#captureProjection(cache);
    if (preview !== null) {
      this.#catalogConfirmedIds = preview;
      this.#catalogPending = true;
    }
    const snapshot = await this.#fetchSnapshot(
      preview === null
        ? undefined
        : async (page) => {
            if (!this.#isProjectionCurrent(projection) || this.#catalogConfirmedIds !== preview)
              return;
            if (
              page.currentUser.user.id !== scope.userId ||
              page.workspace.id !== scope.workspaceId
            )
              throw new Error("The workspace catalog did not match the signed-in session");
            // A catalog ahead of the applied replica must wait for catch-up before replacing counters.
            if (
              this.#syncCursor === null ||
              this.#syncCursor.epoch !== page.syncCursor.epoch ||
              compareSyncPositions(this.#syncCursor, page.syncCursor) !== 0
            )
              return;
            if (
              !(await cache.stageMetadataPage(page, projection.signal)) ||
              !this.#isProjectionCurrent(projection) ||
              this.#catalogConfirmedIds !== preview
            )
              return;
            this.#publishMetadataPage(page, preview, true);
          },
    );
    if (generation !== this.#generation || cache !== this.#cache || scope !== this.#scope) {
      return false;
    }
    if (
      snapshot.currentUser.user.id !== scope.userId ||
      snapshot.workspace.id !== scope.workspaceId
    ) {
      throw new Error("The workspace catalog did not match the signed-in session");
    }

    const cursorBeforeMetadata = this.#syncCursor;
    if (cursorBeforeMetadata === null) return false;
    if (cursorBeforeMetadata.epoch !== snapshot.syncCursor.epoch) {
      return this.#refreshSnapshot(generation, undefined, snapshot);
    }
    if (compareSyncPositions(cursorBeforeMetadata, snapshot.syncCursor) < 0) {
      await this.#repairAndFlush(generation, false, false);
      if (
        generation !== this.#generation ||
        cache !== this.#cache ||
        this.#syncRecoveryPending ||
        this.#membershipRepairPending
      ) {
        return false;
      }
    }

    return this.#commitCacheProjection(async () => {
      if (!this.#isProjectionCurrent(projection)) return false;
      const loaded = await cache.load();
      if (!this.#isProjectionCurrent(projection) || loaded.bootstrap === null) {
        return false;
      }
      const durableCursor = loaded.syncCursor;
      if (durableCursor === null) return false;
      if (compareSyncPositions(durableCursor, snapshot.syncCursor) < 0) {
        throw new Error("The workspace metadata advanced beyond the repaired cursor");
      }
      if (requireCurrentCatalog && compareSyncPositions(snapshot.syncCursor, durableCursor) < 0) {
        return false;
      }

      // When events landed after the metadata response, their cached catalog and member projection
      // is newer. Keep it while still taking workspace, identity-role, and feature metadata from the
      // response. The final catch-up closes the smaller race after this replacement.
      const metadataAtDurableCursor =
        compareSyncPositions(durableCursor, snapshot.syncCursor) === 0;
      const catalog = metadataAtDurableCursor
        ? snapshot.conversations
        : loaded.bootstrap.conversations;
      const members = metadataAtDurableCursor ? snapshot.members : loaded.bootstrap.members;
      const visibleConversationIds = new Set(catalog.map((summary) => summary.conversation.id));
      const signal = projection.signal;
      const replaced = await cache.replaceMetadata(
        {
          currentUser: snapshot.currentUser,
          workspace: snapshot.workspace,
          members,
          conversations: catalog,
          syncCursor: durableCursor,
          featureFlags: snapshot.featureFlags,
        },
        signal,
      );
      if (!this.#isProjectionCurrent(projection)) return false;
      if (!replaced) {
        const reloaded = await this.#reloadCache(generation, cache);
        // Source-less retractions cannot reconcile counters from their event payload. A durable
        // winner newer than this catalog may still have those old totals, so require a fresh server
        // catalog before its retry state can be cleared.
        return !requireCurrentCatalog && reloaded;
      }
      if (!(await this.#reloadCache(generation, cache))) return false;

      for (const conversationId of this.#historyCursors.keys()) {
        if (!visibleConversationIds.has(conversationId))
          this.#historyCursors.delete(conversationId);
      }
      const currentSelection = this.#state.selectedConversationId;
      if (currentSelection !== null && !visibleConversationIds.has(currentSelection)) {
        const bootstrap = this.#state.bootstrap;
        this.#setState({
          selectedConversationId: bootstrap === null ? null : firstConversation(bootstrap),
          focusedMessageId: null,
          selectedThreadRootId: null,
          focusedThreadMessageId: null,
          threadLoading: false,
          threadError: null,
        });
      }
      if (preview !== null && this.#catalogConfirmedIds === preview) {
        this.#catalogPending = false;
        this.#catalogConfirmedIds = null;
      }
      return true;
    });
  }

  /**
   * A source-less retraction has no body to decrement unread or mention totals locally. Keep
   * retrying its metadata refresh until an authoritative catalog has replaced those totals.
   */
  async #refreshSourceLessRetractMetadata(generation: number): Promise<boolean> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return false;
    for (;;) {
      if (!this.#sourceLessRetractMetadataPending) return true;
      const version = this.#sourceLessRetractMetadataVersion;
      let refreshed = false;
      let requestFailed = false;
      try {
        refreshed = await this.#refreshWorkspaceMetadata(generation, true);
      } catch {
        // The retry state below gives a transient catalog failure a durable recovery path.
        requestFailed = true;
      }
      if (generation !== this.#generation || cache !== this.#cache) return false;
      if (!this.#sourceLessRetractMetadataPending) return true;
      if (refreshed) {
        // A newer source-less retract may have landed while this catalog was in flight. Do not
        // treat a response that predates it as authoritative for the newer invalidation.
        if (version !== this.#sourceLessRetractMetadataVersion) continue;
        let summariesRefreshed = false;
        try {
          summariesRefreshed = await this.#refreshInvalidatedThreadSummaries(generation, cache);
        } catch {
          requestFailed = true;
        }
        if (!summariesRefreshed) {
          if (generation !== this.#generation || cache !== this.#cache) return false;
          this.#setState(
            requestFailed
              ? { stale: true, error: SOURCE_LESS_RETRACT_METADATA_ERROR }
              : { stale: true },
          );
          this.#scheduleSourceLessRetractMetadataRetry(generation);
          return false;
        }
        if (version !== this.#sourceLessRetractMetadataVersion) continue;
        this.#sourceLessRetractMetadataPending = false;
        this.#sourceLessRetractMetadataAttempt = 0;
        this.#clearSourceLessRetractMetadataRetryTimer();
        this.#setState({
          stale:
            this.#membersDirty ||
            this.#membershipRepairPending ||
            this.#syncRecoveryPending ||
            this.#resyncRecoveryPending,
          ...(this.#state.error === SOURCE_LESS_RETRACT_METADATA_ERROR ? { error: null } : {}),
        });
        return true;
      }
      this.#setState(
        requestFailed
          ? { stale: true, error: SOURCE_LESS_RETRACT_METADATA_ERROR }
          : { stale: true },
      );
      this.#scheduleSourceLessRetractMetadataRetry(generation);
      return false;
    }
  }

  /**
   * Metadata repairs restore unread totals, but a source-less retract cannot identify its thread
   * root. Reload the affected first pages before accepting their server-derived thread summaries
   * again. These requests run on the event queue, so a later realtime event cannot overtake them.
   */
  async #refreshInvalidatedThreadSummaries(
    generation: number,
    cache: WorkspaceCache,
  ): Promise<boolean> {
    const conversationIds = [...this.#invalidatedThreadSummaryConversationIds];
    for (const conversationId of conversationIds) {
      const projection = this.#captureProjection(cache);
      if (
        generation !== this.#generation ||
        !this.#isProjectionCurrent(projection, conversationId) ||
        !this.#invalidatedThreadSummaryConversationIds.has(conversationId)
      ) {
        return false;
      }
      const history = await this.#client.getConversationMessages({ conversationId, limit: 50 });
      if (!this.#isProjectionCurrent(projection, conversationId)) return false;
      const messageIds = history.messages.map((message) => message.id);
      const hydrated = { reactions: history.reactions };
      if (!this.#isProjectionCurrent(projection, conversationId)) return false;
      const persisted = await cache.upsertHistory(
        conversationId,
        history.messages,
        hydrated.reactions,
        projection.signal,
      );
      if (!persisted || !this.#isProjectionCurrent(projection, conversationId)) return false;
      const retainedMessages = this.#retainMessages(history.messages);
      this.#historyCursors.set(conversationId, history.nextCursor);
      this.#invalidatedThreadSummaryConversationIds.delete(conversationId);
      this.#setState({
        messages: mergeMessages(this.#state.messages, retainedMessages),
        threadSummaries: history.threadsSupported
          ? mergeThreadSummaries(
              this.#withoutConversationThreadSummaries(conversationId),
              history.threadSummaries,
            )
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
        reactions: replaceMessageReactions(
          this.#state.reactions,
          messageIds,
          retainReactionsForLiveMessages(hydrated.reactions, retainedMessages),
        ),
        attachments: replaceMessageAttachments(
          this.#state.attachments,
          messageIds,
          retainAttachmentsForLiveMessages(history.attachments ?? [], retainedMessages),
        ),
      });
    }
    return true;
  }

  #scheduleResync(generation: number, request: number, delayMs: number): void {
    if (this.#protocolBlocked) return;
    this.#clearResyncTimer();
    this.#resyncTimer = setTimeout(() => {
      this.#resyncTimer = null;
      // A newer resync demand can supersede this request while the timer waits, but recovery
      // remains independent from ordinary realtime events and never races another sync pass.
      void this.#serializeRecovery(() => this.#attemptResync(generation, request));
    }, delayMs);
  }

  async #completeStartupAfterReplicaCatchUp(generation: number): Promise<void> {
    if (this.#protocolBlocked) return;
    if (generation !== this.#generation || this.#cache === null) return;
    const refreshed = await this.#refreshWorkspaceMetadata(generation);
    if (!refreshed || generation !== this.#generation || this.#cache === null) {
      if (generation === this.#generation) this.#setState({ busy: false, stale: true });
      return;
    }
    this.#startupReplicaCatchUpPending = false;
    await this.#completeStartupAfterSnapshot(generation);
  }

  /**
   * Completes the crash-recovery path for a durable membership marker. A retryable preflight keeps
   * the marker intact and resumes this exact continuation; the ordinary sync retry cannot run while
   * the marker blocks event application.
   */
  async #recoverDurableMembershipMarker(
    generation: number,
    cache: WorkspaceCache,
    marker: MembershipRepairMarker,
    startCursor: SyncPosition,
  ): Promise<void> {
    if (generation !== this.#generation || cache !== this.#cache) return;
    const preflight = await this.#drainMembershipRepairGap(generation, startCursor);
    if (generation !== this.#generation || cache !== this.#cache) return;
    if (preflight.status === "retryable") {
      this.#setState({ busy: false, stale: true });
      this.#scheduleMembershipMarkerRetry(
        generation,
        cache,
        marker,
        startCursor,
        preflight.retryAfterMs,
      );
      return;
    }
    if (preflight.status === "blocked") {
      this.#syncAttempt = 0;
      this.#setState({ busy: false, stale: true });
      return;
    }
    const repaired = await this.#refreshSnapshot(generation, preflight.minimumCursor);
    if (!repaired || generation !== this.#generation || cache !== this.#cache) return;
    const repairedState = await cache.load();
    if (generation !== this.#generation || cache !== this.#cache) return;
    if (repairedState.repairMarker !== null) {
      throw new Error("Membership repair did not clear its durable marker");
    }
    this.#membershipRepairPending = this.#acceptedMembershipRepairs.size > 0;
    this.#syncCursor = repairedState.syncCursor;
    this.#publishMembershipCache(repairedState, marker.conversationId);
    // The snapshot is now the durable UI representation of the drained gap. Only the final
    // catch-up below may advance and acknowledge beyond it before realtime attaches.
    await this.#completeStartupAfterSnapshot(generation);
  }

  async #completeStartupAfterSnapshot(generation: number): Promise<void> {
    if (this.#protocolBlocked) return;
    if (generation !== this.#generation || this.#cache === null) return;
    this.#startupRealtimePending = true;
    if (this.#realtimeScope === null && this.#syncCursor !== null) {
      await this.#prepareRealtime(generation, this.#syncCursor);
      if (generation !== this.#generation || this.#cache === null) return;
    }
    await this.#repairAndFlush(generation);
    if (generation !== this.#generation || this.#cache === null) return;
    if (this.#syncRecoveryPending || this.#membershipRepairPending) {
      // A retryable final catch-up or an unresolved durable membership marker must keep renderer
      // realtime closed. Starting here could cross an unacknowledged revocation boundary.
      this.#setState({ busy: false, stale: true });
      return;
    }
    await this.#restartRealtime(generation);
    if (generation !== this.#generation) return;
    this.#startupMetadataPending = false;
    this.#startupRealtimePending = false;
    await this.#flushOutbox(generation);
    if (generation !== this.#generation) return;
    this.#setState({ busy: false });
    const selectedConversationId = this.#state.selectedConversationId;
    if (selectedConversationId !== null) this.#ensureConversationHistory(selectedConversationId);
  }

  async #prepareRealtime(
    generation: number,
    after: SyncPosition,
  ): Promise<RealtimeSessionScope | null> {
    if (this.#protocolBlocked) return null;
    const prepared = await this.#client.startWorkspaceRealtime(after);
    if (generation !== this.#generation) {
      await this.#client.stopWorkspaceRealtime(prepared);
      return null;
    }
    const scope = this.#scope;
    if (
      scope === null ||
      prepared.userId !== scope.userId ||
      prepared.workspaceId !== scope.workspaceId
    ) {
      console.error("Dropped a prepared realtime scope for the wrong renderer session");
      await this.#client.stopWorkspaceRealtime(prepared);
      throw new Error("Main prepared realtime for a different signed-in session");
    }
    this.#realtimeScope = prepared;
    return prepared;
  }

  async #restartRealtime(generation: number): Promise<void> {
    if (this.#protocolBlocked) return;
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    const loaded = await cache.load();
    if (generation !== this.#generation) return;
    this.#syncCursor = loaded.syncCursor;
    this.#realtimeEpoch += 1;
    if (loaded.syncCursor === null) throw new Error("Realtime requires a committed sync position");
    const prepared =
      this.#realtimeScope ?? (await this.#prepareRealtime(generation, loaded.syncCursor));
    if (prepared === null || generation !== this.#generation) return;
    try {
      await this.#client.activateWorkspaceRealtime(prepared);
    } catch (error) {
      if (this.#realtimeScope !== null && sameRealtimeScope(prepared, this.#realtimeScope)) {
        this.#realtimeScope = null;
      }
      throw error;
    }
    const activeScope = this.#realtimeScope;
    if (
      generation !== this.#generation ||
      activeScope === null ||
      !sameRealtimeScope(prepared, activeScope)
    ) {
      await this.#client.stopWorkspaceRealtime(prepared);
    }
  }

  async #repairMembershipEvent(
    event: Extract<WorkspaceEvent, { type: "channel.membership_changed" }>,
    generation: number,
    restartRealtime: boolean,
  ): Promise<boolean> {
    const cache = this.#cache;
    if (cache === null) return false;
    // HTTP catch-up membership events do not pass through the realtime listener. Rotate here too;
    // for realtime this harmlessly advances to the signal the authoritative repair will use.
    this.#rotateProjectionBarrier();
    this.#membershipRepairPending = true;
    this.#membershipEpoch += 1;
    this.#clearRetryTimer();
    this.#clearReadTargets();
    this.#beginMembershipBarrier(event);

    // Begin shutdown immediately, but do not await it until the marker and purge have committed.
    // The converted result also prevents an early rejection from becoming unhandled while storage
    // work is still establishing the privacy boundary.
    const realtimeScope = this.#realtimeScope;
    this.#realtimeScope = null;
    const shutdown = (
      realtimeScope === null
        ? this.#client.stopWorkspaceRealtime()
        : this.#client.stopWorkspaceRealtime(realtimeScope)
    ).then(
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
      // Another accepted membership change can invalidate this snapshot while its network reads
      // are in flight. Keep the first durable marker in place and retry at the newest membership
      // epoch; letting the queued repair run first would make it collide with that marker, while
      // acknowledging now could cross a revocation that has not been durably repaired.
      for (;;) {
        const attemptedMembershipEpoch = this.#membershipEpoch;
        const refreshed = await this.#refreshSnapshot(generation);
        if (generation !== this.#generation || cache !== this.#cache) return true;
        if (refreshed) break;
        if (this.#membershipEpoch === attemptedMembershipEpoch) {
          throw new Error("Membership repair snapshot was invalidated without a newer event");
        }
      }
      const repaired = await cache.load();
      if (repaired.repairMarker !== null) {
        throw new Error("Membership repair did not clear its durable marker");
      }
    }

    const candidateCursor = this.#syncCursor ?? event.position;
    // A snapshot or mutation response may have advanced the local cursor beyond another accepted
    // repair. Cap this acknowledgement so a crash leaves that later event available for replay.
    const crossesAcceptedRepair = [...this.#acceptedMembershipRepairs].some(
      ([eventId, workspaceSequence]) =>
        eventId !== event.id && compareSyncPositions(workspaceSequence, candidateCursor) <= 0,
    );
    if (realtimeScope !== null) {
      await this.#client.acknowledgeWorkspaceEvent({
        scope: realtimeScope,
        cursor: crossesAcceptedRepair ? event.position : candidateCursor,
      });
    }
    this.#acceptedMembershipRepairs.delete(event.id);
    if (generation !== this.#generation || cache !== this.#cache) return repairedMembership;
    if (restartRealtime) await this.#restartRealtime(generation);
    if (generation !== this.#generation || cache !== this.#cache) return repairedMembership;
    this.#membershipRepairPending = this.#acceptedMembershipRepairs.size > 0;
    if (!this.#membershipRepairPending) {
      void this.#flushOutbox(generation);
      const selected = this.#state.selectedConversationId;
      if (selected !== null) this.#ensureConversationHistory(selected);
      const root = this.#state.selectedThreadRootId;
      if (root !== null) void this.#fetchThreadPage(root, undefined);
    }
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
    const threadSummaries = this.#state.threadSummaries.filter((summary) =>
      visibleMessageIds.has(summary.threadRootId),
    );
    this.#pruneCreatedMessageMentions(state.messages, state.bootstrap, threadSummaries);
    this.#setState({
      bootstrap: state.bootstrap,
      messages: state.messages,
      threadSummaries,
      reactions: state.reactions,
      attachments: this.#state.attachments.filter(
        (attachment) =>
          attachment.messageId !== null && visibleMessageIds.has(attachment.messageId),
      ),
      conversationFiles:
        selectedConversationId === this.#state.selectedConversationId
          ? this.#state.conversationFiles
          : [],
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
    const threadSummaries = this.#state.threadSummaries.filter((summary) =>
      messageIds.has(summary.threadRootId),
    );
    this.#pruneCreatedMessageMentions(messages, bootstrap, threadSummaries);
    this.#setState({
      bootstrap,
      messages,
      threadSummaries,
      reactions: this.#state.reactions.filter((reaction) => messageIds.has(reaction.messageId)),
      attachments: this.#state.attachments.filter(
        (attachment) => attachment.messageId !== null && messageIds.has(attachment.messageId),
      ),
      conversationFiles:
        this.#state.selectedConversationId === conversationId ? [] : this.#state.conversationFiles,
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

  async #applyWorkspaceEvent(
    event: WorkspaceEvent,
    realtimeScope: RealtimeSessionScope,
    generation: number,
    realtimeEpoch: number,
    acceptedMembershipRepair: boolean,
  ): Promise<void> {
    const cache = this.#cache;
    const sameSessionScope =
      this.#scope !== null &&
      realtimeScope.userId === this.#scope.userId &&
      realtimeScope.workspaceId === this.#scope.workspaceId;
    if (
      cache === null ||
      generation !== this.#generation ||
      !sameSessionScope ||
      (realtimeEpoch !== this.#realtimeEpoch && !acceptedMembershipRepair)
    ) {
      return;
    }
    if (isSelfMembershipChange(event, realtimeScope.userId)) {
      await this.#repairMembershipEvent(event, generation, true);
      return;
    }
    const projection = this.#captureProjection(cache);
    if (projection.generation !== generation || !this.#isProjectionCurrent(projection)) return;
    const retractSource =
      event.type === "message.retracted"
        ? this.#retractedMessageSource(event.payload.messageId, event.conversationId)
        : undefined;
    if (!this.#isProjectionCurrent(projection)) return;
    let applied: CacheEventResult;
    try {
      applied = await cache.applyEvent(event, projection.signal, retractSource);
    } catch (error) {
      if (!this.#isProjectionCurrent(projection)) return;
      throw error;
    }
    if (!this.#isProjectionCurrent(projection)) return;
    if (applied.committedPosition !== null) {
      await this.#client.acknowledgeWorkspaceEvent({
        scope: realtimeScope,
        cursor: applied.committedPosition,
      });
    }
    if (!this.#isProjectionCurrent(projection)) return;
    if (applied.status === "ignored") return;
    this.#syncCursor = applied.committedPosition;
    this.#publishCommittedEvent(event, applied);
    if (applied.changes.invalidated.some((entry) => entry.kind === "members")) {
      this.#membersDirty = true;
      await this.#refreshMembers(generation);
    }
    if (applied.changes.invalidated.some((entry) => entry.kind === "conversation_metadata")) {
      await this.#refreshSourceLessRetractMetadata(generation);
    }
  }

  #hydrateRetractReservations(
    reservations: readonly RetractReservation[],
    messages: readonly Message[] = [],
  ): void {
    this.#retractReservations = [...reservations];
    this.#retractedMessageIds.clear();
    for (const reservation of reservations) this.#retractedMessageIds.add(reservation.messageId);
    for (const message of messages) {
      if (message.deletedAt !== null) this.#retractedMessageIds.add(message.id);
    }
  }

  #retractEffectKey(messageId: string, entityVersion: number): string {
    return `${messageId}:${entityVersion}`;
  }

  #rememberLocallyProjectedRetract(tombstone: Message): void {
    this.#locallyProjectedRetracts.add(this.#retractEffectKey(tombstone.id, tombstone.version));
    while (this.#locallyProjectedRetracts.size > MAX_LOCAL_RETRACT_EFFECTS) {
      const oldest = this.#locallyProjectedRetracts.values().next().value;
      if (oldest === undefined) return;
      this.#locallyProjectedRetracts.delete(oldest);
    }
  }

  #consumeLocallyProjectedRetract(
    event: Extract<WorkspaceEvent, { type: "message.retracted" }>,
  ): boolean {
    const key = this.#retractEffectKey(event.payload.messageId, event.entityVersion);
    if (!this.#locallyProjectedRetracts.has(key)) return false;
    this.#locallyProjectedRetracts.delete(key);
    return true;
  }

  #retainMessages(messages: readonly Message[]): Message[] {
    const reservations = retractReservationMap(this.#retractReservations);
    return messages.map((message) => applyRetractReservation(message, reservations));
  }

  #retractedMessageSource(messageId: string, conversationId: string): Message | undefined {
    const current = this.#state.messages.find((message) => message.id === messageId);
    if (current !== undefined) return current;
    const lastMessage = this.#state.bootstrap?.conversations.find(
      (summary) => summary.conversation.id === conversationId,
    )?.lastMessage;
    if (lastMessage?.id === messageId) return lastMessage;
    return this.#state.threadSummaries.find(
      (summary) =>
        summary.latestReply.id === messageId &&
        summary.latestReply.conversationId === conversationId,
    )?.latestReply;
  }

  #withoutConversationThreadSummaries(conversationId: string): readonly MessageThreadSummary[] {
    return this.#state.threadSummaries.filter(
      (summary) => summary.latestReply.conversationId !== conversationId,
    );
  }

  #invalidateConversationThreadSummaries(conversationId: string): readonly MessageThreadSummary[] {
    this.#invalidatedThreadSummaryConversationIds.add(conversationId);
    this.#sourceLessRetractMetadataPending = true;
    this.#sourceLessRetractMetadataVersion += 1;
    return this.#withoutConversationThreadSummaries(conversationId);
  }

  #applyRetractedMessage(
    tombstone: Message,
    applyRetractEffects: boolean,
    cachedMentionedUserIds?: readonly string[],
  ): void {
    this.#cancelCollectionLoads(
      "A message retraction superseded the collection read",
      tombstone.conversationId,
    );
    if (tombstone.deletedAt !== null) {
      this.#retractReservations = upsertRetractReservation(this.#retractReservations, {
        messageId: tombstone.id,
        deletedAt: tombstone.deletedAt,
        entityVersion: tombstone.version,
      });
      this.#retractedMessageIds.add(tombstone.id);
    }
    const snapshot = this.#state.bootstrap;
    const messages = mergeMessages(this.#state.messages, [tombstone]);
    const retractsThreadRoot = tombstone.threadRootId === null;
    const closesSelectedThread =
      retractsThreadRoot && this.#state.selectedThreadRootId === tombstone.id;
    if (retractsThreadRoot) this.#threadCursors.delete(tombstone.id);
    const summary = snapshot?.conversations.find(
      (candidate) => candidate.conversation.id === tombstone.conversationId,
    );
    const mentionedUserIds =
      cachedMentionedUserIds ??
      this.#createdMessageMentions.get(tombstone.id) ??
      (snapshot === null || summary === undefined
        ? []
        : mentionedMemberIds(tombstone.body, snapshot.members, summary.participantIds));
    this.#createdMessageMentions.delete(tombstone.id);
    this.#setState({
      messages,
      threadSummaries:
        applyRetractEffects &&
        !this.#invalidatedThreadSummaryConversationIds.has(tombstone.conversationId)
          ? retractReplySummary(this.#state.threadSummaries, messages, tombstone)
          : this.#state.threadSummaries,
      reactions: this.#state.reactions.filter((reaction) => reaction.messageId !== tombstone.id),
      attachments: replaceMessageAttachments(this.#state.attachments, [tombstone.id], []),
      conversationFiles: this.#state.conversationFiles.filter(
        (attachment) => attachment.messageId !== tombstone.id,
      ),
      focusedMessageId:
        this.#state.focusedMessageId === tombstone.id ? null : this.#state.focusedMessageId,
      selectedThreadRootId: closesSelectedThread ? null : this.#state.selectedThreadRootId,
      focusedThreadMessageId:
        closesSelectedThread || this.#state.focusedThreadMessageId === tombstone.id
          ? null
          : this.#state.focusedThreadMessageId,
      ...(closesSelectedThread ? { threadLoading: false, threadError: null } : {}),
      bootstrap:
        snapshot === null
          ? null
          : !applyRetractEffects
            ? snapshot
            : replaceConversation(snapshot, tombstone.conversationId, (summary) => {
                if (summary === undefined) return null;
                return reconcileRetractedConversationSummary(
                  summary,
                  tombstone,
                  messages,
                  snapshot.currentUser.user,
                  mentionedUserIds,
                );
              }),
    });
  }

  #publishCommittedEvent(
    event: WorkspaceEvent,
    result: Extract<CacheEventResult, { status: "applied" }>,
  ): void {
    for (const journal of this.#collectionJournals) journal.record(event);
    this.#setState({ collections: invalidateCollections(this.#state.collections, event) });
    const changes = result.changes;
    const revoked = new Set(changes.removedConversationIds);
    const removedReactions = new Set(changes.removedReactionIds);
    const removedMessageReactions = new Set(changes.removedMessageReactionIds);
    let snapshot = this.#state.bootstrap;
    if (snapshot !== null) {
      for (const summary of changes.conversations) {
        snapshot = replaceConversation(snapshot, summary.conversation.id, () => summary);
      }
      snapshot = {
        ...snapshot,
        syncCursor: result.committedPosition,
        conversations: snapshot.conversations.filter(
          (summary) => !revoked.has(summary.conversation.id),
        ),
      };
    }
    const messages = mergeMessages(this.#state.messages, changes.messages).filter(
      (message) => !revoked.has(message.conversationId),
    );
    const revokedMessageIds = new Set(
      this.#state.messages
        .filter((message) => revoked.has(message.conversationId))
        .map((message) => message.id),
    );
    const removedOutboxIds = new Set(changes.removedOutboxIds);
    const outbox = this.#state.outbox.filter(
      (item) =>
        !removedOutboxIds.has(item.operation.message.clientMessageId) &&
        !revoked.has(item.operation.conversationId),
    );
    for (const reservation of changes.retractReservations) {
      this.#retractReservations = upsertRetractReservation(this.#retractReservations, reservation);
      this.#retractedMessageIds.add(reservation.messageId);
    }

    // Thread aggregates and attachments are fetched separately from the current cache stores.
    // Their view state follows committed messages; it does not recalculate cached summaries.
    let threadSummaries: readonly MessageThreadSummary[] = this.#state.threadSummaries.filter(
      (summary) => !revoked.has(summary.latestReply.conversationId),
    );
    let retractedId: string | null = null;
    let closesSelectedThread = false;
    let created: Message | undefined;
    if (event.type === "message.created") {
      created = changes.messages.find((message) => message.id === event.payload.message.id);
      if (created !== undefined && created.deletedAt === null) {
        rememberCreatedMessageMentions(
          this.#createdMessageMentions,
          created.id,
          event.payload.mentionedUserIds,
        );
        const newlyObserved = !this.#state.messages.some((message) => message.id === created?.id);
        const summaryPosition =
          created.threadRootId === null
            ? undefined
            : this.#threadSummaryPositions.get(created.threadRootId);
        if (
          !this.#invalidatedThreadSummaryConversationIds.has(created.conversationId) &&
          (summaryPosition === undefined ||
            compareSyncPositions(event.position, summaryPosition) > 0)
        ) {
          threadSummaries = projectReplySummary(threadSummaries, created, newlyObserved);
        }
      } else if (created !== undefined) {
        this.#createdMessageMentions.delete(created.id);
      }
    } else if (event.type === "message.retracted") {
      retractedId = event.payload.messageId;
      const tombstone = changes.messages.find((message) => message.id === retractedId);
      this.#createdMessageMentions.delete(retractedId);
      closesSelectedThread = this.#state.selectedThreadRootId === retractedId;
      if (tombstone === undefined || tombstone.threadRootId === null)
        this.#threadCursors.delete(retractedId);
      if (
        tombstone !== undefined &&
        !this.#consumeLocallyProjectedRetract(event) &&
        !this.#invalidatedThreadSummaryConversationIds.has(tombstone.conversationId)
      ) {
        threadSummaries = retractReplySummary(threadSummaries, messages, tombstone);
      }
    }
    for (const invalidation of changes.invalidated) {
      if (invalidation.kind === "conversation_metadata") {
        this.#invalidateConversationThreadSummaries(invalidation.conversationId);
        threadSummaries = threadSummaries.filter(
          (summary) => summary.latestReply.conversationId !== invalidation.conversationId,
        );
      }
    }
    this.#setState({
      bootstrap: snapshot,
      messages,
      outbox,
      tasks: mergeTasks(this.#state.tasks, changes.tasks).filter(
        (task) => !revoked.has(task.conversationId),
      ),
      reactions: mergeReactions(this.#state.reactions, changes.reactions).filter(
        (reaction) =>
          !removedReactions.has(reaction.id) &&
          !removedMessageReactions.has(reaction.messageId) &&
          !revokedMessageIds.has(reaction.messageId),
      ),
      threadSummaries,
      attachments: this.#state.attachments.filter(
        (attachment) =>
          (retractedId === null || attachment.messageId !== retractedId) &&
          (attachment.messageId === null || !revokedMessageIds.has(attachment.messageId)),
      ),
      conversationFiles: this.#state.conversationFiles.filter(
        (attachment) =>
          (retractedId === null || attachment.messageId !== retractedId) &&
          (attachment.messageId === null || !revokedMessageIds.has(attachment.messageId)),
      ),
      focusedMessageId:
        this.#state.focusedMessageId === retractedId ? null : this.#state.focusedMessageId,
      selectedThreadRootId: closesSelectedThread ? null : this.#state.selectedThreadRootId,
      focusedThreadMessageId:
        closesSelectedThread || this.#state.focusedThreadMessageId === retractedId
          ? null
          : this.#state.focusedThreadMessageId,
      ...(closesSelectedThread ? { threadLoading: false, threadError: null } : {}),
    });
    if (created !== undefined && created.deletedAt === null)
      void this.#hydrateCreatedMessageAttachments(created);
  }

  #requireProtocolUpgrade(): void {
    if (this.#protocolBlocked) return;
    this.#protocolBlocked = true;
    this.#offlineOnly = true;
    this.#clearResyncTimer();
    this.#resetSourceLessRetractMetadataRefresh();
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#clearMembersRetryTimer();
    this.#setState({
      busy: false,
      stale: true,
      connection: "incompatible",
      error: WORKSPACE_PROTOCOL_UPGRADE_MESSAGE,
    });
    const scope = this.#realtimeScope;
    this.#realtimeScope = null;
    this.#clearActivity(true);
    if (scope !== null) void this.#client.stopWorkspaceRealtime(scope).catch(() => undefined);
  }

  async #flushOutbox(generation: number): Promise<void> {
    const cache = this.#cache;
    if (
      this.#offlineOnly ||
      this.#protocolBlocked ||
      this.#membershipRepairPending ||
      this.#catalogPending ||
      this.#startupMetadataPending ||
      cache === null ||
      generation !== this.#generation
    ) {
      return;
    }
    const owner = this.#captureProjection(cache);
    if (
      this.#outboxFlushOwner?.signal === owner.signal &&
      this.#outboxFlushOwner.cache === owner.cache &&
      this.#outboxFlushOwner.generation === owner.generation
    ) {
      // Do not race the current projection's worker. Its `finally` block will observe this request
      // even when it arrived after that worker found no deliverable item.
      this.#outboxFlushRequested = true;
      return;
    }
    // A generation change or membership barrier rotates the projection signal. The replacement
    // worker must not wait for an old request that can remain hung indefinitely.
    this.#outboxFlushOwner = owner;
    this.#outboxFlushRequested = false;
    this.#clearRetryTimer();
    try {
      for (;;) {
        if (this.#protocolBlocked) return;
        if (!this.#isOutboxFlushOwnerCurrent(owner)) return;
        const next = nextDeliverable(this.#state.outbox, Date.now());
        if (next === undefined) {
          this.#scheduleNextRetry(this.#state.outbox, generation);
          break;
        }
        const id = next.operation.message.clientMessageId;
        if (!this.#isOutboxFlushOwnerCurrent(owner, next.operation.conversationId)) return;
        const attempt = next.attemptCount + 1;
        const patched = await this.#patchOutbox(
          id,
          {
            status: "sending",
            attemptCount: attempt,
            nextAttemptAt: null,
            failureReason: null,
          },
          owner,
          next.operation.conversationId,
          { status: next.status, attemptCount: next.attemptCount },
        );
        if (!patched || !this.#isOutboxFlushOwnerCurrent(owner, next.operation.conversationId)) {
          return;
        }
        const committedPosition = this.#syncCursor;
        if (committedPosition === null) return;
        let result: Awaited<ReturnType<DesktopApi["sendConversationMessage"]>>;
        try {
          result = await this.#client.sendConversationMessage(next.operation);
        } catch {
          // Main may retire the session before IPC can deliver its result, including when a
          // protocol mismatch caused that retirement. Keep the same operation and idempotency key;
          // a replacement projection owns recovery if the session changed while we awaited IPC.
          if (!this.#isOutboxFlushOwnerCurrent(owner, next.operation.conversationId)) return;
          result = { status: "retryable", reason: "network", retryAfterMs: null };
        }
        if (!this.#isOutboxFlushOwnerCurrent(owner, next.operation.conversationId)) return;
        // A membership repair can finish while this request is still in flight. Its authoritative
        // snapshot removes revoked sends from both the cache and this projection; a late response
        // no longer owns anything and must not reinsert its message after the barrier has cleared.
        if (!this.#state.outbox.some((item) => item.operation.message.clientMessageId === id)) {
          continue;
        }
        if (result.status === "accepted") {
          // The send response's cursor is a whole-workspace sequence, so a peer event still in
          // flight can be below it. Record the message durably but keep this client's cursor at
          // what it has actually applied, and never acknowledge the send cursor to the server.
          const persisted = await cache.upsertAcknowledgedMessage(
            result.response.message,
            id,
            this.#syncCursor ?? committedPosition,
            owner.signal,
          );
          if (!this.#isOutboxFlushOwnerCurrent(owner, next.operation.conversationId)) return;
          if (!persisted) {
            if (this.#state.outbox.some((item) => item.operation.message.clientMessageId === id)) {
              return;
            }
            continue;
          }
          if (
            !this.#state.bootstrap?.conversations.some(
              (summary) => summary.conversation.id === result.response.message.conversationId,
            )
          ) {
            return;
          }
          this.#acceptMessage(result.response.message, id, result.response.attachments ?? []);
          continue;
        }
        if (result.status === "upgrade_required") {
          this.#requireProtocolUpgrade();
          await this.#patchOutbox(
            id,
            {
              status: "pending",
              attemptCount: attempt,
              nextAttemptAt: null,
              failureReason: WORKSPACE_PROTOCOL_UPGRADE_MESSAGE,
            },
            owner,
            next.operation.conversationId,
            { status: "sending", attemptCount: attempt },
          );
          return;
        }
        if (result.status === "authentication_required") {
          const paused = await this.#patchOutbox(
            id,
            {
              status: "paused_auth",
              attemptCount: attempt,
              nextAttemptAt: null,
              failureReason: "Sign in to retry",
            },
            owner,
            next.operation.conversationId,
            { status: "sending", attemptCount: attempt },
          );
          if (!paused) return;
          break;
        }
        if (result.status === "permanent") {
          const failed = await this.#patchOutbox(
            id,
            {
              status: "permanent_failure",
              attemptCount: attempt,
              nextAttemptAt: null,
              failureReason: result.reason,
            },
            owner,
            next.operation.conversationId,
            { status: "sending", attemptCount: attempt },
          );
          if (!failed) return;
          continue;
        }
        const delay = result.retryAfterMs ?? retryDelay(attempt);
        const waiting = await this.#patchOutbox(
          id,
          {
            status: "retry_wait",
            attemptCount: attempt,
            nextAttemptAt: new Date(Date.now() + delay).toISOString(),
            failureReason: result.reason,
          },
          owner,
          next.operation.conversationId,
          { status: "sending", attemptCount: attempt },
        );
        if (!waiting) return;
        // Without rearming here the message waits for a manual retry or a restart forever.
        this.#scheduleNextRetry(this.#state.outbox, generation);
        break;
      }
    } finally {
      if (this.#outboxFlushOwner === owner) {
        const rerun = this.#outboxFlushRequested;
        this.#outboxFlushOwner = null;
        this.#outboxFlushRequested = false;
        if (
          rerun &&
          generation === this.#generation &&
          cache === this.#cache &&
          !this.#membershipRepairPending
        ) {
          void this.#flushOutbox(generation);
        }
      }
    }
  }

  #acceptMessage(
    message: Message,
    clientMessageId: string,
    attachments: readonly Attachment[] = [],
  ): void {
    this.#cancelCollectionLoads(
      "A committed send superseded the collection read",
      message.conversationId,
    );
    const retained = this.#retainMessages([message])[0] ?? message;
    if (retained.deletedAt !== null) {
      this.#retractReservations = upsertRetractReservation(this.#retractReservations, {
        messageId: retained.id,
        deletedAt: retained.deletedAt,
        entityVersion: retained.version,
      });
      this.#retractedMessageIds.add(retained.id);
    }
    const snapshot = this.#state.bootstrap;
    const newlyObserved = !this.#state.messages.some((existing) => existing.id === retained.id);
    const bootstrap =
      snapshot === null
        ? null
        : retained.deletedAt !== null
          ? snapshot
          : replaceConversation(snapshot, message.conversationId, (current) => {
              if (current === undefined) return null;
              return { ...current, lastMessage: retained };
            });
    this.#setState({
      messages: mergeMessages(this.#state.messages, [retained]),
      threadSummaries:
        retained.deletedAt === null &&
        !this.#invalidatedThreadSummaryConversationIds.has(retained.conversationId)
          ? projectReplySummary(this.#state.threadSummaries, retained, newlyObserved)
          : this.#state.threadSummaries,
      attachments:
        retained.deletedAt === null
          ? mergeAttachments(this.#state.attachments, attachments)
          : this.#state.attachments,
      conversationFiles:
        retained.deletedAt === null &&
        this.#state.selectedConversationId === retained.conversationId
          ? mergeAttachments(this.#state.conversationFiles, attachedConversationFiles(attachments))
          : this.#state.conversationFiles,
      // Both ids are dropped so a server that does not echo the client id cannot leave the
      // delivered item queued and spin the flush loop.
      outbox: this.#withoutOutbox([clientMessageId, message.clientMessageId]),
      bootstrap,
    });
  }

  async #hydrateCreatedMessageAttachments(message: Message): Promise<void> {
    const cache = this.#cache;
    if (cache === null) return;
    const projection = this.#captureProjection(cache);
    try {
      const result = await this.#client.listMessageAttachments([message.id]);
      if (!this.#isProjectionCurrent(projection, message.conversationId)) return;
      const current = this.#state.messages.find((candidate) => candidate.id === message.id);
      if (current === undefined || current.deletedAt !== null) return;
      if (result.attachments.length > 0)
        this.#cancelCollectionLoads(
          "New attachments superseded the collection read",
          message.conversationId,
        );
      this.#setState({
        attachments: mergeAttachments(this.#state.attachments, result.attachments),
        conversationFiles:
          this.#state.selectedConversationId === message.conversationId
            ? mergeAttachments(
                this.#state.conversationFiles,
                attachedConversationFiles(result.attachments),
              )
            : this.#state.conversationFiles,
      });
    } catch {
      // Live chips catch up on the next history read.
    }
  }

  #withoutOutbox(clientMessageIds: readonly string[]): readonly OutboxItem[] {
    return this.#state.outbox.filter(
      (item) => !clientMessageIds.includes(item.operation.message.clientMessageId),
    );
  }

  async #patchOutbox(
    clientMessageId: string,
    update: OutboxUpdate,
    owner?: ProjectionGuard,
    conversationId?: string,
    expected?: OutboxUpdateExpectation,
  ): Promise<boolean> {
    const cache = owner?.cache ?? this.#cache;
    if (
      cache === null ||
      (owner !== undefined && !this.#isOutboxFlushOwnerCurrent(owner, conversationId))
    ) {
      return false;
    }
    const committed = await cache.updateOutbox(clientMessageId, update, owner?.signal, expected);
    if (!committed) return false;
    if (owner !== undefined && !this.#isOutboxFlushOwnerCurrent(owner, conversationId)) {
      return false;
    }
    this.#setState({
      outbox: this.#state.outbox.map((item) =>
        item.operation.message.clientMessageId === clientMessageId ? { ...item, ...update } : item,
      ),
    });
    return true;
  }

  async #reloadCache(
    generation: number,
    cache: WorkspaceCache,
    allowMembershipRepair = false,
  ): Promise<boolean> {
    const projection = this.#captureProjection(cache);
    const current = (): boolean =>
      generation === this.#generation &&
      cache === this.#cache &&
      projection.membershipEpoch === this.#membershipEpoch &&
      !projection.signal.aborted &&
      (allowMembershipRepair || !this.#membershipRepairPending);
    if (!current()) return false;
    const loaded = await cache.load();
    if (!current()) return false;
    if (allowMembershipRepair)
      this.#membershipRepairPending =
        loaded.repairMarker !== null || this.#acceptedMembershipRepairs.size > 0;
    this.#hydrateRetractReservations(loaded.retractReservations, loaded.messages);
    let threadSummaries: readonly MessageThreadSummary[] = this.#state.threadSummaries.filter(
      (summary) =>
        !this.#invalidatedThreadSummaryConversationIds.has(summary.latestReply.conversationId),
    );
    const currentMessages = new Map(this.#state.messages.map((message) => [message.id, message]));
    const liveMessageIds = new Set(
      loaded.messages.filter((message) => message.deletedAt === null).map((message) => message.id),
    );
    for (const message of loaded.messages) {
      const previous = currentMessages.get(message.id);
      if (this.#invalidatedThreadSummaryConversationIds.has(message.conversationId)) {
        currentMessages.set(message.id, message);
        continue;
      }
      if (message.deletedAt !== null) {
        if (previous === undefined || previous.deletedAt === null) {
          threadSummaries = retractReplySummary(threadSummaries, loaded.messages, message);
        }
      } else if (message.threadRootId !== null) {
        threadSummaries = projectReplySummary(threadSummaries, message, previous === undefined);
      }
      currentMessages.set(message.id, message);
    }
    this.#syncCursor = loaded.syncCursor;
    this.#pruneCreatedMessageMentions(loaded.messages, loaded.bootstrap, threadSummaries);
    this.#setState({
      collections: loaded.collections.filter(
        (state) =>
          state.identity.kind !== "files" ||
          this.#state.collections.some(
            (current) =>
              collectionKey(current.identity) === collectionKey(state.identity) && current.loaded,
          ),
      ),
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      threadSummaries,
      reactions: loaded.reactions,
      attachments: this.#state.attachments.filter(
        (attachment) => attachment.messageId !== null && liveMessageIds.has(attachment.messageId),
      ),
      conversationFiles: this.#state.conversationFiles.filter(
        (attachment) => attachment.messageId === null || liveMessageIds.has(attachment.messageId),
      ),
      tasks: loaded.tasks,
      outbox: loaded.outbox,
    });
    return true;
  }

  #scheduleMembershipMarkerRetry(
    generation: number,
    cache: WorkspaceCache,
    marker: MembershipRepairMarker,
    startCursor: SyncPosition,
    retryAfterMs: number | null,
  ): void {
    if (this.#protocolBlocked) return;
    this.#clearSyncRetryTimer();
    this.#syncAttempt += 1;
    const delay = retryAfterMs ?? retryDelay(this.#syncAttempt);
    this.#syncRetryTimer = setTimeout(() => {
      this.#syncRetryTimer = null;
      void this.#serializeRecovery(async () => {
        if (generation !== this.#generation || cache !== this.#cache || this.#syncAttempt === 0) {
          return;
        }
        this.#setState({ busy: true });
        await this.#recoverDurableMembershipMarker(generation, cache, marker, startCursor);
      }).catch((error: unknown) => {
        if (generation === this.#generation && cache === this.#cache) {
          this.#syncAttempt = 0;
          this.#setState({
            busy: false,
            stale: true,
            error: errorMessage(error, "Could not initialize the workspace"),
          });
        }
      });
    }, delay);
  }

  #scheduleSyncRetry(generation: number, retryAfterMs: number | null): void {
    if (this.#protocolBlocked) return;
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
        const wasReplicaCatchUp = this.#startupReplicaCatchUpPending;
        await this.#repairAndFlush(generation, !wasReplicaCatchUp);
        if (
          generation === this.#generation &&
          wasReplicaCatchUp &&
          this.#startupReplicaCatchUpPending &&
          !this.#syncRecoveryPending
        ) {
          await this.#completeStartupAfterReplicaCatchUp(generation);
          return;
        }
        if (
          generation === this.#generation &&
          this.#startupRealtimePending &&
          !this.#syncRecoveryPending &&
          !this.#membershipRepairPending
        ) {
          await this.#restartRealtime(generation);
          if (generation !== this.#generation) return;
          this.#startupRealtimePending = false;
          this.#startupMetadataPending = false;
          await this.#flushOutbox(generation);
          this.#setState({ busy: false });
          const selectedConversationId = this.#state.selectedConversationId;
          if (selectedConversationId !== null) {
            this.#ensureConversationHistory(selectedConversationId);
          }
        }
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
    if (this.#protocolBlocked) return;
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

  #scheduleSourceLessRetractMetadataRetry(generation: number): void {
    if (this.#protocolBlocked) return;
    this.#clearSourceLessRetractMetadataRetryTimer();
    this.#sourceLessRetractMetadataAttempt += 1;
    this.#sourceLessRetractMetadataRetryTimer = setTimeout(() => {
      this.#sourceLessRetractMetadataRetryTimer = null;
      if (generation !== this.#generation || !this.#sourceLessRetractMetadataPending) return;
      // Metadata replacement reads and rewrites the full cached projection. Join ordinary
      // renderer projections so it cannot discard a history page that the user opens while this
      // retry waits.
      void this.#serialize(() => this.#refreshSourceLessRetractMetadata(generation));
    }, retryDelay(this.#sourceLessRetractMetadataAttempt));
  }

  #clearSourceLessRetractMetadataRetryTimer(): void {
    if (this.#sourceLessRetractMetadataRetryTimer === null) return;
    clearTimeout(this.#sourceLessRetractMetadataRetryTimer);
    this.#sourceLessRetractMetadataRetryTimer = null;
  }

  #resetSourceLessRetractMetadataRefresh(): void {
    this.#clearSourceLessRetractMetadataRetryTimer();
    this.#sourceLessRetractMetadataAttempt = 0;
    this.#sourceLessRetractMetadataPending = false;
    this.#sourceLessRetractMetadataVersion += 1;
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
