import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import {
  cacheDecryptBatchResponseSchema,
  cacheEncryptBatchResponseSchema,
  messageSchema,
  type CacheDecryptBatchRequest,
  type CacheEncryptBatchRequest,
  type ConversationSummary,
  type Message,
  type SendMessageOperation,
  type Task,
  type User,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hype-comms/contracts";

import {
  clearPersistentWorkspaceCaches,
  MAX_RECENT_MESSAGE_MENTIONS,
  MAX_RETRACT_RESERVATIONS,
  MemoryWorkspaceCache,
  PersistentWorkspaceCache,
  rememberCreatedMessageMentions,
  upsertRetractReservation,
  type CachedWorkspaceState,
  type WorkspaceCache,
} from "./workspace-cache";

const NOW = "2026-07-24T12:00:00.000Z";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";

/** Lexicographically first, alphabetically last: the two orders must disagree. */
const MORGAN_ID = "10000000-0000-4000-8000-000000000001";
const ALICE_ID = "10000000-0000-4000-8000-000000000009";

/** Primary-key order is Zebra, direct message, Alpha — never the server's order. */
const ZEBRA_ID = "10000000-0000-4000-8000-000000000031";
const DIRECT_ID = "10000000-0000-4000-8000-000000000032";
const ALPHA_ID = "10000000-0000-4000-8000-000000000033";

/** Primary-key order is sequence 2, 10, 1 — neither insertion nor sequence order. */
const MESSAGE_SEQUENCE_2_ID = "10000000-0000-4000-8000-000000000041";
const MESSAGE_SEQUENCE_10_ID = "10000000-0000-4000-8000-000000000042";
const MESSAGE_SEQUENCE_1_ID = "10000000-0000-4000-8000-000000000043";
const CLIENT_MESSAGE_2_ID = "10000000-0000-4000-8000-000000000051";
const CLIENT_MESSAGE_10_ID = "10000000-0000-4000-8000-000000000052";
const CLIENT_MESSAGE_1_ID = "10000000-0000-4000-8000-000000000053";
const TASK_ID = "10000000-0000-4000-8000-000000000071";

const scope = { userId: MORGAN_ID, workspaceId: WORKSPACE_ID };

const morgan = {
  id: MORGAN_ID,
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const satisfies User;

const alice = {
  id: ALICE_ID,
  kind: "human",
  username: "alice",
  displayName: "alice",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const satisfies User;

function channelSummary(id: string, name: string, slug: string): ConversationSummary {
  return {
    conversation: {
      id,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name,
      slug,
      topic: null,
      access: "workspace",
      channelMode: "chat",
      isArchived: false,
      createdBy: MORGAN_ID,
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

const zebraSummary = channelSummary(ZEBRA_ID, "Zebra", "zebra");
const alphaSummary = channelSummary(ALPHA_ID, "Alpha", "alpha");

const directSummary: ConversationSummary = {
  conversation: {
    id: DIRECT_ID,
    workspaceId: WORKSPACE_ID,
    kind: "direct_message",
    name: null,
    slug: null,
    topic: null,
    access: null,
    channelMode: null,
    isArchived: false,
    createdBy: MORGAN_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  participantIds: [MORGAN_ID, ALICE_ID],
  membershipRole: null,
  lastMessage: null,
  unreadCount: 0,
  mentionCount: 0,
  readCursor: null,
};

/**
 * Deliberately scrambled: neither the server's order nor primary-key order, so a cache that
 * returns storage order or insertion order cannot pass by accident.
 */
const snapshot: WorkspaceSnapshot = {
  currentUser: {
    user: morgan,
    email: "morgan@example.com",
    workspaceId: WORKSPACE_ID,
    role: "owner",
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "Hype Comms",
    slug: "hype-comms",
    createdBy: MORGAN_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [morgan, alice],
  conversations: [directSummary, zebraSummary, alphaSummary],
  syncCursor: "0",
  featureFlags: {
    channels: true,
    directMessages: true,
    mentions: true,
    announcementChannels: false,
  },
};

function historyMessage(id: string, clientMessageId: string, sequence: string): Message {
  return {
    id,
    conversationId: ALPHA_ID,
    conversationSequence: sequence,
    version: 1,
    clientMessageId,
    authorId: ALICE_ID,
    threadRootId: null,
    body: `Message ${sequence}`,
    bodyFormat: "hype_comms_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const messageSequence1 = historyMessage(MESSAGE_SEQUENCE_1_ID, CLIENT_MESSAGE_1_ID, "1");
const messageSequence2 = historyMessage(MESSAGE_SEQUENCE_2_ID, CLIENT_MESSAGE_2_ID, "2");
const messageSequence10 = historyMessage(MESSAGE_SEQUENCE_10_ID, CLIENT_MESSAGE_10_ID, "10");

const messageCreatedEvent: WorkspaceEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000061",
  type: "message.created",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: ALPHA_ID,
  workspaceSequence: "7",
  conversationSequence: "2",
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { message: messageSequence2, mentionedUserIds: [MORGAN_ID] },
};

const messageRetractedEvent: WorkspaceEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000066",
  type: "message.retracted",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: ALPHA_ID,
  workspaceSequence: "9",
  conversationSequence: "2",
  entityVersion: 2,
  delivery: "at_least_once",
  payload: { messageId: MESSAGE_SEQUENCE_2_ID, deletedAt: NOW },
};

const readCursorEvent: WorkspaceEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000062",
  type: "read_cursor.updated",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: ALPHA_ID,
  workspaceSequence: "8",
  conversationSequence: null,
  entityVersion: 1,
  delivery: "at_least_once",
  payload: {
    readCursor: {
      conversationId: ALPHA_ID,
      userId: MORGAN_ID,
      lastReadMessageId: MESSAGE_SEQUENCE_2_ID,
      lastReadConversationSequence: "2",
      lastReadAt: NOW,
      updatedAt: NOW,
    },
    unreadCount: 1,
    mentionCount: 1,
  },
};

const reactionAddedEvent: WorkspaceEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000063",
  type: "reaction.added",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: ALPHA_ID,
  workspaceSequence: "9",
  conversationSequence: "2",
  entityVersion: 1,
  delivery: "at_least_once",
  payload: {
    reaction: {
      id: "10000000-0000-4000-8000-000000000064",
      messageId: MESSAGE_SEQUENCE_2_ID,
      userId: MORGAN_ID,
      emoji: "🎉",
      createdAt: NOW,
    },
  },
};

const reactionRemovedEvent: WorkspaceEvent = {
  ...reactionAddedEvent,
  id: "10000000-0000-4000-8000-000000000065",
  type: "reaction.removed",
  workspaceSequence: "10",
};

/**
 * Carries the agent the server has just disabled. `userSchema` has no status field, so the payload
 * looks exactly like a profile edit — which is why applying it as an upsert re-asserted the
 * disabled member instead of removing it.
 */
const disabledAgent: User = {
  id: "10000000-0000-4000-8000-000000000072",
  kind: "agent",
  username: "hermes",
  displayName: "Hermes",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const task: Task = {
  id: TASK_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: ALPHA_ID,
  number: "1",
  version: 1,
  title: "Build the board",
  description: null,
  status: "todo",
  priority: "high",
  assigneeId: MORGAN_ID,
  dueOn: "2026-08-15",
  sourceMessageId: null,
  rank: "1024",
  createdBy: MORGAN_ID,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const memberUpdatedEvent: WorkspaceEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000066",
  type: "member.updated",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: null,
  workspaceSequence: "11",
  conversationSequence: null,
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { member: disabledAgent },
};

const selfRemovedEvent: WorkspaceEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000067",
  type: "channel.membership_changed",
  occurredAt: NOW,
  workspaceId: WORKSPACE_ID,
  conversationId: ALPHA_ID,
  workspaceSequence: "12",
  conversationSequence: null,
  entityVersion: 1,
  delivery: "at_least_once",
  payload: { memberId: MORGAN_ID, action: "removed" },
};

const otherMemberRemovedEvent: WorkspaceEvent = {
  ...selfRemovedEvent,
  id: "10000000-0000-4000-8000-000000000068",
  payload: { memberId: ALICE_ID, action: "removed" },
};

const queuedAlphaMessage: SendMessageOperation = {
  conversationId: ALPHA_ID,
  idempotencyKey: "10000000-0000-4000-8000-000000000069",
  message: {
    threadRootId: MESSAGE_SEQUENCE_2_ID,
    body: "Must not cross a membership repair",
    bodyFormat: "hype_comms_markdown_v1",
    clientMessageId: "10000000-0000-4000-8000-000000000069",
    mentionedUserIds: [],
    attachmentIds: [],
  },
};

const queuedDirectMessage: SendMessageOperation = {
  conversationId: DIRECT_ID,
  idempotencyKey: "10000000-0000-4000-8000-000000000070",
  message: {
    threadRootId: null,
    body: "Must survive an unrelated membership repair",
    bodyFormat: "hype_comms_markdown_v1",
    clientMessageId: "10000000-0000-4000-8000-000000000070",
    mentionedUserIds: [],
    attachmentIds: [],
  },
};

/** One more than `workspaceSnapshotSchema.members`'s `.max(25)` — the list that bricks `load()`. */
const overCapacityMembers: readonly User[] = Array.from({ length: 26 }, (_unused, index) => {
  const suffix = String(index).padStart(2, "0");
  return {
    id: `10000000-0000-4000-8000-1000000000${suffix}`,
    kind: "human",
    username: `member-${suffix}`,
    displayName: `Member ${suffix}`,
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
});

function taskEvent(value: Task, sequence: string): WorkspaceEvent {
  return {
    version: 1,
    id: `10000000-0000-4000-8000-${sequence.padStart(12, "0")}`,
    type: "task.updated",
    occurredAt: value.updatedAt,
    workspaceId: WORKSPACE_ID,
    conversationId: ALPHA_ID,
    workspaceSequence: sequence,
    conversationSequence: null,
    entityVersion: value.version,
    delivery: "at_least_once",
    payload: { task: value },
  };
}

class FakeCrypto {
  async encryptCacheRecords(input: CacheEncryptBatchRequest) {
    return cacheEncryptBatchResponseSchema.parse({
      items: input.items.map((item) => ({
        store: item.store,
        recordId: item.recordId,
        schemaVersion: 1,
        value: {
          version: 1,
          keyVersion: 1,
          schemaVersion: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: btoa(String.fromCharCode(...new TextEncoder().encode(item.plaintext)))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", ""),
        },
      })),
    });
  }

  async decryptCacheRecords(input: CacheDecryptBatchRequest) {
    return cacheDecryptBatchResponseSchema.parse({
      items: input.items.map((item) => ({
        store: item.store,
        recordId: item.recordId,
        schemaVersion: 1,
        plaintext: new TextDecoder().decode(
          Uint8Array.from(
            atob(
              item.value.ciphertext
                .replaceAll("-", "+")
                .replaceAll("_", "/")
                .padEnd(Math.ceil(item.value.ciphertext.length / 4) * 4, "="),
            ),
            (character) => character.charCodeAt(0),
          ),
        ),
      })),
    });
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface EncryptionGate {
  readonly started: Promise<void>;
  readonly release: () => void;
}

class DeferredFakeCrypto extends FakeCrypto {
  #nextGate: {
    readonly started: Deferred<void>;
    readonly release: Deferred<void>;
  } | null = null;
  #nextDecryptionGate: {
    readonly started: Deferred<void>;
    readonly release: Deferred<void>;
  } | null = null;

  pauseNextEncryption(): EncryptionGate {
    const started = deferred<void>();
    const release = deferred<void>();
    this.#nextGate = { started, release };
    return { started: started.promise, release: () => release.resolve() };
  }

  pauseNextDecryption(): EncryptionGate {
    const started = deferred<void>();
    const release = deferred<void>();
    this.#nextDecryptionGate = { started, release };
    return { started: started.promise, release: () => release.resolve() };
  }

  override async encryptCacheRecords(input: CacheEncryptBatchRequest) {
    const gate = this.#nextGate;
    if (gate !== null) {
      this.#nextGate = null;
      gate.started.resolve();
      await gate.release.promise;
    }
    return super.encryptCacheRecords(input);
  }

  override async decryptCacheRecords(input: CacheDecryptBatchRequest) {
    const gate = this.#nextDecryptionGate;
    if (gate !== null) {
      this.#nextDecryptionGate = null;
      gate.started.resolve();
      await gate.release.promise;
    }
    return super.decryptCacheRecords(input);
  }
}

interface RawMessageRow {
  readonly id: string;
  readonly value: {
    readonly ciphertext: string;
  };
}

function decryptRawMessage(row: RawMessageRow): Message {
  const ciphertext = row.value.ciphertext
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(row.value.ciphertext.length / 4) * 4, "=");
  const plaintext = new TextDecoder().decode(
    Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0)),
  );
  return messageSchema.parse(JSON.parse(plaintext) as unknown);
}

async function readRawCacheMessagesAndReactionCount(): Promise<{
  readonly messages: readonly Message[];
  readonly reactionCount: number;
}> {
  const database = new Dexie(`hype-comms-cache-v1-${scope.workspaceId}-${scope.userId}`);
  await database.open();
  try {
    const messages = (await database.table("messages").toArray()) as unknown as RawMessageRow[];
    const reactionCount = await database.table("reactions").count();
    return { messages: messages.map(decryptRawMessage), reactionCount };
  } finally {
    database.close();
  }
}

interface CacheImplementation {
  readonly name: string;
  readonly create: () => WorkspaceCache;
}

const implementations: readonly CacheImplementation[] = [
  { name: "MemoryWorkspaceCache", create: () => new MemoryWorkspaceCache() },
  {
    name: "PersistentWorkspaceCache",
    create: () => new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope }),
  },
];

function withoutTimestamps(state: CachedWorkspaceState) {
  return { ...state, lastSyncedAt: null };
}

afterEach(async () => {
  await clearPersistentWorkspaceCaches();
});

describe.each(implementations)("$name conformance", ({ create }) => {
  it("upserts a conversation without advancing the cursor or losing newer counters", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.applyEvent(messageCreatedEvent);
    const before = await cache.load();
    const current = before.bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(current).toBeDefined();

    await cache.upsertConversation({
      ...alphaSummary,
      conversation: { ...alphaSummary.conversation, topic: "A projected update" },
    });

    const after = await cache.load();
    const alpha = after.bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(after.syncCursor).toBe("7");
    expect(alpha?.conversation.topic).toBe("A projected update");
    expect(alpha?.lastMessage?.id).toBe(MESSAGE_SEQUENCE_2_ID);
    expect(alpha?.unreadCount).toBe(1);
    expect(alpha?.mentionCount).toBe(1);
  });

  it("orders messages by conversation sequence after an out-of-order upsertHistory", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.upsertHistory(ALPHA_ID, [messageSequence10, messageSequence1, messageSequence2]);

    const state = await cache.load();
    const sequences = state.messages.map((message) => message.conversationSequence);
    expect(sequences).toEqual(["1", "2", "10"]);
    expect(state.messages.at(-1)?.id).toBe(MESSAGE_SEQUENCE_10_ID);
  });

  it("restores the server's conversation and member order on load", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);

    const state = await cache.load();
    const conversations = state.bootstrap?.conversations ?? [];
    const members = state.bootstrap?.members ?? [];
    const expectedConversations = [ALPHA_ID, ZEBRA_ID, DIRECT_ID];
    expect(conversations.map((summary) => summary.conversation.id)).toEqual(expectedConversations);
    expect(members.map((member) => member.id)).toEqual([ALICE_ID, MORGAN_ID]);
  });

  it("treats read_cursor.updated for an uncached conversation as a no-op", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.clearServerStatePreservingOutbox();

    await expect(cache.applyEvent(readCursorEvent)).resolves.toBe(true);
    const state = await cache.load();
    expect(state.bootstrap).toBeNull();
    expect(state.syncCursor).toBe("8");
  });

  it("stores message.created when no workspace row is cached", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.clearServerStatePreservingOutbox();

    await expect(cache.applyEvent(messageCreatedEvent)).resolves.toBe(true);
    const state = await cache.load();
    expect(state.bootstrap).toBeNull();
    expect(state.messages.map((message) => message.id)).toEqual([MESSAGE_SEQUENCE_2_ID]);
    expect(state.syncCursor).toBe("7");
  });

  it("applies a message.retracted tombstone and refuses to resurrect the body", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, [messageSequence2]);
    await cache.upsertReaction(reactionAddedEvent.payload.reaction, ALPHA_ID);
    await expect(cache.applyEvent(messageCreatedEvent)).resolves.toBe(true);
    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(true);
    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(false);

    const retracted = await cache.load();
    expect(retracted.messages).toEqual([
      expect.objectContaining({
        id: MESSAGE_SEQUENCE_2_ID,
        body: "Message 2",
        deletedAt: NOW,
        version: 2,
      }),
    ]);
    expect(retracted.reactions).toEqual([]);
    const alpha = retracted.bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({ lastMessage: null, unreadCount: 0, mentionCount: 0 });

    await expect(cache.upsertHistory(ALPHA_ID, [messageSequence2])).resolves.toBe(true);
    const afterHistory = await cache.load();
    expect(afterHistory.messages[0]).toMatchObject({
      id: MESSAGE_SEQUENCE_2_ID,
      body: "Message 2",
      deletedAt: NOW,
    });
  });

  it("retains a created message's exact mention IDs until its retract arrives", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.applyEvent(messageCreatedEvent);

    await expect(cache.getCreatedMessageMentions(MESSAGE_SEQUENCE_2_ID)).resolves.toEqual([
      MORGAN_ID,
    ]);

    await cache.applyEvent(messageRetractedEvent);
    await expect(cache.getCreatedMessageMentions(MESSAGE_SEQUENCE_2_ID)).resolves.toBeUndefined();
  });

  it("retains exact mention IDs while a message is reachable only as lastMessage", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.applyEvent(messageCreatedEvent);
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          {
            ...alphaSummary,
            lastMessage: messageSequence2,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
        syncCursor: messageCreatedEvent.workspaceSequence,
      },
      [],
    );

    await expect(cache.getCreatedMessageMentions(MESSAGE_SEQUENCE_2_ID)).resolves.toEqual([
      MORGAN_ID,
    ]);
    await cache.applyEvent(messageRetractedEvent);

    const alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({ lastMessage: null, unreadCount: 0, mentionCount: 0 });
  });

  it("retains exact mention IDs for a caller-owned thread-summary source", async () => {
    const cache = create();
    const closedThreadReply = {
      ...messageSequence2,
      threadRootId: messageSequence1.id,
    };
    const created: WorkspaceEvent = {
      ...messageCreatedEvent,
      payload: { message: closedThreadReply, mentionedUserIds: [MORGAN_ID] },
    };
    await cache.replaceSnapshot(snapshot, []);
    await cache.applyEvent(created);
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          {
            ...alphaSummary,
            lastMessage: messageSequence10,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
        syncCursor: created.workspaceSequence,
      },
      [messageSequence1, messageSequence10],
      [],
      [],
      undefined,
      [closedThreadReply.id],
    );

    await expect(cache.getCreatedMessageMentions(closedThreadReply.id)).resolves.toEqual([
      MORGAN_ID,
    ]);
    await cache.applyEvent(messageRetractedEvent, undefined, closedThreadReply);

    const alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({
      lastMessage: { id: MESSAGE_SEQUENCE_10_ID, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it("prunes exact mention IDs after a message becomes unreachable", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.applyEvent(messageCreatedEvent);
    await cache.replaceSnapshot(
      { ...snapshot, syncCursor: messageCreatedEvent.workspaceSequence },
      [],
    );

    await expect(cache.getCreatedMessageMentions(MESSAGE_SEQUENCE_2_ID)).resolves.toBeUndefined();
  });

  it("reconciles a retracted summary to its newest cached live message", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          { ...alphaSummary, lastMessage: messageSequence1 },
        ],
      },
      [messageSequence1],
    );

    await expect(cache.applyEvent(messageCreatedEvent)).resolves.toBe(true);
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          {
            ...alphaSummary,
            lastMessage: messageSequence2,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
        syncCursor: messageCreatedEvent.workspaceSequence,
      },
      [messageSequence1, messageSequence2],
    );
    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(true);

    const alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({
      lastMessage: { id: MESSAGE_SEQUENCE_1_ID, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
  });

  it("uses a retained closed-thread reply to reconcile a retract", async () => {
    const closedThreadReply: Message = {
      ...messageSequence2,
      threadRootId: MESSAGE_SEQUENCE_1_ID,
      conversationSequence: "3",
      body: "@morgan Closed thread reply",
    };
    const laterMainMessage: Message = {
      ...messageSequence10,
      authorId: MORGAN_ID,
      conversationSequence: "4",
      body: "Later main-timeline message",
    };
    const retract: WorkspaceEvent = {
      ...messageRetractedEvent,
      id: "10000000-0000-4000-8000-000000000089",
      workspaceSequence: "11",
      conversationSequence: closedThreadReply.conversationSequence,
      payload: { messageId: closedThreadReply.id, deletedAt: NOW },
    };
    const cache = create();
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          {
            ...alphaSummary,
            participantIds: [MORGAN_ID, ALICE_ID],
            lastMessage: laterMainMessage,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
      },
      [messageSequence1, laterMainMessage],
    );

    await expect(cache.applyEvent(retract, undefined, closedThreadReply)).resolves.toBe(true);

    const state = await cache.load();
    const alpha = state.bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({
      lastMessage: { id: laterMainMessage.id, deletedAt: null },
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(state.messages).toContainEqual(
      expect.objectContaining({ id: closedThreadReply.id, deletedAt: NOW, version: 2 }),
    );
  });

  it("does not acknowledge a retract with a mismatched retained source", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);

    await expect(
      cache.applyEvent(messageRetractedEvent, undefined, messageSequence1),
    ).rejects.toThrow("retract source does not match the retracted message");
    expect((await cache.load()).syncCursor).toBe("0");

    await expect(
      cache.applyEvent(messageRetractedEvent, undefined, messageSequence2),
    ).resolves.toBe(true);
    const state = await cache.load();
    expect(state.syncCursor).toBe("9");
    expect(state.messages).toContainEqual(
      expect.objectContaining({ id: MESSAGE_SEQUENCE_2_ID, deletedAt: NOW, version: 2 }),
    );
  });

  it("does not let stale history resurrect a source-less message.retracted event", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(true);

    const reserved = await cache.load();
    expect(reserved.messages).toEqual([]);
    expect(reserved.syncCursor).toBe("9");
    expect(reserved.retractReservations).toEqual([
      {
        messageId: MESSAGE_SEQUENCE_2_ID,
        deletedAt: NOW,
        entityVersion: 2,
      },
    ]);

    await expect(cache.upsertHistory(ALPHA_ID, [messageSequence2])).resolves.toBe(true);
    const afterHistory = await cache.load();
    expect(afterHistory.messages).toEqual([
      expect.objectContaining({
        id: MESSAGE_SEQUENCE_2_ID,
        body: "Message 2",
        deletedAt: NOW,
        version: 2,
      }),
    ]);
  });

  it("does not restore a reaction from stale history after a source-less retract", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(true);

    await expect(
      cache.upsertHistory(ALPHA_ID, [messageSequence2], [reactionAddedEvent.payload.reaction]),
    ).resolves.toBe(true);

    const state = await cache.load();
    expect(state.messages).toContainEqual(
      expect.objectContaining({ id: MESSAGE_SEQUENCE_2_ID, deletedAt: NOW, version: 2 }),
    );
    expect(state.reactions).toEqual([]);
  });

  it("reserves a tombstone received through history before a later live page arrives", async () => {
    const cache = create();
    const deleted = { ...messageSequence2, deletedAt: NOW, version: 2, updatedAt: NOW };
    await cache.replaceSnapshot(
      snapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
    );

    await expect(cache.upsertHistory(ALPHA_ID, [deleted])).resolves.toBe(true);
    expect((await cache.load()).retractReservations).toContainEqual({
      messageId: MESSAGE_SEQUENCE_2_ID,
      deletedAt: NOW,
      entityVersion: 2,
    });

    await expect(
      cache.upsertHistory(ALPHA_ID, [messageSequence2], [reactionAddedEvent.payload.reaction]),
    ).resolves.toBe(true);

    const state = await cache.load();
    expect(state.messages).toContainEqual(
      expect.objectContaining({ id: MESSAGE_SEQUENCE_2_ID, deletedAt: NOW, version: 2 }),
    );
    expect(state.reactions).toEqual([]);
  });

  it("reconciles counts when history sees a tombstone before its retract event", async () => {
    const cache = create();
    const mentioned = { ...messageSequence2, body: "@morgan Message 2" };
    const deleted = { ...mentioned, deletedAt: NOW, version: 2, updatedAt: NOW };
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          {
            ...alphaSummary,
            participantIds: [MORGAN_ID, ALICE_ID],
            lastMessage: mentioned,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
      },
      [mentioned],
    );

    await expect(cache.upsertHistory(ALPHA_ID, [deleted])).resolves.toBe(true);
    let alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({ unreadCount: 1, mentionCount: 1 });

    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(true);
    alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({ unreadCount: 0, mentionCount: 0, lastMessage: null });

    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(false);
    alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({ unreadCount: 0, mentionCount: 0 });
  });

  it("retains a tombstone supplied by a stale snapshot", async () => {
    const cache = create();
    const deleted = { ...messageSequence2, deletedAt: NOW, version: 2, updatedAt: NOW };
    await cache.replaceSnapshot(
      { ...snapshot, syncCursor: "10" },
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
    );

    await expect(
      cache.replaceSnapshot(
        { ...snapshot, syncCursor: "9" },
        [deleted],
        [reactionAddedEvent.payload.reaction],
      ),
    ).resolves.toBe(false);

    const state = await cache.load();
    expect(state.retractReservations).toContainEqual({
      messageId: MESSAGE_SEQUENCE_2_ID,
      deletedAt: NOW,
      entityVersion: 2,
    });
    expect(state.messages).toContainEqual(
      expect.objectContaining({ id: MESSAGE_SEQUENCE_2_ID, deletedAt: NOW, version: 2 }),
    );
    expect(state.reactions).toEqual([]);
  });

  it("does not let an older snapshot replace a newer retract cursor", async () => {
    const cache = create();
    const staleSnapshot = { ...snapshot, syncCursor: "8" };
    await cache.replaceSnapshot(
      staleSnapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
    );
    await expect(cache.applyEvent(messageRetractedEvent)).resolves.toBe(true);

    await cache.replaceSnapshot(
      staleSnapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
    );

    const state = await cache.load();
    expect(state.syncCursor).toBe(messageRetractedEvent.workspaceSequence);
    expect(state.messages).toContainEqual(
      expect.objectContaining({ id: MESSAGE_SEQUENCE_2_ID, deletedAt: NOW, version: 2 }),
    );
    expect(state.reactions).toEqual([]);
  });

  it("counts an unread mention once and rejects the duplicate event", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);

    await expect(cache.applyEvent(messageCreatedEvent)).resolves.toBe(true);
    await expect(cache.applyEvent(messageCreatedEvent)).resolves.toBe(false);

    const state = await cache.load();
    const conversations = state.bootstrap?.conversations ?? [];
    const alpha = conversations.find((summary) => summary.conversation.id === ALPHA_ID);
    expect(alpha?.unreadCount).toBe(1);
    expect(alpha?.mentionCount).toBe(1);
    expect(state.messages).toHaveLength(1);
  });

  it("projects the canonical counts carried by read_cursor.updated", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          { ...alphaSummary, unreadCount: 4, mentionCount: 3 },
        ],
      },
      [],
    );

    await expect(cache.applyEvent(readCursorEvent)).resolves.toBe(true);
    const alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({
      readCursor: readCursorEvent.payload.readCursor,
      unreadCount: 1,
      mentionCount: 1,
    });
  });

  it("preserves counts when replaying a legacy read_cursor.updated event", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          { ...alphaSummary, unreadCount: 4, mentionCount: 3 },
        ],
      },
      [],
    );

    await expect(
      cache.applyEvent({
        ...readCursorEvent,
        payload: { readCursor: readCursorEvent.payload.readCursor },
      }),
    ).resolves.toBe(true);
    const alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({
      readCursor: readCursorEvent.payload.readCursor,
      unreadCount: 4,
      mentionCount: 3,
    });
  });

  it("does not replay a message already reflected by the bootstrap cursor", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: [
          directSummary,
          zebraSummary,
          {
            ...alphaSummary,
            lastMessage: messageSequence2,
            unreadCount: 1,
            mentionCount: 1,
          },
        ],
        syncCursor: messageCreatedEvent.workspaceSequence,
      },
      [],
    );

    await expect(cache.applyEvent(messageCreatedEvent)).resolves.toBe(false);
    const alpha = (await cache.load()).bootstrap?.conversations.find(
      (summary) => summary.conversation.id === ALPHA_ID,
    );
    expect(alpha).toMatchObject({
      lastMessage: { id: MESSAGE_SEQUENCE_2_ID },
      unreadCount: 1,
      mentionCount: 1,
    });
  });

  it("persists reaction events idempotently without corrupting message projections", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, [messageSequence2]);

    await expect(cache.applyEvent(reactionAddedEvent)).resolves.toBe(true);
    await expect(cache.applyEvent(reactionAddedEvent)).resolves.toBe(false);

    const added = await cache.load();
    expect(added.syncCursor).toBe("9");
    expect(added.reactions).toEqual([reactionAddedEvent.payload.reaction]);
    expect(added.messages).toEqual([messageSequence2]);
    expect(added.bootstrap?.conversations).toHaveLength(snapshot.conversations.length);

    await expect(cache.applyEvent(reactionRemovedEvent)).resolves.toBe(true);
    await expect(cache.applyEvent(reactionRemovedEvent)).resolves.toBe(false);
    const removed = await cache.load();
    expect(removed.syncCursor).toBe("10");
    expect(removed.reactions).toEqual([]);
  });

  it("leaves the member list untouched when member.updated is applied", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    const before = await cache.load();

    await expect(cache.applyEvent(memberUpdatedEvent)).resolves.toBe(true);

    const after = await cache.load();
    // The guard the design rests on. `member.updated` announces THAT the directory changed, never
    // what it now is, so the only correct local effect is advancing the cursor. Re-adding an
    // upsert here is what made disabling a member re-assert it, and this assertion is what makes
    // that unwriteable: the payload member must not appear, and no existing member may change.
    expect(after.bootstrap?.members).toEqual(before.bootstrap?.members);
    expect(after.bootstrap?.members.map((member) => member.id)).not.toContain(disabledAgent.id);
    expect(after.syncCursor).toBe("11");
    await expect(cache.applyEvent(memberUpdatedEvent)).resolves.toBe(false);
  });

  it("purges every conversation-scoped row when the current user is removed", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      snapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
      [task],
    );
    await cache.enqueue(queuedAlphaMessage, NOW);

    await expect(cache.applyEvent(selfRemovedEvent)).resolves.toBe(true);

    const state = await cache.load();
    expect(
      state.bootstrap?.conversations.some((summary) => summary.conversation.id === ALPHA_ID),
    ).toBe(false);
    expect(state.messages.filter((message) => message.conversationId === ALPHA_ID)).toEqual([]);
    expect(state.reactions).toEqual([]);
    expect(state.tasks.filter((item) => item.conversationId === ALPHA_ID)).toEqual([]);
    expect(state.outbox.filter((item) => item.operation.conversationId === ALPHA_ID)).toEqual([]);
    expect(state.syncCursor).toBe(selfRemovedEvent.workspaceSequence);
    await expect(cache.applyEvent(reactionAddedEvent)).rejects.toThrow(
      "Membership repair must complete",
    );
    await expect(cache.enqueue(queuedAlphaMessage, NOW)).rejects.toThrow(
      "Membership repair must complete",
    );
  });

  it("purges a reaction even when its message row is absent", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await expect(cache.applyEvent(reactionAddedEvent)).resolves.toBe(true);
    expect((await cache.load()).reactions).toEqual([reactionAddedEvent.payload.reaction]);

    await expect(cache.applyEvent(selfRemovedEvent)).resolves.toBe(true);

    expect((await cache.load()).reactions).toEqual([]);
  });

  it("projects another member's removal without opening a membership repair", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: snapshot.conversations.map((summary) =>
          summary.conversation.id === ALPHA_ID
            ? { ...summary, participantIds: [MORGAN_ID, ALICE_ID] }
            : summary,
        ),
      },
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
      [task],
    );
    await cache.enqueue(queuedAlphaMessage, NOW);

    await expect(cache.applyEvent(otherMemberRemovedEvent)).resolves.toBe(true);

    const state = await cache.load();
    expect(
      state.bootstrap?.conversations.some((summary) => summary.conversation.id === ALPHA_ID),
    ).toBe(true);
    expect(state.messages).toContainEqual(messageSequence2);
    expect(state.reactions).toContainEqual(reactionAddedEvent.payload.reaction);
    expect(state.tasks).toContainEqual(task);
    expect(state.outbox[0]?.operation).toEqual(queuedAlphaMessage);
    expect(
      state.bootstrap?.conversations.find((summary) => summary.conversation.id === ALPHA_ID)
        ?.participantIds,
    ).toEqual([MORGAN_ID]);
    expect(state.syncCursor).toBe(otherMemberRemovedEvent.workspaceSequence);
    expect(state.repairMarker).toBeNull();
    await expect(cache.applyEvent(otherMemberRemovedEvent)).resolves.toBe(false);
  });

  it("prunes only outbox rows outside an authoritative conversation catalog", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, []);
    await cache.enqueue(queuedAlphaMessage, NOW);
    await cache.enqueue(queuedDirectMessage, "2026-07-24T12:00:01.000Z");

    await cache.replaceSnapshot(
      {
        ...snapshot,
        conversations: snapshot.conversations.filter(
          (summary) => summary.conversation.id !== ALPHA_ID,
        ),
        syncCursor: "12",
      },
      [],
    );

    expect((await cache.load()).outbox.map((item) => item.operation)).toEqual([
      queuedDirectMessage,
    ]);
  });

  it("updates an outbox status only for the current attempt and projection", async () => {
    const cache = create();
    const clientMessageId = queuedAlphaMessage.message.clientMessageId;
    await cache.replaceSnapshot(snapshot, []);
    await cache.enqueue(queuedAlphaMessage, NOW);
    const sending = {
      status: "sending" as const,
      attemptCount: 1,
      nextAttemptAt: null,
      failureReason: null,
    };

    const retired = new AbortController();
    retired.abort();
    await expect(
      cache.updateOutbox(clientMessageId, sending, retired.signal, {
        status: "pending",
        attemptCount: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      cache.updateOutbox(clientMessageId, sending, undefined, {
        status: "sending",
        attemptCount: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      cache.updateOutbox(clientMessageId, sending, undefined, {
        status: "pending",
        attemptCount: 0,
      }),
    ).resolves.toBe(true);
    await expect(
      cache.updateOutbox(
        clientMessageId,
        {
          status: "retry_wait",
          attemptCount: 1,
          nextAttemptAt: NOW,
          failureReason: "network",
        },
        undefined,
        { status: "sending", attemptCount: 1 },
      ),
    ).resolves.toBe(true);

    expect((await cache.load()).outbox[0]).toMatchObject({
      status: "retry_wait",
      attemptCount: 1,
      failureReason: "network",
    });
  });

  it("accepts a send response only while its outbox row and conversation are authorized", async () => {
    const cache = create();
    const acknowledged: Message = {
      ...messageSequence2,
      id: "10000000-0000-4000-8000-000000000074",
      clientMessageId: "10000000-0000-4000-8000-000000000075",
      authorId: MORGAN_ID,
      threadRootId: queuedAlphaMessage.message.threadRootId,
      body: queuedAlphaMessage.message.body,
      conversationSequence: "11",
    };
    await cache.replaceSnapshot(snapshot, []);
    await cache.enqueue(queuedAlphaMessage, NOW);

    // A resync can temporarily preserve the queued operation without an authorization catalog.
    // The response stays uncommitted until a complete snapshot proves the conversation.
    await cache.clearServerStatePreservingOutbox();
    await expect(
      cache.upsertAcknowledgedMessage(
        acknowledged,
        queuedAlphaMessage.message.clientMessageId,
        "1",
      ),
    ).resolves.toBe(false);
    expect((await cache.load()).messages).toEqual([]);
    expect((await cache.load()).outbox.map((item) => item.operation)).toEqual([queuedAlphaMessage]);

    await cache.replaceSnapshot({ ...snapshot, syncCursor: "1" }, []);
    await expect(
      cache.upsertAcknowledgedMessage(
        acknowledged,
        queuedAlphaMessage.message.clientMessageId,
        "1",
      ),
    ).resolves.toBe(true);
    const accepted = await cache.load();
    expect(accepted.messages).toEqual([acknowledged]);
    expect(accepted.outbox).toEqual([]);
  });

  it("leaves an existing snapshot unchanged when its replacement generation is aborted", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, [messageSequence2]);
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      cache.replaceSnapshot(
        { ...snapshot, conversations: [], syncCursor: "12" },
        [],
        [],
        [],
        abortController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const state = await cache.load();
    expect(state.syncCursor).toBe("0");
    expect(state.bootstrap?.conversations.map((item) => item.conversation.id)).toEqual([
      ALPHA_ID,
      ZEBRA_ID,
      DIRECT_ID,
    ]);
    expect(state.messages).toEqual([messageSequence2]);
  });

  it("does not discard a member replace that arrives before the first snapshot", async () => {
    // A cache that has never seen replaceSnapshot (or has just had clearServerStatePreservingOutbox
    // run) still has to accept a replaceMembers write rather than silently dropping it --
    // WorkspaceRuntime clears its dirty flag once this call resolves regardless of what happened
    // underneath, so a no-op here would lose the invalidation for good on a memory-only cache.
    const cache = create();
    await expect(cache.replaceMembers([morgan, alice])).resolves.toBeUndefined();

    // No workspace row is cached yet, so bootstrap stays null for both implementations -- that
    // half of the contract is unaffected by whether the write above actually landed.
    const beforeSnapshot = await cache.load();
    expect(beforeSnapshot.bootstrap).toBeNull();

    // Once a real snapshot lands, both implementations must agree on the resulting member list.
    await cache.replaceSnapshot(snapshot, []);
    const state = await cache.load();
    expect(state.bootstrap?.members.map((member) => member.id)).toEqual([ALICE_ID, MORGAN_ID]);
  });

  it("replaces the whole member directory rather than merging into it", async () => {
    const cache = create();
    await cache.replaceSnapshot({ ...snapshot, members: [morgan, alice, disabledAgent] }, []);

    // The server's active-only answer after the disable: the agent is simply absent from it.
    await cache.replaceMembers([morgan, alice]);

    const state = await cache.load();
    expect(state.bootstrap?.members.map((member) => member.id)).toEqual([ALICE_ID, MORGAN_ID]);
  });

  it("leaves the member directory unchanged when a replacement is aborted", async () => {
    const cache = create();
    await cache.replaceSnapshot({ ...snapshot, members: [morgan, alice, disabledAgent] }, []);
    const before = (await cache.load()).bootstrap?.members;
    const abortController = new AbortController();
    abortController.abort();

    await expect(cache.replaceMembers([morgan], abortController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    const state = await cache.load();
    expect(state.bootstrap?.members).toEqual(before);
  });

  it("replaces hydrated reactions for a history page and projects mutation responses", async () => {
    const cache = create();
    const reaction = reactionAddedEvent.payload.reaction;
    await cache.replaceSnapshot(snapshot, [messageSequence2], [reaction]);

    await cache.upsertHistory(ALPHA_ID, [messageSequence2], []);
    expect((await cache.load()).reactions).toEqual([]);

    await cache.upsertReaction(reaction, ALPHA_ID);
    expect((await cache.load()).reactions).toEqual([reaction]);
    await cache.removeReaction(reaction.id);
    expect((await cache.load()).reactions).toEqual([]);
  });

  it("persists tasks by canonical version while independently advancing event cursors", async () => {
    const cache = create();
    await cache.replaceSnapshot(snapshot, [], [], [task]);
    const mutationProjection: Task = {
      ...task,
      version: 3,
      title: "Build and verify the board",
      updatedAt: "2026-07-24T12:03:00.000Z",
    };
    await cache.upsertTasks([mutationProjection]);

    const olderEventTask: Task = {
      ...task,
      version: 2,
      title: "Stale title",
      updatedAt: "2026-07-24T12:02:00.000Z",
    };
    await expect(cache.applyEvent(taskEvent(olderEventTask, "11"))).resolves.toBe(true);
    expect(await cache.load()).toMatchObject({
      syncCursor: "11",
      tasks: [mutationProjection],
    });

    const newerEventTask: Task = {
      ...mutationProjection,
      version: 4,
      status: "in_progress",
      rank: "2048",
      updatedAt: "2026-07-24T12:04:00.000Z",
    };
    await expect(cache.applyEvent(taskEvent(newerEventTask, "12"))).resolves.toBe(true);
    await expect(cache.applyEvent(taskEvent(newerEventTask, "12"))).resolves.toBe(false);
    expect(await cache.load()).toMatchObject({
      syncCursor: "12",
      tasks: [newerEventTask],
    });
  });
});

describe("PersistentWorkspaceCache durability", () => {
  it("rolls back a projection when its membership signal aborts at transaction commit", async () => {
    const cache = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await cache.replaceSnapshot(snapshot, []);
    const baseSignal = new AbortController().signal;
    let commitChecks = 0;
    let aborted = false;
    const signal = new Proxy(baseSignal, {
      get(target, property) {
        if (property === "aborted") return aborted;
        if (property === "throwIfAborted") {
          return () => {
            commitChecks += 1;
            if (commitChecks === 2) {
              aborted = true;
              throw new DOMException("Membership projection retired", "AbortError");
            }
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(cache.upsertHistory(ALPHA_ID, [messageSequence2], [], signal)).resolves.toBe(
      false,
    );

    expect(commitChecks).toBe(2);
    expect((await cache.load()).messages).toEqual([]);
  });

  it("rolls back an outbox status when its owner aborts at transaction commit", async () => {
    const cache = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await cache.replaceSnapshot(snapshot, []);
    await cache.enqueue(queuedAlphaMessage, NOW);
    const baseSignal = new AbortController().signal;
    let commitChecks = 0;
    let aborted = false;
    const signal = new Proxy(baseSignal, {
      get(target, property) {
        if (property === "aborted") return aborted;
        if (property === "throwIfAborted") {
          return () => {
            commitChecks += 1;
            if (commitChecks === 2) {
              aborted = true;
              throw new DOMException("Outbox owner retired", "AbortError");
            }
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      cache.updateOutbox(
        queuedAlphaMessage.message.clientMessageId,
        {
          status: "sending",
          attemptCount: 1,
          nextAttemptAt: null,
          failureReason: null,
        },
        signal,
        { status: "pending", attemptCount: 0 },
      ),
    ).resolves.toBe(false);

    expect(commitChecks).toBe(2);
    expect((await cache.load()).outbox[0]).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
  });

  it("keeps a completed self-removal purge durable across reopen", async () => {
    const first = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await first.replaceSnapshot(
      snapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
      [task],
    );
    await first.enqueue(queuedAlphaMessage, NOW);
    await first.applyEvent(selfRemovedEvent);

    const reopened = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    const state = await reopened.load();
    expect(
      state.bootstrap?.conversations.some((summary) => summary.conversation.id === ALPHA_ID),
    ).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.reactions).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.outbox).toEqual([]);
    expect(state.repairMarker?.conversationId).toBe(ALPHA_ID);
  });

  it("keeps a source-less retract reservation durable across reopen", async () => {
    const first = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await first.replaceSnapshot(snapshot, []);
    await first.applyEvent(messageRetractedEvent);

    const reopened = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    expect((await reopened.load()).retractReservations).toEqual([
      {
        messageId: MESSAGE_SEQUENCE_2_ID,
        deletedAt: NOW,
        entityVersion: 2,
      },
    ]);
    await expect(reopened.upsertHistory(ALPHA_ID, [messageSequence2])).resolves.toBe(true);
    expect((await reopened.load()).messages[0]).toMatchObject({
      id: MESSAGE_SEQUENCE_2_ID,
      body: "Message 2",
      deletedAt: NOW,
      version: 2,
    });
  });

  it("finishes a staged self-removal purge before exposing a reopened cache", async () => {
    const first = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await first.replaceSnapshot(
      snapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
      [task],
    );
    await first.enqueue(queuedAlphaMessage, NOW);

    const database = new Dexie(`hype-comms-cache-v1-${scope.workspaceId}-${scope.userId}`);
    await database.open();
    await database.table("metadata").update("state", {
      repairMarker: {
        kind: "membership",
        eventId: selfRemovedEvent.id,
        workspaceSequence: selfRemovedEvent.workspaceSequence,
        conversationId: ALPHA_ID,
        selfRemoval: true,
      },
    });
    database.close();

    const reopened = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    const state = await reopened.load();
    expect(
      state.bootstrap?.conversations.some((summary) => summary.conversation.id === ALPHA_ID),
    ).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.reactions).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.outbox).toEqual([]);
    expect(state.syncCursor).toBe(selfRemovedEvent.workspaceSequence);
  });

  it("purges an orphaned reaction when a staged removal is reopened", async () => {
    const first = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await first.replaceSnapshot(snapshot, []);
    await first.applyEvent(reactionAddedEvent);
    await first.stageMembershipRepair(selfRemovedEvent);

    const reopened = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    expect((await reopened.load()).reactions).toEqual([]);
  });

  it("clamps an over-capacity cached member list instead of failing the load", async () => {
    const cache = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await cache.replaceSnapshot(snapshot, []);
    // A client upgraded from the append-only build can hold 26 rows after a disable followed by a
    // create. `workspaceSnapshotSchema.members` is `.max(25)` and `load()` parses through it
    // inside WorkspaceRuntime.start()'s try block, so throwing here bricks the app for good.
    await cache.replaceMembers(overCapacityMembers);

    const state = await cache.load();
    expect(state.bootstrap?.members).toHaveLength(25);
    expect(state.bootstrap?.members.map((member) => member.displayName)).toEqual(
      overCapacityMembers.slice(0, 25).map((member) => member.displayName),
    );

    // The next server-derived write repairs the truncation.
    await cache.replaceMembers([morgan, alice]);
    expect((await cache.load()).bootstrap?.members.map((member) => member.id)).toEqual([
      ALICE_ID,
      MORGAN_ID,
    ]);
  });
});

describe("created-message mention retention", () => {
  it("keeps only the newest bounded exact mention metadata", () => {
    const mentions = new Map<string, readonly string[]>();
    for (let index = 0; index <= MAX_RECENT_MESSAGE_MENTIONS; index += 1) {
      rememberCreatedMessageMentions(mentions, `message-${String(index)}`, [MORGAN_ID]);
    }

    expect(mentions.size).toBe(MAX_RECENT_MESSAGE_MENTIONS);
    expect(mentions.has("message-0")).toBe(false);
    expect(mentions.has(`message-${String(MAX_RECENT_MESSAGE_MENTIONS)}`)).toBe(true);
  });
});

describe("retract reservation retention", () => {
  it("keeps only the newest bounded reservations", () => {
    const existing = Array.from({ length: MAX_RETRACT_RESERVATIONS }, (_, index) => ({
      messageId: `retracted-message-${index}`,
      deletedAt: NOW,
      entityVersion: 2,
    }));
    const reservations = upsertRetractReservation(existing, {
      messageId: `retracted-message-${MAX_RETRACT_RESERVATIONS}`,
      deletedAt: NOW,
      entityVersion: 2,
    });

    expect(reservations).toHaveLength(MAX_RETRACT_RESERVATIONS);
    expect(reservations[0]?.messageId).toBe("retracted-message-1");
    expect(reservations.at(-1)?.messageId).toBe(`retracted-message-${MAX_RETRACT_RESERVATIONS}`);
  });
});

describe("PersistentWorkspaceCache retraction write races", () => {
  it("retries a snapshot write when a source-less retract arrives during encryption", async () => {
    const writerCrypto = new DeferredFakeCrypto();
    const writer = new PersistentWorkspaceCache({ crypto: writerCrypto, scope });
    const retracting = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await writer.replaceSnapshot(snapshot, []);

    const gate = writerCrypto.pauseNextEncryption();
    const replacing = writer.replaceSnapshot(
      { ...snapshot, syncCursor: messageRetractedEvent.workspaceSequence },
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
    );
    await gate.started;
    await expect(retracting.applyEvent(messageRetractedEvent)).resolves.toBe(true);
    gate.release();
    await expect(replacing).resolves.toBe(true);

    const raw = await readRawCacheMessagesAndReactionCount();
    expect(raw.messages).toEqual([
      expect.objectContaining({
        id: MESSAGE_SEQUENCE_2_ID,
        deletedAt: NOW,
        version: messageRetractedEvent.entityVersion,
      }),
    ]);
    expect(raw.reactionCount).toBe(0);
  });

  it("retries a history write when a source-less retract arrives during encryption", async () => {
    const writerCrypto = new DeferredFakeCrypto();
    const writer = new PersistentWorkspaceCache({ crypto: writerCrypto, scope });
    const retracting = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await writer.replaceSnapshot(snapshot, []);

    const gate = writerCrypto.pauseNextEncryption();
    const writingHistory = writer.upsertHistory(
      ALPHA_ID,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
    );
    await gate.started;
    await expect(retracting.applyEvent(messageRetractedEvent)).resolves.toBe(true);
    gate.release();
    await expect(writingHistory).resolves.toBe(true);

    const raw = await readRawCacheMessagesAndReactionCount();
    expect(raw.messages).toEqual([
      expect.objectContaining({
        id: MESSAGE_SEQUENCE_2_ID,
        deletedAt: NOW,
        version: messageRetractedEvent.entityVersion,
      }),
    ]);
    expect(raw.reactionCount).toBe(0);
  });

  it("rewrites an in-flight create as a tombstone after a history retraction", async () => {
    const writerCrypto = new DeferredFakeCrypto();
    const writer = new PersistentWorkspaceCache({ crypto: writerCrypto, scope });
    const retracting = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await writer.replaceSnapshot(snapshot, []);
    const tombstone = {
      ...messageSequence2,
      deletedAt: NOW,
      version: messageRetractedEvent.entityVersion,
      updatedAt: NOW,
    };

    const gate = writerCrypto.pauseNextEncryption();
    const creating = writer.applyEvent(messageCreatedEvent);
    await gate.started;
    await expect(retracting.upsertHistory(ALPHA_ID, [tombstone])).resolves.toBe(true);
    gate.release();
    await expect(creating).resolves.toBe(true);

    const raw = await readRawCacheMessagesAndReactionCount();
    expect(raw.messages).toEqual([
      expect.objectContaining({
        id: MESSAGE_SEQUENCE_2_ID,
        deletedAt: NOW,
        version: messageRetractedEvent.entityVersion,
      }),
    ]);
    expect(raw.reactionCount).toBe(0);
  });

  it("keeps concurrent retraction reservations while a tombstone is encrypting", async () => {
    const writerCrypto = new DeferredFakeCrypto();
    const writer = new PersistentWorkspaceCache({ crypto: writerCrypto, scope });
    const history = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await writer.replaceSnapshot(snapshot, [messageSequence1, messageSequence2]);
    const firstTombstone = {
      ...messageSequence1,
      deletedAt: NOW,
      version: 2,
      updatedAt: NOW,
    };

    const gate = writerCrypto.pauseNextEncryption();
    const retracting = writer.applyEvent(messageRetractedEvent);
    await gate.started;
    await expect(history.upsertHistory(ALPHA_ID, [firstTombstone])).resolves.toBe(true);
    gate.release();
    await expect(retracting).resolves.toBe(true);

    expect((await writer.load()).retractReservations).toEqual(
      expect.arrayContaining([
        {
          messageId: MESSAGE_SEQUENCE_1_ID,
          deletedAt: NOW,
          entityVersion: firstTombstone.version,
        },
        {
          messageId: MESSAGE_SEQUENCE_2_ID,
          deletedAt: NOW,
          entityVersion: messageRetractedEvent.entityVersion,
        },
      ]),
    );
  });

  it("retries a history write and retains the newer message when a live create arrives during history decryption", async () => {
    const writerCrypto = new DeferredFakeCrypto();
    const writer = new PersistentWorkspaceCache({ crypto: writerCrypto, scope });
    const live = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await writer.replaceSnapshot(snapshot, [messageSequence2]);

    const olderHistoryMessage: Message = {
      ...messageSequence2,
      body: "older version from history",
      version: 1,
    };
    const newerLiveMessage: Message = {
      ...messageSequence2,
      body: "newer version from realtime",
      version: 2,
    };
    const liveEvent: WorkspaceEvent = {
      ...messageCreatedEvent,
      workspaceSequence: "100",
      entityVersion: 2,
      payload: {
        message: newerLiveMessage,
        mentionedUserIds: [],
      },
    };

    const gate = writerCrypto.pauseNextDecryption();
    const writingHistory = writer.upsertHistory(ALPHA_ID, [olderHistoryMessage]);
    await gate.started;
    await expect(live.applyEvent(liveEvent)).resolves.toBe(true);
    gate.release();
    await expect(writingHistory).resolves.toBe(true);

    const raw = await readRawCacheMessagesAndReactionCount();
    expect(raw.messages).toEqual([
      expect.objectContaining({
        id: MESSAGE_SEQUENCE_2_ID,
        body: "newer version from realtime",
        version: 2,
      }),
    ]);
  });
});

describe("workspace cache implementation parity", () => {
  it("returns identical loaded state from both implementations", async () => {
    const memory: WorkspaceCache = new MemoryWorkspaceCache();
    const persistent: WorkspaceCache = new PersistentWorkspaceCache({
      crypto: new FakeCrypto(),
      scope,
    });
    for (const cache of [memory, persistent]) {
      await cache.replaceSnapshot(snapshot, []);
      await cache.upsertHistory(ALPHA_ID, [messageSequence10, messageSequence1]);
      await cache.applyEvent(messageCreatedEvent);
      await cache.applyEvent(readCursorEvent);
      await cache.applyEvent(memberUpdatedEvent);
      await cache.replaceMembers([alice, morgan, disabledAgent]);
      await cache.upsertTasks([task]);
    }

    const memoryState = withoutTimestamps(await memory.load());
    const persistentState = withoutTimestamps(await persistent.load());
    expect(memoryState).toEqual(persistentState);
  });
});
