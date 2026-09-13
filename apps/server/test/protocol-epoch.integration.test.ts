import { runProtocolEpochCli } from "../src/modules/workspace/protocol-epoch-cli.js";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncPositionSchema } from "@hype-comms/contracts";
import { z } from "zod";

import { runMigrations } from "../src/db/migrate.js";
import {
  establishWorkspaceProtocolEpoch,
  readWorkspaceProtocol,
} from "../src/modules/workspace/protocol-epoch.js";
import { createTestDatabase, type TestDatabase } from "./support/database.js";
import { WorkspaceSyncOperations } from "../src/modules/workspace/sync-operations.js";
import { runIdempotentMutation } from "../src/modules/workspace/idempotency.js";
import { runWorkspaceTransaction } from "../src/modules/workspace/transaction.js";

const ownerId = randomUUID();
const oldWorkspaceId = randomUUID();
const oldSessionId = randomUUID();
const oldConversationId = randomUUID();
const oldMessageId = randomUUID();
const oldAgentId = randomUUID();
const oldAcceptedInput = {
  clientMessageId: randomUUID(),
  body: "Accepted before cutover 😀",
  bodyFormat: "hype_comms_markdown_v1" as const,
  threadRootId: null,
  mentionedUserIds: [],
  attachmentIds: [],
};
let database: TestDatabase;
let oldMigrations: string;
let beforeMigration: unknown;

async function retainedRecords(): Promise<unknown> {
  const result = await database.pool.query(
    `
    SELECT (SELECT jsonb_agg(to_jsonb(row)) FROM users AS row) AS users,
           (SELECT jsonb_agg(to_jsonb(row)) FROM device_sessions AS row WHERE id = $2) AS sessions,
           (SELECT jsonb_agg(to_jsonb(row)) FROM conversations AS row WHERE workspace_id = $1) AS conversations,
           (SELECT jsonb_agg(to_jsonb(row)) FROM messages AS row WHERE workspace_id = $1) AS messages,
           (SELECT jsonb_agg(to_jsonb(row)) FROM tasks AS row WHERE workspace_id = $1) AS tasks,
           (SELECT jsonb_agg(to_jsonb(row)) FROM attachments AS row WHERE workspace_id = $1) AS attachments,
           (SELECT jsonb_agg(to_jsonb(row)) FROM agents AS row WHERE workspace_id = $1) AS agents,
           (SELECT jsonb_agg(to_jsonb(row)) FROM agent_tokens AS row WHERE workspace_id = $1) AS agent_tokens,
           (SELECT jsonb_agg(to_jsonb(row)) FROM sync_events AS row WHERE workspace_id = $1) AS events,
           (SELECT jsonb_agg(to_jsonb(row)) FROM api_idempotency_records AS row WHERE idempotency_key = 'accepted-before-cutover') AS receipts
  `,
    [oldWorkspaceId, oldSessionId],
  );
  return result.rows[0];
}

async function read(workspaceId: string) {
  const client = await database.pool.connect();
  try {
    return await readWorkspaceProtocol(client, workspaceId);
  } finally {
    client.release();
  }
}

