import {
  compareSyncPositions,
  sameSyncPosition,
  syncPositionSchema,
  type SyncPosition,
} from "@hype-comms/contracts";
import Dexie, { type Table } from "dexie";

import {
  conversationSummarySchema,
  entityIdSchema,
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
  type HumanWorkspaceBootstrapResponse,
  type Message,
  type Reaction,
  type SendMessageOperation,
  type Task,
  type User,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hype-comms/contracts";

import {
  acceptsTaskVersion,
  applyRetractReservation,
  applyRetractReservationsToConversations,
  applyRetractReservationsToMessages,
  compareConversations,
  compareMembers,
  compareMessages,
  compareReactions,
  compareTasks,
  mergeConversationProjection,
  preferRetainedMessage,
  projectConversationMembershipChange,
  projectConversationSummary,
  projectCreatedMessageSummary,
  projectReadCursorSummary,
  reconcileRetractedConversationSummary,
  reserveTombstonedMessages,
  retractReservationMap,
  retractedMessageIds,
  tombstoneMessage,
  trimRetractReservations,
  type RetractReservation,
  upsertRetractReservation,
} from "./workspace-projection";
import {
  committedCacheEvent,
  ignoredCacheEvent,
  type CacheEventResult,
  type CommittedCacheChanges,
} from "./workspace-cache-changes";

import {
  assertReactionSnapshotCurrent,
  commitCollectionState,
  invalidateCollections,
  parseCollectionStates,
  type CollectionCommit,
  type CollectionState,
} from "./workspace-collections";

import { mentionedMemberIds } from "./mentions";

const CACHE_SCHEMA_VERSION = 1 as const;
const CACHE_DATABASE_PREFIX = "hype-comms-cache-v1-";
const MAX_ACKNOWLEDGED_MESSAGES = 20_000;
// Live creates retain exact mention IDs while a retract can still reach the message. The hard cap
// keeps this auxiliary runtime-only map bounded during a busy desktop session.
export const MAX_RECENT_MESSAGE_MENTIONS = 20_000;
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

export interface OutboxUpdateExpectation {
  readonly status: OutboxStatus;
  readonly attemptCount: number;
}

export interface MembershipRepairMarker {
  readonly kind: "membership";
  readonly eventId: string;
  readonly position: SyncPosition;
  readonly conversationId: string;
  readonly selfRemoval: boolean;
}

export interface CachedWorkspaceState {
  readonly collections: readonly CollectionState[];
  /**
   * The aggregate client snapshot, not a bootstrap response: the cache holds every conversation
   * page the client has fetched, so page cursors have no meaning once state is cached.
   */
  readonly bootstrap: WorkspaceSnapshot | null;
  readonly messages: readonly Message[];
  readonly reactions: readonly Reaction[];
  readonly tasks: readonly Task[];
  readonly outbox: readonly OutboxItem[];
  readonly syncCursor: SyncPosition | null;
  readonly lastSyncedAt: string | null;
  readonly repairMarker: MembershipRepairMarker | null;
  /**
   * Retract events that arrived before their message row existed. History and later created
   * projections must apply these so a stale live body cannot resurrect the message.
   */
  readonly retractReservations: readonly RetractReservation[];
}

type MembershipChangedEvent = Extract<WorkspaceEvent, { type: "channel.membership_changed" }>;

/** Rolls back the complete optimistic write when another commit has already passed this event. */
class SupersededCacheEvent extends Error {
  constructor(readonly committedPosition: SyncPosition | null) {
    super("The cache has already committed this event or a later position");
  }
}

type MetadataWriteMode = "refresh" | "page" | "bootstrap";

function canWriteMetadata(
  current: SyncPosition | null,
  incoming: SyncPosition,
  marker: MembershipRepairMarker | null,
  mode: MetadataWriteMode,
): boolean {
  if (current !== null && current.epoch !== incoming.epoch)
    throw new Error("Reset the protocol replica before installing another epoch");
  if (marker !== null) {
    if (mode !== "bootstrap")
      throw new Error("Membership repair must complete before replacing metadata");
    if (
      marker.position.epoch !== incoming.epoch ||
      compareSyncPositions(incoming, marker.position) < 0
    )
      throw new Error("Authoritative snapshot predates the membership repair marker");
  }
  return mode === "refresh"
    ? current !== null && sameSyncPosition(current, incoming)
    : current === null || compareSyncPositions(current, incoming) <= 0;
}

function metadataCollections(
  states: readonly CollectionState[],
  visible: ReadonlySet<string>,
  position: SyncPosition,
  mode: MetadataWriteMode,
): CollectionState[] {
  if (mode === "page") return [...states];
  return states
    .filter(
      (state) => state.identity.kind === "my_tasks" || visible.has(state.identity.conversationId),
    )
    .map((state) => {
      if (
        mode !== "bootstrap" ||
        (state.snapshotPosition !== null &&
          state.snapshotPosition.epoch === position.epoch &&
          compareSyncPositions(state.snapshotPosition, position) >= 0)
      )
        return state;
      return { ...state, invalidatedAt: position };
    });
}

export interface SnapshotCollections {
  readonly states: readonly CollectionState[];
  readonly reactionPositions: ReadonlyMap<string, SyncPosition>;
}

export interface WorkspaceCache {
  readonly mode: CacheCryptoStatus["mode"];
  load(): Promise<CachedWorkspaceState>;
  readCollections(): Promise<readonly CollectionState[]>;
  commitCollectionMetadata(commit: CollectionCommit, signal?: AbortSignal): Promise<void>;
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
    signal?: AbortSignal,
    retractSourceMessageIds?: readonly string[],
    collections?: SnapshotCollections,
  ): Promise<boolean>;
  /** Replaces a complete catalog at the applied position without replacing retained collection rows. */
  replaceMetadata(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean>;
  /** Stages a validated catalog page without removing unseen work or advancing replay. */
  stageMetadataPage(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean>;
  /** Installs a complete catalog and its replay baseline after bootstrap/repair. */
  installMetadataSnapshot(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean>;
  /**
   * Replaces the whole member directory with the server's answer to `GET /v2/members`.
   *
   * This is the only writer of the cached member list outside `replaceSnapshot`. `member.updated`
   * deliberately does not write here: its payload is a bare `User` with no status field, so it
   * cannot express a removal, and upserting it would re-assert a member the server just disabled.
   * A caller may abort a replacement when the cache generation that requested it is retired.
   */
  replaceMembers(members: readonly User[], signal?: AbortSignal): Promise<void>;
  /** Persists a mutation projection without claiming that its workspace cursor was applied. */
  upsertConversation(summary: ConversationSummary): Promise<void>;
  /** Durably closes the cache before the current user's membership repair can wait on network. */
  stageMembershipRepair(event: MembershipChangedEvent): Promise<boolean>;
  /**
   * Applies an event and advances the durable cursor. A change to the current user's membership
   * first stages its repair, purges revoked conversation state when applicable, and leaves the
   * cache blocked until an authoritative snapshot clears the repair marker. Other members'
   * changes update the affected conversation's participant list like ordinary durable events.
   *
   * A retract has no message body. The runtime may supply its retained source when a closed
   * thread's latest reply is not part of the cached history page.
   * Results contain only committed writes. Cancellation or transaction failure throws; a duplicate
   * or superseded event returns its durable position without publishing record changes.
   */
  applyEvent(
    event: WorkspaceEvent,
    signal?: AbortSignal,
    retractSource?: Message,
  ): Promise<CacheEventResult>;
  /** Exact server-verified mention IDs retained for a live message until it is retracted. */
  getCreatedMessageMentions(messageId: string): Promise<readonly string[] | undefined>;
  advanceCursor(syncCursor: SyncPosition): Promise<void>;
  /** Atomically persists a history page only while its conversation remains authorized. */
  upsertHistory(
    conversationId: string,
    messages: readonly Message[],
    reactions?: readonly Reaction[],
    signal?: AbortSignal,
    collection?: CollectionCommit,
  ): Promise<boolean>;
  /** Projects a mutation response only while its conversation remains authorized. */
  upsertReaction(
    reaction: Reaction,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Projects a mutation response without advancing the workspace event cursor. */
  removeReaction(reactionId: string): Promise<void>;
  /**
   * Persists only task projections whose conversations remain authorized, without advancing the
   * workspace event cursor. Returns the subset accepted atomically.
   */
  upsertTasks(
    tasks: readonly Task[],
    signal?: AbortSignal,
    collection?: CollectionCommit,
  ): Promise<readonly Task[]>;
  /**
   * Reconciles a committed send only while its queued operation and authorized conversation still
   * exist atomically. Returns false when a concurrent repair or projection already retired it.
   */
  upsertAcknowledgedMessage(
    message: Message,
    expectedClientMessageId: string,
    syncCursor: SyncPosition,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Queues a send only while its conversation remains authorized. */
  enqueue(
    operation: SendMessageOperation,
    createdAt?: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Atomically replaces one failed queued send while its conversation remains authorized. */
  replaceOutbox(
    clientMessageId: string,
    operation: SendMessageOperation,
    createdAt: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  updateOutbox(
    clientMessageId: string,
    update: {
      readonly status: OutboxStatus;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly failureReason: string | null;
    },
    signal?: AbortSignal,
    expected?: OutboxUpdateExpectation,
  ): Promise<boolean>;
  removeOutbox(clientMessageId: string): Promise<void>;
  clearServerStatePreservingOutbox(): Promise<void>;
  /** Drops an obsolete protocol replica, including recovery markers, without touching queued work. */
  resetProtocolReplica(): Promise<void>;
  clearAll(): Promise<void>;
}

interface CacheCryptoClient {
  encryptCacheRecords(input: CacheEncryptBatchRequest): Promise<CacheEncryptBatchResponse>;
  decryptCacheRecords(input: CacheDecryptBatchRequest): Promise<CacheDecryptBatchResponse>;
}

interface MetadataRow {
  readonly id: "state";
  readonly collections?: readonly CollectionState[];
  readonly userId: string;
  readonly workspaceId: string;
  readonly syncCursor: SyncPosition | null;
  readonly lastSyncedAt: string | null;
  /** Non-indexed local recovery metadata; adding it does not require an IndexedDB schema bump. */
  readonly repairMarker?: MembershipRepairMarker | null;
  /** Non-indexed local recovery metadata; adding it does not require an IndexedDB schema bump. */
  readonly retractReservations?: RetractReservation[];
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
  readonly reactionSnapshotPosition?: SyncPosition;
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
  readonly conversationId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly value: CacheCiphertext;
}

// Version 4 reaction rows did not carry conversation ownership. If their message has already been
// evicted, preserve them on upgrade under an internal bucket that every self-removal purge clears.
const UNKNOWN_REACTION_CONVERSATION_ID = "__unknown__";

interface TaskRow {
  readonly id: string;
  readonly conversationId: string;
  readonly assigneeId: string | null;
  readonly status: Task["status"];
  readonly rank: string;
  /** Non-indexed optimistic version; older cache rows may omit it until the next snapshot. */
  readonly version?: number;
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

function matchesOutboxExpectation(
  current: Pick<OutboxItem, "status" | "attemptCount">,
  expected: OutboxUpdateExpectation | undefined,
): boolean {
  if (expected === undefined) return true;
  // A process restart deliberately projects an interrupted durable `sending` row as `pending`.
  // Treat that one recovery representation as equivalent while still comparing its attempt.
  const statusMatches =
    current.status === expected.status ||
    (current.status === "sending" && expected.status === "pending");
  return statusMatches && current.attemptCount === expected.attemptCount;
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
    this.version(5)
      .stores({
        reactions: "&id,messageId,conversationId,userId,createdAt",
      })
      .upgrade(async (transaction) => {
        // Version 4 could only recover ownership through a cached message. Preserve every row,
        // assigning already-orphaned rows to the conservative bucket cleared by every removal.
        const messageRows = await transaction.table<MessageRow, string>("messages").toArray();
        const conversationIds = new Map(
          messageRows.map((row) => [row.id, row.conversationId] as const),
        );
        const reactionTable = transaction.table<ReactionRow, string>("reactions");
        const reactionRows = await reactionTable.toArray();
        await reactionTable.bulkPut(
          reactionRows.map((row) => ({
            ...row,
            conversationId: conversationIds.get(row.messageId) ?? UNKNOWN_REACTION_CONVERSATION_ID,
          })),
        );
      });
    this.version(6)
      .stores({})
      .upgrade(async (transaction) => {
        // Old sequence-only replicas cannot establish an epoch. Keep their encrypted outbox in
        // this same database; encryption identity/version and main-process keys remain unchanged.
        await Promise.all(
          [
            "metadata",
            "workspaces",
            "members",
            "conversations",
            "messages",
            "reactions",
            "tasks",
            "events",
          ].map((store) => transaction.table(store).clear()),
        );
      });
  }
}

type ProtectedStore =
  "workspace" | "member" | "conversation" | "message" | "reaction" | "task" | "outbox";

const MEMBERSHIP_REPAIR_MARKER_KEYS = [
  "conversationId",
  "eventId",
  "kind",
  "position",
  "selfRemoval",
] as const;

const RETRACT_RESERVATION_KEYS = ["deletedAt", "entityVersion", "messageId"] as const;

function parseRetractReservations(value: unknown): RetractReservation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid retract reservations");
  }
  const reservations = value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid retract reservation");
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== RETRACT_RESERVATION_KEYS.length ||
      keys.some((key, index) => key !== RETRACT_RESERVATION_KEYS[index]) ||
      typeof record.deletedAt !== "string" ||
      typeof record.entityVersion !== "number" ||
      !Number.isInteger(record.entityVersion)
    ) {
      throw new Error("Invalid retract reservation");
    }
    return {
      messageId: entityIdSchema.parse(record.messageId),
      deletedAt: record.deletedAt,
      entityVersion: record.entityVersion,
    };
  });
  return trimRetractReservations(reservations);
}

function parseMembershipRepairMarker(value: unknown): MembershipRepairMarker | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid membership repair marker");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== MEMBERSHIP_REPAIR_MARKER_KEYS.length ||
    keys.some((key, index) => key !== MEMBERSHIP_REPAIR_MARKER_KEYS[index]) ||
    record.kind !== "membership" ||
    typeof record.selfRemoval !== "boolean"
  ) {
    throw new Error("Invalid membership repair marker");
  }
  return {
    kind: "membership",
    eventId: entityIdSchema.parse(record.eventId),
    position: syncPositionSchema.parse(record.position),
    conversationId: entityIdSchema.parse(record.conversationId),
    selfRemoval: record.selfRemoval,
  };
}

