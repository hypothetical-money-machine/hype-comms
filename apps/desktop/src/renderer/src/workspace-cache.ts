import Dexie, { type Table } from "dexie";

import {
  conversationSummarySchema,
  messageSchema,
  reactionSchema,
  sendMessageOperationSchema,
  taskSchema,
  userSchema,
  workspaceEventSchema,
  workspaceSnapshotSchema,
  type CacheCiphertext,
  type CacheCryptoStatus,
  type CacheDecryptBatchRequest,
  type CacheDecryptBatchResponse,
  type CacheEncryptBatchRequest,
  type CacheEncryptBatchResponse,
  type CacheScope,
  type ConversationSummary,
  type Message,
  type Reaction,
  type SendMessageOperation,
  type Task,
  type User,
  type HumanWorkspaceBootstrapResponse,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hmm-chat/contracts";

const CACHE_SCHEMA_VERSION = 1 as const;
const CACHE_DATABASE_PREFIX = "hmm-chat-cache-v2-";
const MAX_ACKNOWLEDGED_MESSAGES = 20_000;
const MAX_MESSAGE_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
/**
 * Mirrors `workspaceSnapshotSchema.members`, which is `z.array(userSchema).max(25)`. `load()`
 * parses through that schema, so a cached list above this bound is not a stale read — it is a
 * client that can never start again.
 */
const MAX_CACHED_MEMBERS = 25;

export type OutboxStatus =
  "pending" | "sending" | "retry_wait" | "paused_auth" | "permanent_failure";

export interface OutboxItem {
  readonly operation: SendMessageOperation;
  readonly createdAt: string;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly failureReason: string | null;
}

export interface CachedWorkspaceState {
  /**
   * The aggregate client snapshot, not a bootstrap response: the cache holds every conversation
   * page the client has fetched, so page cursors have no meaning once state is cached.
   */
  readonly bootstrap: WorkspaceSnapshot | null;
  readonly messages: readonly Message[];
  readonly reactions: readonly Reaction[];
  readonly tasks: readonly Task[];
  readonly outbox: readonly OutboxItem[];
  readonly syncCursor: string | null;
  readonly lastSyncedAt: string | null;
}

export interface WorkspaceCache {
  readonly mode: CacheCryptoStatus["mode"];
  load(): Promise<CachedWorkspaceState>;
  /**
   * Accepts either a bootstrap response or the aggregate client snapshot; only the fields both
   * shapes share are persisted, so a caller that has paged past the first conversation page can
   * hand the aggregate straight in.
   */
  replaceSnapshot(
    snapshot: HumanWorkspaceBootstrapResponse | WorkspaceSnapshot,
    messages: readonly Message[],
    reactions?: readonly Reaction[],
    tasks?: readonly Task[],
  ): Promise<void>;
  /**
   * Replaces the whole member directory with the server's answer to `GET /v1/members`.
   *
   * This is the only writer of the cached member list outside `replaceSnapshot`. `member.updated`
   * deliberately does not write here: its payload is a bare `User` with no status field, so it
   * cannot express a removal, and upserting it would re-assert a member the server just disabled.
   */
  replaceMembers(members: readonly User[]): Promise<void>;
  /** Persists a mutation projection without claiming that its workspace cursor was applied. */
  upsertConversation(summary: ConversationSummary): Promise<void>;
  applyEvent(event: WorkspaceEvent): Promise<boolean>;
  advanceCursor(syncCursor: string): Promise<void>;
  upsertHistory(messages: readonly Message[], reactions?: readonly Reaction[]): Promise<void>;
  /** Projects a mutation response without advancing the workspace event cursor. */
  upsertReaction(reaction: Reaction): Promise<void>;
  /** Projects a mutation response without advancing the workspace event cursor. */
  removeReaction(reactionId: string): Promise<void>;
  /** Persists task list or mutation projections without advancing the workspace event cursor. */
  upsertTasks(tasks: readonly Task[]): Promise<void>;
  upsertAcknowledgedMessage(message: Message, syncCursor: string): Promise<void>;
  enqueue(operation: SendMessageOperation, createdAt?: string): Promise<void>;
  updateOutbox(
    clientMessageId: string,
    update: {
      readonly status: OutboxStatus;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly failureReason: string | null;
    },
  ): Promise<void>;
  removeOutbox(clientMessageId: string): Promise<void>;
  clearServerStatePreservingOutbox(): Promise<void>;
  clearAll(): Promise<void>;
}

interface CacheCryptoClient {
  encryptCacheRecords(input: CacheEncryptBatchRequest): Promise<CacheEncryptBatchResponse>;
  decryptCacheRecords(input: CacheDecryptBatchRequest): Promise<CacheDecryptBatchResponse>;
}

interface MetadataRow {
  readonly id: "state";
  readonly userId: string;
  readonly workspaceId: string;
  readonly syncCursor: string | null;
  readonly lastSyncedAt: string | null;
}

interface WorkspacePayload {
  readonly currentUser: HumanWorkspaceBootstrapResponse["currentUser"];
  readonly workspace: HumanWorkspaceBootstrapResponse["workspace"];
  readonly featureFlags: HumanWorkspaceBootstrapResponse["featureFlags"];
}

interface WorkspaceRow {
  readonly id: string;
  readonly value: CacheCiphertext;
}

interface MemberRow {
  readonly id: string;
  readonly updatedAt: string;
  readonly value: CacheCiphertext;
}

interface ConversationRow {
  readonly id: string;
  readonly kind: "channel" | "direct_message" | "group_direct_message";
  readonly updatedAt: string;
  readonly value: CacheCiphertext;
}

interface MessageRow {
  readonly id: string;
  readonly clientMessageId: string;
  readonly conversationId: string;
  readonly conversationSequence: string;
  readonly createdAt: string;
  readonly value: CacheCiphertext;
}

interface ReactionRow {
  readonly id: string;
  readonly messageId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly value: CacheCiphertext;
}

interface TaskRow {
  readonly id: string;
  readonly conversationId: string;
  readonly assigneeId: string | null;
  readonly status: Task["status"];
  readonly rank: string;
  readonly updatedAt: string;
  readonly value: CacheCiphertext;
}

interface OutboxRow {
  readonly clientMessageId: string;
  readonly conversationId: string;
  readonly createdAt: string;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly failureReason: string | null;
  readonly value: CacheCiphertext;
}

interface EventRow {
  readonly id: string;
  readonly workspaceSequence: string;
}

class WorkspaceCacheDatabase extends Dexie {
  metadata!: Table<MetadataRow, "state">;
  workspaces!: Table<WorkspaceRow, string>;
  members!: Table<MemberRow, string>;
  conversations!: Table<ConversationRow, string>;
  messages!: Table<MessageRow, string>;
  reactions!: Table<ReactionRow, string>;
  tasks!: Table<TaskRow, string>;
  outbox!: Table<OutboxRow, string>;
  events!: Table<EventRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      metadata: "&id",
      workspaces: "&id",
      members: "&id,updatedAt",
      conversations: "&id,kind,updatedAt",
      messages: "&id,&clientMessageId,conversationId,createdAt",
      outbox: "&clientMessageId,conversationId,createdAt,status,nextAttemptAt",
      events: "&id,workspaceSequence",
    });
    // Version 2 only adds the message sequence index, so existing databases upgrade in place and
    // every store not named here carries over from version 1 unchanged.
    this.version(2).stores({
      messages: "&id,&clientMessageId,conversationId,createdAt,conversationSequence",
    });
    this.version(3).stores({
      reactions: "&id,messageId,userId,createdAt",
    });
    this.version(4).stores({
      tasks: "&id,conversationId,assigneeId,status,rank,updatedAt",
    });
  }
}

