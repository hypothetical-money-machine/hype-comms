import { describe, expect, it, vi } from "vitest";

import type {
  AdvanceReadCursorResponse,
  CacheCryptoStatus,
  CacheDecryptBatchResponse,
  CacheEncryptBatchResponse,
  CacheScope,
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  ChatSessionState,
  ConversationMutationResponse,
  ConversationSummary,
  CreateChannelRequest,
  ListConversationsQuery,
  ListConversationsResponse,
  MagicLinkDeliveryState,
  Message,
  MessageHistoryResponse,
  MessageSearchQuery,
  MessageSearchResponse,
  ProductRealtimeEvent,
  RealtimeConnectionState,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
  UpdateState,
  WorkspaceBootstrapResponse,
  WorkspaceEvent,
} from "@hmm-chat/contracts";

import type {
  DesktopApi,
  DesktopPlatform,
  NotificationAction,
  ServerStatus,
} from "../../shared/desktop-api";
import type { CachedWorkspaceState, OutboxItem, WorkspaceCache } from "./workspace-cache";
import { WorkspaceRuntime } from "./workspace-runtime";

const USER_ID = "20000000-0000-4000-8000-000000000001";
const PEER_ID = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000003";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000004";
const SECOND_CONVERSATION_ID = "20000000-0000-4000-8000-000000000005";
const OWN_MESSAGE_ID = "20000000-0000-4000-8000-000000000006";
const PEER_MESSAGE_ID = "20000000-0000-4000-8000-000000000007";
const PEER_EVENT_ID = "20000000-0000-4000-8000-000000000008";
const RESYNC_EVENT_ID = "20000000-0000-4000-8000-000000000009";
const OWN_CLIENT_MESSAGE_ID = "20000000-0000-4000-8000-00000000000a";
const PEER_CLIENT_MESSAGE_ID = "20000000-0000-4000-8000-00000000000b";
const CONNECTED_EVENT_ID = "20000000-0000-4000-8000-00000000000c";
const CONNECTION_ID = "20000000-0000-4000-8000-00000000000d";
const CREATED_CHANNEL_ID = "20000000-0000-4000-8000-000000000010";
const NOW = "2026-07-24T12:00:00.000Z";
const NEXT_PAGE_CURSOR = "eyJpZCI6InAxIn0";

const scope: CacheScope = { userId: USER_ID, workspaceId: WORKSPACE_ID };

const session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  status: "signed-in",
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

