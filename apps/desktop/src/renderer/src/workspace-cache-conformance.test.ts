import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import {
  cacheDecryptBatchResponseSchema,
  cacheEncryptBatchResponseSchema,
  type CacheDecryptBatchRequest,
  type CacheEncryptBatchRequest,
  type ConversationSummary,
  type Message,
  type SendMessageOperation,
  type Task,
  type User,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
} from "@hmm-chat/contracts";

import {
  clearPersistentWorkspaceCaches,
  MemoryWorkspaceCache,
  PersistentWorkspaceCache,
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
    slug: "hmm-chat",
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
    bodyFormat: "hmm_markdown_v1",
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
    bodyFormat: "hmm_markdown_v1",
    clientMessageId: "10000000-0000-4000-8000-000000000069",
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
    await cache.upsertHistory([messageSequence10, messageSequence1, messageSequence2]);

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

  it("does not purge a conversation when a different member is removed", async () => {
    const cache = create();
    await cache.replaceSnapshot(
      snapshot,
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
    expect(state.repairMarker).toMatchObject({
      conversationId: ALPHA_ID,
      selfRemoval: false,
    });
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

    await cache.upsertHistory([messageSequence2], []);
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

  it("finishes a staged self-removal purge before exposing a reopened cache", async () => {
    const first = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope });
    await first.replaceSnapshot(
      snapshot,
      [messageSequence2],
      [reactionAddedEvent.payload.reaction],
      [task],
    );
    await first.enqueue(queuedAlphaMessage, NOW);

    const database = new Dexie(`hmm-chat-cache-v2-${scope.workspaceId}-${scope.userId}`);
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

describe("workspace cache implementation parity", () => {
  it("returns identical loaded state from both implementations", async () => {
    const memory: WorkspaceCache = new MemoryWorkspaceCache();
    const persistent: WorkspaceCache = new PersistentWorkspaceCache({
      crypto: new FakeCrypto(),
      scope,
    });
    for (const cache of [memory, persistent]) {
      await cache.replaceSnapshot(snapshot, []);
      await cache.upsertHistory([messageSequence10, messageSequence1]);
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