type ProtectedStore =
  "workspace" | "member" | "conversation" | "message" | "reaction" | "task" | "outbox";

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Sequences are decimal strings, so IndexedDB's lexicographic index order is not the numeric
 * order the UI needs ("10" sorts before "9"). Every read therefore sorts numerically in JS; the
 * stored index exists for lookups, not for ordering.
 */
function compareMessages(left: Message, right: Message): number {
  return compareSequence(left.conversationSequence, right.conversationSequence);
}

function compareReactions(left: Reaction, right: Reaction): number {
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

/**
 * Clamps an over-capacity cached member list down to `workspaceSnapshotSchema.members`'s
 * `.max(25)` bound so the hard `.parse` inside `load()` cannot brick the client. `compareMembers`
 * sorts by displayName then id -- there is no recency signal in that order -- so the truncation
 * this performs is arbitrary, not "the newest complete list": it just drops whatever sorts last.
 * The one row it must never drop is the signed-in user, since losing it breaks author-name
 * rendering everywhere the client attributes its own messages. When the sorted truncation would
 * drop that row, this swaps it back in for the row that would otherwise sort last.
 */
function capCachedMembers(members: readonly User[], currentUserId: string | null): User[] {
  const sorted = [...members].sort(compareMembers);
  if (sorted.length <= MAX_CACHED_MEMBERS) return sorted;
  const capped = sorted.slice(0, MAX_CACHED_MEMBERS);
  if (currentUserId === null || capped.some((member) => member.id === currentUserId)) {
    return capped;
  }
  const currentUser = sorted.find((member) => member.id === currentUserId);
  if (currentUser === undefined) return capped;
  return [...capped.slice(0, -1), currentUser].sort(compareMembers);
}

/**
 * Both cache implementations store rows keyed by ID, which loses the order the server sent. This
 * restores the server's deliberate ordering so the renderer never has to sort, and so the two
 * implementations return identical state for identical input.
 */
function canonicalSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    ...snapshot,
    members: [...snapshot.members].sort(compareMembers),
    conversations: [...snapshot.conversations].sort(compareConversations),
  };
}

/**
 * Reduces a bootstrap response or an aggregate snapshot to the cached snapshot shape. Picking
 * fields explicitly keeps the strict schema happy for both inputs.
 */
function parseSnapshotInput(
  input: HumanWorkspaceBootstrapResponse | WorkspaceSnapshot,
): WorkspaceSnapshot {
  return workspaceSnapshotSchema.parse({
    currentUser: input.currentUser,
    workspace: input.workspace,
    members: input.members,
    conversations: input.conversations,
    syncCursor: input.syncCursor,
    featureFlags: input.featureFlags,
  });
}

function databaseName(scope: CacheScope): string {
  return `${CACHE_DATABASE_PREFIX}${scope.workspaceId}-${scope.userId}`;
}

/**
 * Deletes one member's cached workspace and nothing else. Every scope keeps its own database, and a
 * member who is not signed in can still have an encrypted cache and undelivered outbox on this OS
 * account, so signing out or resetting the local cache must reach only the scope that asked.
 */
export async function clearPersistentWorkspaceCache(scope: CacheScope): Promise<void> {
  await Dexie.delete(databaseName(scope));
}

/**
 * Deletes every scope's cache on this OS account. Test cleanup is what this is for — wiping other
 * members' undelivered messages is data loss anywhere a real member signs out, so product code
 * deletes the signed-in scope with `clearPersistentWorkspaceCache` instead.
 */
export async function clearPersistentWorkspaceCaches(): Promise<void> {
  const names = await Dexie.getDatabaseNames();
  await Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_DATABASE_PREFIX))
      .map((name) => Dexie.delete(name)),
  );
}

function protectedRecord(store: ProtectedStore, recordId: string, value: unknown) {
  return {
    store,
    recordId,
    schemaVersion: CACHE_SCHEMA_VERSION,
    plaintext: JSON.stringify(value),
  } as const;
}

