import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { SendMessageOperation } from "@hype-comms/contracts";
import Dexie from "dexie";
import { expect, it } from "vitest";

import { PersistentWorkspaceCache } from "../src/renderer/src/workspace-cache";
import { CacheCrypto, type SafeStorageAdapter } from "../src/main/cache-crypto";
import { createTemporaryDirectory } from "../src/main/test-support/temporary-directory";

// Only OS key wrapping is substituted. The production cipher, AAD, key file and cache upgrade run.
const safeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "kwallet6",
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};

it("reopens a version 5 encrypted outbox with the same key after replica migration and reset", async () => {
  const userDataPath = await createTemporaryDirectory("hype-comms-epoch-crypto-");
  const scope = { userId: randomUUID(), workspaceId: randomUUID() };
  const options = {
    userDataPath,
    apiOrigin: "https://chat.example",
    platform: "linux" as const,
    safeStorage,
  };
  const cipher = new CacheCrypto(options);
  expect((await cipher.initialize(scope)).mode).toBe("persistent");
  const clientMessageId = randomUUID();
  const operation: SendMessageOperation = {
    conversationId: randomUUID(),
    idempotencyKey: clientMessageId,
    message: {
      clientMessageId,
      body: "Unsent before upgrade 🦊",
      bodyFormat: "hype_comms_markdown_v1",
      threadRootId: null,
      mentionedUserIds: [],
      attachmentIds: [],
    },
  };
  const encrypted = cipher.encrypt({
    items: [
      {
        store: "outbox",
        recordId: operation.message.clientMessageId,
        schemaVersion: 1,
        plaintext: JSON.stringify(operation),
      },
    ],
  }).items[0];
  if (encrypted === undefined) throw new Error("Missing encrypted operation");
  const cacheDirectory = path.join(userDataPath, "cache");
  const keyFile = (await readdir(cacheDirectory)).find((name) => name.endsWith(".bin"));
  if (keyFile === undefined) throw new Error("Missing persisted encryption key");
  const keyPath = path.join(cacheDirectory, keyFile);
  const keyBefore = await readFile(keyPath);
  const name = `hype-comms-cache-v1-${scope.workspaceId}-${scope.userId}`;
  const legacy = new Dexie(name);
  legacy.version(5).stores({
    metadata: "&id",
    workspaces: "&id",
    members: "&id,updatedAt",
    conversations: "&id,kind,updatedAt",
    messages: "&id,&clientMessageId,conversationId,createdAt,conversationSequence",
    reactions: "&id,messageId,conversationId,userId,createdAt",
    tasks: "&id,conversationId,assigneeId,status,rank,updatedAt",
    outbox: "&clientMessageId,conversationId,createdAt,status,nextAttemptAt",
    events: "&id,workspaceSequence",
  });
  const row = {
    clientMessageId: operation.message.clientMessageId,
    conversationId: operation.conversationId,
    createdAt: "2026-09-12T00:00:00.000Z",
    status: "sending",
    attemptCount: 2,
    nextAttemptAt: null,
    failureReason: null,
    value: encrypted.value,
  };
  await legacy.open();
  await legacy.table("outbox").put(row);
  // An old incomplete membership repair must not remove unsent work during the upgrade.
  await legacy.table("metadata").put({
    id: "state",
    ...scope,
    syncCursor: "19",
    repairMarker: {
      kind: "membership",
      eventId: randomUUID(),
      workspaceSequence: "20",
      conversationId: operation.conversationId,
      selfRemoval: true,
    },
  });
  await legacy
    .table("messages")
    .put({ id: randomUUID(), clientMessageId: randomUUID(), value: { obsolete: true } });
  legacy.close();

  const reopenedCipher = new CacheCrypto(options);
  await reopenedCipher.initialize(scope);
  const cache = new PersistentWorkspaceCache({
    scope,
    crypto: {
      encryptCacheRecords: async (input) => reopenedCipher.encrypt(input),
      decryptCacheRecords: async (input) => reopenedCipher.decrypt(input),
    },
  });
  try {
    const migrated = await cache.load();
    expect(migrated).toMatchObject({
      bootstrap: null,
      syncCursor: null,
      messages: [],
      repairMarker: null,
    });
    expect(migrated.outbox).toEqual([
      {
        operation,
        createdAt: row.createdAt,
        status: "pending",
        attemptCount: 2,
        nextAttemptAt: null,
        failureReason: null,
      },
    ]);
    await cache.resetProtocolReplica();
    await cache.resetProtocolReplica();
    expect((await cache.load()).outbox).toEqual(migrated.outbox);
    const stored = new Dexie(name);
    await stored.open();
    try {
      expect(await stored.table("outbox").get(row.clientMessageId)).toEqual(row);
    } finally {
      stored.close();
    }
    expect(await readFile(keyPath)).toEqual(keyBefore);
  } finally {
    await cache.clearAll();
  }
});