function sameMembershipRepair(
  marker: MembershipRepairMarker | null,
  event: MembershipChangedEvent,
): boolean {
  return (
    marker?.eventId === event.id &&
    sameSyncPosition(marker.position, event.position) &&
    marker.conversationId === event.conversationId
  );
}

function matchingRetractSource(
  event: Extract<WorkspaceEvent, { type: "message.retracted" }>,
  retractSource: Message | undefined,
): Message | null {
  if (retractSource === undefined) return null;
  const parsed = messageSchema.parse(retractSource);
  if (parsed.id !== event.payload.messageId || parsed.conversationId !== event.conversationId) {
    throw new Error("The retract source does not match the retracted message");
  }
  return parsed;
}

function retainLiveMessageMentions(
  mentions: Map<string, readonly string[]>,
  messages: readonly Message[],
  conversations: readonly ConversationSummary[] = [],
  retractSourceMessageIds: readonly string[] = [],
): void {
  const liveMessageIds = new Set(
    messages.filter((message) => message.deletedAt === null).map((message) => message.id),
  );
  for (const summary of conversations) {
    if (summary.lastMessage?.deletedAt === null) liveMessageIds.add(summary.lastMessage.id);
  }
  for (const messageId of retractSourceMessageIds) liveMessageIds.add(messageId);
  for (const messageId of mentions.keys()) {
    if (!liveMessageIds.has(messageId)) mentions.delete(messageId);
  }
  trimRecentMessageMentions(mentions);
}

export function rememberCreatedMessageMentions(
  mentions: Map<string, readonly string[]>,
  messageId: string,
  mentionedUserIds: readonly string[],
): void {
  mentions.set(messageId, mentionedUserIds);
  trimRecentMessageMentions(mentions);
}

function trimRecentMessageMentions(mentions: Map<string, readonly string[]>): void {
  while (mentions.size > MAX_RECENT_MESSAGE_MENTIONS) {
    const oldestMessageId = mentions.keys().next().value;
    if (oldestMessageId === undefined) return;
    mentions.delete(oldestMessageId);
  }
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

function sameRetractReservations(
  left: readonly RetractReservation[],
  right: readonly RetractReservation[],
): boolean {
  const leftByMessageId = retractReservationMap(left);
  const rightByMessageId = retractReservationMap(right);
  if (leftByMessageId.size !== rightByMessageId.size) return false;
  for (const [messageId, reservation] of leftByMessageId) {
    const other = rightByMessageId.get(messageId);
    if (
      other === undefined ||
      other.deletedAt !== reservation.deletedAt ||
      other.entityVersion !== reservation.entityVersion
    ) {
      return false;
    }
  }
  return true;
}

function sameMessageRow(left: MessageRow | undefined, right: MessageRow | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.id === right.id &&
    left.clientMessageId === right.clientMessageId &&
    left.conversationId === right.conversationId &&
    left.conversationSequence === right.conversationSequence &&
    left.createdAt === right.createdAt &&
    left.value.ciphertext === right.value.ciphertext &&
    left.value.nonce === right.value.nonce &&
    left.value.keyVersion === right.value.keyVersion &&
    left.value.schemaVersion === right.value.schemaVersion &&
    left.value.version === right.value.version
  );
}

function sameMessageRows(
  left: readonly (MessageRow | undefined)[],
  right: readonly (MessageRow | undefined)[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!sameMessageRow(left[i], right[i])) {
      return false;
    }
  }
  return true;
}

function mergeMetadataRow(
  current: MetadataRow | undefined,
  scope: CacheScope,
  patch: Partial<Omit<MetadataRow, "id">>,
): MetadataRow {
  const collections = patch.collections ?? current?.collections;
  const repairMarker =
    patch.repairMarker !== undefined ? patch.repairMarker : current?.repairMarker;
  const retractReservations = patch.retractReservations ?? current?.retractReservations;
  return {
    id: "state",
    ...(collections === undefined ? {} : { collections }),
    userId: patch.userId ?? current?.userId ?? scope.userId,
    workspaceId: patch.workspaceId ?? current?.workspaceId ?? scope.workspaceId,
    syncCursor: patch.syncCursor !== undefined ? patch.syncCursor : (current?.syncCursor ?? null),
    lastSyncedAt:
      patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : (current?.lastSyncedAt ?? null),
    ...(repairMarker === undefined ? {} : { repairMarker }),
    ...(retractReservations === undefined ? {} : { retractReservations }),
  };
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
  conversationId: string,
  encrypted: ReadonlyMap<string, CacheCiphertext>,
): ReactionRow {
  return {
    id: reaction.id,
    messageId: reaction.messageId,
    conversationId,
    userId: reaction.userId,
    createdAt: reaction.createdAt,
    value: encryptedValue(encrypted, "reaction", reaction.id),
  };
}

function reactionRows(
  reactions: readonly Reaction[],
  messages: readonly Message[],
  encrypted: ReadonlyMap<string, CacheCiphertext>,
): ReactionRow[] {
  // Snapshot/history hydration is defined for the supplied message set. Refuse to create a new
  // ownerless row if a malformed hydration response mentions some other message, and never
  // restore reactions for a retained tombstone.
  const conversationIds = new Map(
    messages
      .filter((message) => message.deletedAt === null)
      .map((message) => [message.id, message.conversationId] as const),
  );
  return reactions.flatMap((reaction) => {
    const conversationId = conversationIds.get(reaction.messageId);
    return conversationId === undefined ? [] : [reactionRow(reaction, conversationId, encrypted)];
  });
}

function taskRow(task: Task, encrypted: ReadonlyMap<string, CacheCiphertext>): TaskRow {
  return {
    id: task.id,
    conversationId: task.conversationId,
    assigneeId: task.assigneeId,
    status: task.status,
    rank: task.rank,
    version: task.version,
    updatedAt: task.updatedAt,
    value: encryptedValue(encrypted, "task", task.id),
  };
}

export class PersistentWorkspaceCache implements WorkspaceCache {
  readonly mode = "persistent" as const;
  readonly #crypto: CacheCryptoClient;
  readonly #scope: CacheScope;
  readonly #database: WorkspaceCacheDatabase;
  /** Exact mention IDs from live creates, retained until their matching retract arrives. */
  readonly #createdMessageMentions = new Map<string, readonly string[]>();

  constructor(options: { readonly crypto: CacheCryptoClient; readonly scope: CacheScope }) {
    this.#crypto = options.crypto;
    this.#scope = options.scope;
    this.#database = new WorkspaceCacheDatabase(databaseName(options.scope));
  }

