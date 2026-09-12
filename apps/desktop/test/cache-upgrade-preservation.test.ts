import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { SendMessageOperation, WorkspaceSnapshot } from "@hype-comms/contracts";
import Dexie from "dexie";
import { IDBObjectStore } from "fake-indexeddb";
import { expect, it, vi } from "vitest";

import { CacheCrypto, type SafeStorageAdapter } from "../src/main/cache-crypto";
import { DevicePreferencesStore } from "../src/main/device-preferences-store";
import { createTemporaryDirectory } from "../src/main/test-support/temporary-directory";
import { DEFAULT_DEVICE_PREFERENCES } from "../src/shared/device-preferences";
import { PersistentWorkspaceCache } from "../src/renderer/src/workspace-cache";

const safeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "kwallet6",
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const legacyStores = {
  metadata: "&id",
  workspaces: "&id",
  members: "&id,updatedAt",
  conversations: "&id,kind,updatedAt",
  messages: "&id,&clientMessageId,conversationId,createdAt,conversationSequence",
  reactions: "&id,messageId,conversationId,userId,createdAt",
  tasks: "&id,conversationId,assigneeId,status,rank,updatedAt",
  outbox: "&clientMessageId,conversationId,createdAt,status,nextAttemptAt",
  events: "&id,workspaceSequence",
};

async function seedLegacyScope(userDataPath: string) {
  const scope = { userId: randomUUID(), workspaceId: randomUUID() };
  const options = {
    userDataPath,
    apiOrigin: "https://chat.example",
    platform: "linux" as const,
    safeStorage,
  };
  const cipher = new CacheCrypto(options);
  expect((await cipher.initialize(scope)).mode).toBe("persistent");
  const name = `hype-comms-cache-v1-${scope.workspaceId}-${scope.userId}`;
  const legacy = new Dexie(name);
  legacy.version(5).stores(legacyStores);
  const operations: SendMessageOperation[] = ["Pending 😀", "Acknowledgement lost 🦊"].map(
    (body) => {
      const id = randomUUID();
      return {
        conversationId: randomUUID(),
        idempotencyKey: id,
        message: {
          clientMessageId: id,
          body,
          bodyFormat: "hype_comms_markdown_v1",
          threadRootId: null,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      };
    },
  );
  const rows = operations.map((operation, index) => ({
    clientMessageId: operation.message.clientMessageId,
    conversationId: operation.conversationId,
    createdAt: `2026-09-12T00:00:0${index}.000Z`,
    status: index === 0 ? "pending" : "sending",
    attemptCount: index,
    nextAttemptAt: null,
    failureReason: null,
    value: cipher.encrypt({
      items: [
        {
          store: "outbox",
          recordId: operation.message.clientMessageId,
          schemaVersion: 1,
          plaintext: JSON.stringify(operation),
        },
      ],
    }).items[0]!.value,
  }));
  await legacy.open();
  await legacy.table("outbox").bulkPut(rows);
  await legacy
    .table("metadata")
    .put({ id: "state", ...scope, syncCursor: "19", lastSyncedAt: null });
  for (const table of [
    "workspaces",
    "members",
    "conversations",
    "messages",
    "reactions",
    "tasks",
    "events",
  ]) {
    await legacy
      .table(table)
      .put({ id: randomUUID(), clientMessageId: randomUUID(), value: { legacy: true } });
  }
  legacy.close();
  const openCurrent = async () => {
    const reopened = new CacheCrypto(options);
    expect((await reopened.initialize(scope)).mode).toBe("persistent");
    return new PersistentWorkspaceCache({
      scope,
      crypto: {
        encryptCacheRecords: async (input) => reopened.encrypt(input),
        decryptCacheRecords: async (input) => reopened.decrypt(input),
      },
    });
  };
  return { name, scope, operations, rows, openCurrent };
}

async function inspectDatabase(name: string) {
  const database = new Dexie(name);
  await database.open();
  try {
    return {
      version: database.verno,
      tables: Object.fromEntries(
        await Promise.all(
          database.tables.map(async (table) => [table.name, await table.toArray()] as const),
        ),
      ),
    };
  } finally {
    database.close();
  }
}

async function keyBytes(userDataPath: string) {
  const directory = path.join(userDataPath, "cache");
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory))
        .sort()
        .map(async (file) => [file, await readFile(path.join(directory, file))] as const),
    ),
  );
}