async function encryptRecords(
  crypto: CacheCryptoClient,
  records: readonly ReturnType<typeof protectedRecord>[],
): Promise<Map<string, CacheCiphertext>> {
  const values = new Map<string, CacheCiphertext>();
  for (let offset = 0; offset < records.length; offset += 64) {
    const batch = records.slice(offset, offset + 64);
    if (batch.length === 0) continue;
    const response = await crypto.encryptCacheRecords({ items: batch });
    for (const item of response.items) values.set(`${item.store}:${item.recordId}`, item.value);
  }
  return values;
}

function encryptedValue(
  values: ReadonlyMap<string, CacheCiphertext>,
  store: ProtectedStore,
  id: string,
): CacheCiphertext {
  const value = values.get(`${store}:${id}`);
  if (value === undefined) throw new Error("Cache encryption result is incomplete");
  return value;
}

async function decryptRows<T>(
  crypto: CacheCryptoClient,
  store: ProtectedStore,
  rows: readonly { readonly value: CacheCiphertext }[],
  ids: readonly string[],
  parse: (value: unknown) => T,
): Promise<T[]> {
  const values: T[] = [];
  for (let offset = 0; offset < rows.length; offset += 64) {
    const batch = rows.slice(offset, offset + 64);
    const batchIds = ids.slice(offset, offset + 64);
    if (batch.length === 0) continue;
    const response = await crypto.decryptCacheRecords({
      items: batch.map((row, index) => ({
        store,
        recordId: batchIds[index] ?? "",
        schemaVersion: CACHE_SCHEMA_VERSION,
        value: row.value,
      })),
    });
    for (const item of response.items) values.push(parse(JSON.parse(item.plaintext) as unknown));
  }
  return values;
}

function messageRow(message: Message, encrypted: ReadonlyMap<string, CacheCiphertext>): MessageRow {
  return {
    id: message.id,
    clientMessageId: message.clientMessageId,
    conversationId: message.conversationId,
    conversationSequence: message.conversationSequence,
    createdAt: message.createdAt,
    value: encryptedValue(encrypted, "message", message.id),
  };
}

function reactionRow(
  reaction: Reaction,
  encrypted: ReadonlyMap<string, CacheCiphertext>,
): ReactionRow {
  return {
    id: reaction.id,
    messageId: reaction.messageId,
    userId: reaction.userId,
    createdAt: reaction.createdAt,
    value: encryptedValue(encrypted, "reaction", reaction.id),
  };
}

function taskRow(task: Task, encrypted: ReadonlyMap<string, CacheCiphertext>): TaskRow {
  return {
    id: task.id,
    conversationId: task.conversationId,
    assigneeId: task.assigneeId,
    status: task.status,
    rank: task.rank,
    updatedAt: task.updatedAt,
    value: encryptedValue(encrypted, "task", task.id),
  };
}

