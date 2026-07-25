import Dexie, { type Table } from "dexie";

import {
  conversationSummarySchema,
  messageSchema,
  sendMessageOperationSchema,
  userSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  type CacheCiphertext,
  type CacheCryptoStatus,
  type CacheDecryptBatchRequest,
  type CacheDecryptBatchResponse,
  type CacheEncryptBatchRequest,
  type CacheEncryptBatchResponse,
  type CacheScope,
  type ConversationSummary,
  type Message,
  type SendMessageOperation,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hmm-chat/contracts";

const CACHE_SCHEMA_VERSION = 1 as const;
const CACHE_DATABASE_PREFIX = "hmm-chat-cache-v2-";
const MAX_ACKNOWLEDGED_MESSAGES = 20_000;
const MAX_MESSAGE_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

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
  readonly bootstrap: WorkspaceBootstrapResponse | null;
  readonly messages: readonly Message[];
  readonly outbox: readonly OutboxItem[];
  readonly syncCursor: string | null;
  readonly lastSyncedAt: string | null;
}

export interface WorkspaceCache {
  readonly mode: CacheCryptoStatus["mode"];
  load(): Promise<CachedWorkspaceState>;
  replaceSnapshot(
    bootstrap: WorkspaceBootstrapResponse,
    messages: readonly Message[],
  ): Promise<void>;
  applyEvent(event: WorkspaceEvent): Promise<boolean>;
  advanceCursor(syncCursor: string): Promise<void>;
  upsertHistory(messages: readonly Message[]): Promise<void>;
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
  readonly currentUser: WorkspaceBootstrapResponse["currentUser"];
  readonly workspace: WorkspaceBootstrapResponse["workspace"];
  readonly featureFlags: WorkspaceBootstrapResponse["featureFlags"];
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
  }
}

