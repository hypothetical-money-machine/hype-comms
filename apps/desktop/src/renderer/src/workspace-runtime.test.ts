import { describe, expect, it, vi } from "vitest";

import type {
  AdvanceReadCursorResponse,
  CacheCryptoStatus,
  CacheDecryptBatchResponse,
  CacheEncryptBatchResponse,
  CacheScope,
  ChatSessionState,
  ConversationMutationResponse,
  ConversationSummary,
  ListConversationsQuery,
  ListConversationsResponse,
  MagicLinkDeliveryState,
  Message,
  MessageHistoryResponse,
  ProductRealtimeEvent,
  RealtimeConnectionState,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
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
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [],
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
  readonly conversationPages = new Map<string, ListConversationsResponse>();
  readonly histories = new Map<string, MessageHistoryResponse>();
  readonly syncResults: SyncAttemptResult[] = [];
  readonly sendResults: SendAttemptResult[] = [];
  readonly startedCursors: string[] = [];
  readonly acknowledged: string[] = [];
  readonly sent: SendMessageOperation[] = [];
  readonly syncedFrom: string[] = [];
  readonly listedAfter: (string | undefined)[] = [];
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
    return this.histories.get(input.conversationId) ?? { messages: [], nextCursor: null };
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

  async createChannel(): Promise<ConversationMutationResponse> {
    throw new Error("The runtime test does not create channels");
  }

  async archiveChannel(): Promise<ConversationMutationResponse> {
    throw new Error("The runtime test does not archive channels");
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