function mergeConversationProjection(
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

export class PersistentWorkspaceCache implements WorkspaceCache {
  readonly mode = "persistent" as const;
  readonly #crypto: CacheCryptoClient;
  readonly #scope: CacheScope;
  readonly #database: WorkspaceCacheDatabase;

  constructor(options: { readonly crypto: CacheCryptoClient; readonly scope: CacheScope }) {
    this.#crypto = options.crypto;
    this.#scope = options.scope;
    this.#database = new WorkspaceCacheDatabase(databaseName(options.scope));
  }

  async load(): Promise<CachedWorkspaceState> {
    const [
      metadata,
      workspaceRows,
      memberRows,
      conversationRows,
      messageRows,
      reactionRows,
      taskRows,
      outboxRows,
    ] = await Promise.all([
      this.#database.metadata.get("state"),
      this.#database.workspaces.toArray(),
      this.#database.members.toArray(),
      this.#database.conversations.toArray(),
      this.#database.messages.toArray(),
      this.#database.reactions.toArray(),
      this.#database.tasks.toArray(),
      this.#database.outbox.orderBy("createdAt").toArray(),
    ]);
    const [workspacePayloads, members, conversations, messages, reactions, tasks, operations] =
      await Promise.all([
        decryptRows(
          this.#crypto,
          "workspace",
          workspaceRows,
          workspaceRows.map((row) => row.id),
          (value) => value as WorkspacePayload,
        ),
        decryptRows(
          this.#crypto,
          "member",
          memberRows,
          memberRows.map((row) => row.id),
          (value) => userSchema.parse(value),
        ),
        decryptRows(
          this.#crypto,
          "conversation",
          conversationRows,
          conversationRows.map((row) => row.id),
          (value) => conversationSummarySchema.parse(value),
        ),
        decryptRows(
          this.#crypto,
          "message",
          messageRows,
          messageRows.map((row) => row.id),
          (value) => messageSchema.parse(value),
        ),
        decryptRows(
          this.#crypto,
          "reaction",
          reactionRows,
          reactionRows.map((row) => row.id),
          (value) => reactionSchema.parse(value),
        ),
        decryptRows(
          this.#crypto,
          "task",
          taskRows,
          taskRows.map((row) => row.id),
          (value) => taskSchema.parse(value),
        ),
        decryptRows(
          this.#crypto,
          "outbox",
          outboxRows,
          outboxRows.map((row) => row.clientMessageId),
          (value) => sendMessageOperationSchema.parse(value),
        ),
      ]);
    const workspace = workspacePayloads[0];
    // A client upgraded from the build that upserted `member.updated` can hold 26 member rows
    // after a disable followed by a create, and `workspaceSnapshotSchema.members` is `.max(25)`.
    // That hard `.parse` runs inside `WorkspaceRuntime.start()`'s try block, so an over-capacity
    // cached list would brick the client with "Could not initialize the workspace" and no repair
    // path. Drop an arbitrary row (see `capCachedMembers`) rather than the newest one -- there is
    // no recency signal to prefer by -- but never the signed-in user; the next `replaceMembers` or
    // `replaceSnapshot` restores whatever else this truncated from the server.
    const cappedMembers = capCachedMembers(members, workspace?.currentUser.user.id ?? null);
    // Dexie reads return primary-key (UUID) order, so both collections are re-sorted into the
    // order the server sent them; the renderer does not sort.
    const bootstrap =
      workspace === undefined
        ? null
        : canonicalSnapshot(
            parseSnapshotInput({
              ...workspace,
              members: cappedMembers,
              conversations,
              syncCursor: metadata?.syncCursor ?? "0",
            }),
          );
    return {
      bootstrap,
      messages: messages.sort(compareMessages),
      reactions: reactions.sort(compareReactions),
      tasks: tasks.sort(compareTasks),
      outbox: outboxRows.map((row, index) => ({
        operation: operations[index] as SendMessageOperation,
        createdAt: row.createdAt,
        status: row.status === "sending" ? "pending" : row.status,
        attemptCount: row.attemptCount,
        nextAttemptAt: row.nextAttemptAt,
        failureReason: row.failureReason,
      })),
      syncCursor: metadata?.syncCursor ?? null,
      lastSyncedAt: metadata?.lastSyncedAt ?? null,
    };
  }

  async replaceSnapshot(
    snapshot: HumanWorkspaceBootstrapResponse | WorkspaceSnapshot,
    messages: readonly Message[],
    reactions: readonly Reaction[] = [],
    tasks: readonly Task[] = [],
  ): Promise<void> {
    const parsed = parseSnapshotInput(snapshot);
    const parsedMessages = messages.map((message) => messageSchema.parse(message));
    const parsedReactions = reactions.map((reaction) => reactionSchema.parse(reaction));
    const parsedTasks = tasks.map((task) => taskSchema.parse(task));
    const encrypted = await encryptRecords(this.#crypto, [
      protectedRecord("workspace", parsed.workspace.id, {
        currentUser: parsed.currentUser,
        workspace: parsed.workspace,
        featureFlags: parsed.featureFlags,
      } satisfies WorkspacePayload),
      ...parsed.members.map((member) => protectedRecord("member", member.id, member)),
      ...parsed.conversations.map((conversation) =>
        protectedRecord("conversation", conversation.conversation.id, conversation),
      ),
      ...parsedMessages.map((message) => protectedRecord("message", message.id, message)),
      ...parsedReactions.map((reaction) => protectedRecord("reaction", reaction.id, reaction)),
      ...parsedTasks.map((task) => protectedRecord("task", task.id, task)),
    ]);
    await this.#database.transaction(
      "rw",
      [
        this.#database.metadata,
        this.#database.workspaces,
        this.#database.members,
        this.#database.conversations,
        this.#database.messages,
        this.#database.reactions,
        this.#database.tasks,
        this.#database.events,
      ],
      async () => {
        await Promise.all([
          this.#database.workspaces.clear(),
          this.#database.conversations.clear(),
          this.#database.messages.clear(),
          this.#database.reactions.clear(),
          this.#database.tasks.clear(),
          this.#database.events.clear(),
        ]);
        await this.#database.workspaces.put({
          id: parsed.workspace.id,
          value: encryptedValue(encrypted, "workspace", parsed.workspace.id),
        });
        await this.#writeMembers(parsed.members, encrypted);
        await this.#database.conversations.bulkPut(
          parsed.conversations.map((summary) => ({
            id: summary.conversation.id,
            kind: summary.conversation.kind,
            updatedAt: summary.conversation.updatedAt,
            value: encryptedValue(encrypted, "conversation", summary.conversation.id),
          })),
        );
        await this.#database.messages.bulkPut(
          parsedMessages.map((message) => messageRow(message, encrypted)),
        );
        await this.#database.reactions.bulkPut(
          parsedReactions.map((reaction) => reactionRow(reaction, encrypted)),
        );
        await this.#database.tasks.bulkPut(parsedTasks.map((task) => taskRow(task, encrypted)));
        await this.#database.metadata.put({
          id: "state",
          ...this.#scope,
          syncCursor: parsed.syncCursor,
          lastSyncedAt: new Date().toISOString(),
        });
      },
    );
    await this.#evictMessages();
  }

  async replaceMembers(members: readonly User[]): Promise<void> {
    const parsed = members.map((member) => userSchema.parse(member)).sort(compareMembers);
    const encrypted = await encryptRecords(
      this.#crypto,
      parsed.map((member) => protectedRecord("member", member.id, member)),
    );
    await this.#database.transaction(
      "rw",
      this.#database.metadata,
      this.#database.members,
      async () => {
        await this.#writeMembers(parsed, encrypted);
      },
    );
  }

  async upsertConversation(summary: ConversationSummary): Promise<void> {
    const parsed = conversationSummarySchema.parse(summary);
    const current = await this.#conversation(parsed.conversation.id);
    const merged = mergeConversationProjection(parsed, current);
    const encrypted = await encryptRecords(this.#crypto, [
      protectedRecord("conversation", merged.conversation.id, merged),
    ]);
    await this.#database.conversations.put({
      id: merged.conversation.id,
      kind: merged.conversation.kind,
      updatedAt: merged.conversation.updatedAt,
      value: encryptedValue(encrypted, "conversation", merged.conversation.id),
    });
  }

  async applyEvent(event: WorkspaceEvent): Promise<boolean> {
    const parsed = workspaceEventSchema.parse(event);
    const metadata = await this.#database.metadata.get("state");
    if (
      (metadata?.syncCursor !== null &&
        metadata?.syncCursor !== undefined &&
        compareSequence(parsed.workspaceSequence, metadata.syncCursor) <= 0) ||
      (await this.#database.events.get(parsed.id)) !== undefined
    ) {
      return false;
    }

    if (parsed.type === "message.created") {
      const currentSummary = await this.#conversation(parsed.conversationId);
      // The workspace row can be missing while a resync is in flight. Store the message and skip
      // the unread bookkeeping instead of throwing, matching MemoryWorkspaceCache.
      const currentUserId = await this.#currentUserId();
      const fromAnotherMember = parsed.payload.message.authorId !== currentUserId;
      const nextSummary =
        currentSummary === null || currentUserId === null
          ? null
          : conversationSummarySchema.parse({
              ...currentSummary,
              lastMessage: parsed.payload.message,
              unreadCount: currentSummary.unreadCount + (fromAnotherMember ? 1 : 0),
              mentionCount:
                currentSummary.mentionCount +
                (fromAnotherMember && parsed.payload.mentionedUserIds.includes(currentUserId)
                  ? 1
                  : 0),
            });
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("message", parsed.payload.message.id, parsed.payload.message),
        ...(nextSummary === null
          ? []
          : [protectedRecord("conversation", nextSummary.conversation.id, nextSummary)]),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.messages,
        this.#database.conversations,
        this.#database.outbox,
        this.#database.events,
        async () => {
          await this.#database.messages.put(messageRow(parsed.payload.message, encrypted));
          if (nextSummary !== null) {
            await this.#database.conversations.put({
              id: nextSummary.conversation.id,
              kind: nextSummary.conversation.kind,
              updatedAt: nextSummary.conversation.updatedAt,
              value: encryptedValue(encrypted, "conversation", nextSummary.conversation.id),
            });
          }
          await this.#database.outbox.delete(parsed.payload.message.clientMessageId);
          await this.#recordEvent(parsed);
        },
      );
    } else if (parsed.type === "member.updated") {
      // An invalidation signal, not a delta: `payload.member` is a bare `User` with no status
      // field, so upserting it would re-assert a member the server just disabled instead of
      // dropping it. Record the cursor here; WorkspaceRuntime replaces the server-derived member
      // list immediately after applying this event.
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.events,
        async () => {
          await this.#recordEvent(parsed);
        },
      );
    } else if (parsed.type === "channel.membership_changed") {
      // Membership changes can remove the current user and therefore invalidate both the
      // conversation and its cached history. Record the cursor here; WorkspaceRuntime replaces
      // the complete server-derived snapshot immediately after applying this event.
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.events,
        async () => {
          await this.#recordEvent(parsed);
        },
      );
    } else if (parsed.type === "reaction.added") {
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("reaction", parsed.payload.reaction.id, parsed.payload.reaction),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.reactions,
        this.#database.events,
        async () => {
          await this.#database.reactions.put(reactionRow(parsed.payload.reaction, encrypted));
          await this.#recordEvent(parsed);
        },
      );
    } else if (parsed.type === "reaction.removed") {
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.reactions,
        this.#database.events,
        async () => {
          await this.#database.reactions.delete(parsed.payload.reaction.id);
          await this.#recordEvent(parsed);
        },
      );
    } else if (parsed.type === "task.created" || parsed.type === "task.updated") {
      const task = parsed.payload.task;
      const current = await this.#task(task.id);
      if (current !== null && current.version > task.version) {
        await this.#database.transaction(
          "rw",
          this.#database.metadata,
          this.#database.events,
          async () => this.#recordEvent(parsed),
        );
        return true;
      }
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("task", task.id, task),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.tasks,
        this.#database.events,
        async () => {
          await this.#database.tasks.put(taskRow(task, encrypted));
          await this.#recordEvent(parsed);
        },
      );
    } else {
      const current = await this.#conversation(parsed.conversationId);
      let nextSummary: ConversationSummary | null = null;
      if (parsed.type === "read_cursor.updated") {
        // A read cursor for a conversation this cache has never seen is a no-op: there is no
        // summary to attach it to, and a placeholder would invent a conversation the server never
        // sent. MemoryWorkspaceCache makes the same choice. The event is still recorded, so the
        // sync cursor advances past it rather than replaying it forever.
        if (current !== null) {
          nextSummary = conversationSummarySchema.parse({
            ...current,
            readCursor: parsed.payload.readCursor,
            unreadCount: parsed.payload.unreadCount ?? current.unreadCount,
            mentionCount: parsed.payload.mentionCount ?? current.mentionCount,
          });
        }
      } else {
        nextSummary = conversationSummarySchema.parse({
          conversation: parsed.payload.conversation,
          participantIds: parsed.payload.participantIds,
          membershipRole: current?.membershipRole ?? null,
          lastMessage: current?.lastMessage ?? null,
          unreadCount: current?.unreadCount ?? 0,
          mentionCount: current?.mentionCount ?? 0,
          readCursor: current?.readCursor ?? null,
        });
      }
      if (nextSummary === null) {
        await this.#database.transaction(
          "rw",
          this.#database.metadata,
          this.#database.events,
          async () => {
            await this.#recordEvent(parsed);
          },
        );
        return true;
      }
      const summary = nextSummary;
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("conversation", summary.conversation.id, summary),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.conversations,
        this.#database.events,
        async () => {
          await this.#database.conversations.put({
            id: summary.conversation.id,
            kind: summary.conversation.kind,
            updatedAt: summary.conversation.updatedAt,
            value: encryptedValue(encrypted, "conversation", summary.conversation.id),
          });
          await this.#recordEvent(parsed);
        },
      );
    }
    return true;
  }

  async advanceCursor(syncCursor: string): Promise<void> {
    const current = await this.#database.metadata.get("state");
    if (
      current?.syncCursor !== null &&
      current?.syncCursor !== undefined &&
      compareSequence(syncCursor, current.syncCursor) <= 0
    ) {
      return;
    }
    await this.#database.metadata.put({
      id: "state",
      ...this.#scope,
      syncCursor,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  async upsertAcknowledgedMessage(message: Message, syncCursor: string): Promise<void> {
    const parsed = messageSchema.parse(message);
    const encrypted = await encryptRecords(this.#crypto, [
      protectedRecord("message", parsed.id, parsed),
    ]);
    await this.#database.transaction(
      "rw",
      this.#database.messages,
      this.#database.outbox,
      this.#database.metadata,
      async () => {
        await this.#database.messages.put(messageRow(parsed, encrypted));
        await this.#database.outbox.delete(parsed.clientMessageId);
        await this.advanceCursor(syncCursor);
      },
    );
  }

  async upsertHistory(
    messages: readonly Message[],
    reactions?: readonly Reaction[],
  ): Promise<void> {
    const parsed = messages.map((message) => messageSchema.parse(message));
    if (parsed.length === 0) return;
    const parsedReactions = reactions?.map((reaction) => reactionSchema.parse(reaction));
    const encrypted = await encryptRecords(this.#crypto, [
      ...parsed.map((message) => protectedRecord("message", message.id, message)),
      ...(parsedReactions ?? []).map((reaction) =>
        protectedRecord("reaction", reaction.id, reaction),
      ),
    ]);
    await this.#database.transaction(
      "rw",
      this.#database.messages,
      this.#database.reactions,
      async () => {
        await this.#database.messages.bulkPut(
          parsed.map((message) => messageRow(message, encrypted)),
        );
        if (parsedReactions !== undefined) {
          const messageIds = parsed.map((message) => message.id);
          await this.#database.reactions.where("messageId").anyOf(messageIds).delete();
          await this.#database.reactions.bulkPut(
            parsedReactions.map((reaction) => reactionRow(reaction, encrypted)),
          );
        }
      },
    );
    await this.#evictMessages();
  }

  async upsertReaction(reaction: Reaction): Promise<void> {
    const parsed = reactionSchema.parse(reaction);
    const encrypted = await encryptRecords(this.#crypto, [
      protectedRecord("reaction", parsed.id, parsed),
    ]);
    await this.#database.reactions.put(reactionRow(parsed, encrypted));
  }

  async removeReaction(reactionId: string): Promise<void> {
    await this.#database.reactions.delete(reactionId);
  }

  async upsertTasks(tasks: readonly Task[]): Promise<void> {
    const parsed: Task[] = [];
    for (const input of tasks) {
      const task = taskSchema.parse(input);
      const existing = await this.#task(task.id);
      if (existing === null || task.version >= existing.version) parsed.push(task);
    }
    if (parsed.length === 0) return;
    const encrypted = await encryptRecords(
      this.#crypto,
      parsed.map((task) => protectedRecord("task", task.id, task)),
    );
    await this.#database.tasks.bulkPut(parsed.map((task) => taskRow(task, encrypted)));
  }

  async enqueue(
    operation: SendMessageOperation,
    createdAt = new Date().toISOString(),
  ): Promise<void> {
    const parsed = sendMessageOperationSchema.parse(operation);
    const id = parsed.message.clientMessageId;
    if ((await this.#database.outbox.get(id)) !== undefined) return;
    const encrypted = await encryptRecords(this.#crypto, [protectedRecord("outbox", id, parsed)]);
    await this.#database.outbox.add({
      clientMessageId: id,
      conversationId: parsed.conversationId,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
      value: encryptedValue(encrypted, "outbox", id),
    });
  }

  async updateOutbox(
    clientMessageId: string,
    update: {
      readonly status: OutboxStatus;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly failureReason: string | null;
    },
  ): Promise<void> {
    await this.#database.outbox.update(clientMessageId, update);
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    await this.#database.outbox.delete(clientMessageId);
  }

  async clearServerStatePreservingOutbox(): Promise<void> {
    await this.#database.transaction(
      "rw",
      [
        this.#database.metadata,
        this.#database.workspaces,
        this.#database.members,
        this.#database.conversations,
        this.#database.messages,
        this.#database.reactions,
        this.#database.tasks,
        this.#database.events,
      ],
      async () => {
        await Promise.all([
          this.#database.metadata.clear(),
          this.#database.workspaces.clear(),
          this.#database.members.clear(),
          this.#database.conversations.clear(),
          this.#database.messages.clear(),
          this.#database.reactions.clear(),
          this.#database.tasks.clear(),
          this.#database.events.clear(),
        ]);
      },
    );
  }

  async clearAll(): Promise<void> {
    this.#database.close();
    await Dexie.delete(this.#database.name);
  }

  async #conversation(id: string | null): Promise<ConversationSummary | null> {
    if (id === null) return null;
    const row = await this.#database.conversations.get(id);
    if (row === undefined) return null;
    return (
      (
        await decryptRows(this.#crypto, "conversation", [row], [id], (value) =>
          conversationSummarySchema.parse(value),
        )
      )[0] ?? null
    );
  }

  async #task(id: string): Promise<Task | null> {
    const row = await this.#database.tasks.get(id);
    if (row === undefined) return null;
    return (
      (
        await decryptRows(this.#crypto, "task", [row], [id], (value) => taskSchema.parse(value))
      )[0] ?? null
    );
  }

  /**
   * Null when no workspace row is cached — the window a resync opens between
   * `clearServerStatePreservingOutbox()` and the next snapshot refresh. Callers treat that as
   * "identity unknown" and skip identity-dependent bookkeeping instead of failing the event.
   */
  async #currentUserId(): Promise<string | null> {
    const row = (await this.#database.workspaces.toArray())[0];
    if (row === undefined) return null;
    const payload = (
      await decryptRows(this.#crypto, "workspace", [row], [row.id], (value) =>
        workspaceSnapshotSchema.shape.currentUser.parse(
          (value as Partial<WorkspacePayload>).currentUser,
        ),
      )
    )[0];
    return payload?.user.id ?? null;
  }

  /**
   * The single member-table writer, shared by `replaceSnapshot` and `replaceMembers` so the two
   * cannot drift into different notions of what "the member directory" means. Always a clear plus
   * a rewrite: a member the server no longer lists has to disappear, which a bulkPut cannot do.
   * Runs inside the caller's transaction.
   */
  async #writeMembers(
    members: readonly User[],
    encrypted: ReadonlyMap<string, CacheCiphertext>,
  ): Promise<void> {
    await this.#database.members.clear();
    await this.#database.members.bulkPut(
      members.map((member) => ({
        id: member.id,
        updatedAt: member.updatedAt,
        value: encryptedValue(encrypted, "member", member.id),
      })),
    );
  }

  async #recordEvent(event: WorkspaceEvent): Promise<void> {
    await this.#database.events.put({
      id: event.id,
      workspaceSequence: event.workspaceSequence,
    });
    await this.#database.metadata.put({
      id: "state",
      ...this.#scope,
      syncCursor: event.workspaceSequence,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  async #evictMessages(): Promise<void> {
    const rows = await this.#database.messages.toArray();
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const cutoff = Date.now() - MAX_MESSAGE_AGE_MS;
    const expired = rows.filter(
      (row, index) => index >= MAX_ACKNOWLEDGED_MESSAGES || Date.parse(row.createdAt) < cutoff,
    );
    const expiredIds = expired.map((row) => row.id);
    if (expiredIds.length === 0) return;
    await this.#database.transaction(
      "rw",
      this.#database.messages,
      this.#database.reactions,
      async () => {
        await this.#database.messages.bulkDelete(expiredIds);
        await this.#database.reactions.where("messageId").anyOf(expiredIds).delete();
      },
    );
  }
}