async function createWorkspace(sequence = "0") {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO workspaces (id, name, slug, created_by, last_event_sequence)
     VALUES ($1, 'Epoch fixture', $2, $3, $4::bigint)`,
    [id, `epoch-${id}`, ownerId, sequence],
  );
  return { id, state: await read(id) };
}

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  oldMigrations = await mkdtemp(path.join(os.tmpdir(), "hype-comms-epoch-migrations-"));
  const directory = new URL("../src/db/migrations/", import.meta.url);
  for (const filename of await readdir(directory)) {
    if (filename.endsWith(".sql") && filename < "0032_") {
      await copyFile(new URL(filename, directory), path.join(oldMigrations, filename));
    }
  }
  await runMigrations(database.pool, pathToFileURL(`${oldMigrations}/`));
  await database.pool.query(
    `INSERT INTO users (id, email, username, display_name)
     VALUES ($1, 'epoch@example.test', 'epoch-owner', 'Epoch owner')`,
    [ownerId],
  );
  await database.pool.query(
    `INSERT INTO workspaces (id, name, slug, created_by, last_event_sequence)
     VALUES ($1, 'Existing workspace', 'existing-workspace', $2, 7)`,
    [oldWorkspaceId, ownerId],
  );
  await database.pool.query(
    `INSERT INTO device_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, now(), now(), now() + interval '1 day')`,
    [oldSessionId, ownerId, Buffer.alloc(32, 7)],
  );
  await database.pool.query(
    `INSERT INTO sync_events (id, workspace_id, workspace_sequence, event_type, payload)
     VALUES ($1, $2, 7, 'channel.created', '{"historicalShape":true}'::jsonb)`,
    [randomUUID(), oldWorkspaceId],
  );
  await database.pool.query(
    `INSERT INTO api_idempotency_records
      (actor_user_id, route, idempotency_key, request_fingerprint, response_status, response_body)
     VALUES ($1, '/v1/channels', 'accepted-before-cutover', $2, 201, '{"syncCursor":"7"}'::jsonb)`,
    [ownerId, Buffer.alloc(32, 8)],
  );
  await database.pool.query(
    "INSERT INTO users (id, kind, username, display_name) VALUES ($1, 'agent', 'preserved-agent', 'Preserved agent')",
    [oldAgentId],
  );
  await database.pool.query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')",
    [oldWorkspaceId, ownerId, oldAgentId],
  );
  await database.pool.query(
    "INSERT INTO agents (user_id, workspace_id, created_by) VALUES ($1, $2, $3)",
    [oldAgentId, oldWorkspaceId, ownerId],
  );
  await database.pool.query(
    `INSERT INTO agent_tokens (id, workspace_id, agent_user_id, token_hash, label, scopes, created_by)
     VALUES ($1, $2, $3, $4, 'Existing Hermes token', ARRAY['workspace:read', 'messages:write'], $5)`,
    [randomUUID(), oldWorkspaceId, oldAgentId, Buffer.alloc(32, 10), ownerId],
  );
  await database.pool.query(
    `INSERT INTO conversations (id, workspace_id, kind, name, slug, created_by, last_message_sequence, channel_access)
     VALUES ($1, $2, 'channel', 'General', 'general', $3, 1, 'workspace')`,
    [oldConversationId, oldWorkspaceId, ownerId],
  );
  // Freeze the protocol-1 request fingerprint encoding used by an already accepted desktop send.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        conversationId: oldConversationId,
        threadRootId: null,
        body: oldAcceptedInput.body,
        bodyFormat: oldAcceptedInput.bodyFormat,
        clientMessageId: oldAcceptedInput.clientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      }),
    )
    .digest();
  await database.pool.query(
    `INSERT INTO messages (id, workspace_id, conversation_id, conversation_sequence, committed_workspace_sequence,
      client_message_id, request_fingerprint, author_id, body, body_format)
     VALUES ($1, $2, $3, 1, 6, $4, $5, $6, $7, 'hype_comms_markdown_v1')`,
    [
      oldMessageId,
      oldWorkspaceId,
      oldConversationId,
      oldAcceptedInput.clientMessageId,
      fingerprint,
      ownerId,
      oldAcceptedInput.body,
    ],
  );
  await database.pool.query(
    `INSERT INTO tasks (id, workspace_id, conversation_id, number, title, status, rank, created_by, source_message_id)
     VALUES ($1, $2, $3, 1, 'Existing task', 'todo', 1, $4, $5)`,
    [randomUUID(), oldWorkspaceId, oldConversationId, ownerId, oldMessageId],
  );
  await database.pool.query(
    `INSERT INTO attachments (id, workspace_id, conversation_id, message_id, uploaded_by, file_name,
      content_type, size_bytes, content_sha256, status, content_received_at)
     VALUES ($1, $2, $3, $4, $5, 'existing.txt', 'text/plain', 3, $6, 'ready', now())`,
    [randomUUID(), oldWorkspaceId, oldConversationId, oldMessageId, ownerId, Buffer.alloc(32, 11)],
  );
  beforeMigration = await retainedRecords();
  await runMigrations(database.pool);
});

afterAll(async () => {
  await database?.dispose();
  if (oldMigrations !== undefined) await rm(oldMigrations, { recursive: true, force: true });
});

describe("workspace protocol epoch migration", () => {
  it("inspects and activates through the operator command, with an unchanged restart receipt", async () => {
    const { id, state } = await createWorkspace("8");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = {
      stdout: {
        write: (value: string | Uint8Array) => {
          stdout.push(String(value));
          return true;
        },
      },
      stderr: {
        write: (value: string | Uint8Array) => {
          stderr.push(String(value));
          return true;
        },
      },
    };
    const env = { HYPE_COMMS_DATABASE_URL: database.url };
    expect(await runProtocolEpochCli(["inspect", "--workspace-id", id], env, output)).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({ workspaceId: id, ...state });
    const epoch = randomUUID();
    const args = [
      "activate",
      "--workspace-id",
      id,
      "--expected-epoch",
      state.epoch,
      "--expected-sequence",
      "8",
      "--epoch",
      epoch,
      "--writers-stopped",
    ];
    stdout.length = 0;
    expect(await runProtocolEpochCli(args, env, output)).toBe(0);
    const receipt = stdout.join("");
    expect(JSON.parse(receipt)).toEqual({
      workspaceId: id,
      epoch,
      sequence: "8",
      replayFloor: "8",
    });
    stdout.length = 0;
    expect(await runProtocolEpochCli(args, env, output)).toBe(0);
    expect(stdout.join("")).toBe(receipt);
    expect(stderr).toEqual([]);
    expect(await runProtocolEpochCli([...args.slice(0, -1)], {}, output)).toBe(1);
    expect(stderr.join("")).toContain("--writers-stopped");
    expect(await read(id)).toEqual({ epoch, sequence: "8", replayFloor: "8" });
  });

  it("does not update feature flags when bootstrap rejects an inactive workspace", async () => {
    const { id } = await createWorkspace();
    await database.pool.query("UPDATE workspaces SET protocol_epoch = NULL WHERE id = $1", [id]);
    const sync = new WorkspaceSyncOperations(database.pool, {
      announcementChannelsEnabled: true,
      humansOnlyChannelsEnabled: true,
    });
    const now = "2026-09-12T00:00:00.000Z";
    await expect(
      sync.bootstrap({
        principalKind: "human",
        sessionId: randomUUID(),
        currentUser: {
          user: {
            id: ownerId,
            kind: "human",
            username: "epoch-owner",
            displayName: "Epoch owner",
            avatarUrl: null,
            createdAt: now,
            updatedAt: now,
          },
          email: "epoch@example.test",
          workspaceId: id,
          role: "owner",
        },
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    const result = await database.pool.query(
      "SELECT announcement_channels_available, humans_only_channels_available FROM workspaces WHERE id = $1",
      [id],
    );
    expect(result.rows).toEqual([
      { announcement_channels_available: false, humans_only_channels_available: false },
    ]);
  });
  it("excludes unparseable historical events at the replay floor and rejects the old epoch", async () => {
    const { id, state } = await createWorkspace("7");
    await database.pool.query(
      `INSERT INTO sync_events (id, workspace_id, workspace_sequence, event_type, payload)
       VALUES ($1, $2, 7, 'channel.created', '{"legacy":true}'::jsonb)`,
      [randomUUID(), id],
    );
    const epoch = randomUUID();
    await establishWorkspaceProtocolEpoch(database.pool, {
      workspaceId: id,
      expectedEpoch: state.epoch,
      expectedSequence: "7",
      epoch,
    });
    const sync = new WorkspaceSyncOperations(database.pool);
    const principal = { workspaceId: id, userId: ownerId };
    await expect(
      sync.syncPrincipal(principal, { epoch: state.epoch, sequence: "7" }, 100),
    ).rejects.toMatchObject({ kind: "sync_epoch_mismatch" });
    await expect(
      sync.syncPrincipal(principal, { epoch, sequence: "6" }, 100),
    ).rejects.toMatchObject({ kind: "sync_position_expired" });
    expect(await sync.syncPrincipal(principal, { epoch, sequence: "7" }, 100)).toEqual({
      events: [],
      nextCursor: { epoch, sequence: "7" },
      highWaterCursor: { epoch, sequence: "7" },
      hasMore: false,
    });
    expect(
      (await database.pool.query("SELECT payload FROM sync_events WHERE workspace_id = $1", [id]))
        .rows,
    ).toEqual([{ payload: { legacy: true } }]);
  });

  it("rejects unconsumed tickets from an old or missing epoch and accepts a fresh ticket once", async () => {
    const { id, state } = await createWorkspace();
    const sessionId = randomUUID();
    await database.pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [id, ownerId],
    );
    await database.pool.query(
      `INSERT INTO device_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, now(), now(), now() + interval '1 day')`,
      [sessionId, ownerId, Buffer.from(randomUUID().replaceAll("-", ""))],
    );
    const now = "2026-09-12T00:00:00.000Z";
    const identity = {
      principalKind: "human" as const,
      sessionId,
      currentUser: {
        user: {
          id: ownerId,
          kind: "human" as const,
          username: "epoch-owner",
          displayName: "Epoch owner",
          avatarUrl: null,
          createdAt: now,
          updatedAt: now,
        },
        email: "epoch@example.test",
        workspaceId: id,
        role: "owner" as const,
      },
    };
    const sync = new WorkspaceSyncOperations(database.pool);
    const missing = await sync.issueRealtimeTicket(identity);
    await database.pool.query(
      "UPDATE realtime_tickets SET protocol_epoch = NULL WHERE workspace_id = $1",
      [id],
    );
    const old = await sync.issueRealtimeTicket(identity);
    const epoch = randomUUID();
    await establishWorkspaceProtocolEpoch(database.pool, {
      workspaceId: id,
      expectedEpoch: state.epoch,
      expectedSequence: "0",
      epoch,
    });
    expect(await sync.consumeRealtimeTicket(missing.ticket)).toBeNull();
    expect(await sync.consumeRealtimeTicket(old.ticket)).toBeNull();
    const fresh = await sync.issueRealtimeTicket(identity);
    expect(fresh.position).toEqual({ epoch, sequence: "0" });
    expect(await sync.consumeRealtimeTicket(fresh.ticket)).toEqual({
      workspaceId: id,
      userId: ownerId,
      deviceSessionId: sessionId,
      agentTokenId: null,
    });
    expect(await sync.consumeRealtimeTicket(fresh.ticket)).toBeNull();
  });

  it("normalizes an accepted scalar mutation receipt without executing its mutation again", async () => {
    const { id, state } = await createWorkspace("9");
    const epoch = randomUUID();
    await establishWorkspaceProtocolEpoch(database.pool, {
      workspaceId: id,
      expectedEpoch: state.epoch,
      expectedSequence: "9",
      epoch,
    });
    const key = randomUUID();
    const fingerprint = Buffer.alloc(32, 9);
    await database.pool.query(
      `INSERT INTO api_idempotency_records
       (actor_user_id, route, idempotency_key, request_fingerprint, response_status, response_body)
       VALUES ($1, '/v1/epoch-fixture', $2, $3, 201, '{"syncCursor":"7","result":"accepted"}')`,
      [ownerId, key, fingerprint],
    );
    const response = await runWorkspaceTransaction(database.pool, (client) =>
      runIdempotentMutation(
        client,
        {
          workspaceId: id,
          actorUserId: ownerId,
          route: "/v1/epoch-fixture",
          idempotencyKey: key,
          requestFingerprint: fingerprint,
          responseStatus: 201,
          responseSchema: z
            .object({ syncCursor: syncPositionSchema, result: z.literal("accepted") })
            .strict(),
        },
        async () => {
          throw new Error("A previously accepted mutation must never run again");
        },
      ),
    );
    expect(response).toEqual({ syncCursor: { epoch, sequence: "9" }, result: "accepted" });
    const stored = await database.pool.query(
      "SELECT response_body, request_fingerprint FROM api_idempotency_records WHERE idempotency_key = $1",
      [key],
    );
    expect(stored.rows).toEqual([{ response_body: response, request_fingerprint: fingerprint }]);
  });

  it("retains historical records and waits for an explicit cutover of an existing workspace", async () => {
    expect(await retainedRecords()).toEqual(beforeMigration);
    await expect(read(oldWorkspaceId)).rejects.toMatchObject({ kind: "unavailable" });
    const epoch = randomUUID();
    const input = {
      workspaceId: oldWorkspaceId,
      expectedEpoch: null,
      expectedSequence: "7",
      epoch,
    };
    expect(await establishWorkspaceProtocolEpoch(database.pool, input)).toEqual({
      epoch,
      sequence: "7",
      replayFloor: "7",
    });
    expect(await retainedRecords()).toEqual(beforeMigration);
    expect((await runMigrations(database.pool)).applied).toEqual([]);
    const identity: AuthenticatedIdentity = {
      principalKind: "human",
      sessionId: oldSessionId,
      currentUser: {
        user: {
          id: ownerId,
          kind: "human",
          username: "epoch-owner",
          displayName: "Epoch owner",
          avatarUrl: null,
          createdAt: "2026-09-12T00:00:00.000Z",
          updatedAt: "2026-09-12T00:00:00.000Z",
        },
        email: "epoch@example.test",
        workspaceId: oldWorkspaceId,
        role: "owner",
      },
    };
    const repository = new WorkspaceRepository(database.pool);
    const results = await Promise.all(
      [1, 2].map(() => repository.sendMessage(identity, oldConversationId, oldAcceptedInput)),
    );
    for (const response of results) {
      expect(response.message.id).toBe(oldMessageId);
      expect(response.syncCursor).toEqual({ epoch, sequence: "7" });
    }
    expect(await retainedRecords()).toEqual(beforeMigration);
    expect(await read(oldWorkspaceId)).toEqual({ epoch, sequence: "7", replayFloor: "7" });
  });

  it("starts a newly created workspace in its own epoch with floor zero", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    expect(a.state).toMatchObject({ sequence: "0", replayFloor: "0" });
    expect(a.state.epoch).not.toBe(b.state.epoch);
  });

  it("refuses a stale cutover position without changing the current epoch", async () => {
    const { id, state } = await createWorkspace("9");
    await expect(
      establishWorkspaceProtocolEpoch(database.pool, {
        workspaceId: id,
        expectedEpoch: state.epoch,
        expectedSequence: "8",
        epoch: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(await read(id)).toEqual(state);
  });

  it("retries an established cutover without moving its floor over newly accepted writes", async () => {
    const { id, state } = await createWorkspace("9");
    const input = {
      workspaceId: id,
      expectedEpoch: state.epoch,
      expectedSequence: "9",
      epoch: randomUUID(),
    };
    await establishWorkspaceProtocolEpoch(database.pool, input);
    await database.pool.query("UPDATE workspaces SET last_event_sequence = 10 WHERE id = $1", [id]);
    expect(await establishWorkspaceProtocolEpoch(database.pool, input)).toEqual({
      epoch: input.epoch,
      sequence: "10",
      replayFloor: "9",
    });
  });

  it("allows only one of two competing epoch changes to commit", async () => {
    const { id, state } = await createWorkspace("9");
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((epoch) =>
        establishWorkspaceProtocolEpoch(database.pool, {
          workspaceId: id,
          expectedEpoch: state.epoch,
          expectedSequence: "9",
          epoch,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ kind: "conflict" }) },
    ]);
  });
});
