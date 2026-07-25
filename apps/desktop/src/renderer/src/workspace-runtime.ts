import {
  sendMessageOperationSchema,
  type CacheScope,
  type ChatSessionState,
  type ConversationSummary,
  type Message,
  type ProductRealtimeEvent,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hmm-chat/contracts";

import type { DesktopApi, RealtimeConnectionState } from "../../shared/desktop-api";
import {
  clearPersistentWorkspaceCaches,
  MemoryWorkspaceCache,
  PersistentWorkspaceCache,
  type OutboxItem,
  type WorkspaceCache,
} from "./workspace-cache";

export interface WorkspaceRuntimeState {
  readonly bootstrap: WorkspaceBootstrapResponse | null;
  readonly messages: readonly Message[];
  readonly outbox: readonly OutboxItem[];
  readonly selectedConversationId: string | null;
  readonly connection: RealtimeConnectionState;
  readonly cacheMode: "persistent" | "memory_only" | null;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}

const INITIAL_STATE: WorkspaceRuntimeState = {
  bootstrap: null,
  messages: [],
  outbox: [],
  selectedConversationId: null,
  connection: "offline",
  cacheMode: null,
  stale: true,
  busy: false,
  error: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function firstConversation(bootstrap: WorkspaceBootstrapResponse): string | null {
  return (
    bootstrap.conversations.find(
      (summary) =>
        summary.conversation.kind === "channel" && summary.conversation.slug === "general",
    )?.conversation.id ??
    bootstrap.conversations[0]?.conversation.id ??
    null
  );
}

function retryDelay(attempt: number): number {
  const maximum = Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
  return Math.floor(Math.random() * maximum);
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
  #state = INITIAL_STATE;
  #cache: WorkspaceCache | null = null;
  #generation = 0;
  #flushing = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #eventQueue: Promise<void> = Promise.resolve();
  readonly #historyCursors = new Map<string, string | null>();
  #unsubscribeEvent: (() => void) | null = null;
  #unsubscribeConnection: (() => void) | null = null;

  constructor(client: DesktopApi) {
    this.#client = client;
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
    try {
      const cryptoStatus = await this.#client.initializeCacheCrypto(scope);
      this.#cache =
        cryptoStatus.mode === "persistent"
          ? new PersistentWorkspaceCache({ crypto: this.#client, scope })
          : new MemoryWorkspaceCache();
      const cached = await this.#cache.load();
      if (generation !== this.#generation) return;
      this.#setState({
        bootstrap: cached.bootstrap,
        messages: cached.messages,
        outbox: cached.outbox,
        selectedConversationId:
          this.#state.selectedConversationId ??
          (cached.bootstrap === null ? null : firstConversation(cached.bootstrap)),
        cacheMode: cryptoStatus.mode,
        stale: true,
      });

      await this.#refreshSnapshot(generation);
      if (generation !== this.#generation || this.#cache === null) return;
      await this.#repairAndFlush(generation);
      const loaded = await this.#cache.load();
      await this.#client.startWorkspaceRealtime(loaded.syncCursor ?? "0");
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
    this.#unsubscribeEvent?.();
    this.#unsubscribeConnection?.();
    this.#unsubscribeEvent = null;
    this.#unsubscribeConnection = null;
    await this.#client.stopWorkspaceRealtime();
    this.#cache = null;
    this.#state = INITIAL_STATE;
    for (const listener of this.#listeners) listener(this.#state);
  }

  selectConversation(conversationId: string): void {
    this.#setState({ selectedConversationId: conversationId });
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
    await cache.enqueue(operation);
    await this.#reloadCache();
    void this.#flushOutbox(this.#generation);
  }

  async retryMessage(clientMessageId: string): Promise<void> {
    await this.#cache?.updateOutbox(clientMessageId, {
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
    await this.#reloadCache();
    void this.#flushOutbox(this.#generation);
  }

  async discardMessage(clientMessageId: string): Promise<void> {
    await this.#cache?.removeOutbox(clientMessageId);
    await this.#reloadCache();
  }

  async createChannel(name: string, slug: string): Promise<void> {
    await this.#client.createChannel({ name, slug, topic: null });
    await this.#refreshSnapshot(this.#generation);
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
    await this.#reloadCache();
  }

  hasOlder(conversationId: string): boolean {
    return this.#historyCursors.get(conversationId) !== null;
  }

  async resetLocalCache(): Promise<void> {
    await this.#client.stopWorkspaceRealtime();
    await this.#cache?.clearAll().catch(() => undefined);
    await clearPersistentWorkspaceCaches();
    await this.#client.resetCacheCrypto();
    this.#cache = null;
    this.#setState({ ...INITIAL_STATE, error: "Local cache reset. Sign in again to rebuild it." });
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

  async #refreshSnapshot(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null) return;
    const bootstrap = await this.#client.getWorkspaceBootstrap();
    const messages: Message[] = [];
    this.#historyCursors.clear();
    for (const summary of bootstrap.conversations) {
      const history = await this.#client.getConversationMessages({
        conversationId: summary.conversation.id,
        limit: 50,
      });
      this.#historyCursors.set(summary.conversation.id, history.nextCursor);
      messages.push(...history.messages);
    }
    if (generation !== this.#generation) return;
    await cache.replaceSnapshot(bootstrap, messages);
    const loaded = await cache.load();
    this.#setState({
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      outbox: loaded.outbox,
      selectedConversationId: this.#state.selectedConversationId ?? firstConversation(bootstrap),
      stale: false,
      error: null,
    });
  }

  async #repairAndFlush(generation: number): Promise<void> {
    const cache = this.#cache;
    if (cache === null || generation !== this.#generation) return;
    let state = await cache.load();
    let cursor = state.syncCursor ?? "0";
    for (;;) {
      const result = await this.#client.syncWorkspace(cursor);
      if (generation !== this.#generation) return;
      if (result.status === "authentication_required") return;
      if (result.status === "retryable") {
        this.#setState({ stale: true });
        return;
      }
      if (result.status === "reset_required") {
        await cache.clearServerStatePreservingOutbox();
        await this.#refreshSnapshot(generation);
        state = await cache.load();
        cursor = state.syncCursor ?? "0";
        continue;
      }
      for (const event of result.response.events) await cache.applyEvent(event);
      await cache.advanceCursor(result.response.nextCursor);
      await this.#client.acknowledgeWorkspaceEvent(result.response.nextCursor);
      cursor = result.response.nextCursor;
      if (!result.response.hasMore) break;
    }
    await this.#reloadCache();
    this.#setState({ stale: false });
    await this.#flushOutbox(generation);
  }

  async #handleRealtimeEvent(event: ProductRealtimeEvent, generation: number): Promise<void> {
    if (generation !== this.#generation || this.#cache === null) return;
    if (event.type === "system.connected") {
      await this.#cache.advanceCursor(event.workspaceSequence);
      await this.#client.acknowledgeWorkspaceEvent(event.workspaceSequence);
      this.#setState({ connection: "live" });
      return;
    }
    if (event.type === "system.resync_required") {
      await this.#cache.clearServerStatePreservingOutbox();
      await this.#refreshSnapshot(generation);
      return;
    }
    await this.#applyWorkspaceEvent(event);
  }

  async #applyWorkspaceEvent(event: WorkspaceEvent): Promise<void> {
    if (this.#cache === null) return;
    await this.#cache.applyEvent(event);
    await this.#client.acknowledgeWorkspaceEvent(event.workspaceSequence);
    await this.#reloadCache();
  }

  async #flushOutbox(generation: number): Promise<void> {
    if (this.#flushing || this.#cache === null || generation !== this.#generation) return;
    this.#flushing = true;
    this.#clearRetryTimer();
    try {
      for (;;) {
        const loaded = await this.#cache.load();
        const now = Date.now();
        const next = nextDeliverable(loaded.outbox, now);
        if (next === undefined) {
          this.#scheduleNextRetry(loaded.outbox, generation);
          break;
        }
        const id = next.operation.message.clientMessageId;
        const attempt = next.attemptCount + 1;
        await this.#cache.updateOutbox(id, {
          status: "sending",
          attemptCount: attempt,
          nextAttemptAt: null,
          failureReason: null,
        });
        await this.#reloadCache();
        const result = await this.#client.sendConversationMessage(next.operation);
        if (generation !== this.#generation) return;
        if (result.status === "accepted") {
          await this.#cache.upsertAcknowledgedMessage(
            result.response.message,
            result.response.syncCursor,
          );
          await this.#client.acknowledgeWorkspaceEvent(result.response.syncCursor);
          await this.#reloadCache();
          continue;
        }
        if (result.status === "authentication_required") {
          await this.#cache.updateOutbox(id, {
            status: "paused_auth",
            attemptCount: attempt,
            nextAttemptAt: null,
            failureReason: "Sign in to retry",
          });
          break;
        }
        if (result.status === "permanent") {
          await this.#cache.updateOutbox(id, {
            status: "permanent_failure",
            attemptCount: attempt,
            nextAttemptAt: null,
            failureReason: result.reason,
          });
          continue;
        }
        const delay = result.retryAfterMs ?? retryDelay(attempt);
        await this.#cache.updateOutbox(id, {
          status: "retry_wait",
          attemptCount: attempt,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          failureReason: result.reason,
        });
        break;
      }
    } finally {
      this.#flushing = false;
      await this.#reloadCache();
    }
  }

  async #reloadCache(): Promise<void> {
    if (this.#cache === null) return;
    const loaded = await this.#cache.load();
    this.#setState({
      bootstrap: loaded.bootstrap,
      messages: loaded.messages,
      outbox: loaded.outbox,
    });
  }

  #scheduleNextRetry(outbox: readonly OutboxItem[], generation: number): void {
    const times = firstItemsByConversation(outbox)
      .filter((item) => item.status === "retry_wait" && item.nextAttemptAt !== null)
      .map((item) => Date.parse(item.nextAttemptAt as string))
      .filter(Number.isFinite);
    const next = times.length === 0 ? undefined : Math.min(...times);
    if (next === undefined) return;
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
}