it("rolls back an interrupted IndexedDB upgrade and retries without changing pending ciphertext", async () => {
  const directory = await createTemporaryDirectory("hype-upgrade-interrupted-");
  const fixture = await seedLegacyScope(directory);
  const before = await inspectDatabase(fixture.name);
  const keys = await keyBytes(directory);
  const clear = IDBObjectStore.prototype.clear;
  const interruption = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (
    this: InstanceType<typeof IDBObjectStore>,
  ) {
    if (this.name === "messages") throw new DOMException("Upgrade interrupted", "AbortError");
    return clear.call(this);
  });
  try {
    const failed = await fixture.openCurrent();
    await expect(failed.load()).rejects.toThrow(/Upgrade interrupted/u);
  } finally {
    interruption.mockRestore();
  }
  expect(await inspectDatabase(fixture.name)).toEqual(before);
  expect(await keyBytes(directory)).toEqual(keys);
  const retried = await fixture.openCurrent();
  try {
    const state = await retried.load();
    expect(state.bootstrap).toBeNull();
    expect(state.syncCursor).toBeNull();
    expect(state.outbox.map((item) => item.operation)).toEqual(fixture.operations);
    expect(state.outbox.map((item) => item.status)).toEqual(["pending", "pending"]);
    expect((await inspectDatabase(fixture.name)).tables.outbox).toEqual(before.tables.outbox);
    expect(await keyBytes(directory)).toEqual(keys);
    const now = "2026-09-12T00:00:00.000Z";
    const emptyCatalog: WorkspaceSnapshot = {
      currentUser: {
        user: {
          id: fixture.scope.userId,
          kind: "human",
          username: "upgrade-owner",
          displayName: "Owner",
          avatarUrl: null,
          createdAt: now,
          updatedAt: now,
        },
        email: "upgrade@example.test",
        workspaceId: fixture.scope.workspaceId,
        role: "owner",
      },
      workspace: {
        id: fixture.scope.workspaceId,
        name: "Preservation",
        slug: "preservation",
        createdBy: fixture.scope.userId,
        createdAt: now,
        updatedAt: now,
      },
      members: [],
      conversations: [],
      syncCursor: { epoch: randomUUID(), sequence: "20" },
      featureFlags: {
        channels: true,
        directMessages: true,
        mentions: true,
        announcementChannels: false,
        humansOnlyChannels: false,
      },
    };
    await retried.installMetadataSnapshot(emptyCatalog);
    const retained = (await retried.load()).outbox;
    expect(retained.map((item) => item.operation)).toEqual(fixture.operations);
    expect(retained.map((item) => item.status)).toEqual(["permanent_failure", "permanent_failure"]);
    const stored = (await inspectDatabase(fixture.name)).tables.outbox;
    const originalOutbox = before.tables.outbox;
    if (originalOutbox === undefined) throw new Error("The legacy outbox fixture is missing");
    expect(stored).toEqual(
      originalOutbox.map((row: Record<string, unknown>) => ({
        ...row,
        status: "permanent_failure",
        nextAttemptAt: null,
        failureReason:
          "Conversation access was removed. Your unsent message is retained on this device.",
      })),
    );
    expect(await keyBytes(directory)).toEqual(keys);
  } finally {
    await retried.clearAll();
  }
});

it("upgrades each signed-in scope independently while preserving preferences and the other scope's old database", async () => {
  const directory = await createTemporaryDirectory("hype-upgrade-scopes-");
  const first = await seedLegacyScope(directory);
  const second = await seedLegacyScope(directory);
  const secondBefore = await inspectDatabase(second.name);
  const preferences = {
    ...DEFAULT_DEVICE_PREFERENCES,
    spellCheck: false,
    sendMessageShortcut: "mod-enter" as const,
  };
  const preferenceStore = new DevicePreferencesStore({ userDataPath: directory });
  await preferenceStore.save(preferences);
  const preferencePath = path.join(directory, "hype-comms-settings/device-preferences.json");
  const preferenceBytes = await readFile(preferencePath);
  const keys = await keyBytes(directory);
  const firstCache = await first.openCurrent();
  const secondCache = await second.openCurrent();
  try {
    expect((await firstCache.load()).outbox.map((item) => item.operation)).toEqual(
      first.operations,
    );
    await firstCache.resetProtocolReplica();
    expect(await inspectDatabase(second.name)).toEqual(secondBefore);
    expect((await secondCache.load()).outbox.map((item) => item.operation)).toEqual(
      second.operations,
    );
    await secondCache.resetProtocolReplica();
    await secondCache.resetProtocolReplica();
    expect((await secondCache.load()).outbox.map((item) => item.operation)).toEqual(
      second.operations,
    );
    expect((await firstCache.load()).outbox.map((item) => item.operation)).toEqual(
      first.operations,
    );
    expect(await new DevicePreferencesStore({ userDataPath: directory }).load()).toEqual(
      preferences,
    );
    expect(await readFile(preferencePath)).toEqual(preferenceBytes);
    expect(await keyBytes(directory)).toEqual(keys);
  } finally {
    await firstCache.clearAll();
    await secondCache.clearAll();
  }
});
