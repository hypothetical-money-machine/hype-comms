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
  type ProductRealtimeEvent,
  type SyncAttemptResult,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hmm-chat/contracts";

import type { DesktopApi, RealtimeConnectionState } from "../../shared/desktop-api";
import {
  clearPersistentWorkspaceCache,
  compareConversations,
  compareMembers,
  MemoryWorkspaceCache,
  PersistentWorkspaceCache,
  type OutboxItem,
  type OutboxStatus,
  type WorkspaceCache,
} from "./workspace-cache";

/** Why the encrypted cache fell back to memory. Derived so a new crypto reason cannot drift. */
export type CacheFallbackReason = Extract<CacheCryptoStatus, { mode: "memory_only" }>["reason"];

export interface WorkspaceRuntimeState {
  readonly bootstrap: WorkspaceSnapshot | null;
  readonly messages: readonly Message[];
  readonly outbox: readonly OutboxItem[];
  readonly selectedConversationId: string | null;
  readonly focusedMessageId: string | null;
  readonly connection: RealtimeConnectionState;
  readonly cacheMode: "persistent" | "memory_only" | null;
  readonly cacheFallbackReason: CacheFallbackReason | null;
  readonly stale: boolean;
  readonly busy: boolean;
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
  outbox: [],
  selectedConversationId: null,
  focusedMessageId: null,
  connection: "offline",
  cacheMode: null,
  cacheFallbackReason: null,
  stale: true,
  busy: false,
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
  /**
   * Resync demands in the current chain. Only demands count: a failed download is retried without
   * touching this, and `system.connected` cannot reset it either, so the bound stays armed on a
   * server that accepts a handshake and then rejects the cursor it just issued.
   */
  #resyncAttempt = 0;
  /** Transient failures of the resync now in flight, so its backoff grows the usual way. */
  #resyncFailures = 0;
  /** When the resync now in place restarted realtime; how a chain is told from a fresh demand. */
  #resyncSettledAt: number | null = null;
  /** The signed-in scope, kept past `stop()` so a sign-out reset knows whose cache to delete. */
  #scope: CacheScope | null = null;
  /** The highest workspace sequence this client has durably applied. */
  #syncCursor: string | null = null;
  #eventQueue: Promise<void> = Promise.resolve();
  readonly #historyCursors = new Map<string, string | null>();
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

