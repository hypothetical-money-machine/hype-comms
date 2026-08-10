import "fake-indexeddb/auto";

import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";

import {
  cacheDecryptBatchResponseSchema,
  cacheEncryptBatchResponseSchema,
  type CacheDecryptBatchRequest,
  type CacheEncryptBatchRequest,
  type Message,
  type Reaction,
  type SendMessageOperation,
  type HumanWorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hmm-chat/contracts";

import {
  clearPersistentWorkspaceCache,
  clearPersistentWorkspaceCaches,
  PersistentWorkspaceCache,
} from "./workspace-cache";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000008";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const CLIENT_MESSAGE_ID = "10000000-0000-4000-8000-000000000005";
const NOW = "2026-07-24T12:00:00.000Z";
const scope = { userId: USER_ID, workspaceId: WORKSPACE_ID };

const user = {
  id: USER_ID,
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const bootstrap: HumanWorkspaceBootstrapResponse = {
  currentUser: {
    user,
    email: "morgan@example.com",
    workspaceId: WORKSPACE_ID,
    role: "owner",
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "Hype Comms",
    slug: "hmm-chat",
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [user],
  conversations: [
    {
      conversation: {
        id: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "channel",
        name: "General",
        slug: "general",
        topic: null,
        access: "workspace",
        channelMode: "chat",
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
    },
  ],
  conversationsNextCursor: null,
  conversationsHasMore: false,
  syncCursor: "0",
  featureFlags: {
    channels: true,
    directMessages: true,
    mentions: true,
    announcementChannels: false,
  },
};

const operation: SendMessageOperation = {
  conversationId: CONVERSATION_ID,
  idempotencyKey: CLIENT_MESSAGE_ID,
  message: {
    threadRootId: null,
    body: "Survive restart",
    bodyFormat: "hmm_markdown_v1",
    clientMessageId: CLIENT_MESSAGE_ID,
    mentionedUserIds: [],
    attachmentIds: [],
  },
};

const message: Message = {
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  conversationSequence: "1",
  version: 1,
  clientMessageId: CLIENT_MESSAGE_ID,
  authorId: USER_ID,
  threadRootId: null,
  body: "Survive restart",
  bodyFormat: "hmm_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const reaction: Reaction = {
  id: "10000000-0000-4000-8000-000000000006",
  messageId: MESSAGE_ID,
  userId: USER_ID,
  emoji: "🎉",
  createdAt: NOW,
};

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

afterEach(async () => {
  await clearPersistentWorkspaceCaches();
});

describe("PersistentWorkspaceCache", () => {
  it("survives restart and reconciles a committed retry by client message ID", async () => {
    const crypto = new FakeCrypto();
    const first = new PersistentWorkspaceCache({ crypto, scope });
    await first.replaceSnapshot(bootstrap, []);
    await first.enqueue(operation);

    const restarted = new PersistentWorkspaceCache({ crypto, scope });
    expect((await restarted.load()).outbox).toHaveLength(1);
    await restarted.upsertAcknowledgedMessage(message, CLIENT_MESSAGE_ID, "1");

    const recovered = await restarted.load();
    expect(recovered.outbox).toEqual([]);
    expect(recovered.messages).toEqual([message]);
    expect(recovered.syncCursor).toBe("1");
  });

  it("restores encrypted reactions without exposing the emoji in IndexedDB indexes", async () => {
    const crypto = new FakeCrypto();
    const first = new PersistentWorkspaceCache({ crypto, scope });
    await first.replaceSnapshot(bootstrap, [message], [reaction]);

    const restarted = new PersistentWorkspaceCache({ crypto, scope });
    expect((await restarted.load()).reactions).toEqual([reaction]);

    const name = `hmm-chat-cache-v2-${scope.workspaceId}-${scope.userId}`;
    const database = new Dexie(name);
    await database.open();
    const rows = await database.table("reactions").toArray();
    database.close();
    expect(JSON.stringify(rows)).not.toContain(reaction.emoji);
    expect(rows[0]).toMatchObject({ id: reaction.id, messageId: reaction.messageId });
  });

  it("applies duplicate events once and preserves queued sends during snapshot reset", async () => {
    const crypto = new FakeCrypto();
    const cache = new PersistentWorkspaceCache({ crypto, scope });
    await cache.replaceSnapshot(bootstrap, []);
    await cache.enqueue(operation);
    const event: WorkspaceEvent = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000006",
      type: "message.created",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "1",
      conversationSequence: "1",
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { message, mentionedUserIds: [] },
    };
    await expect(cache.applyEvent(event)).resolves.toBe(true);
    await expect(cache.applyEvent(event)).resolves.toBe(false);

    await cache.enqueue({ ...operation, idempotencyKey: operation.message.clientMessageId });
    await cache.clearServerStatePreservingOutbox();
    const state = await cache.load();
    expect(state.bootstrap).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.outbox).toHaveLength(1);
  });

  it("deletes only the scope that asked, so another member keeps their queued sends", async () => {
    const crypto = new FakeCrypto();
    // Two members sharing one OS account: the first signs out while the second is still waiting for
    // messages to go out. A sign-out resets the signed-in scope, and nobody agreed to discard the
    // other member's outbox along with it.
    const otherScope = { userId: OTHER_USER_ID, workspaceId: WORKSPACE_ID };
    const mine = new PersistentWorkspaceCache({ crypto, scope });
    const theirs = new PersistentWorkspaceCache({ crypto, scope: otherScope });
    await mine.replaceSnapshot(bootstrap, []);
    await theirs.replaceSnapshot(bootstrap, []);
    await mine.enqueue(operation);
    await theirs.enqueue(operation);

    await clearPersistentWorkspaceCache(scope);

    const reopenedMine = await new PersistentWorkspaceCache({ crypto, scope }).load();
    expect(reopenedMine.bootstrap).toBeNull();
    expect(reopenedMine.outbox).toEqual([]);
    const reopenedTheirs = await new PersistentWorkspaceCache({
      crypto,
      scope: otherScope,
    }).load();
    expect(reopenedTheirs.outbox).toHaveLength(1);
    expect(reopenedTheirs.outbox[0]?.operation.message.body).toBe("Survive restart");
  });

  it("upgrades a version 1 database in place with message and reaction indexes", async () => {
    // A scope of its own, so no cache opened by an earlier test can still hold this database.
    const upgradeScope = {
      userId: "10000000-0000-4000-8000-000000000007",
      workspaceId: WORKSPACE_ID,
    };
    const name = `hmm-chat-cache-v2-${upgradeScope.workspaceId}-${upgradeScope.userId}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      metadata: "&id",
      workspaces: "&id",
      members: "&id,updatedAt",
      conversations: "&id,kind,updatedAt",
      messages: "&id,&clientMessageId,conversationId,createdAt",
      outbox: "&clientMessageId,conversationId,createdAt,status,nextAttemptAt",
      events: "&id,workspaceSequence",
    });
    await legacy.open();
    const legacyMetadata = { id: "state", ...upgradeScope, syncCursor: "12", lastSyncedAt: NOW };
    await legacy.table("metadata").put(legacyMetadata);
    legacy.close();

    const cache = new PersistentWorkspaceCache({ crypto: new FakeCrypto(), scope: upgradeScope });
    const state = await cache.load();
    expect(state.syncCursor).toBe("12");

    const upgraded = new Dexie(name);
    await upgraded.open();
    const indexes = upgraded.table("messages").schema.indexes.map((index) => index.name);
    const reactionIndexes = upgraded.table("reactions").schema.indexes.map((index) => index.name);
    upgraded.close();
    expect(indexes).toContain("conversationSequence");
    expect(reactionIndexes).toContain("messageId");
  });

  it("upgrades version 4 reactions with ownership without losing related cached data", async () => {
    const upgradeScope = {
      userId: "10000000-0000-4000-8000-000000000011",
      workspaceId: WORKSPACE_ID,
    };
    const name = `hmm-chat-cache-v2-${upgradeScope.workspaceId}-${upgradeScope.userId}`;
    const legacy = new Dexie(name);
    legacy.version(4).stores({
      metadata: "&id",
      workspaces: "&id",
      members: "&id,updatedAt",
      conversations: "&id,kind,updatedAt",
      messages: "&id,&clientMessageId,conversationId,createdAt,conversationSequence",
      reactions: "&id,messageId,userId,createdAt",
      tasks: "&id,conversationId,assigneeId,status,rank,updatedAt",
      outbox: "&clientMessageId,conversationId,createdAt,status,nextAttemptAt",
      events: "&id,workspaceSequence",
    });
    await legacy.open();
    const orphanedReaction = {
      ...reaction,
      id: "10000000-0000-4000-8000-000000000012",
      messageId: "10000000-0000-4000-8000-000000000013",
    };
    const crypto = new FakeCrypto();
    const encrypted = await crypto.encryptCacheRecords({
      items: [
        {
          store: "message",
          recordId: message.id,
          schemaVersion: 1,
          plaintext: JSON.stringify(message),
        },
        {
          store: "reaction",
          recordId: reaction.id,
          schemaVersion: 1,
          plaintext: JSON.stringify(reaction),
        },
        {
          store: "reaction",
          recordId: orphanedReaction.id,
          schemaVersion: 1,
          plaintext: JSON.stringify(orphanedReaction),
        },
      ],
    });
    const encryptedValue = (store: string, recordId: string) => {
      const item = encrypted.items.find(
        (candidate) => candidate.store === store && candidate.recordId === recordId,
      );
      if (item === undefined) throw new Error("Missing encrypted test row");
      return item.value;
    };
    await legacy.table("metadata").put({
      id: "state",
      ...upgradeScope,
      syncCursor: "12",
      lastSyncedAt: NOW,
    });
    await legacy.table("messages").put({
      id: message.id,
      clientMessageId: message.clientMessageId,
      conversationId: message.conversationId,
      conversationSequence: message.conversationSequence,
      createdAt: message.createdAt,
      value: encryptedValue("message", message.id),
    });
    await legacy.table("reactions").bulkPut(
      [reaction, orphanedReaction].map((item) => ({
        id: item.id,
        messageId: item.messageId,
        userId: item.userId,
        createdAt: item.createdAt,
        value: encryptedValue("reaction", item.id),
      })),
    );
    legacy.close();

    const upgradedCache = new PersistentWorkspaceCache({ crypto, scope: upgradeScope });
    const state = await upgradedCache.load();
    expect(state.messages).toEqual([message]);
    expect(state.reactions).toEqual([reaction, orphanedReaction]);

    const upgraded = new Dexie(name);
    await upgraded.open();
    expect(upgraded.table("reactions").schema.indexes.map((index) => index.name)).toContain(
      "conversationId",
    );
    expect(await upgraded.table("reactions").get(reaction.id)).toMatchObject({
      id: reaction.id,
      conversationId: CONVERSATION_ID,
    });
    expect(await upgraded.table("reactions").get(orphanedReaction.id)).toMatchObject({
      id: orphanedReaction.id,
      conversationId: "__unknown__",
    });
    upgraded.close();

    const selfRemovedEvent: WorkspaceEvent = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000014",
      type: "channel.membership_changed",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      workspaceSequence: "13",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { memberId: upgradeScope.userId, action: "removed" },
    };
    await upgradedCache.applyEvent(selfRemovedEvent);
    expect((await upgradedCache.load()).reactions).toEqual([]);
  });
});