  async readCollections(): Promise<readonly CollectionState[]> {
    return parseCollectionStates((await this.#database.metadata.get("state"))?.collections);
  }

  async commitCollectionMetadata(commit: CollectionCommit, signal?: AbortSignal): Promise<void> {
    await this.#database.transaction(
      "rw",
      this.#database.metadata,
      this.#database.conversations,
      async () => {
        signal?.throwIfAborted();
        await this.#assertNoMembershipRepair();
        const identity = commit.state.identity;
        if (identity.kind !== "files")
          throw new Error("Only session-only file lists use metadata commits");
        if ((await this.#database.conversations.get(identity.conversationId)) === undefined)
          throw new Error("The collection conversation is no longer authorized");
        const current = await this.#database.metadata.get("state");
        const collections = commitCollectionState(
          parseCollectionStates(current?.collections),
          current?.syncCursor ?? null,
          commit,
        );
        await this.#database.metadata.put(mergeMetadataRow(current, this.#scope, { collections }));
        signal?.throwIfAborted();
      },
    );
  }

  async load(): Promise<CachedWorkspaceState> {
    // A process may have stopped after staging the fail-closed marker but before the event's purge
    // transaction began. Finish that transaction before decrypting or returning any cached state.
    await this.#finishStagedMembershipEvent();
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
    const reservations = retractReservationMap(
      parseRetractReservations(metadata?.retractReservations),
    );
    const retainedMessages = applyRetractReservationsToMessages(messages, reservations);
    const retainedConversations = applyRetractReservationsToConversations(
      conversations,
      reservations,
    );
    const retractedIds = retractedMessageIds(retainedMessages, reservations);
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
      workspace === undefined || metadata?.syncCursor == null
        ? null
        : canonicalSnapshot(
            parseSnapshotInput({
              ...workspace,
              members: cappedMembers,
              conversations: retainedConversations,
              syncCursor: metadata.syncCursor,
            }),
          );
    return {
      collections: parseCollectionStates(metadata?.collections).map((state) =>
        state.identity.kind === "files" ? { ...state, loaded: false, nextCursor: null } : state,
      ),
      bootstrap,
      messages: retainedMessages.sort(compareMessages),
      // A reservation may be written before its source message is available locally. Keep orphaned
      // reactions for normal event ordering, but never expose one that belongs to a known retract.
      reactions: reactions
        .filter((reaction) => !retractedIds.has(reaction.messageId))
        .sort(compareReactions),
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
      repairMarker: parseMembershipRepairMarker(metadata?.repairMarker),
      retractReservations: parseRetractReservations(metadata?.retractReservations),
    };
  }

  async replaceSnapshot(
    snapshot: HumanWorkspaceBootstrapResponse | WorkspaceSnapshot,
    messages: readonly Message[],
    reactions: readonly Reaction[] = [],
    tasks: readonly Task[] = [],
    signal?: AbortSignal,
    retractSourceMessageIds: readonly string[] = [],
    collections?: SnapshotCollections,
  ): Promise<boolean> {
    const parsed = parseSnapshotInput(snapshot);
    const authorizedConversationIds = new Set(
      parsed.conversations.map((summary) => summary.conversation.id),
    );
    const inputMessages = messages.map((message) => messageSchema.parse(message));
    const parsedReactions = reactions.map((reaction) => reactionSchema.parse(reaction));
    const parsedTasks = tasks.map((task) => taskSchema.parse(task));
    for (;;) {
      signal?.throwIfAborted();
      const baseReservations = parseRetractReservations(
        (await this.#database.metadata.get("state"))?.retractReservations,
      );
      const nextReservations = reserveTombstonedMessages(baseReservations, inputMessages);
      const reservations = retractReservationMap(nextReservations);
      const parsedMessages = applyRetractReservationsToMessages(inputMessages, reservations);
      const parsedConversations = applyRetractReservationsToConversations(
        parsed.conversations,
        reservations,
      );
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("workspace", parsed.workspace.id, {
          currentUser: parsed.currentUser,
          workspace: parsed.workspace,
          featureFlags: parsed.featureFlags,
        } satisfies WorkspacePayload),
        ...parsed.members.map((member) => protectedRecord("member", member.id, member)),
        ...parsedConversations.map((conversation) =>
          protectedRecord("conversation", conversation.conversation.id, conversation),
        ),
        ...parsedMessages.map((message) => protectedRecord("message", message.id, message)),
        ...parsedReactions.map((reaction) => protectedRecord("reaction", reaction.id, reaction)),
        ...parsedTasks.map((task) => protectedRecord("task", task.id, task)),
      ]);
      signal?.throwIfAborted();
      const outcome = await this.#database.transaction(
        "rw",
        [
          this.#database.metadata,
          this.#database.workspaces,
          this.#database.members,
          this.#database.conversations,
          this.#database.messages,
          this.#database.reactions,
          this.#database.tasks,
          this.#database.outbox,
          this.#database.events,
        ],
        async () => {
          signal?.throwIfAborted();
          const metadata = await this.#database.metadata.get("state");
          const currentReservations = parseRetractReservations(metadata?.retractReservations);
          // Encryption happens before this transaction. Retry if a concurrent retract changed the
          // source set, so the rows written below are encrypted from the current tombstones.
          if (!sameRetractReservations(baseReservations, currentReservations)) return "retry";
          const repairMarker = parseMembershipRepairMarker(metadata?.repairMarker);
          if (
            repairMarker !== null &&
            repairMarker.position.epoch === parsed.syncCursor.epoch &&
            compareSyncPositions(parsed.syncCursor, repairMarker.position) < 0
          ) {
            throw new Error("Authoritative snapshot predates the membership repair marker");
          }
          // A snapshot fetched before a realtime event must never lower the durable cursor or
          // replace counters the event already reconciled.
          if (
            metadata?.syncCursor !== null &&
            metadata?.syncCursor !== undefined &&
            metadata.syncCursor.epoch === parsed.syncCursor.epoch &&
            compareSyncPositions(parsed.syncCursor, metadata.syncCursor) < 0
          ) {
            // The stale snapshot cannot replace the newer projection, but its tombstone still
            // prevents an older history response from restoring the message body later.
            signal?.throwIfAborted();
            if (!sameRetractReservations(currentReservations, nextReservations)) {
              await this.#database.metadata.put(
                mergeMetadataRow(metadata, this.#scope, { retractReservations: nextReservations }),
              );
            }
            signal?.throwIfAborted();
            return "stale";
          }
          const revokedOutboxIds = (await this.#database.outbox.toArray())
            .filter((row) => !authorizedConversationIds.has(row.conversationId))
            .map((row) => row.clientMessageId);
          await Promise.all([
            this.#database.workspaces.clear(),
            this.#database.conversations.clear(),
            this.#database.messages.clear(),
            this.#database.reactions.clear(),
            this.#database.tasks.clear(),
            this.#database.outbox.bulkDelete(revokedOutboxIds),
            this.#database.events.clear(),
          ]);
          await this.#database.workspaces.put({
            id: parsed.workspace.id,
            value: encryptedValue(encrypted, "workspace", parsed.workspace.id),
          });
          await this.#writeMembers(parsed.members, encrypted);
          await this.#database.conversations.bulkPut(
            parsedConversations.map((summary) => ({
              id: summary.conversation.id,
              kind: summary.conversation.kind,
              updatedAt: summary.conversation.updatedAt,
              value: encryptedValue(encrypted, "conversation", summary.conversation.id),
            })),
          );
          await this.#database.messages.bulkPut(
            parsedMessages.map((message) => {
              const reactionSnapshotPosition = collections?.reactionPositions.get(message.id);
              return {
                ...messageRow(message, encrypted),
                ...(reactionSnapshotPosition === undefined ? {} : { reactionSnapshotPosition }),
              };
            }),
          );
          await this.#database.reactions.bulkPut(
            reactionRows(parsedReactions, parsedMessages, encrypted),
          );
          await this.#database.tasks.bulkPut(parsedTasks.map((task) => taskRow(task, encrypted)));
          await this.#database.metadata.put(
            mergeMetadataRow(metadata, this.#scope, {
              ...this.#scope,
              syncCursor: parsed.syncCursor,
              collections: parseCollectionStates(collections?.states),
              lastSyncedAt: new Date().toISOString(),
              repairMarker: null,
              retractReservations: nextReservations,
            }),
          );
          // Throwing inside the transaction rolls every store back when this cache generation was
          // retired while its encrypted replacement was in progress.
          signal?.throwIfAborted();
          return "replaced";
        },
      );
      if (outcome === "retry") continue;
      if (outcome === "stale") return false;
      await this.#evictMessages();
      retainLiveMessageMentions(
        this.#createdMessageMentions,
        parsedMessages,
        parsedConversations,
        retractSourceMessageIds,
      );
      return true;
    }
  }

  async replaceMetadata(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean> {
    return this.#writeMetadata(snapshot, "refresh", signal);
  }

  async stageMetadataPage(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean> {
    return this.#writeMetadata(snapshot, "page", signal);
  }

  async installMetadataSnapshot(
    snapshot: WorkspaceSnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.#writeMetadata(snapshot, "bootstrap", signal);
  }

  async #writeMetadata(
    snapshot: WorkspaceSnapshot,
    mode: MetadataWriteMode,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const parsed = parseSnapshotInput(snapshot);
    const visible = new Set(parsed.conversations.map((summary) => summary.conversation.id));
    for (;;) {
      signal?.throwIfAborted();
      const reservations = parseRetractReservations(
        (await this.#database.metadata.get("state"))?.retractReservations,
      );
      const summaries = applyRetractReservationsToConversations(
        parsed.conversations,
        retractReservationMap(reservations),
      );
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("workspace", parsed.workspace.id, {
          currentUser: parsed.currentUser,
          workspace: parsed.workspace,
          featureFlags: parsed.featureFlags,
        } satisfies WorkspacePayload),
        ...parsed.members.map((member) => protectedRecord("member", member.id, member)),
        ...summaries.map((summary) =>
          protectedRecord("conversation", summary.conversation.id, summary),
        ),
      ]);
      signal?.throwIfAborted();
      const result = await this.#database.transaction(
        "rw",
        [
          this.#database.metadata,
          this.#database.workspaces,
          this.#database.members,
          this.#database.conversations,
          this.#database.messages,
          this.#database.reactions,
          this.#database.tasks,
          this.#database.outbox,
        ],
        async () => {
          signal?.throwIfAborted();
          const metadata = await this.#database.metadata.get("state");
          if (
            !canWriteMetadata(
              metadata?.syncCursor ?? null,
              parsed.syncCursor,
              parseMembershipRepairMarker(metadata?.repairMarker),
              mode,
            )
          )
            return "stale";
          if (
            !sameRetractReservations(
              reservations,
              parseRetractReservations(metadata?.retractReservations),
            )
          )
            return "retry";
          // Retained collection rows and their reaction anchors stay in this transaction's stores.
          // A page can commit while metadata encryption is in flight without being overwritten.
          if (mode !== "page")
            await Promise.all([
              this.#database.workspaces.clear(),
              this.#database.conversations.clear(),
              this.#database.messages.filter((row) => !visible.has(row.conversationId)).delete(),
              this.#database.reactions.filter((row) => !visible.has(row.conversationId)).delete(),
              this.#database.tasks.filter((row) => !visible.has(row.conversationId)).delete(),
              this.#database.outbox.filter((row) => !visible.has(row.conversationId)).delete(),
            ]);
          await this.#database.workspaces.put({
            id: parsed.workspace.id,
            value: encryptedValue(encrypted, "workspace", parsed.workspace.id),
          });
          await this.#writeMembers(parsed.members, encrypted, signal);
          await this.#database.conversations.bulkPut(
            summaries.map((summary) => ({
              id: summary.conversation.id,
              kind: summary.conversation.kind,
              updatedAt: summary.conversation.updatedAt,
              value: encryptedValue(encrypted, "conversation", summary.conversation.id),
            })),
          );
          await this.#database.metadata.put(
            mergeMetadataRow(metadata, this.#scope, {
              collections: metadataCollections(
                parseCollectionStates(metadata?.collections),
                visible,
                parsed.syncCursor,
                mode,
              ),
              ...(mode === "bootstrap"
                ? { syncCursor: parsed.syncCursor, repairMarker: null }
                : {}),
              ...(mode === "page" ? {} : { lastSyncedAt: new Date().toISOString() }),
            }),
          );
          signal?.throwIfAborted();
          return "replaced";
        },
      );
      if (result === "retry") continue;
      return result === "replaced";
    }
  }

  async replaceMembers(members: readonly User[], signal?: AbortSignal): Promise<void> {
    const parsed = members.map((member) => userSchema.parse(member)).sort(compareMembers);
    const encrypted = await encryptRecords(
      this.#crypto,
      parsed.map((member) => protectedRecord("member", member.id, member)),
    );
    signal?.throwIfAborted();
    await this.#database.transaction(
      "rw",
      this.#database.metadata,
      this.#database.members,
      async () => {
        await this.#writeMembers(parsed, encrypted, signal);
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
    await this.#database.transaction(
      "rw",
      this.#database.metadata,
      this.#database.conversations,
      async () => {
        await this.#assertNoMembershipRepair();
        await this.#database.conversations.put({
          id: merged.conversation.id,
          kind: merged.conversation.kind,
          updatedAt: merged.conversation.updatedAt,
          value: encryptedValue(encrypted, "conversation", merged.conversation.id),
        });
      },
    );
  }

  async stageMembershipRepair(event: MembershipChangedEvent): Promise<boolean> {
    const parsed = workspaceEventSchema.parse(event);
    if (parsed.type !== "channel.membership_changed" || parsed.conversationId === null) {
      throw new Error("A channel membership event is required");
    }
    const marker: MembershipRepairMarker = {
      kind: "membership",
      eventId: parsed.id,
      position: parsed.position,
      conversationId: parsed.conversationId,
      selfRemoval:
        parsed.payload.action === "removed" && parsed.payload.memberId === this.#scope.userId,
    };
    return this.#database.transaction("rw", this.#database.metadata, async () => {
      const metadata = await this.#database.metadata.get("state");
      const pending = parseMembershipRepairMarker(metadata?.repairMarker);
      if (pending !== null) {
        if (sameMembershipRepair(pending, parsed)) return false;
        throw new Error("Membership repair is already pending");
      }
      if (
        metadata?.syncCursor !== null &&
        metadata?.syncCursor !== undefined &&
        compareSyncPositions(parsed.position, metadata.syncCursor) <= 0
      ) {
        return false;
      }
      await this.#database.metadata.put(
        mergeMetadataRow(metadata, this.#scope, {
          repairMarker: marker,
        }),
      );
      return true;
    });
  }

  async getCreatedMessageMentions(messageId: string): Promise<readonly string[] | undefined> {
    return this.#createdMessageMentions.get(entityIdSchema.parse(messageId));
  }

  async applyEvent(
    event: WorkspaceEvent,
    signal?: AbortSignal,
    retractSource?: Message,
  ): Promise<CacheEventResult> {
    const parsed = workspaceEventSchema.parse(event);
    for (;;) {
      signal?.throwIfAborted();
      try {
        const outcome = await this.#applyEventAttempt(parsed, signal, retractSource);
        if (outcome !== "retry") return outcome;
      } catch (error) {
        if (error instanceof SupersededCacheEvent) {
          return ignoredCacheEvent(error.committedPosition);
        }
        throw error;
      }
    }
  }

  /**
   * Performs one optimistic event write. A retract reservation can change while encryption is in
   * flight, so the public method retries that transaction race in a loop rather than recursing.
   */
  async #applyEventAttempt(
    parsed: WorkspaceEvent,
    signal?: AbortSignal,
    retractSource?: Message,
  ): Promise<CacheEventResult | "retry"> {
    let changes: Partial<CommittedCacheChanges> = {};
    signal?.throwIfAborted();
    const metadata = await this.#database.metadata.get("state");
    const repairMarker = parseMembershipRepairMarker(metadata?.repairMarker);
    if (
      parsed.type === "channel.membership_changed" &&
      parsed.payload.memberId === this.#scope.userId
    ) {
      if (repairMarker === null) {
        const staged = await this.stageMembershipRepair(parsed);
        if (!staged) return ignoredCacheEvent(metadata?.syncCursor ?? null);
      } else if (!sameMembershipRepair(repairMarker, parsed)) {
        throw new Error("Membership repair must complete before applying later events");
      }
      const applied = await this.#finishStagedMembershipEvent();
      const position = (await this.#database.metadata.get("state"))?.syncCursor ?? parsed.position;
      return applied
        ? committedCacheEvent(position, {
            removedConversationIds:
              parsed.payload.action === "removed" ? [parsed.conversationId] : [],
            invalidated: [{ kind: "membership", conversationId: parsed.conversationId }],
          })
        : ignoredCacheEvent(position);
    }
    if (repairMarker !== null) {
      throw new Error("Membership repair must complete before applying later events");
    }
    if (
      (metadata?.syncCursor !== null &&
        metadata?.syncCursor !== undefined &&
        compareSyncPositions(parsed.position, metadata.syncCursor) <= 0) ||
      (await this.#database.events.get(parsed.id)) !== undefined
    ) {
      return ignoredCacheEvent(metadata?.syncCursor ?? null);
    }

    if (parsed.type === "channel.membership_changed") {
      const current = await this.#conversation(parsed.conversationId);
      const summary =
        current === null ? null : projectConversationMembershipChange(current, parsed);
      changes = { conversations: summary === null ? [] : [summary] };
      const encrypted = await encryptRecords(
        this.#crypto,
        summary === null ? [] : [protectedRecord("conversation", summary.conversation.id, summary)],
      );
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.conversations,
        this.#database.events,
        async () => {
          if (summary !== null) {
            await this.#database.conversations.put({
              id: summary.conversation.id,
              kind: summary.conversation.kind,
              updatedAt: summary.conversation.updatedAt,
              value: encryptedValue(encrypted, "conversation", summary.conversation.id),
            });
          }
          await this.#recordEvent(parsed, signal);
        },
      );
    } else if (parsed.type === "message.created") {
      const [currentSummary, currentMessage] = await Promise.all([
        this.#conversation(parsed.conversationId),
        this.#message(parsed.payload.message.id),
      ]);
      const baseReservations = parseRetractReservations(metadata?.retractReservations);
      const incoming = applyRetractReservation(
        parsed.payload.message,
        retractReservationMap(baseReservations),
      );
      const created = preferRetainedMessage(currentMessage ?? undefined, incoming);
      // The workspace row can be missing while a resync is in flight. Store the message and skip
      // the unread bookkeeping instead of throwing, matching MemoryWorkspaceCache.
      const currentUserId = await this.#currentUserId();
      const nextSummary =
        currentSummary === null || currentUserId === null || created.deletedAt !== null
          ? null
          : projectCreatedMessageSummary(
              currentSummary,
              created,
              currentUserId,
              parsed.payload.mentionedUserIds,
            );
      changes = {
        messages: [created],
        conversations: nextSummary === null ? [] : [nextSummary],
        removedOutboxIds: [created.clientMessageId],
      };
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("message", created.id, created),
        ...(nextSummary === null
          ? []
          : [protectedRecord("conversation", nextSummary.conversation.id, nextSummary)]),
      ]);
      const outcome = await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.messages,
        this.#database.conversations,
        this.#database.outbox,
        this.#database.events,
        async () => {
          const currentMetadata = await this.#database.metadata.get("state");
          if (
            !sameRetractReservations(
              baseReservations,
              parseRetractReservations(currentMetadata?.retractReservations),
            )
          ) {
            return "retry";
          }
          if (
            (currentMetadata?.syncCursor !== null &&
              currentMetadata?.syncCursor !== undefined &&
              compareSyncPositions(parsed.position, currentMetadata.syncCursor) <= 0) ||
            (await this.#database.events.get(parsed.id)) !== undefined
          ) {
            throw new SupersededCacheEvent(currentMetadata?.syncCursor ?? null);
          }
          await this.#database.messages.put({
            ...(await this.#database.messages.get(created.id)),
            ...messageRow(created, encrypted),
          });
          if (nextSummary !== null) {
            await this.#database.conversations.put({
              id: nextSummary.conversation.id,
              kind: nextSummary.conversation.kind,
              updatedAt: nextSummary.conversation.updatedAt,
              value: encryptedValue(encrypted, "conversation", nextSummary.conversation.id),
            });
          }
          await this.#database.outbox.delete(parsed.payload.message.clientMessageId);
          await this.#recordEvent(parsed, signal);
          return "written";
        },
      );
      if (outcome === "retry") return "retry";
      if (created.deletedAt === null) {
        rememberCreatedMessageMentions(
          this.#createdMessageMentions,
          created.id,
          parsed.payload.mentionedUserIds,
        );
      } else {
        this.#createdMessageMentions.delete(created.id);
      }
    } else if (parsed.type === "member.updated") {
      changes = { invalidated: [{ kind: "members" }] };
      // An invalidation signal, not a delta: `payload.member` is a bare `User` with no status
      // field, so upserting it would re-assert a member the server just disabled instead of
      // dropping it. Record the cursor here; WorkspaceRuntime replaces the server-derived member
      // list immediately after applying this event.
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.events,
        async () => {
          await this.#recordEvent(parsed, signal);
        },
      );
    } else if (parsed.type === "reaction.added") {
      changes = { reactions: [parsed.payload.reaction] };
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("reaction", parsed.payload.reaction.id, parsed.payload.reaction),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.messages,
        this.#database.reactions,
        this.#database.events,
        async () => {
          const anchor = (await this.#database.messages.get(parsed.payload.reaction.messageId))
            ?.reactionSnapshotPosition;
          if (anchor !== undefined && compareSyncPositions(parsed.position, anchor) <= 0) {
            changes = {};
            await this.#recordEvent(parsed, signal);
            return;
          }
          await this.#database.reactions.put(
            reactionRow(parsed.payload.reaction, parsed.conversationId, encrypted),
          );
          await this.#recordEvent(parsed, signal);
        },
      );
    } else if (parsed.type === "reaction.removed") {
      changes = { removedReactionIds: [parsed.payload.reaction.id] };
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.messages,
        this.#database.reactions,
        this.#database.events,
        async () => {
          const anchor = (await this.#database.messages.get(parsed.payload.reaction.messageId))
            ?.reactionSnapshotPosition;
          if (anchor !== undefined && compareSyncPositions(parsed.position, anchor) <= 0) {
            changes = {};
            await this.#recordEvent(parsed, signal);
            return;
          }
          await this.#database.reactions.delete(parsed.payload.reaction.id);
          await this.#recordEvent(parsed, signal);
        },
      );
    } else if (parsed.type === "task.created" || parsed.type === "task.updated") {
      const task = parsed.payload.task;
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("task", task.id, task),
      ]);
      await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.tasks,
        this.#database.events,
        async () => {
          const current = await this.#database.tasks.get(task.id);
          if (acceptsTaskVersion(current?.version, task.version)) {
            await this.#database.tasks.put(taskRow(task, encrypted));
            changes = { tasks: [task] };
          }
          await this.#recordEvent(parsed, signal);
        },
      );
    } else if (parsed.type === "message.retracted") {
      const suppliedSource = matchingRetractSource(parsed, retractSource);
      const [currentMessage, currentSummary, currentUser] = await Promise.all([
        this.#message(parsed.payload.messageId),
        this.#conversation(parsed.conversationId),
        this.#currentUser(),
      ]);
      const source =
        currentMessage ??
        (currentSummary?.lastMessage?.id === parsed.payload.messageId
          ? currentSummary.lastMessage
          : suppliedSource);
      const conversationMessages =
        source !== null && currentSummary?.lastMessage?.id === source.id
          ? await this.#conversationMessages(parsed.conversationId)
          : [];
      const tombstone = source === null ? null : tombstoneMessage(source, parsed);
      const messages =
        tombstone === null
          ? conversationMessages
          : [...conversationMessages.filter((message) => message.id !== tombstone.id), tombstone];
      const mentionedUserIds =
        this.#createdMessageMentions.get(parsed.payload.messageId) ??
        (source === null || currentSummary === null || currentUser === null
          ? []
          : mentionedMemberIds(source.body, [currentUser], currentSummary.participantIds));
      const baseReservations = parseRetractReservations(metadata?.retractReservations);
      const retractReservations = upsertRetractReservation(baseReservations, {
        messageId: parsed.payload.messageId,
        deletedAt: parsed.payload.deletedAt,
        entityVersion: parsed.entityVersion,
      });
      const nextSummary =
        currentSummary === null || source === null
          ? null
          : reconcileRetractedConversationSummary(
              currentSummary,
              source,
              messages,
              currentUser,
              mentionedUserIds,
            );
      changes = {
        messages: tombstone === null ? [] : [tombstone],
        conversations: nextSummary === null ? [] : [nextSummary],
        removedMessageReactionIds: [parsed.payload.messageId],
        retractReservations: [
          {
            messageId: parsed.payload.messageId,
            deletedAt: parsed.payload.deletedAt,
            entityVersion: parsed.entityVersion,
          },
        ],
        invalidated:
          source === null
            ? [{ kind: "conversation_metadata", conversationId: parsed.conversationId }]
            : [],
      };
      const encrypted = await encryptRecords(this.#crypto, [
        ...(tombstone === null ? [] : [protectedRecord("message", tombstone.id, tombstone)]),
        ...(nextSummary === null
          ? []
          : [protectedRecord("conversation", nextSummary.conversation.id, nextSummary)]),
      ]);
      const outcome = await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.messages,
        this.#database.conversations,
        this.#database.reactions,
        this.#database.events,
        async () => {
          const currentMetadata = await this.#database.metadata.get("state");
          if (
            !sameRetractReservations(
              baseReservations,
              parseRetractReservations(currentMetadata?.retractReservations),
            )
          ) {
            return "retry";
          }
          if (
            (currentMetadata?.syncCursor !== null &&
              currentMetadata?.syncCursor !== undefined &&
              compareSyncPositions(parsed.position, currentMetadata.syncCursor) <= 0) ||
            (await this.#database.events.get(parsed.id)) !== undefined
          ) {
            throw new SupersededCacheEvent(currentMetadata?.syncCursor ?? null);
          }
          if (tombstone !== null) {
            await this.#database.messages.put({
              ...(await this.#database.messages.get(tombstone.id)),
              ...messageRow(tombstone, encrypted),
            });
          }
          await this.#database.reactions
            .where("messageId")
            .equals(parsed.payload.messageId)
            .delete();
          await this.#recordEvent(parsed, signal, { retractReservations });
          if (nextSummary !== null) {
            await this.#database.conversations.put({
              id: nextSummary.conversation.id,
              kind: nextSummary.conversation.kind,
              updatedAt: nextSummary.conversation.updatedAt,
              value: encryptedValue(encrypted, "conversation", nextSummary.conversation.id),
            });
          }
          return "written";
        },
      );
      if (outcome === "retry") return "retry";
      this.#createdMessageMentions.delete(parsed.payload.messageId);
    } else {
      const current = await this.#conversation(parsed.conversationId);
      let nextSummary: ConversationSummary | null = null;
      if (parsed.type === "read_cursor.updated") {
        // A read cursor for a conversation this cache has never seen is a no-op: there is no
        // summary to attach it to, and a placeholder would invent a conversation the server never
        // sent. MemoryWorkspaceCache makes the same choice. The event is still recorded, so the
        // sync cursor advances past it rather than replaying it forever.
        if (current !== null) {
          nextSummary = projectReadCursorSummary(current, parsed);
        }
      } else {
        nextSummary = projectConversationSummary(current, parsed, this.#scope.userId);
      }
      if (nextSummary === null) {
        await this.#database.transaction(
          "rw",
          this.#database.metadata,
          this.#database.events,
          async () => {
            await this.#recordEvent(parsed, signal);
          },
        );
        return committedCacheEvent(parsed.position, changes);
      }
      const summary = nextSummary;
      changes = { conversations: [summary] };
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
          await this.#recordEvent(parsed, signal);
        },
      );
    }
    return committedCacheEvent(parsed.position, changes);
  }

  async advanceCursor(syncCursor: SyncPosition): Promise<void> {
    await this.#database.transaction("rw", this.#database.metadata, async () => {
      await this.#assertNoMembershipRepair();
      const current = await this.#database.metadata.get("state");
      if (
        current?.syncCursor !== null &&
        current?.syncCursor !== undefined &&
        compareSyncPositions(syncCursor, current.syncCursor) <= 0
      ) {
        return;
      }
      await this.#database.metadata.put(
        mergeMetadataRow(current, this.#scope, {
          ...this.#scope,
          syncCursor,
          lastSyncedAt: new Date().toISOString(),
          repairMarker: null,
        }),
      );
    });
  }

  async upsertAcknowledgedMessage(
    message: Message,
    expectedClientMessageId: string,
    syncCursor: SyncPosition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const input = messageSchema.parse(message);
    const expectedId = entityIdSchema.parse(expectedClientMessageId);
    for (;;) {
      signal?.throwIfAborted();
      const baseReservations = parseRetractReservations(
        (await this.#database.metadata.get("state"))?.retractReservations,
      );
      const nextReservations = reserveTombstonedMessages(baseReservations, [input]);
      const parsed = applyRetractReservation(input, retractReservationMap(nextReservations));
      const encrypted = await encryptRecords(this.#crypto, [
        protectedRecord("message", parsed.id, parsed),
      ]);
      if (signal?.aborted) return false;
      let outcome: "retry" | "rejected" | "written";
      try {
        outcome = await this.#database.transaction(
          "rw",
          this.#database.messages,
          this.#database.outbox,
          this.#database.metadata,
          this.#database.conversations,
          async () => {
            signal?.throwIfAborted();
            const [metadata, pending, conversation] = await Promise.all([
              this.#database.metadata.get("state"),
              this.#database.outbox.get(expectedId),
              this.#database.conversations.get(parsed.conversationId),
            ]);
            const currentReservations = parseRetractReservations(metadata?.retractReservations);
            if (!sameRetractReservations(baseReservations, currentReservations)) return "retry";
            if (
              parseMembershipRepairMarker(metadata?.repairMarker) !== null ||
              pending?.conversationId !== parsed.conversationId ||
              conversation === undefined
            ) {
              return "rejected";
            }
            await this.#database.messages.put({
              ...(await this.#database.messages.get(parsed.id)),
              ...messageRow(parsed, encrypted),
            });
            await this.#database.outbox.bulkDelete([
              ...new Set([expectedId, parsed.clientMessageId]),
            ]);
            await this.#database.metadata.put(
              mergeMetadataRow(metadata, this.#scope, {
                syncCursor:
                  metadata?.syncCursor === null ||
                  metadata?.syncCursor === undefined ||
                  compareSyncPositions(syncCursor, metadata.syncCursor) > 0
                    ? syncCursor
                    : metadata.syncCursor,
                lastSyncedAt: new Date().toISOString(),
                retractReservations: nextReservations,
              }),
            );
            signal?.throwIfAborted();
            return "written";
          },
        );
      } catch (error) {
        if (signal?.aborted) return false;
        throw error;
      }
      if (outcome === "retry") continue;
      return outcome === "written" && signal?.aborted !== true;
    }
  }

  async upsertHistory(
    conversationId: string,
    messages: readonly Message[],
    reactions?: readonly Reaction[],
    signal?: AbortSignal,
    collection?: CollectionCommit,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const expectedConversationId = entityIdSchema.parse(conversationId);
    if (
      collection !== undefined &&
      ((collection.state.identity.kind !== "timeline" &&
        collection.state.identity.kind !== "thread") ||
        collection.state.identity.conversationId !== expectedConversationId)
    )
      throw new Error("The collection identity does not match this history page");
    const inputMessages = messages.map((message) => messageSchema.parse(message));
    if (inputMessages.some((message) => message.conversationId !== expectedConversationId)) {
      throw new Error("The workspace history crossed conversation scope");
    }
    const parsedReactions = reactions?.map((reaction) => reactionSchema.parse(reaction));
    for (;;) {
      signal?.throwIfAborted();
      const baseReservations = parseRetractReservations(
        (await this.#database.metadata.get("state"))?.retractReservations,
      );
      const nextReservations = reserveTombstonedMessages(baseReservations, inputMessages);
      const parsed = applyRetractReservationsToMessages(
        inputMessages,
        retractReservationMap(nextReservations),
      );
      const encrypted = await encryptRecords(this.#crypto, [
        ...parsed.map((message) => protectedRecord("message", message.id, message)),
        ...(parsedReactions ?? []).map((reaction) =>
          protectedRecord("reaction", reaction.id, reaction),
        ),
      ]);
      const existingRows = await this.#database.messages.bulkGet(
        parsed.map((message) => message.id),
      );
      const existing = await decryptRows(
        this.#crypto,
        "message",
        existingRows.filter((row): row is NonNullable<typeof row> => row !== undefined),
        existingRows.flatMap((row) => (row === undefined ? [] : [row.id])),
        (value) => messageSchema.parse(value),
      );
      const existingById = new Map(existing.map((message) => [message.id, message]));
      if (signal?.aborted) return false;
      let outcome: "retry" | "rejected" | "written";
      try {
        outcome = await this.#database.transaction(
          "rw",
          this.#database.messages,
          this.#database.reactions,
          this.#database.metadata,
          this.#database.conversations,
          async () => {
            signal?.throwIfAborted();
            const [metadata, conversation, currentRows] = await Promise.all([
              this.#database.metadata.get("state"),
              this.#database.conversations.get(expectedConversationId),
              this.#database.messages.bulkGet(parsed.map((message) => message.id)),
            ]);
            const collections =
              collection === undefined
                ? undefined
                : commitCollectionState(
                    parseCollectionStates(metadata?.collections),
                    metadata?.syncCursor ?? null,
                    collection,
                  );
            const currentReservations = parseRetractReservations(metadata?.retractReservations);
            if (!sameRetractReservations(baseReservations, currentReservations)) return "retry";
            if (!sameMessageRows(existingRows, currentRows)) return "retry";
            if (parsedReactions !== undefined)
              for (const row of currentRows)
                assertReactionSnapshotCurrent(row?.reactionSnapshotPosition, collection);
            if (parseMembershipRepairMarker(metadata?.repairMarker) !== null) {
              throw new Error("Membership repair must complete before mutating the cache");
            }
            if (conversation === undefined) return "rejected";
            const retainedMessages = parsed.map((message) =>
              preferRetainedMessage(existingById.get(message.id), message),
            );
            await this.#database.messages.bulkPut(
              parsed
                .filter((message, index) => retainedMessages[index] === message)
                .map((message) => {
                  const previous = existingRows.find((row) => row?.id === message.id);
                  const reactionSnapshotPosition =
                    collection === undefined || parsedReactions === undefined
                      ? previous?.reactionSnapshotPosition
                      : (collection.state.snapshotPosition ?? undefined);
                  return {
                    ...messageRow(message, encrypted),
                    ...(reactionSnapshotPosition === undefined ? {} : { reactionSnapshotPosition }),
                  };
                }),
            );
            if (collection?.state.snapshotPosition != null && parsedReactions !== undefined) {
              for (const [index, message] of parsed.entries())
                if (retainedMessages[index] !== message)
                  await this.#database.messages.update(message.id, {
                    reactionSnapshotPosition: collection.state.snapshotPosition,
                  });
            }
            const retractedIds = new Set(
              retainedMessages
                .filter((message) => message.deletedAt !== null)
                .map((message) => message.id),
            );
            if (parsedReactions !== undefined) {
              const messageIds = parsed.map((message) => message.id);
              await this.#database.reactions.where("messageId").anyOf(messageIds).delete();
              await this.#database.reactions.bulkPut(
                reactionRows(parsedReactions, retainedMessages, encrypted),
              );
            } else if (retractedIds.size > 0) {
              await this.#database.reactions
                .where("messageId")
                .anyOf([...retractedIds])
                .delete();
            }
            await this.#database.metadata.put(
              mergeMetadataRow(metadata, this.#scope, {
                retractReservations: nextReservations,
                ...(collections === undefined ? {} : { collections }),
              }),
            );
            signal?.throwIfAborted();
            return "written";
          },
        );
      } catch (error) {
        if (signal?.aborted) return false;
        throw error;
      }
      if (outcome === "retry") continue;
      if (outcome === "rejected") return false;
      await this.#evictMessages();
      return signal?.aborted !== true;
    }
  }

  async upsertReaction(
    reaction: Reaction,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const parsed = reactionSchema.parse(reaction);
    const expectedConversationId = entityIdSchema.parse(conversationId);
    const encrypted = await encryptRecords(this.#crypto, [
      protectedRecord("reaction", parsed.id, parsed),
    ]);
    if (signal?.aborted) return false;
    try {
      return await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.reactions,
        this.#database.conversations,
        async () => {
          signal?.throwIfAborted();
          const [metadata, conversation] = await Promise.all([
            this.#database.metadata.get("state"),
            this.#database.conversations.get(expectedConversationId),
          ]);
          if (parseMembershipRepairMarker(metadata?.repairMarker) !== null) {
            throw new Error("Membership repair must complete before mutating the cache");
          }
          if (conversation === undefined) return false;
          await this.#database.reactions.put(
            reactionRow(parsed, expectedConversationId, encrypted),
          );
          signal?.throwIfAborted();
          return true;
        },
      );
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
  }

  async removeReaction(reactionId: string): Promise<void> {
    await this.#database.reactions.delete(reactionId);
  }

  async upsertTasks(
    tasks: readonly Task[],
    signal?: AbortSignal,
    collection?: CollectionCommit,
  ): Promise<readonly Task[]> {
    if (
      collection !== undefined &&
      collection.state.identity.kind !== "tasks" &&
      collection.state.identity.kind !== "my_tasks"
    )
      throw new Error("The collection identity does not match this task page");
    if (signal?.aborted) return [];
    const parsed = tasks.map((task) => taskSchema.parse(task));
    if (parsed.length === 0 && collection === undefined) return [];
    const encrypted = await encryptRecords(
      this.#crypto,
      parsed.map((task) => protectedRecord("task", task.id, task)),
    );
    if (signal?.aborted) return [];
    try {
      return await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.tasks,
        this.#database.conversations,
        async () => {
          signal?.throwIfAborted();
          const metadata = await this.#database.metadata.get("state");
          if (parseMembershipRepairMarker(metadata?.repairMarker) !== null) {
            throw new Error("Membership repair must complete before mutating the cache");
          }
          const collections =
            collection === undefined
              ? undefined
              : commitCollectionState(
                  parseCollectionStates(metadata?.collections),
                  metadata?.syncCursor ?? null,
                  collection,
                );
          if (collection !== undefined && collection.state.identity.kind !== "my_tasks") {
            if (
              (await this.#database.conversations.get(collection.state.identity.conversationId)) ===
              undefined
            )
              throw new Error("The collection conversation is no longer authorized");
          }
          const conversationIds = [...new Set(parsed.map((task) => task.conversationId))];
          const conversations = await this.#database.conversations.bulkGet(conversationIds);
          const authorizedIds = new Set(
            conversationIds.filter((_conversationId, index) => conversations[index] !== undefined),
          );
          const authorized = parsed.filter((task) => authorizedIds.has(task.conversationId));
          const existingRows = await this.#database.tasks.bulkGet(
            authorized.map((task) => task.id),
          );
          const accepted = authorized.filter((task, index) => {
            const existingVersion = existingRows[index]?.version;
            return acceptsTaskVersion(existingVersion, task.version);
          });
          await this.#database.tasks.bulkPut(accepted.map((task) => taskRow(task, encrypted)));
          if (collections !== undefined)
            await this.#database.metadata.put(
              mergeMetadataRow(metadata, this.#scope, { collections }),
            );
          signal?.throwIfAborted();
          return accepted;
        },
      );
    } catch (error) {
      if (signal?.aborted) return [];
      throw error;
    }
  }

  async enqueue(
    operation: SendMessageOperation,
    createdAt = new Date().toISOString(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const parsed = sendMessageOperationSchema.parse(operation);
    const id = parsed.message.clientMessageId;
    const encrypted = await encryptRecords(this.#crypto, [protectedRecord("outbox", id, parsed)]);
    if (signal?.aborted) return false;
    try {
      return await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.outbox,
        this.#database.conversations,
        async () => {
          signal?.throwIfAborted();
          const [metadata, conversation, existing] = await Promise.all([
            this.#database.metadata.get("state"),
            this.#database.conversations.get(parsed.conversationId),
            this.#database.outbox.get(id),
          ]);
          if (parseMembershipRepairMarker(metadata?.repairMarker) !== null) {
            throw new Error("Membership repair must complete before mutating the cache");
          }
          if (conversation === undefined) return false;
          if (existing !== undefined) return true;
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
          signal?.throwIfAborted();
          return true;
        },
      );
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
  }

  async replaceOutbox(
    clientMessageId: string,
    operation: SendMessageOperation,
    createdAt: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const predecessorId = entityIdSchema.parse(clientMessageId);
    const parsed = sendMessageOperationSchema.parse(operation);
    const replacementId = parsed.message.clientMessageId;
    const encrypted = await encryptRecords(this.#crypto, [
      protectedRecord("outbox", replacementId, parsed),
    ]);
    if (signal?.aborted) return false;
    try {
      return await this.#database.transaction(
        "rw",
        this.#database.metadata,
        this.#database.outbox,
        this.#database.conversations,
        async () => {
          signal?.throwIfAborted();
          const [metadata, conversation, predecessor, replacement] = await Promise.all([
            this.#database.metadata.get("state"),
            this.#database.conversations.get(parsed.conversationId),
            this.#database.outbox.get(predecessorId),
            this.#database.outbox.get(replacementId),
          ]);
          if (parseMembershipRepairMarker(metadata?.repairMarker) !== null) {
            throw new Error("Membership repair must complete before mutating the cache");
          }
          if (
            conversation === undefined ||
            predecessor?.conversationId !== parsed.conversationId ||
            replacement !== undefined
          ) {
            return false;
          }
          await this.#database.outbox.add({
            clientMessageId: replacementId,
            conversationId: parsed.conversationId,
            createdAt,
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: null,
            failureReason: null,
            value: encryptedValue(encrypted, "outbox", replacementId),
          });
          await this.#database.outbox.delete(predecessorId);
          signal?.throwIfAborted();
          return true;
        },
      );
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
  }

  async updateOutbox(
    clientMessageId: string,
    update: {
      readonly status: OutboxStatus;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly failureReason: string | null;
    },
    signal?: AbortSignal,
    expected?: OutboxUpdateExpectation,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const id = entityIdSchema.parse(clientMessageId);
    try {
      return await this.#database.transaction("rw", this.#database.outbox, async () => {
        signal?.throwIfAborted();
        const current = await this.#database.outbox.get(id);
        if (current === undefined || !matchesOutboxExpectation(current, expected)) return false;
        await this.#database.outbox.update(id, update);
        // Throwing inside the transaction rolls the status write back when a projection is retired
        // while IndexedDB is still completing the update.
        signal?.throwIfAborted();
        return true;
      });
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    await this.#database.outbox.delete(clientMessageId);
  }

  async clearServerStatePreservingOutbox(): Promise<void> {
    await this.#clearServerState(false);
  }

  async resetProtocolReplica(): Promise<void> {
    await this.#clearServerState(true);
  }

  async #clearServerState(resetProtocol: boolean): Promise<void> {
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
        if (!resetProtocol) await this.#assertNoMembershipRepair();
        const reservations = resetProtocol
          ? []
          : parseRetractReservations(
              (await this.#database.metadata.get("state"))?.retractReservations,
            );
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
        if (reservations.length > 0) {
          await this.#database.metadata.put(
            mergeMetadataRow(undefined, this.#scope, {
              retractReservations: reservations,
            }),
          );
        }
      },
    );
    this.#createdMessageMentions.clear();
  }

  async clearAll(): Promise<void> {
    this.#createdMessageMentions.clear();
    this.#database.close();
    await Dexie.delete(this.#database.name);
  }

  async #finishStagedMembershipEvent(): Promise<boolean> {
    return this.#database.transaction(
      "rw",
      [
        this.#database.metadata,
        this.#database.conversations,
        this.#database.messages,
        this.#database.reactions,
        this.#database.tasks,
        this.#database.outbox,
        this.#database.events,
      ],
      async () => {
        const metadata = await this.#database.metadata.get("state");
        const marker = parseMembershipRepairMarker(metadata?.repairMarker);
        if (marker === null) return false;
        const alreadyRecorded = (await this.#database.events.get(marker.eventId)) !== undefined;

        if (marker.selfRemoval) {
          await Promise.all([
            this.#database.conversations.delete(marker.conversationId),
            this.#database.messages.where("conversationId").equals(marker.conversationId).delete(),
            this.#database.reactions
              .where("conversationId")
              .anyOf(marker.conversationId, UNKNOWN_REACTION_CONVERSATION_ID)
              .delete(),
            this.#database.tasks.where("conversationId").equals(marker.conversationId).delete(),
            this.#database.outbox.where("conversationId").equals(marker.conversationId).delete(),
          ]);
        }

        await this.#database.events.put({
          id: marker.eventId,
          workspaceSequence: marker.position.sequence,
        });
        await this.#database.metadata.put(
          mergeMetadataRow(metadata, this.#scope, {
            collections: parseCollectionStates(metadata?.collections).filter(
              (state) =>
                state.identity.kind !== "my_tasks" &&
                state.identity.conversationId !== marker.conversationId,
            ),
            syncCursor:
              metadata?.syncCursor === null ||
              metadata?.syncCursor === undefined ||
              compareSyncPositions(marker.position, metadata.syncCursor) > 0
                ? marker.position
                : metadata.syncCursor,
            lastSyncedAt: new Date().toISOString(),
            repairMarker: marker,
          }),
        );
        return !alreadyRecorded;
      },
    );
  }

  async #assertNoMembershipRepair(): Promise<void> {
    const metadata = await this.#database.metadata.get("state");
    if (parseMembershipRepairMarker(metadata?.repairMarker) !== null) {
      throw new Error("Membership repair must complete before mutating the cache");
    }
  }

  async #message(id: string): Promise<Message | null> {
    const row = await this.#database.messages.get(id);
    if (row === undefined) return null;
    return (
      (
        await decryptRows(this.#crypto, "message", [row], [id], (value) =>
          messageSchema.parse(value),
        )
      )[0] ?? null
    );
  }

  async #conversationMessages(conversationId: string): Promise<Message[]> {
    const rows = await this.#database.messages
      .where("conversationId")
      .equals(conversationId)
      .toArray();
    return decryptRows(
      this.#crypto,
      "message",
      rows,
      rows.map((row) => row.id),
      (value) => messageSchema.parse(value),
    );
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

  /**
   * Null when no workspace row is cached — the window a resync opens between
   * `clearServerStatePreservingOutbox()` and the next snapshot refresh. Callers treat that as
   * "identity unknown" and skip identity-dependent bookkeeping instead of failing the event.
   */
  async #currentUser(): Promise<User | null> {
    const row = (await this.#database.workspaces.toArray())[0];
    if (row === undefined) return null;
    const payload = (
      await decryptRows(this.#crypto, "workspace", [row], [row.id], (value) =>
        workspaceSnapshotSchema.shape.currentUser.parse(
          (value as Partial<WorkspacePayload>).currentUser,
        ),
      )
    )[0];
    return payload?.user ?? null;
  }

  async #currentUserId(): Promise<string | null> {
    return (await this.#currentUser())?.id ?? null;
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
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.#database.members.clear();
    signal?.throwIfAborted();
    await this.#database.members.bulkPut(
      members.map((member) => ({
        id: member.id,
        updatedAt: member.updatedAt,
        value: encryptedValue(encrypted, "member", member.id),
      })),
    );
    signal?.throwIfAborted();
  }

  async #recordEvent(
    event: WorkspaceEvent,
    signal?: AbortSignal,
    extras: Pick<MetadataRow, "retractReservations"> = {},
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.#assertNoMembershipRepair();
    const current = await this.#database.metadata.get("state");
    if (
      (current?.syncCursor != null &&
        compareSyncPositions(event.position, current.syncCursor) <= 0) ||
      (await this.#database.events.get(event.id)) !== undefined
    ) {
      throw new SupersededCacheEvent(current?.syncCursor ?? null);
    }
    const currentReservations = parseRetractReservations(current?.retractReservations);
    const retractReservations =
      extras.retractReservations === undefined
        ? undefined
        : extras.retractReservations.reduce(
            (merged, reservation) => upsertRetractReservation(merged, reservation),
            currentReservations,
          );
    const syncCursor =
      current?.syncCursor !== null &&
      current?.syncCursor !== undefined &&
      compareSyncPositions(current.syncCursor, event.position) > 0
        ? current.syncCursor
        : event.position;
    await this.#database.events.put({
      id: event.id,
      workspaceSequence: event.position.sequence,
    });
    await this.#database.metadata.put(
      mergeMetadataRow(current, this.#scope, {
        syncCursor,
        collections: invalidateCollections(parseCollectionStates(current?.collections), event),
        lastSyncedAt: new Date().toISOString(),
        ...(retractReservations === undefined ? {} : { retractReservations }),
      }),
    );
    signal?.throwIfAborted();
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
  readonly #reactionConversationIds = new Map<string, string>();
  readonly #tasks = new Map<string, Task>();
  readonly #outbox = new Map<string, OutboxItem>();
  readonly #events = new Set<string>();
  readonly #reactionSnapshotPositions = new Map<string, SyncPosition>();
  #collections: readonly CollectionState[] = [];
  #syncCursor: SyncPosition | null = null;
  #lastSyncedAt: string | null = null;
  #repairMarker: MembershipRepairMarker | null = null;
  #retractReservations: RetractReservation[] = [];
  #currentUserId: string | null = null;
  /** Exact mention IDs from live creates, retained until their matching retract arrives. */
  readonly #createdMessageMentions = new Map<string, readonly string[]>();

  async readCollections(): Promise<readonly CollectionState[]> {
    return this.#collections;
  }

  async commitCollectionMetadata(commit: CollectionCommit, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#assertNoMembershipRepair();
    const identity = commit.state.identity;
    if (identity.kind !== "files")
      throw new Error("Only session-only file lists use metadata commits");
    if (
      !this.#snapshot?.conversations.some(
        (summary) => summary.conversation.id === identity.conversationId,
      )
    )
      throw new Error("The collection conversation is no longer authorized");
    this.#collections = commitCollectionState(this.#collections, this.#syncCursor, commit);
  }

  async load(): Promise<CachedWorkspaceState> {
    this.#finishStagedMembershipEvent();
    const reservations = retractReservationMap(this.#retractReservations);
    const retainedMessages = applyRetractReservationsToMessages(
      [...this.#messages.values()],
      reservations,
    );
    const retractedIds = retractedMessageIds(retainedMessages, reservations);
    const snapshot =
      this.#snapshot === null
        ? null
        : {
            ...this.#snapshot,
            conversations: applyRetractReservationsToConversations(
              this.#snapshot.conversations,
              reservations,
            ),
          };
    // The reported snapshot cursor tracks applied events, matching how PersistentWorkspaceCache
    // rebuilds it from the metadata row.
    const syncCursor = this.#syncCursor;
    const bootstrap =
      snapshot === null || syncCursor === null
        ? null
        : canonicalSnapshot({ ...snapshot, members: [...this.#members], syncCursor });
    return {
      collections: this.#collections.map((state) =>
        state.identity.kind === "files" ? { ...state, loaded: false, nextCursor: null } : state,
      ),
      bootstrap,
      // Map insertion order is arrival order, not conversation order; sort so "load older
      // messages" cannot append history below newer messages and so `messages.at(-1)` is really
      // the newest message, exactly like PersistentWorkspaceCache.
      messages: retainedMessages.sort(compareMessages),
      reactions: [...this.#reactions.values()]
        .filter((reaction) => !retractedIds.has(reaction.messageId))
        .sort(compareReactions),
      tasks: [...this.#tasks.values()].sort(compareTasks),
      outbox: [...this.#outbox.values()]
        .map((item): OutboxItem => ({
          ...item,
          status: item.status === "sending" ? "pending" : item.status,
        }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      syncCursor: this.#syncCursor,
      lastSyncedAt: this.#lastSyncedAt,
      repairMarker: this.#repairMarker,
      retractReservations: this.#retractReservations,
    };
  }

  async replaceSnapshot(
    snapshot: HumanWorkspaceBootstrapResponse | WorkspaceSnapshot,
    messages: readonly Message[],
    reactions: readonly Reaction[] = [],
    tasks: readonly Task[] = [],
    signal?: AbortSignal,
    retractSourceMessageIds: readonly string[] = [],
    collections?: SnapshotCollections,
  ): Promise<boolean> {
    const parsed = parseSnapshotInput(snapshot);
    const authorizedConversationIds = new Set(
      parsed.conversations.map((summary) => summary.conversation.id),
    );
    const parsedMessages = messages.map((message) => messageSchema.parse(message));
    const parsedReactions = reactions.map((reaction) => reactionSchema.parse(reaction));
    const parsedTasks = tasks.map((task) => taskSchema.parse(task));
    signal?.throwIfAborted();
    if (
      this.#repairMarker !== null &&
      this.#repairMarker.position.epoch === parsed.syncCursor.epoch &&
      compareSyncPositions(parsed.syncCursor, this.#repairMarker.position) < 0
    ) {
      throw new Error("Authoritative snapshot predates the membership repair marker");
    }
    const nextReservations = reserveTombstonedMessages(this.#retractReservations, parsedMessages);
    if (
      this.#syncCursor !== null &&
      this.#syncCursor.epoch === parsed.syncCursor.epoch &&
      compareSyncPositions(parsed.syncCursor, this.#syncCursor) < 0
    ) {
      this.#retractReservations = nextReservations;
      return false;
    }
    this.#retractReservations = nextReservations;
    const reservations = retractReservationMap(nextReservations);
    const retainedMessages = applyRetractReservationsToMessages(parsedMessages, reservations);
    const retainedConversations = applyRetractReservationsToConversations(
      parsed.conversations,
      reservations,
    );
    const liveConversationIds = new Map(
      retainedMessages
        .filter((message) => message.deletedAt === null)
        .map((message) => [message.id, message.conversationId] as const),
    );
    this.#snapshot = { ...parsed, conversations: retainedConversations };
    this.#currentUserId = parsed.currentUser.user.id;
    this.#members = parsed.members;
    this.#messages.clear();
    for (const message of retainedMessages) this.#messages.set(message.id, message);
    this.#reactions.clear();
    this.#reactionConversationIds.clear();
    for (const reaction of parsedReactions) {
      const conversationId = liveConversationIds.get(reaction.messageId);
      if (conversationId === undefined) continue;
      this.#reactions.set(reaction.id, reaction);
      this.#reactionConversationIds.set(reaction.id, conversationId);
    }
    this.#tasks.clear();
    for (const task of parsedTasks) this.#tasks.set(task.id, task);
    for (const [id, item] of this.#outbox) {
      if (!authorizedConversationIds.has(item.operation.conversationId)) this.#outbox.delete(id);
    }
    this.#syncCursor = parsed.syncCursor;
    this.#collections = parseCollectionStates(collections?.states);
    this.#reactionSnapshotPositions.clear();
    for (const [messageId, position] of collections?.reactionPositions ?? [])
      this.#reactionSnapshotPositions.set(messageId, position);
    this.#lastSyncedAt = new Date().toISOString();
    this.#repairMarker = null;
    retainLiveMessageMentions(
      this.#createdMessageMentions,
      retainedMessages,
      retainedConversations,
      retractSourceMessageIds,
    );
    return true;
  }

  async replaceMetadata(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean> {
    return this.#writeMetadata(snapshot, "refresh", signal);
  }

  async stageMetadataPage(snapshot: WorkspaceSnapshot, signal?: AbortSignal): Promise<boolean> {
    return this.#writeMetadata(snapshot, "page", signal);
  }

  async installMetadataSnapshot(
    snapshot: WorkspaceSnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.#writeMetadata(snapshot, "bootstrap", signal);
  }

  async #writeMetadata(
    snapshot: WorkspaceSnapshot,
    mode: MetadataWriteMode,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const parsed = parseSnapshotInput(snapshot);
    signal?.throwIfAborted();
    if (!canWriteMetadata(this.#syncCursor, parsed.syncCursor, this.#repairMarker, mode))
      return false;
    const visible = new Set(parsed.conversations.map((summary) => summary.conversation.id));
    this.#snapshot = {
      ...parsed,
      conversations: applyRetractReservationsToConversations(
        mode === "page"
          ? [
              ...(this.#snapshot?.conversations ?? []).filter(
                (summary) => !visible.has(summary.conversation.id),
              ),
              ...parsed.conversations,
            ]
          : parsed.conversations,
        retractReservationMap(this.#retractReservations),
      ),
    };
    this.#currentUserId = parsed.currentUser.user.id;
    this.#members = parsed.members;
    if (mode !== "page") {
      for (const [id, message] of this.#messages)
        if (!visible.has(message.conversationId)) {
          this.#messages.delete(id);
          this.#reactionSnapshotPositions.delete(id);
        }
      for (const [id, conversationId] of this.#reactionConversationIds)
        if (!visible.has(conversationId)) {
          this.#reactions.delete(id);
          this.#reactionConversationIds.delete(id);
        }
      for (const [id, task] of this.#tasks)
        if (!visible.has(task.conversationId)) this.#tasks.delete(id);
      for (const [id, item] of this.#outbox)
        if (!visible.has(item.operation.conversationId)) this.#outbox.delete(id);
    }
    this.#collections = metadataCollections(this.#collections, visible, parsed.syncCursor, mode);
    if (mode === "bootstrap") {
      this.#syncCursor = parsed.syncCursor;
      this.#repairMarker = null;
    }
    if (mode !== "page") this.#lastSyncedAt = new Date().toISOString();
    return true;
  }

  async replaceMembers(members: readonly User[], signal?: AbortSignal): Promise<void> {
    const parsed = members.map((member) => userSchema.parse(member)).sort(compareMembers);
    // Persists regardless of `#snapshot`, matching PersistentWorkspaceCache's independent members
    // table -- a replaceMembers call that arrives before the first replaceSnapshot must not be
    // silently discarded, even though `load()` still reports no bootstrap until a snapshot exists.
    signal?.throwIfAborted();
    this.#members = parsed;
    if (this.#snapshot !== null) this.#snapshot = { ...this.#snapshot, members: parsed };
  }

  async upsertConversation(summary: ConversationSummary): Promise<void> {
    this.#assertNoMembershipRepair();
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

  async stageMembershipRepair(event: MembershipChangedEvent): Promise<boolean> {
    const parsed = workspaceEventSchema.parse(event);
    if (parsed.type !== "channel.membership_changed" || parsed.conversationId === null) {
      throw new Error("A channel membership event is required");
    }
    if (this.#repairMarker !== null) {
      if (sameMembershipRepair(this.#repairMarker, parsed)) return false;
      throw new Error("Membership repair is already pending");
    }
    if (this.#syncCursor !== null && compareSyncPositions(parsed.position, this.#syncCursor) <= 0) {
      return false;
    }
    this.#repairMarker = {
      kind: "membership",
      eventId: parsed.id,
      position: parsed.position,
      conversationId: parsed.conversationId,
      selfRemoval:
        parsed.payload.action === "removed" && parsed.payload.memberId === this.#currentUserId,
    };
    return true;
  }

  async getCreatedMessageMentions(messageId: string): Promise<readonly string[] | undefined> {
    return this.#createdMessageMentions.get(entityIdSchema.parse(messageId));
  }

  async applyEvent(
    event: WorkspaceEvent,
    signal?: AbortSignal,
    retractSource?: Message,
  ): Promise<CacheEventResult> {
    let changes: Partial<CommittedCacheChanges> = {};
    signal?.throwIfAborted();
    const parsed = workspaceEventSchema.parse(event);
    if (
      parsed.type === "channel.membership_changed" &&
      (this.#currentUserId === null || parsed.payload.memberId === this.#currentUserId)
    ) {
      if (this.#repairMarker === null) {
        const staged = await this.stageMembershipRepair(parsed);
        if (!staged) return ignoredCacheEvent(this.#syncCursor);
      } else if (!sameMembershipRepair(this.#repairMarker, parsed)) {
        throw new Error("Membership repair must complete before applying later events");
      }
      const applied = this.#finishStagedMembershipEvent();
      return applied
        ? committedCacheEvent(this.#syncCursor ?? parsed.position, {
            removedConversationIds:
              parsed.payload.action === "removed" ? [parsed.conversationId] : [],
            invalidated: [{ kind: "membership", conversationId: parsed.conversationId }],
          })
        : ignoredCacheEvent(this.#syncCursor);
    }
    this.#assertNoMembershipRepair();
    const suppliedRetractSource =
      parsed.type === "message.retracted" ? matchingRetractSource(parsed, retractSource) : null;
    if (
      this.#events.has(parsed.id) ||
      (this.#syncCursor !== null && compareSyncPositions(parsed.position, this.#syncCursor) <= 0)
    ) {
      return ignoredCacheEvent(this.#syncCursor);
    }
    this.#collections = invalidateCollections(this.#collections, parsed);
    this.#events.add(parsed.id);
    this.#syncCursor = parsed.position;
    this.#lastSyncedAt = new Date().toISOString();
    if (parsed.type === "reaction.added" || parsed.type === "reaction.removed") {
      const anchor = this.#reactionSnapshotPositions.get(parsed.payload.reaction.messageId);
      if (anchor !== undefined && compareSyncPositions(parsed.position, anchor) <= 0)
        return committedCacheEvent(parsed.position, {});
    }
    if (parsed.type === "channel.membership_changed") {
      if (this.#snapshot !== null) {
        const conversations = new Map(
          this.#snapshot.conversations.map((summary) => [summary.conversation.id, summary]),
        );
        const current = conversations.get(parsed.conversationId);
        if (current !== undefined) {
          conversations.set(
            parsed.conversationId,
            projectConversationMembershipChange(current, parsed),
          );
          this.#snapshot = { ...this.#snapshot, conversations: [...conversations.values()] };
          const changed = conversations.get(parsed.conversationId);
          changes = { ...changes, conversations: changed === undefined ? [] : [changed] };
        }
      }
    } else if (parsed.type === "message.created") {
      const incoming = applyRetractReservation(
        parsed.payload.message,
        retractReservationMap(this.#retractReservations),
      );
      const created = preferRetainedMessage(this.#messages.get(incoming.id), incoming);
      this.#messages.set(created.id, created);
      changes = { messages: [created], removedOutboxIds: [created.clientMessageId] };
      if (created.deletedAt === null) {
        rememberCreatedMessageMentions(
          this.#createdMessageMentions,
          created.id,
          parsed.payload.mentionedUserIds,
        );
      } else {
        this.#createdMessageMentions.delete(created.id);
      }
      this.#outbox.delete(created.clientMessageId);
      if (created.deletedAt === null && this.#snapshot !== null && parsed.conversationId !== null) {
        const conversations = new Map(
          this.#snapshot.conversations.map((summary) => [summary.conversation.id, summary]),
        );
        const current = conversations.get(parsed.conversationId);
        if (current !== undefined) {
          const currentUserId = this.#snapshot.currentUser.user.id;
          conversations.set(
            parsed.conversationId,
            projectCreatedMessageSummary(
              current,
              created,
              currentUserId,
              parsed.payload.mentionedUserIds,
            ),
          );
          this.#snapshot = {
            ...this.#snapshot,
            conversations: [...conversations.values()],
          };
          const changed = conversations.get(parsed.conversationId);
          changes = { ...changes, conversations: changed === undefined ? [] : [changed] };
        }
      }
    } else if (parsed.type === "reaction.added") {
      changes = { reactions: [parsed.payload.reaction] };
      this.#reactions.set(parsed.payload.reaction.id, parsed.payload.reaction);
      this.#reactionConversationIds.set(parsed.payload.reaction.id, parsed.conversationId);
    } else if (parsed.type === "reaction.removed") {
      changes = { removedReactionIds: [parsed.payload.reaction.id] };
      this.#reactions.delete(parsed.payload.reaction.id);
      this.#reactionConversationIds.delete(parsed.payload.reaction.id);
    } else if (parsed.type === "task.created" || parsed.type === "task.updated") {
      const current = this.#tasks.get(parsed.payload.task.id);
      if (acceptsTaskVersion(current?.version, parsed.payload.task.version)) {
        this.#tasks.set(parsed.payload.task.id, parsed.payload.task);
        changes = { tasks: [parsed.payload.task] };
      }
    } else if (parsed.type === "member.updated") {
      changes = { invalidated: [{ kind: "members" }] };
      // WorkspaceRuntime replaces the server-derived member list because `payload.member` cannot
      // express a removal. Advancing the cursor above keeps this event idempotent until then.
    } else if (parsed.type === "message.retracted") {
      this.#retractReservations = upsertRetractReservation(this.#retractReservations, {
        messageId: parsed.payload.messageId,
        deletedAt: parsed.payload.deletedAt,
        entityVersion: parsed.entityVersion,
      });
      const current = this.#messages.get(parsed.payload.messageId);
      for (const [id, reaction] of this.#reactions) {
        if (reaction.messageId === parsed.payload.messageId) {
          this.#reactions.delete(id);
          this.#reactionConversationIds.delete(id);
        }
      }
      const lastMessage = this.#snapshot?.conversations.find(
        (summary) => summary.conversation.id === parsed.conversationId,
      )?.lastMessage;
      const source =
        current ??
        (lastMessage?.id === parsed.payload.messageId
          ? lastMessage
          : (suppliedRetractSource ?? undefined));
      changes = {
        removedMessageReactionIds: [parsed.payload.messageId],
        retractReservations: [
          {
            messageId: parsed.payload.messageId,
            deletedAt: parsed.payload.deletedAt,
            entityVersion: parsed.entityVersion,
          },
        ],
        invalidated:
          source === undefined
            ? [{ kind: "conversation_metadata", conversationId: parsed.conversationId }]
            : [],
      };
      if (source !== undefined) {
        const tombstone = tombstoneMessage(source, parsed);
        this.#messages.set(tombstone.id, tombstone);
        changes = { ...changes, messages: [tombstone] };
        if (this.#snapshot !== null && parsed.conversationId !== null) {
          const conversations = new Map(
            this.#snapshot.conversations.map((summary) => [summary.conversation.id, summary]),
          );
          const summary = conversations.get(parsed.conversationId);
          if (summary !== undefined) {
            const mentionedUserIds =
              this.#createdMessageMentions.get(tombstone.id) ??
              mentionedMemberIds(
                source.body,
                [this.#snapshot.currentUser.user],
                summary.participantIds,
              );
            conversations.set(
              parsed.conversationId,
              reconcileRetractedConversationSummary(
                summary,
                source,
                [...this.#messages.values()],
                this.#snapshot.currentUser.user,
                mentionedUserIds,
              ),
            );
            this.#snapshot = {
              ...this.#snapshot,
              conversations: [...conversations.values()],
            };
            const changed = conversations.get(parsed.conversationId);
            changes = { ...changes, conversations: changed === undefined ? [] : [changed] };
          }
        }
      }
      this.#createdMessageMentions.delete(parsed.payload.messageId);
    } else if (this.#snapshot !== null && parsed.conversationId !== null) {
      const conversations = new Map(
        this.#snapshot.conversations.map((summary) => [summary.conversation.id, summary]),
      );
      const current = conversations.get(parsed.conversationId);
      if (parsed.type === "read_cursor.updated") {
        if (current !== undefined) {
          conversations.set(parsed.conversationId, projectReadCursorSummary(current, parsed));
        }
      } else {
        conversations.set(
          parsed.conversationId,
          projectConversationSummary(current, parsed, this.#snapshot.currentUser.user.id),
        );
      }
      this.#snapshot = { ...this.#snapshot, conversations: [...conversations.values()] };
      const changed = conversations.get(parsed.conversationId);
      changes = { ...changes, conversations: changed === undefined ? [] : [changed] };
    }
    signal?.throwIfAborted();
    return committedCacheEvent(parsed.position, changes);
  }

  async advanceCursor(syncCursor: SyncPosition): Promise<void> {
    this.#assertNoMembershipRepair();
    if (this.#syncCursor === null || compareSyncPositions(syncCursor, this.#syncCursor) > 0) {
      this.#syncCursor = syncCursor;
      this.#lastSyncedAt = new Date().toISOString();
    }
  }

  async upsertAcknowledgedMessage(
    message: Message,
    expectedClientMessageId: string,
    syncCursor: SyncPosition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const parsed = messageSchema.parse(message);
    const expectedId = entityIdSchema.parse(expectedClientMessageId);
    const pending = this.#outbox.get(expectedId);
    const authorized = this.#snapshot?.conversations.some(
      (summary) => summary.conversation.id === parsed.conversationId,
    );
    if (
      this.#repairMarker !== null ||
      pending?.operation.conversationId !== parsed.conversationId ||
      authorized !== true
    ) {
      return false;
    }
    this.#retractReservations = reserveTombstonedMessages(this.#retractReservations, [parsed]);
    const retained = applyRetractReservation(
      parsed,
      retractReservationMap(this.#retractReservations),
    );
    this.#messages.set(parsed.id, preferRetainedMessage(this.#messages.get(parsed.id), retained));
    this.#outbox.delete(expectedId);
    this.#outbox.delete(parsed.clientMessageId);
    await this.advanceCursor(syncCursor);
    signal?.throwIfAborted();
    return true;
  }

  async upsertHistory(
    conversationId: string,
    messages: readonly Message[],
    reactions?: readonly Reaction[],
    signal?: AbortSignal,
    collection?: CollectionCommit,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const expectedConversationId = entityIdSchema.parse(conversationId);
    const parsedMessages = messages.map((message) => messageSchema.parse(message));
    if (
      collection !== undefined &&
      ((collection.state.identity.kind !== "timeline" &&
        collection.state.identity.kind !== "thread") ||
        collection.state.identity.conversationId !== expectedConversationId)
    )
      throw new Error("The collection identity does not match this history page");
    if (parsedMessages.some((message) => message.conversationId !== expectedConversationId)) {
      throw new Error("The workspace history crossed conversation scope");
    }
    const authorized = this.#snapshot?.conversations.some(
      (summary) => summary.conversation.id === expectedConversationId,
    );
    this.#assertNoMembershipRepair();
    if (authorized !== true) return false;
    const collections =
      collection === undefined
        ? this.#collections
        : commitCollectionState(this.#collections, this.#syncCursor, collection);
    if (reactions !== undefined)
      for (const message of parsedMessages)
        assertReactionSnapshotCurrent(this.#reactionSnapshotPositions.get(message.id), collection);
    this.#retractReservations = reserveTombstonedMessages(
      this.#retractReservations,
      parsedMessages,
    );
    const reservations = retractReservationMap(this.#retractReservations);
    const retainedMessages = parsedMessages.map((message) =>
      applyRetractReservation(message, reservations),
    );
    for (const reserved of retainedMessages) {
      this.#messages.set(
        reserved.id,
        preferRetainedMessage(this.#messages.get(reserved.id), reserved),
      );
    }
    const retractedIds = new Set(
      retainedMessages
        .map((message) => this.#messages.get(message.id) ?? message)
        .filter((message) => message.deletedAt !== null)
        .map((message) => message.id),
    );
    if (reactions !== undefined) {
      const messageIds = new Set(messages.map((message) => message.id));
      for (const [id, reaction] of this.#reactions) {
        if (messageIds.has(reaction.messageId)) {
          this.#reactions.delete(id);
          this.#reactionConversationIds.delete(id);
        }
      }
      const conversationIds = new Map(
        retainedMessages
          .map((message) => this.#messages.get(message.id) ?? message)
          .filter((message) => message.deletedAt === null)
          .map((message) => [message.id, message.conversationId] as const),
      );
      for (const reaction of reactions) {
        const parsed = reactionSchema.parse(reaction);
        const conversationId = conversationIds.get(parsed.messageId);
        if (conversationId === undefined) continue;
        this.#reactions.set(parsed.id, parsed);
        this.#reactionConversationIds.set(parsed.id, conversationId);
      }
    } else {
      for (const [id, reaction] of this.#reactions) {
        if (!retractedIds.has(reaction.messageId)) continue;
        this.#reactions.delete(id);
        this.#reactionConversationIds.delete(id);
      }
    }
    if (collection?.state.snapshotPosition != null && reactions !== undefined) {
      for (const message of parsedMessages)
        this.#reactionSnapshotPositions.set(message.id, collection.state.snapshotPosition);
    }
    this.#collections = collections;
    signal?.throwIfAborted();
    return true;
  }

  async upsertReaction(
    reaction: Reaction,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    this.#assertNoMembershipRepair();
    const parsed = reactionSchema.parse(reaction);
    const authorized = this.#snapshot?.conversations.some(
      (summary) => summary.conversation.id === conversationId,
    );
    if (authorized !== true) return false;
    this.#reactions.set(parsed.id, parsed);
    this.#reactionConversationIds.set(parsed.id, conversationId);
    signal?.throwIfAborted();
    return true;
  }

  async removeReaction(reactionId: string): Promise<void> {
    this.#reactions.delete(reactionId);
    this.#reactionConversationIds.delete(reactionId);
  }

  async upsertTasks(
    tasks: readonly Task[],
    signal?: AbortSignal,
    collection?: CollectionCommit,
  ): Promise<readonly Task[]> {
    if (
      collection !== undefined &&
      collection.state.identity.kind !== "tasks" &&
      collection.state.identity.kind !== "my_tasks"
    )
      throw new Error("The collection identity does not match this task page");
    if (signal?.aborted) return [];
    this.#assertNoMembershipRepair();
    const authorizedConversationIds = new Set(
      this.#snapshot?.conversations.map((summary) => summary.conversation.id) ?? [],
    );
    const collections =
      collection === undefined
        ? this.#collections
        : commitCollectionState(this.#collections, this.#syncCursor, collection);
    if (
      collection !== undefined &&
      collection.state.identity.kind !== "my_tasks" &&
      !authorizedConversationIds.has(collection.state.identity.conversationId)
    )
      throw new Error("The collection conversation is no longer authorized");
    const accepted: Task[] = [];
    for (const task of tasks) {
      const parsed = taskSchema.parse(task);
      if (!authorizedConversationIds.has(parsed.conversationId)) continue;
      const current = this.#tasks.get(parsed.id);
      if (acceptsTaskVersion(current?.version, parsed.version)) {
        this.#tasks.set(parsed.id, parsed);
        accepted.push(parsed);
      }
    }
    this.#collections = collections;
    signal?.throwIfAborted();
    return accepted;
  }

  async enqueue(
    operation: SendMessageOperation,
    createdAt = new Date().toISOString(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    this.#assertNoMembershipRepair();
    const parsed = sendMessageOperationSchema.parse(operation);
    const authorized = this.#snapshot?.conversations.some(
      (summary) => summary.conversation.id === parsed.conversationId,
    );
    if (authorized !== true) return false;
    const id = parsed.message.clientMessageId;
    if (this.#outbox.has(id)) return true;
    this.#outbox.set(id, {
      operation: parsed,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
    signal?.throwIfAborted();
    return true;
  }

  async replaceOutbox(
    clientMessageId: string,
    operation: SendMessageOperation,
    createdAt: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    this.#assertNoMembershipRepair();
    const predecessorId = entityIdSchema.parse(clientMessageId);
    const parsed = sendMessageOperationSchema.parse(operation);
    const predecessor = this.#outbox.get(predecessorId);
    const authorized = this.#snapshot?.conversations.some(
      (summary) => summary.conversation.id === parsed.conversationId,
    );
    if (
      authorized !== true ||
      predecessor?.operation.conversationId !== parsed.conversationId ||
      this.#outbox.has(parsed.message.clientMessageId)
    ) {
      return false;
    }
    this.#outbox.set(parsed.message.clientMessageId, {
      operation: parsed,
      createdAt,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      failureReason: null,
    });
    this.#outbox.delete(predecessorId);
    signal?.throwIfAborted();
    return true;
  }

  async updateOutbox(
    clientMessageId: string,
    update: {
      readonly status: OutboxStatus;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly failureReason: string | null;
    },
    signal?: AbortSignal,
    expected?: OutboxUpdateExpectation,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const current = this.#outbox.get(clientMessageId);
    if (current === undefined || !matchesOutboxExpectation(current, expected)) return false;
    this.#outbox.set(clientMessageId, { ...current, ...update });
    if (signal?.aborted) {
      this.#outbox.set(clientMessageId, current);
      return false;
    }
    return true;
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    this.#outbox.delete(clientMessageId);
  }

  async clearServerStatePreservingOutbox(): Promise<void> {
    this.#assertNoMembershipRepair();
    this.#snapshot = null;
    this.#messages.clear();
    this.#reactions.clear();
    this.#reactionConversationIds.clear();
    this.#tasks.clear();
    this.#events.clear();
    this.#syncCursor = null;
    this.#collections = [];
    this.#reactionSnapshotPositions.clear();
    this.#lastSyncedAt = null;
    this.#createdMessageMentions.clear();
  }

  async resetProtocolReplica(): Promise<void> {
    this.#repairMarker = null;
    this.#retractReservations = [];
    this.#members = [];
    this.#currentUserId = null;
    await this.clearServerStatePreservingOutbox();
  }

  async clearAll(): Promise<void> {
    this.#repairMarker = null;
    this.#retractReservations = [];
    this.#currentUserId = null;
    this.#createdMessageMentions.clear();
    await this.clearServerStatePreservingOutbox();
    this.#outbox.clear();
  }

  #finishStagedMembershipEvent(): boolean {
    const marker = this.#repairMarker;
    if (marker === null) return false;
    const alreadyRecorded = this.#events.has(marker.eventId);
    if (marker.selfRemoval) {
      this.#collections = this.#collections.filter(
        (state) =>
          state.identity.kind !== "my_tasks" &&
          state.identity.conversationId !== marker.conversationId,
      );
      if (this.#snapshot !== null) {
        this.#snapshot = {
          ...this.#snapshot,
          conversations: this.#snapshot.conversations.filter(
            (summary) => summary.conversation.id !== marker.conversationId,
          ),
        };
      }
      for (const [id, message] of this.#messages) {
        if (message.conversationId === marker.conversationId) this.#messages.delete(id);
      }
      for (const [id] of this.#reactions) {
        if (this.#reactionConversationIds.get(id) === marker.conversationId) {
          this.#reactions.delete(id);
          this.#reactionConversationIds.delete(id);
        }
      }
      for (const [id, task] of this.#tasks) {
        if (task.conversationId === marker.conversationId) this.#tasks.delete(id);
      }
      for (const [id, item] of this.#outbox) {
        if (item.operation.conversationId === marker.conversationId) this.#outbox.delete(id);
      }
    }
    this.#events.add(marker.eventId);
    if (this.#syncCursor === null || compareSyncPositions(marker.position, this.#syncCursor) > 0) {
      this.#syncCursor = marker.position;
    }
    this.#lastSyncedAt = new Date().toISOString();
    return !alreadyRecorded;
  }

  #assertNoMembershipRepair(): void {
    if (this.#repairMarker !== null) {
      throw new Error("Membership repair must complete before mutating the cache");
    }
  }
}