const user = {
  id: USER_ID,
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

function channel(id: string, slug: string): ConversationSummary {
  return {
    conversation: {
      id,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name: slug,
      slug,
      topic: null,
      access: "workspace",
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [],
    membershipRole: null,
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

function bootstrapAt(
  syncCursor: string,
  overrides: Partial<WorkspaceBootstrapResponse> = {},
): WorkspaceBootstrapResponse {
  return {
    currentUser: { user, email: "morgan@example.com", workspaceId: WORKSPACE_ID, role: "owner" },
    workspace: {
      id: WORKSPACE_ID,
      name: "HMM Chat",
      slug: "hmm-chat",
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    members: [user],
    conversations: [channel(CONVERSATION_ID, "general")],
    conversationsNextCursor: null,
    conversationsHasMore: false,
    syncCursor,
    featureFlags: { channels: true, directMessages: true, mentions: true },
    ...overrides,
  };
}

function message(
  id: string,
  authorId: string,
  conversationSequence: string,
  clientMessageId: string,
): Message {
  return {
    id,
    conversationId: CONVERSATION_ID,
    conversationSequence,
    version: 1,
    clientMessageId,
    authorId,
    threadRootId: null,
    body: authorId === USER_ID ? "Mine" : "Theirs",
    bodyFormat: "hmm_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const peerMessage = message(PEER_MESSAGE_ID, PEER_ID, "1", PEER_CLIENT_MESSAGE_ID);
const ownMessage = message(OWN_MESSAGE_ID, USER_ID, "2", OWN_CLIENT_MESSAGE_ID);

/** A peer's event whose workspace sequence is below the sequence a send response reports. */
const peerEvent: WorkspaceEvent = {
  version: 1,
  id: PEER_EVENT_ID,
  type: "message.created",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  workspaceSequence: "11",
  conversationSequence: "1",
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { message: peerMessage, mentionedUserIds: [] },
};

/**
 * The server sends this on every socket whose first flush drains, including one it goes on to
 * answer with `system.resync_required` from a later flush, so a healthy handshake proves nothing
 * about the cursor holding up.
 */
function connectedAt(workspaceSequence: string): ProductRealtimeEvent {
  return {
    version: 1,
    id: CONNECTED_EVENT_ID,
    type: "system.connected",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: null,
    workspaceSequence,
    conversationSequence: null,
    entityVersion: 1,
    delivery: "at_least_once",
    payload: { connectionId: CONNECTION_ID, userId: USER_ID },
  };
}

const resyncRequired: ProductRealtimeEvent = {
  version: 1,
  id: RESYNC_EVENT_ID,
  type: "system.resync_required",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: null,
  workspaceSequence: "5",
  conversationSequence: null,
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { reason: "cursor_expired" },
};

type ReplaceSnapshotArgs = Parameters<WorkspaceCache["replaceSnapshot"]>;

/**
 * A hand-written cache that records how often the runtime asks for a full decrypted load, and
 * exposes the sync cursor it has durably accepted.
 */
class FakeWorkspaceCache implements WorkspaceCache {
  readonly mode = "memory_only" as const;
  loadCount = 0;
  #snapshot: CachedWorkspaceState["bootstrap"] = null;
  #syncCursor: string | null = null;
  readonly #messages = new Map<string, Message>();
  readonly #outbox = new Map<string, OutboxItem>();
  readonly #events = new Set<string>();
  upsertFailure: Error | null = null;

  get cursor(): string | null {
    return this.#syncCursor;
  }

  async load(): Promise<CachedWorkspaceState> {
    this.loadCount += 1;
    return {
      bootstrap: this.#snapshot,
      messages: [...this.#messages.values()],
      outbox: [...this.#outbox.values()],
      syncCursor: this.#syncCursor,
      lastSyncedAt: null,
    };
  }

  async replaceSnapshot(...args: ReplaceSnapshotArgs): Promise<void> {
    const [snapshot, messages] = args;
    this.#snapshot = snapshot;
    this.#messages.clear();
    for (const item of messages) this.#messages.set(item.id, item);
    this.#syncCursor = snapshot.syncCursor;
  }

  async upsertConversation(summary: ConversationSummary): Promise<void> {
    if (this.upsertFailure !== null) throw this.upsertFailure;
    if (this.#snapshot === null) return;
    this.#snapshot = {
      ...this.#snapshot,
      conversations: [
        summary,
        ...this.#snapshot.conversations.filter(
          (candidate) => candidate.conversation.id !== summary.conversation.id,
        ),
      ],
    };
  }

  async applyEvent(event: WorkspaceEvent): Promise<boolean> {
    if (this.#events.has(event.id)) return false;
    if (this.#syncCursor !== null && BigInt(event.workspaceSequence) <= BigInt(this.#syncCursor)) {
      return false;
    }
    this.#events.add(event.id);
    this.#syncCursor = event.workspaceSequence;
    if (event.type === "message.created") {
      this.#messages.set(event.payload.message.id, event.payload.message);
      this.#outbox.delete(event.payload.message.clientMessageId);
    }
    return true;
  }

  async advanceCursor(syncCursor: string): Promise<void> {
    if (this.#syncCursor === null || BigInt(syncCursor) > BigInt(this.#syncCursor)) {
      this.#syncCursor = syncCursor;
    }
  }

  async upsertHistory(messages: readonly Message[]): Promise<void> {
    for (const item of messages) this.#messages.set(item.id, item);
  }

  async upsertAcknowledgedMessage(item: Message, syncCursor: string): Promise<void> {
    this.#messages.set(item.id, item);
    this.#outbox.delete(item.clientMessageId);
    await this.advanceCursor(syncCursor);
  }

  async enqueue(operation: SendMessageOperation, createdAt = NOW): Promise<void> {
    const id = operation.message.clientMessageId;
    if (this.#outbox.has(id)) return;
    this.#outbox.set(id, {
      operation,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
  }

  async updateOutbox(...args: Parameters<WorkspaceCache["updateOutbox"]>): Promise<void> {
    const [clientMessageId, update] = args;
    const current = this.#outbox.get(clientMessageId);
    if (current !== undefined) this.#outbox.set(clientMessageId, { ...current, ...update });
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    this.#outbox.delete(clientMessageId);
  }

  async clearServerStatePreservingOutbox(): Promise<void> {
    this.#snapshot = null;
    this.#messages.clear();
    this.#events.clear();
    this.#syncCursor = null;
  }

  async clearAll(): Promise<void> {
    await this.clearServerStatePreservingOutbox();
    this.#outbox.clear();
  }
}

class FakeDesktopApi implements DesktopApi {
  readonly platform: DesktopPlatform = "darwin";
  bootstrap: WorkspaceBootstrapResponse;
  cryptoStatus: CacheCryptoStatus = {
    mode: "memory_only",
    scope,
    reason: "credential_store_unavailable",
  };
  bootstrapRequests = 0;
  stopRequests = 0;
  /** How many upcoming bootstrap requests fail, standing in for a server still coming back up. */
  bootstrapFailures = 0;
  /** When set, every handshake is answered with a resync demand, as an unusable cursor is. */
  resyncOnStart = false;
  /** When set, every handshake reports itself live first, exactly as the real server does. */
  connectedOnStart = false;
  readonly conversationPages = new Map<string, ListConversationsResponse>();
  readonly histories = new Map<string, MessageHistoryResponse>();
  readonly syncResults: SyncAttemptResult[] = [];
  readonly sendResults: SendAttemptResult[] = [];
  readonly channelResults: (
    ConversationMutationResponse | Promise<ConversationMutationResponse>
  )[] = [];
  readonly startedCursors: string[] = [];
  readonly acknowledged: string[] = [];
  readonly sent: SendMessageOperation[] = [];
  readonly createdChannels: CreateChannelRequest[] = [];
  readonly syncedFrom: string[] = [];
  readonly listedAfter: (string | undefined)[] = [];
  readonly historyRequests: string[] = [];
  readonly searchResults: MessageSearchResponse[] = [];
  readonly searchRequests: MessageSearchQuery[] = [];
  readonly #eventListeners = new Set<(event: ProductRealtimeEvent) => void>();
  readonly #connectionListeners = new Set<(state: RealtimeConnectionState) => void>();
  readonly #sessionListeners = new Set<(state: ChatSessionState) => void>();
  readonly #notificationListeners = new Set<(action: NotificationAction) => void>();

  constructor(bootstrap: WorkspaceBootstrapResponse) {
    this.bootstrap = bootstrap;
  }

  emitWorkspaceEvent(event: ProductRealtimeEvent): void {
    for (const listener of this.#eventListeners) listener(event);
  }

  emitRealtimeState(state: RealtimeConnectionState): void {
    for (const listener of this.#connectionListeners) listener(state);
  }

  emitSessionState(state: ChatSessionState): void {
    for (const listener of this.#sessionListeners) listener(state);
  }

  emitNotificationAction(action: NotificationAction): void {
    for (const listener of this.#notificationListeners) listener(action);
  }

  async getServerStatus(): Promise<ServerStatus> {
    return "reachable";
  }

  async getSessionState(): Promise<ChatSessionState> {
    return session;
  }

  async requestMagicLink(): Promise<MagicLinkDeliveryState> {
    return { status: "email-sent" };
  }

  async signOut(): Promise<ChatSessionState> {
    return { status: "signed-out" };
  }

  onSessionChanged(listener: (state: ChatSessionState) => void): () => void {
    this.#sessionListeners.add(listener);
    return () => this.#sessionListeners.delete(listener);
  }

  async getAppVersion(): Promise<string> {
    return "0.0.0-test";
  }

  // The updater belongs to the app shell, not the workspace runtime. These throw so that a runtime
  // that starts reaching for them fails loudly here instead of silently observing a no-op updater.
  async getUpdateState(): Promise<UpdateState> {
    throw new Error("The runtime test does not report update state");
  }

  async checkForUpdates(): Promise<void> {
    throw new Error("The runtime test does not check for updates");
  }

  async restartToInstallUpdate(): Promise<void> {
    throw new Error("The runtime test does not install updates");
  }

  onUpdateStateChanged(): () => void {
    throw new Error("The runtime test does not observe update state");
  }

  onNotificationAction(listener: (action: NotificationAction) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  async initializeCacheCrypto(): Promise<CacheCryptoStatus> {
    return this.cryptoStatus;
  }

  async encryptCacheRecords(): Promise<CacheEncryptBatchResponse> {
    throw new Error("The runtime test cache does not encrypt records");
  }

  async decryptCacheRecords(): Promise<CacheDecryptBatchResponse> {
    throw new Error("The runtime test cache does not decrypt records");
  }

  async resetCacheCrypto(): Promise<void> {
    this.cryptoStatus = { mode: "memory_only", scope, reason: "credential_store_unavailable" };
  }

  async getWorkspaceBootstrap(): Promise<WorkspaceBootstrapResponse> {
    this.bootstrapRequests += 1;
    if (this.bootstrapFailures > 0) {
      this.bootstrapFailures -= 1;
      throw new Error("The workspace is temporarily unavailable");
    }
    return this.bootstrap;
  }

  async listConversations(
    input: Partial<ListConversationsQuery> = {},
  ): Promise<ListConversationsResponse> {
    this.listedAfter.push(input.after);
    return (
      this.conversationPages.get(input.after ?? "") ?? {
        conversations: [],
        nextCursor: null,
        hasMore: false,
      }
    );
  }

  async getConversationMessages(input: {
    readonly conversationId: string;
  }): Promise<MessageHistoryResponse> {
    this.historyRequests.push(input.conversationId);
    return this.histories.get(input.conversationId) ?? { messages: [], nextCursor: null };
  }

  async searchMessages(input: MessageSearchQuery): Promise<MessageSearchResponse> {
    this.searchRequests.push(input);
    const response = this.searchResults.shift();
    if (response === undefined) throw new Error("The test queued no search result");
    return response;
  }

  async sendConversationMessage(input: SendMessageOperation): Promise<SendAttemptResult> {
    this.sent.push(input);
    const result = this.sendResults.shift();
    if (result === undefined) throw new Error("The test queued no send result");
    if (result.status !== "accepted") return result;
    // The real server echoes the client message id it was sent.
    return {
      status: "accepted",
      response: {
        ...result.response,
        message: { ...result.response.message, clientMessageId: input.message.clientMessageId },
      },
    };
  }

  async createChannel(input: CreateChannelRequest): Promise<ConversationMutationResponse> {
    this.createdChannels.push(input);
    const result = this.channelResults.shift();
    if (result === undefined) throw new Error("The test queued no channel result");
    return await result;
  }

  async archiveChannel(): Promise<ConversationMutationResponse> {
    throw new Error("The runtime test does not archive channels");
  }

  async getChannelMembers(): Promise<ChannelMembersResponse> {
    throw new Error("The runtime test does not list channel members");
  }

  async upsertChannelMember(): Promise<ChannelMembershipMutationResponse> {
    throw new Error("The runtime test does not update channel members");
  }

  async removeChannelMember(): Promise<ChannelMembershipMutationResponse> {
    throw new Error("The runtime test does not remove channel members");
  }

  async createDirectConversation(): Promise<ConversationMutationResponse> {
    throw new Error("The runtime test does not create direct conversations");
  }

  async advanceReadCursor(
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    return {
      readCursor: {
        conversationId,
        userId: USER_ID,
        lastReadMessageId,
        lastReadConversationSequence: "1",
        lastReadAt: NOW,
        updatedAt: NOW,
      },
      syncCursor: "1",
    };
  }

  async syncWorkspace(after: string): Promise<SyncAttemptResult> {
    this.syncedFrom.push(after);
    return (
      this.syncResults.shift() ?? {
        status: "accepted",
        response: {
          events: [],
          nextCursor: after,
          highWaterCursor: after,
          hasMore: false,
        },
      }
    );
  }

  async startWorkspaceRealtime(after: string): Promise<void> {
    this.startedCursors.push(after);
    // The real server reports the connection live once its first flush drains and sends the resync
    // demand from a later flush on that same socket, then closes it, so the client sees both.
    if (this.connectedOnStart) this.emitWorkspaceEvent(connectedAt(after));
    if (this.resyncOnStart) this.emitWorkspaceEvent(resyncRequired);
  }

  async stopWorkspaceRealtime(): Promise<void> {
    this.stopRequests += 1;
  }

  async acknowledgeWorkspaceEvent(cursor: string): Promise<void> {
    this.acknowledged.push(cursor);
  }

  async getRealtimeState(): Promise<RealtimeConnectionState> {
    return "offline";
  }

  onRealtimeStateChanged(listener: (state: RealtimeConnectionState) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  onWorkspaceEvent(listener: (event: ProductRealtimeEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }
}

/** Drains the runtime's promise chains without depending on real or fake timers. */
async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
}

function runtimeWith(api: FakeDesktopApi, cache: WorkspaceCache): WorkspaceRuntime {
  return new WorkspaceRuntime(api, { createCache: () => cache });
}

describe("WorkspaceRuntime", () => {
  it("restarts realtime with the cursor a resync established, and does not loop", async () => {
    const api = new FakeDesktopApi(bootstrapAt("5"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    expect(api.startedCursors).toEqual(["5"]);
    expect(api.bootstrapRequests).toBe(1);

    // The server restored the workspace: the client cursor is unusable and the socket is closed.
    api.bootstrap = bootstrapAt("40");
    api.emitWorkspaceEvent(resyncRequired);
    await settle(() => api.startedCursors.length === 2, "realtime restart after resync");

    expect(api.stopRequests).toBe(1);
    expect(api.startedCursors).toEqual(["5", "40"]);
    expect(api.bootstrapRequests).toBe(2);
    expect(cache.cursor).toBe("40");
    // One resync must not turn into a repeating download of the whole workspace.
    await drain();
    expect(api.bootstrapRequests).toBe(2);
    expect(api.startedCursors).toEqual(["5", "40"]);
  });

  it("bounds a resync chain whose handshakes each report the connection live", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("5"));
      // A restored workspace whose cursor sits below the oldest retained event answers every
      // handshake this way: the socket comes up live and the demand follows from a later flush, so
      // `system.connected` says nothing about the cursor and cannot end the chain.
      api.connectedOnStart = true;
      api.resyncOnStart = true;
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);
      await settle(() => api.bootstrapRequests === 2, "first resync download");

      // The repeat waits for a backoff instead of re-downloading as fast as the server rejects it.
      await drain();
      expect(api.bootstrapRequests).toBe(2);

      for (let round = 0; round < 12 && runtime.state.error === null; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
      }
      const downloads = api.bootstrapRequests;
      expect(runtime.state.error).toBe(
        "The server keeps asking this device to resync. Reset the local cache.",
      );
      expect(runtime.state.stale).toBe(true);
      // Bounded: a handful of downloads, then the dead end is reported instead of retried.
      expect(downloads).toBeLessThanOrEqual(4);

      for (let round = 0; round < 4; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
      }
      expect(api.bootstrapRequests).toBe(downloads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a resync whose download failed instead of wedging the client", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("5"));
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);

      // One genuine demand, then a server that is briefly unavailable: a 502 for a few seconds is
      // not a server demanding resyncs, and it must not spend a budget meant for that.
      api.bootstrap = bootstrapAt("40");
      api.bootstrapFailures = 3;
      api.emitWorkspaceEvent(resyncRequired);
      await settle(() => runtime.state.error !== null, "failed resync surfaces");

      // The notice is the failure that happened, not a resync loop the server never asked for.
      expect(runtime.state.error).toBe("The workspace is temporarily unavailable");
      // Realtime is stopped and the cached workspace is gone, so only the retry can heal this.
      expect(api.startedCursors).toEqual(["5"]);

      for (let round = 0; round < 6 && api.startedCursors.length === 1; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await drain();
      }
      expect(api.startedCursors).toEqual(["5", "40"]);
      expect(runtime.state.error).toBeNull();
      expect(runtime.state.stale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies an in-flight lower-sequence peer event after a send is accepted", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);

    // The send is allocated workspace sequence 12 while a peer's event 11 is still in flight.
    api.sendResults.push({
      status: "accepted",
      response: { message: ownMessage, syncCursor: "12" },
    });
    await runtime.sendMessage(CONVERSATION_ID, "Mine", []);
    await settle(() => runtime.state.outbox.length === 0, "send acknowledgement");

    expect(cache.cursor).toBe("10");
    expect(api.acknowledged).not.toContain("12");

    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((item) => item.id === PEER_MESSAGE_ID),
      "peer message application",
    );

    const ids = runtime.state.messages.map((item) => item.id);
    expect(ids).toContain(PEER_MESSAGE_ID);
    expect(ids).toContain(OWN_MESSAGE_ID);
    expect(runtime.state.bootstrap?.conversations[0]?.unreadCount).toBe(1);
  });

  it("projects and selects a created channel without refreshing or skipping earlier events", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const bootstrapRequestsAfterStart = api.bootstrapRequests;
    const historyRequestsAfterStart = api.historyRequests.length;
    const createdSummary = channel(CREATED_CHANNEL_ID, "alpha-team");
    api.channelResults.push({
      conversation: {
        ...createdSummary,
        conversation: { ...createdSummary.conversation, name: "Alpha Team" },
      },
      syncCursor: "12",
    });

    await runtime.createChannel("Alpha Team", "alpha-team", "workspace");

    expect(api.createdChannels).toEqual([
      { name: "Alpha Team", slug: "alpha-team", topic: null, access: "workspace" },
    ]);
    expect(api.bootstrapRequests).toBe(bootstrapRequestsAfterStart);
    expect(api.historyRequests).toHaveLength(historyRequestsAfterStart);
    expect(runtime.state.selectedConversationId).toBe(CREATED_CHANNEL_ID);
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.slug)).toEqual([
      "alpha-team",
      "general",
    ]);
    expect(
      (await cache.load()).bootstrap?.conversations.map((item) => item.conversation.slug),
    ).toContain("alpha-team");
    await runtime.loadOlder(CREATED_CHANNEL_ID);
    expect(api.historyRequests).toHaveLength(historyRequestsAfterStart);

    // The mutation's cursor is a high-water mark, not proof that every earlier event is cached.
    expect(cache.cursor).toBe("10");
    expect(api.acknowledged).not.toContain("12");
    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((item) => item.id === PEER_MESSAGE_ID),
      "earlier peer event after channel creation",
    );
    expect(runtime.state.messages.map((item) => item.id)).toContain(PEER_MESSAGE_ID);
  });

  it("rejects channel creation before bootstrap without contacting the server", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());

    await expect(runtime.createChannel("Too Soon", "too-soon", "members")).rejects.toThrow(
      "Workspace is still loading",
    );
    expect(api.createdChannels).toEqual([]);
  });

  it("does not project a successful mutation into a replacement session", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    let resolveResult: ((result: ConversationMutationResponse) => void) | undefined;
    api.channelResults.push(
      new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const creation = runtime.createChannel("Alpha Team", "alpha-team", "workspace");
    await settle(() => api.createdChannels.length === 1, "channel request");
    await runtime.stop();
    const createdSummary = channel(CREATED_CHANNEL_ID, "alpha-team");
    resolveResult?.({ conversation: createdSummary, syncCursor: "12" });

    await expect(creation).resolves.toBeUndefined();
    expect(runtime.state.bootstrap).toBeNull();
  });

  it("keeps a server-created channel selected when its cache write fails", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    cache.upsertFailure = new Error("disk full");
    const createdSummary = channel(CREATED_CHANNEL_ID, "alpha-team");
    api.channelResults.push({ conversation: createdSummary, syncCursor: "12" });

    await expect(
      runtime.createChannel("Alpha Team", "alpha-team", "workspace"),
    ).resolves.toBeUndefined();
    expect(runtime.state.selectedConversationId).toBe(CREATED_CHANNEL_ID);
    expect(runtime.state.bootstrap?.conversations).toContainEqual(createdSummary);
    expect(runtime.state.stale).toBe(true);
    expect(runtime.state.error).toMatch(/local cache needs repair/);
    expect(cache.cursor).toBe("10");
  });

  it("rearms the retry timer so a retryable send is redelivered with no user action", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      const cache = new FakeWorkspaceCache();
      const runtime = runtimeWith(api, cache);
      await runtime.start(session);
      api.sendResults.push({ status: "retryable", reason: "network", retryAfterMs: 5_000 });
      api.sendResults.push({
        status: "accepted",
        response: { message: ownMessage, syncCursor: "11" },
      });

      await runtime.sendMessage(CONVERSATION_ID, "Mine", []);
      await settle(() => runtime.state.outbox[0]?.status === "retry_wait", "retry wait");
      expect(api.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await settle(() => api.sent.length === 2, "automatic redelivery");
      expect(runtime.state.outbox).toEqual([]);
      expect(runtime.state.messages.map((item) => item.id)).toContain(OWN_MESSAGE_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a realtime event without reloading the whole decrypted cache", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const loadsAfterStart = cache.loadCount;

    api.emitWorkspaceEvent(peerEvent);
    await settle(
      () => runtime.state.messages.some((item) => item.id === PEER_MESSAGE_ID),
      "peer message application",
    );

    expect(cache.loadCount).toBe(loadsAfterStart);
    expect((await cache.load()).messages.map((item) => item.id)).toContain(PEER_MESSAGE_ID);
  });

  it("opens a search hit in the main timeline and clears the focus on normal navigation", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    const searchHit: Message = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000014",
      clientMessageId: "20000000-0000-4000-8000-000000000015",
      body: "Quarterly avalanche review",
      conversationSequence: "3",
    };
    api.searchResults.push({ results: [{ message: searchHit }], nextCursor: null });

    const response = await runtime.searchMessages("quarterly avalanche");
    expect(api.searchRequests).toEqual([{ query: "quarterly avalanche", limit: 25 }]);
    const firstResult = response.results[0];
    if (firstResult === undefined) throw new Error("Expected a search result");
    await runtime.openSearchResult(firstResult);

    expect(runtime.state.selectedConversationId).toBe(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBe(searchHit.id);
    expect(runtime.state.messages).toContainEqual(searchHit);
    expect((await cache.load()).messages).toContainEqual(searchHit);

    runtime.selectConversation(CONVERSATION_ID);
    expect(runtime.state.focusedMessageId).toBeNull();
  });

  it("orders a peer-created conversation the way a cold load would", async () => {
    const alphaId = "20000000-0000-4000-8000-000000000010";
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000000e",
      type: "channel.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: alphaId,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { conversation: channel(alphaId, "alpha").conversation, participantIds: [] },
    });
    await settle(
      () => runtime.state.bootstrap?.conversations.length === 2,
      "peer channel application",
    );

    // "alpha" sorts before "general", so appending it renders it last in the sidebar until the next
    // full reload silently moves it.
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.slug)).toEqual([
      "alpha",
      "general",
    ]);
  });

  it("purges a removed member's private channel, history, and active selection", async () => {
    const privateSummary: ConversationSummary = {
      ...channel(SECOND_CONVERSATION_ID, "leadership"),
      conversation: {
        ...channel(SECOND_CONVERSATION_ID, "leadership").conversation,
        access: "members",
      },
      participantIds: [USER_ID],
      membershipRole: "owner",
    };
    const api = new FakeDesktopApi(
      bootstrapAt("10", {
        conversations: [channel(CONVERSATION_ID, "general"), privateSummary],
      }),
    );
    const privateMessage = {
      ...peerMessage,
      id: "20000000-0000-4000-8000-000000000012",
      conversationId: SECOND_CONVERSATION_ID,
    };
    api.histories.set(SECOND_CONVERSATION_ID, {
      messages: [privateMessage],
      nextCursor: null,
    });
    const cache = new FakeWorkspaceCache();
    const runtime = runtimeWith(api, cache);
    await runtime.start(session);
    runtime.selectConversation(SECOND_CONVERSATION_ID);
    expect(runtime.state.messages).toContainEqual(privateMessage);

    api.bootstrap = bootstrapAt("11");
    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-000000000013",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: SECOND_CONVERSATION_ID,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: USER_ID, action: "removed" },
    });

    await settle(
      () => runtime.state.selectedConversationId === CONVERSATION_ID,
      "membership removal refresh",
    );
    expect(runtime.state.bootstrap?.conversations).toHaveLength(1);
    expect(runtime.state.messages).not.toContainEqual(privateMessage);
    expect((await cache.load()).messages).not.toContainEqual(privateMessage);
    expect(api.acknowledged).toContain("11");
  });

  it("orders a newly delivered member the way a cold load would", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    api.emitWorkspaceEvent({
      version: 1,
      id: "20000000-0000-4000-8000-00000000000f",
      type: "member.updated",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: null,
      workspaceSequence: "11",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: {
        member: {
          id: "20000000-0000-4000-8000-000000000011",
          username: "alice",
          displayName: "Alice",
          avatarUrl: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    });
    await settle(() => runtime.state.bootstrap?.members.length === 2, "member application");

    expect(runtime.state.bootstrap?.members.map((item) => item.displayName)).toEqual([
      "Alice",
      "Morgan",
    ]);
  });

  it("pages conversations that the bootstrap response could not carry", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [channel(SECOND_CONVERSATION_ID, "second")],
      nextCursor: null,
      hasMore: false,
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    expect(api.listedAfter).toEqual([NEXT_PAGE_CURSOR]);
    expect(runtime.state.bootstrap?.conversations.map((item) => item.conversation.id)).toEqual([
      CONVERSATION_ID,
      SECOND_CONVERSATION_ID,
    ]);
  });

  it("stops paging when the server claims more conversations without advancing", async () => {
    const api = new FakeDesktopApi(
      bootstrapAt("10", { conversationsNextCursor: NEXT_PAGE_CURSOR, conversationsHasMore: true }),
    );
    api.conversationPages.set(NEXT_PAGE_CURSOR, {
      conversations: [channel(SECOND_CONVERSATION_ID, "second")],
      nextCursor: NEXT_PAGE_CURSOR,
      hasMore: true,
    });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    expect(api.listedAfter).toEqual([NEXT_PAGE_CURSOR]);
    expect(runtime.state.bootstrap?.conversations).toHaveLength(2);
  });

  it("surfaces a permanent sync failure instead of silently going stale", async () => {
    const api = new FakeDesktopApi(bootstrapAt("10"));
    api.syncResults.push({ status: "permanent", reason: "forbidden" });
    const runtime = runtimeWith(api, new FakeWorkspaceCache());
    await runtime.start(session);

    expect(runtime.state.error).toBe("This device is no longer allowed to sync this workspace.");
    expect(runtime.state.stale).toBe(true);
  });

  it("retries a retryable sync after the server's Retry-After delay", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeDesktopApi(bootstrapAt("10"));
      api.syncResults.push({ status: "retryable", reason: "server", retryAfterMs: 2_000 });
      const runtime = runtimeWith(api, new FakeWorkspaceCache());
      await runtime.start(session);
      expect(api.syncedFrom).toEqual(["10"]);
      expect(runtime.state.stale).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await settle(() => api.syncedFrom.length === 2, "scheduled sync retry");
      expect(runtime.state.stale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