export class MemoryWorkspaceCache implements WorkspaceCache {
  readonly mode = "memory_only" as const;
  #snapshot: WorkspaceSnapshot | null = null;
  // Mirrors PersistentWorkspaceCache's separate `members` Dexie table: that table is written by
  // both replaceSnapshot and replaceMembers regardless of whether a workspace row exists yet, so
  // a replaceMembers call that lands before the first replaceSnapshot is never lost. Keeping
  // members here instead of only inside `#snapshot` gives this cache the same durability instead
  // of silently discarding the write when `#snapshot` is still null.
  #members: readonly User[] = [];
  readonly #messages = new Map<string, Message>();
  readonly #reactions = new Map<string, Reaction>();
  readonly #tasks = new Map<string, Task>();
  readonly #outbox = new Map<string, OutboxItem>();
  readonly #events = new Set<string>();
  #syncCursor: string | null = null;
  #lastSyncedAt: string | null = null;

  async load(): Promise<CachedWorkspaceState> {
    const snapshot = this.#snapshot;
    // The reported snapshot cursor tracks applied events, matching how PersistentWorkspaceCache
    // rebuilds it from the metadata row.
    const syncCursor = this.#syncCursor ?? snapshot?.syncCursor ?? "0";
    const bootstrap =
      snapshot === null
        ? null
        : canonicalSnapshot({ ...snapshot, members: [...this.#members], syncCursor });
    return {
      bootstrap,
      // Map insertion order is arrival order, not conversation order; sort so "load older
      // messages" cannot append history below newer messages and so `messages.at(-1)` is really
      // the newest message, exactly like PersistentWorkspaceCache.
      messages: [...this.#messages.values()].sort(compareMessages),
      reactions: [...this.#reactions.values()].sort(compareReactions),
      tasks: [...this.#tasks.values()].sort(compareTasks),
      outbox: [...this.#outbox.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      syncCursor: this.#syncCursor,
      lastSyncedAt: this.#lastSyncedAt,
    };
  }

  async replaceSnapshot(
    snapshot: HumanWorkspaceBootstrapResponse | WorkspaceSnapshot,
    messages: readonly Message[],
    reactions: readonly Reaction[] = [],
    tasks: readonly Task[] = [],
  ): Promise<void> {
    const parsed = parseSnapshotInput(snapshot);
    this.#snapshot = parsed;
    this.#members = parsed.members;
    this.#messages.clear();
    for (const message of messages) this.#messages.set(message.id, messageSchema.parse(message));
    this.#reactions.clear();
    for (const reaction of reactions) {
      const parsedReaction = reactionSchema.parse(reaction);
      this.#reactions.set(parsedReaction.id, parsedReaction);
    }
    this.#tasks.clear();
    for (const task of tasks) {
      const parsedTask = taskSchema.parse(task);
      this.#tasks.set(parsedTask.id, parsedTask);
    }
    this.#syncCursor = parsed.syncCursor;
    this.#lastSyncedAt = new Date().toISOString();
  }

  async replaceMembers(members: readonly User[]): Promise<void> {
    const parsed = members.map((member) => userSchema.parse(member)).sort(compareMembers);
    // Persists regardless of `#snapshot`, matching PersistentWorkspaceCache's independent members
    // table -- a replaceMembers call that arrives before the first replaceSnapshot must not be
    // silently discarded, even though `load()` still reports no bootstrap until a snapshot exists.
    this.#members = parsed;
    if (this.#snapshot !== null) this.#snapshot = { ...this.#snapshot, members: parsed };
  }

  async upsertConversation(summary: ConversationSummary): Promise<void> {
    const parsed = conversationSummarySchema.parse(summary);
    if (this.#snapshot === null) return;
    const current =
      this.#snapshot.conversations.find(
        (candidate) => candidate.conversation.id === parsed.conversation.id,
      ) ?? null;
    const merged = mergeConversationProjection(parsed, current);
    const conversations = this.#snapshot.conversations.filter(
      (candidate) => candidate.conversation.id !== parsed.conversation.id,
    );
    conversations.push(merged);
    this.#snapshot = {
      ...this.#snapshot,
      conversations: conversations.sort(compareConversations),
    };
  }

  async applyEvent(event: WorkspaceEvent): Promise<boolean> {
    const parsed = workspaceEventSchema.parse(event);
    if (
      this.#events.has(parsed.id) ||
      (this.#syncCursor !== null &&
        compareSequence(parsed.workspaceSequence, this.#syncCursor) <= 0)
    ) {
      return false;
    }
    this.#events.add(parsed.id);
    this.#syncCursor = parsed.workspaceSequence;
    this.#lastSyncedAt = new Date().toISOString();
    if (parsed.type === "message.created") {
      this.#messages.set(parsed.payload.message.id, parsed.payload.message);
      this.#outbox.delete(parsed.payload.message.clientMessageId);
      if (this.#snapshot !== null && parsed.conversationId !== null) {
        const conversations = new Map(
          this.#snapshot.conversations.map((summary) => [summary.conversation.id, summary]),
        );
        const current = conversations.get(parsed.conversationId);
        if (current !== undefined) {
          const currentUserId = this.#snapshot.currentUser.user.id;
          conversations.set(parsed.conversationId, {
            ...current,
            lastMessage: parsed.payload.message,
            unreadCount:
              current.unreadCount + (parsed.payload.message.authorId === currentUserId ? 0 : 1),
            mentionCount:
              current.mentionCount +
              (parsed.payload.message.authorId !== currentUserId &&
              parsed.payload.mentionedUserIds.includes(currentUserId)
                ? 1
                : 0),
          });
          this.#snapshot = {
            ...this.#snapshot,
            conversations: [...conversations.values()],
          };
        }
      }
    } else if (parsed.type === "channel.membership_changed") {
      // WorkspaceRuntime replaces the snapshot because the current conversation may have become
      // invisible. Advancing the cursor above keeps this event idempotent until that refresh.
    } else if (parsed.type === "reaction.added") {
      this.#reactions.set(parsed.payload.reaction.id, parsed.payload.reaction);
    } else if (parsed.type === "reaction.removed") {
      this.#reactions.delete(parsed.payload.reaction.id);
    } else if (parsed.type === "task.created" || parsed.type === "task.updated") {
      const current = this.#tasks.get(parsed.payload.task.id);
      if (current === undefined || parsed.payload.task.version >= current.version) {
        this.#tasks.set(parsed.payload.task.id, parsed.payload.task);
      }
    } else if (parsed.type === "member.updated") {
      // WorkspaceRuntime replaces the server-derived member list because `payload.member` cannot
      // express a removal. Advancing the cursor above keeps this event idempotent until then.
    } else if (this.#snapshot !== null && parsed.conversationId !== null) {
      const conversations = new Map(
        this.#snapshot.conversations.map((summary) => [summary.conversation.id, summary]),
      );
      const current = conversations.get(parsed.conversationId);
      if (parsed.type === "read_cursor.updated") {
        if (current !== undefined) {
          conversations.set(parsed.conversationId, {
            ...current,
            readCursor: parsed.payload.readCursor,
            unreadCount: parsed.payload.unreadCount ?? current.unreadCount,
            mentionCount: parsed.payload.mentionCount ?? current.mentionCount,
          });
        }
      } else {
        conversations.set(parsed.conversationId, {
          conversation: parsed.payload.conversation,
          participantIds: parsed.payload.participantIds,
          membershipRole: current?.membershipRole ?? null,
          lastMessage: current?.lastMessage ?? null,
          unreadCount: current?.unreadCount ?? 0,
          mentionCount: current?.mentionCount ?? 0,
          readCursor: current?.readCursor ?? null,
        });
      }
      this.#snapshot = { ...this.#snapshot, conversations: [...conversations.values()] };
    }
    return true;
  }

  async advanceCursor(syncCursor: string): Promise<void> {
    if (this.#syncCursor === null || compareSequence(syncCursor, this.#syncCursor) > 0) {
      this.#syncCursor = syncCursor;
      this.#lastSyncedAt = new Date().toISOString();
    }
  }

  async upsertAcknowledgedMessage(message: Message, syncCursor: string): Promise<void> {
    const parsed = messageSchema.parse(message);
    this.#messages.set(parsed.id, parsed);
    this.#outbox.delete(parsed.clientMessageId);
    await this.advanceCursor(syncCursor);
  }

  async upsertHistory(
    messages: readonly Message[],
    reactions?: readonly Reaction[],
  ): Promise<void> {
    for (const message of messages) {
      const parsed = messageSchema.parse(message);
      this.#messages.set(parsed.id, parsed);
    }
    if (reactions !== undefined) {
      const messageIds = new Set(messages.map((message) => message.id));
      for (const [id, reaction] of this.#reactions) {
        if (messageIds.has(reaction.messageId)) this.#reactions.delete(id);
      }
      for (const reaction of reactions) {
        const parsed = reactionSchema.parse(reaction);
        this.#reactions.set(parsed.id, parsed);
      }
    }
  }

  async upsertReaction(reaction: Reaction): Promise<void> {
    const parsed = reactionSchema.parse(reaction);
    this.#reactions.set(parsed.id, parsed);
  }

  async removeReaction(reactionId: string): Promise<void> {
    this.#reactions.delete(reactionId);
  }

  async upsertTasks(tasks: readonly Task[]): Promise<void> {
    for (const task of tasks) {
      const parsed = taskSchema.parse(task);
      const current = this.#tasks.get(parsed.id);
      if (current === undefined || parsed.version >= current.version) {
        this.#tasks.set(parsed.id, parsed);
      }
    }
  }

  async enqueue(
    operation: SendMessageOperation,
    createdAt = new Date().toISOString(),
  ): Promise<void> {
    const parsed = sendMessageOperationSchema.parse(operation);
    const id = parsed.message.clientMessageId;
    if (this.#outbox.has(id)) return;
    this.#outbox.set(id, {
      operation: parsed,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
  }

  async updateOutbox(
    clientMessageId: string,
    update: {
      readonly status: OutboxStatus;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly failureReason: string | null;
    },
  ): Promise<void> {
    const current = this.#outbox.get(clientMessageId);
    if (current !== undefined) this.#outbox.set(clientMessageId, { ...current, ...update });
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    this.#outbox.delete(clientMessageId);
  }

  async clearServerStatePreservingOutbox(): Promise<void> {
    this.#snapshot = null;
    this.#messages.clear();
    this.#reactions.clear();
    this.#tasks.clear();
    this.#events.clear();
    this.#syncCursor = null;
    this.#lastSyncedAt = null;
  }

  async clearAll(): Promise<void> {
    await this.clearServerStatePreservingOutbox();
    this.#outbox.clear();
  }
}