  async start(session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }>) {
    const generation = ++this.#generation;
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#resetResyncState();
    this.#syncAttempt = 0;
    this.#setState({ busy: true, error: null });
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#eventQueue = Promise.resolve();
    this.#unsubscribeEvent = this.#client.onWorkspaceEvent((event) => {
      this.#eventQueue = this.#eventQueue
        .then(() => this.#handleRealtimeEvent(event, generation))
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
      this.#syncCursor = cached.syncCursor;
      this.#setState({
        bootstrap: cached.bootstrap,
        messages: cached.messages,
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
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#resetResyncState();
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeEvent = null;
    this.#unsubscribeConnection = null;
    await this.#client.stopWorkspaceRealtime();
    this.#cache = null;
    this.#syncCursor = null;
    this.#state = INITIAL_STATE;
    for (const listener of this.#listeners) listener(this.#state);
  }

  selectConversation(conversationId: string): void {
    this.#setState({ selectedConversationId: conversationId, focusedMessageId: null });
    const messages = this.#state.messages.filter(
      (message) => message.conversationId === conversationId,
    );
    const latest = messages.at(-1);
    if (latest !== undefined) {
      void this.#client.advanceReadCursor(conversationId, latest.id).catch(() => undefined);
    }
  }

  async sendMessage(
    conversationId: string,
    body: string,
    mentionedUserIds: readonly string[],
  ): Promise<void> {
    const cache = this.#cache;
    if (cache === null) throw new Error("Workspace cache is unavailable");
    const clientMessageId = crypto.randomUUID();
    const operation = sendMessageOperationSchema.parse({
      conversationId,
      idempotencyKey: clientMessageId,
      message: {
        threadRootId: null,
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

  async openSearchResult(result: MessageSearchResult): Promise<void> {
    const cache = this.#cache;
    const snapshot = this.#state.bootstrap;
    if (cache === null || snapshot === null) throw new Error("Workspace is still loading");
    const conversationId = result.message.conversationId;
    if (!snapshot.conversations.some((summary) => summary.conversation.id === conversationId)) {
      throw new Error("This conversation is no longer available");
    }
    await cache.upsertHistory([result.message]);
    const messages = mergeMessages(this.#state.messages, [result.message]);
    this.#setState({
      messages,
      selectedConversationId: conversationId,
      focusedMessageId: result.message.id,
    });
    const latest = messages.filter((message) => message.conversationId === conversationId).at(-1);
    if (latest !== undefined) {
      void this.#client.advanceReadCursor(conversationId, latest.id).catch(() => undefined);
    }
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

  async createChannel(name: string, slug: string, access: ChannelAccess): Promise<void> {
    const generation = this.#generation;
    const cache = this.#cache;
    if (cache === null || this.#state.bootstrap === null) {
      throw new Error("Workspace is still loading");
    }
    const result = await this.#client.createChannel({ name, slug, topic: null, access });
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
    const before = this.#historyCursors.get(conversationId);
    if (cache === null || before === null) return;
    const history = await this.#client.getConversationMessages({
      conversationId,
      ...(before === undefined ? {} : { before }),
      limit: 50,
    });
    this.#historyCursors.set(conversationId, history.nextCursor);
    await cache.upsertHistory(history.messages);
    this.#setState({ messages: mergeMessages(this.#state.messages, history.messages) });
  }

  hasOlder(conversationId: string): boolean {
    return this.#historyCursors.get(conversationId) !== null;
  }

  async resetLocalCache(): Promise<void> {
    ++this.#generation;
    this.#clearRetryTimer();
    this.#clearSyncRetryTimer();
    this.#resetResyncState();
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
    this.#setState({ ...INITIAL_STATE, error: "Local cache reset. Rebuilding the workspace…" });
  }

  conversationName(summary: ConversationSummary): string {
    if (summary.conversation.kind === "channel") {
      return `# ${summary.conversation.name ?? summary.conversation.slug ?? "channel"}`;
    }
    const otherId = summary.participantIds.find(
      (id) => id !== this.#state.bootstrap?.currentUser.user.id,
    );
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
    const snapshot = await this.#fetchSnapshot();
    const messages: Message[] = [];
    this.#historyCursors.clear();
    for (const summary of snapshot.conversations) {
      const history = await this.#client.getConversationMessages({
        conversationId: summary.conversation.id,
        limit: 50,
      });
      this.#historyCursors.set(summary.conversation.id, history.nextCursor);
      messages.push(...history.messages);
    }
    if (generation !== this.#generation) return;
    await cache.replaceSnapshot(snapshot, messages);
    const loaded = await cache.load();
    if (generation !== this.#generation) return;
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
    this.#setState({
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      outbox: loaded.outbox,
      selectedConversationId,
      focusedMessageId,
      stale: false,
      error: null,
    });
  }

  async #repairAndFlush(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
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
      for (const event of result.response.events) await cache.applyEvent(event);
      await cache.advanceCursor(result.response.nextCursor);
      await this.#client.acknowledgeWorkspaceEvent(result.response.nextCursor);
      this.#syncCursor = result.response.nextCursor;
      cursor = result.response.nextCursor;
      if (!result.response.hasMore) break;
    }
    this.#syncAttempt = 0;
    await this.#reloadCache();
    this.#setState({ stale: false });
    await this.#flushOutbox(generation);
  }

  async #handleRealtimeEvent(event: ProductRealtimeEvent, generation: number): Promise<void> {
    if (generation !== this.#generation || this.#cache === null) return;
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
      await this.#resync(generation);
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
  async #resync(generation: number): Promise<void> {
    if (this.#cache === null || generation !== this.#generation) return;
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
      await this.#attemptResync(generation);
      return;
    }
    this.#scheduleResync(generation, retryDelay(this.#resyncAttempt));
  }

  /**
   * One resync attempt: drop the server-derived stores, keep the outbox, re-download, resume the
   * sync loop, and restart realtime with the cursor that establishes. A failure here is transient —
   * a server that has not finished coming back up, most often — so it is retried with backoff and
   * does not count against the demand bound. Charging it there wedged the client for good: a few
   * seconds of downtime spent the whole budget, left no cached workspace behind, and reported a
   * server demanding resyncs it had never sent.
   */
  async #attemptResync(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    try {
      await cache.clearServerStatePreservingOutbox();
      this.#syncCursor = null;
      await this.#refreshSnapshot(generation);
      if (generation !== this.#generation || this.#cache === null) return;
      await this.#repairAndFlush(generation);
      if (generation !== this.#generation || this.#cache === null) return;
      // Stamped before the handshake goes out, because the demand that answers it arrives on the
      // socket this opens: a chain has to be measured from the handshake, not from a reply to it.
      this.#resyncSettledAt = Date.now();
      await this.#restartRealtime(generation);
      if (generation !== this.#generation) return;
      this.#resyncFailures = 0;
    } catch (error) {
      if (generation !== this.#generation) return;
      // Realtime is stopped and the server-derived stores are already gone, so without rearming
      // here the client sits offline with no cached workspace until the user presses Retry. The
      // notice is the failure that actually happened, never the server-keeps-demanding dead end.
      this.#resyncFailures += 1;
      this.#setState({ stale: true, error: errorMessage(error, "Could not resync the workspace") });
      this.#scheduleResync(generation, retryDelay(this.#resyncFailures));
    }
  }

  #scheduleResync(generation: number, delayMs: number): void {
    this.#clearResyncTimer();
    this.#resyncTimer = setTimeout(() => {
      this.#resyncTimer = null;
      void this.#attemptResync(generation);
    }, delayMs);
  }

  async #restartRealtime(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    const loaded = await cache.load();
    if (generation !== this.#generation) return;
    this.#syncCursor = loaded.syncCursor;
    await this.#client.startWorkspaceRealtime(loaded.syncCursor ?? "0");
  }

  async #applyWorkspaceEvent(event: WorkspaceEvent, generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null) return;
    const applied = await cache.applyEvent(event);
    await this.#client.acknowledgeWorkspaceEvent(event.workspaceSequence);
    if (!applied) return;
    this.#syncCursor = event.workspaceSequence;
    if (event.type === "channel.membership_changed") {
      await this.#refreshSnapshot(generation);
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
      this.#setState({
        messages: mergeMessages(this.#state.messages, [message]),
        outbox: this.#withoutOutbox([message.clientMessageId]),
        bootstrap: snapshot === null ? null : countMessage(snapshot, event),
      });
      return;
    }
    if (snapshot === null) return;
    if (event.type === "member.updated") {
      const member = event.payload.member;
      const updated = snapshot.members.some((existing) => existing.id === member.id)
        ? snapshot.members.map((existing) => (existing.id === member.id ? member : existing))
        : [...snapshot.members, member];
      // A new member appends and a display-name change reorders, so re-sort as above.
      const members = updated.sort(compareMembers);
      this.#setState({ bootstrap: { ...snapshot, members } });
      return;
    }
    if (event.type === "read_cursor.updated") {
      const readCursor = event.payload.readCursor;
      this.#setState({
        bootstrap: replaceConversation(snapshot, event.conversationId, (current) => {
          if (current === undefined) return null;
          return { ...current, readCursor, unreadCount: 0, mentionCount: 0 };
        }),
      });
      return;
    }
    if (event.type === "channel.membership_changed") return;
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
    if (this.#flushing || cache === null || generation !== this.#generation) return;
    this.#flushing = true;
    this.#clearRetryTimer();
    try {
      for (;;) {
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
        const result = await this.#client.sendConversationMessage(next.operation);
        if (generation !== this.#generation) return;
        if (result.status === "accepted") {
          // The send response's cursor is a whole-workspace sequence, so a peer event still in
          // flight can be below it. Record the message durably but keep this client's cursor at
          // what it has actually applied, and never acknowledge the send cursor to the server.
          await cache.upsertAcknowledgedMessage(result.response.message, this.#syncCursor ?? "0");
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
    const bootstrap =
      snapshot === null
        ? null
        : replaceConversation(snapshot, message.conversationId, (current) => {
            if (current === undefined) return null;
            return { ...current, lastMessage: message };
          });
    this.#setState({
      messages: mergeMessages(this.#state.messages, [message]),
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
    this.#syncCursor = loaded.syncCursor;
    this.#setState({
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      outbox: loaded.outbox,
    });
  }

  #scheduleSyncRetry(generation: number, retryAfterMs: number | null): void {
    this.#clearSyncRetryTimer();
    this.#syncAttempt += 1;
    const delay = retryAfterMs ?? retryDelay(this.#syncAttempt);
    this.#syncRetryTimer = setTimeout(() => {
      this.#syncRetryTimer = null;
      void this.#repairAndFlush(generation).catch((error: unknown) => {
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
    this.#resyncSettledAt = null;
  }
}
