import type {
  CacheDecryptBatchRequest,
  CacheDecryptBatchResponse,
  CacheEncryptBatchRequest,
  CacheEncryptBatchResponse,
} from "@hype-comms/contracts";
import Dexie from "dexie";

import { PersistentWorkspaceCache } from "../../apps/desktop/src/renderer/src/workspace-cache";
import { legacyStores, operation, scope } from "./cache-fixture";

declare global {
  interface Window {
    encryptCacheRecords(input: CacheEncryptBatchRequest): Promise<CacheEncryptBatchResponse>;
    decryptCacheRecords(input: CacheDecryptBatchRequest): Promise<CacheDecryptBatchResponse>;
  }
}

const databaseName = `hype-comms-cache-v1-${scope.workspaceId}-${scope.userId}`;
function cache(): PersistentWorkspaceCache {
  return new PersistentWorkspaceCache({
    scope,
    crypto: {
      encryptCacheRecords: (input) => window.encryptCacheRecords(input),
      decryptCacheRecords: (input) => window.decryptCacheRecords(input),
    },
  });
}
async function inspect() {
  const database = new Dexie(databaseName);
  await database.open();
  try {
    return {
      version: database.verno,
      tables: Object.fromEntries(
        await Promise.all(
          database.tables.map(async (table) => [table.name, await table.toArray()]),
        ),
      ),
    };
  } finally {
    database.close();
  }
}
async function seed() {
  const encrypted = await window.encryptCacheRecords({
    items: [
      {
        store: "outbox",
        recordId: operation.message.clientMessageId,
        schemaVersion: 1,
        plaintext: JSON.stringify(operation),
      },
    ],
  });
  const value = encrypted.items[0]?.value;
  if (value === undefined) throw new Error("The cipher returned no operation");
  const database = new Dexie(databaseName);
  database.version(5).stores(legacyStores);
  await database.open();
  try {
    await database.table("outbox").put({
      clientMessageId: operation.message.clientMessageId,
      conversationId: operation.conversationId,
      createdAt: "2026-09-12T00:00:00.000Z",
      status: "sending",
      attemptCount: 2,
      nextAttemptAt: null,
      failureReason: null,
      value,
    });
    await database
      .table("metadata")
      .put({ id: "state", ...scope, syncCursor: "19", lastSyncedAt: null });
    await database.table("messages").put({
      id: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      value: { obsolete: true },
    });
  } finally {
    database.close();
  }
  return inspect();
}
async function interruptedUpgrade() {
  const original = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function () {
    if (this.name === "messages")
      throw new DOMException("Rehearsal upgrade interruption", "AbortError");
    return original.call(this);
  };
  let rejected = false;
  const pending = cache();
  try {
    await pending.load();
  } catch {
    rejected = true;
  } finally {
    IDBObjectStore.prototype.clear = original;
  }
  if (!rejected) throw new Error("The interrupted upgrade unexpectedly succeeded");
  return inspect();
}
async function migrate() {
  const current = cache();
  const loaded = await current.load();
  await current.resetProtocolReplica();
  await current.resetProtocolReplica();
  return { loaded, reset: await current.load(), stored: await inspect(), operation };
}
Object.assign(window, { rehearsalCache: { seed, inspect, interruptedUpgrade, migrate } });
