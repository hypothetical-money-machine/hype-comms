import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  cacheDecryptBatchResponseSchema,
  cacheEncryptBatchResponseSchema,
  type CacheDecryptBatchRequest,
  type CacheEncryptBatchRequest,
  type Message,
  type SendMessageOperation,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hmm-chat/contracts";

import { clearPersistentWorkspaceCaches, PersistentWorkspaceCache } from "./workspace-cache";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const CLIENT_MESSAGE_ID = "10000000-0000-4000-8000-000000000005";
const NOW = "2026-07-24T12:00:00.000Z";
const scope = { userId: USER_ID, workspaceId: WORKSPACE_ID };

const user = {
  id: USER_ID,
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const bootstrap: WorkspaceBootstrapResponse = {
  currentUser: {
    user,
    email: "morgan@example.com",
    workspaceId: WORKSPACE_ID,
    role: "owner",
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "HMM Chat",
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
    },
  ],
  syncCursor: "0",
  featureFlags: { channels: true, directMessages: true, mentions: true },
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
          ciphertext: btoa(item.plaintext)
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
        plaintext: atob(
          item.value.ciphertext
            .replaceAll("-", "+")
            .replaceAll("_", "/")
            .padEnd(Math.ceil(item.value.ciphertext.length / 4) * 4, "="),
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
    await restarted.upsertAcknowledgedMessage(message, "1");

    const recovered = await restarted.load();
    expect(recovered.outbox).toEqual([]);
    expect(recovered.messages).toEqual([message]);
    expect(recovered.syncCursor).toBe("1");
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
});