type ProtectedStore = "workspace" | "member" | "conversation" | "message" | "outbox";

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function databaseName(scope: CacheScope): string {
  return `${CACHE_DATABASE_PREFIX}${scope.workspaceId}-${scope.userId}`;
}

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
    const [metadata, workspaceRows, memberRows, conversationRows, messageRows, outboxRows] =
      await Promise.all([
        this.#database.metadata.get("state"),
        this.#database.workspaces.toArray(),
        this.#database.members.toArray(),
        this.#database.conversations.toArray(),
        this.#database.messages.toArray(),
        this.#database.outbox.orderBy("createdAt").toArray(),
      ]);
    const [workspacePayloads, members, conversations, messages, operations] = await Promise.all([
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
        "outbox",
        outboxRows,
        outboxRows.map((row) => row.clientMessageId),
        (value) => sendMessageOperationSchema.parse(value),
      ),
    ]);
    const workspace = workspacePayloads[0];
    const bootstrap =
      workspace === undefined
        ? null
        : workspaceBootstrapResponseSchema.parse({
            ...workspace,
            members,
            conversations,
            syncCursor: metadata?.syncCursor ?? "0",
          });
    return {
      bootstrap,
      messages: messages.sort((left, right) =>
        compareSequence(left.conversationSequence, right.conversationSequence),
      ),
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
    bootstrap: WorkspaceBootstrapResponse,
    messages: readonly Message[],
  ): Promise<void> {
    const parsed = workspaceBootstrapResponseSchema.parse(bootstrap);
    const parsedMessages = messages.map((message) => messageSchema.parse(message));
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
    ]);
    await this.#database.transaction(
      "rw",
      [
        this.#database.metadata,
        this.#database.workspaces,
        this.#database.members,
        this.#database.conversations,
        this.#database.messages,
        this.#database.events,
      ],
      async () => {
        await Promise.all([
          this.#database.workspaces.clear(),
          this.#database.members.clear(),
          this.#database.conversations.clear(),
          this.#database.messages.clear(),
          this.#database.events.clear(),
        ]);
        await this.#database.workspaces.put({
          id: parsed.workspace.id,
          value: encryptedValue(encrypted, "workspace", parsed.workspace.id),
        });
        await this.#database.members.bulkPut(
          parsed.members.map((member) => ({
            id: member.id,
            updatedAt: member.updatedAt,
            value: encryptedValue(encrypted, "member", member.id),
          })),
        );
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
      const currentUserId = await this.#currentUserId();
      const fromAnotherMember = parsed.payload.message.authorId !== currentUserId;
      const nextSummary =
        currentSummary === null
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
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("member", parsed.payload.member.id, parsed.payload.member),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.members,
        this.#database.events,
        async () => {
          await this.#database.members.put({
            id: parsed.payload.member.id,
            updatedAt: parsed.payload.member.updatedAt,
            value: encryptedValue(encrypted, "member", parsed.payload.member.id),
          });
          await this.#recordEvent(parsed);
        },
      );
    } else {
      const current = await this.#conversation(parsed.conversationId);
      const summary: ConversationSummary =
        parsed.type === "read_cursor.updated"
          ? conversationSummarySchema.parse({
              ...current,
              readCursor: parsed.payload.readCursor,
              unreadCount: 0,
              mentionCount: 0,
            })
          : conversationSummarySchema.parse({
              conversation: parsed.payload.conversation,
              participantIds: parsed.payload.participantIds,
              lastMessage: current?.lastMessage ?? null,
              unreadCount: current?.unreadCount ?? 0,
              mentionCount: current?.mentionCount ?? 0,
              readCursor: current?.readCursor ?? null,
            });
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

  async upsertHistory(messages: readonly Message[]): Promise<void> {
    const parsed = messages.map((message) => messageSchema.parse(message));
    if (parsed.length === 0) return;
    const encrypted = await encryptRecords(
      this.#crypto,
      parsed.map((message) => protectedRecord("message", message.id, message)),
    );
    await this.#database.messages.bulkPut(parsed.map((message) => messageRow(message, encrypted)));
    await this.#evictMessages();
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
        this.#database.events,
      ],
      async () => {
        await Promise.all([
          this.#database.metadata.clear(),
          this.#database.workspaces.clear(),
          this.#database.members.clear(),
          this.#database.conversations.clear(),
          this.#database.messages.clear(),
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

  async #currentUserId(): Promise<string> {
    const row = (await this.#database.workspaces.toArray())[0];
    if (row === undefined) throw new Error("Cached workspace identity is unavailable");
    const payload = (
      await decryptRows(this.#crypto, "workspace", [row], [row.id], (value) =>
        workspaceBootstrapResponseSchema.shape.currentUser.parse(
          (value as Partial<WorkspacePayload>).currentUser,
        ),
      )
    )[0];
    if (payload === undefined) throw new Error("Cached workspace identity is unavailable");
    return payload.user.id;
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
    await this.#database.messages.bulkDelete(expired.map((row) => row.id));
  }
}

export class MemoryWorkspaceCache implements WorkspaceCache {
  readonly mode = "memory_only" as const;
  #bootstrap: WorkspaceBootstrapResponse | null = null;
  readonly #messages = new Map<string, Message>();
  readonly #outbox = new Map<string, OutboxItem>();
  readonly #events = new Set<string>();
  #syncCursor: string | null = null;
  #lastSyncedAt: string | null = null;

  async load(): Promise<CachedWorkspaceState> {
    return {
      bootstrap: this.#bootstrap,
      messages: [...this.#messages.values()],
      outbox: [...this.#outbox.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      syncCursor: this.#syncCursor,
      lastSyncedAt: this.#lastSyncedAt,
    };
  }

  async replaceSnapshot(
    bootstrap: WorkspaceBootstrapResponse,
    messages: readonly Message[],
  ): Promise<void> {
    this.#bootstrap = workspaceBootstrapResponseSchema.parse(bootstrap);
    this.#messages.clear();
    for (const message of messages) this.#messages.set(message.id, messageSchema.parse(message));
    this.#syncCursor = bootstrap.syncCursor;
    this.#lastSyncedAt = new Date().toISOString();
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
      if (this.#bootstrap !== null && parsed.conversationId !== null) {
        const conversations = new Map(
          this.#bootstrap.conversations.map((summary) => [summary.conversation.id, summary]),
        );
        const current = conversations.get(parsed.conversationId);
        if (current !== undefined) {
          const currentUserId = this.#bootstrap.currentUser.user.id;
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
          this.#bootstrap = {
            ...this.#bootstrap,
            conversations: [...conversations.values()],
          };
        }
      }
    } else if (this.#bootstrap !== null && parsed.type === "member.updated") {
      const members = new Map(this.#bootstrap.members.map((member) => [member.id, member]));
      members.set(parsed.payload.member.id, parsed.payload.member);
      this.#bootstrap = { ...this.#bootstrap, members: [...members.values()] };
    } else if (this.#bootstrap !== null && parsed.conversationId !== null) {
      const conversations = new Map(
        this.#bootstrap.conversations.map((summary) => [summary.conversation.id, summary]),
      );
      const current = conversations.get(parsed.conversationId);
      if (parsed.type === "read_cursor.updated") {
        if (current !== undefined) {
          conversations.set(parsed.conversationId, {
            ...current,
            readCursor: parsed.payload.readCursor,
            unreadCount: 0,
            mentionCount: 0,
          });
        }
      } else {
        conversations.set(parsed.conversationId, {
          conversation: parsed.payload.conversation,
          participantIds: parsed.payload.participantIds,
          lastMessage: current?.lastMessage ?? null,
          unreadCount: current?.unreadCount ?? 0,
          mentionCount: current?.mentionCount ?? 0,
          readCursor: current?.readCursor ?? null,
        });
      }
      this.#bootstrap = { ...this.#bootstrap, conversations: [...conversations.values()] };
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

  async upsertHistory(messages: readonly Message[]): Promise<void> {
    for (const message of messages) {
      const parsed = messageSchema.parse(message);
      this.#messages.set(parsed.id, parsed);
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
    this.#bootstrap = null;
    this.#messages.clear();
    this.#events.clear();
    this.#syncCursor = null;
    this.#lastSyncedAt = null;
  }

  async clearAll(): Promise<void> {
    await this.clearServerStatePreservingOutbox();
    this.#outbox.clear();
  }
}
