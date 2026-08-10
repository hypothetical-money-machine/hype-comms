import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { escapeIdentifier, type Pool } from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

async function withFreshSchema(fn: (pool: Pool) => Promise<void>): Promise<void> {
  if (testDatabaseUrl === undefined) return;

  const schemaName = `migrate_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const adminPool = createPool({ url: testDatabaseUrl, poolSize: 1 });
  await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
  const pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 2 });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  }
}

async function withoutAgentMigration(fn: (migrationsDirectory: URL) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-pre-agent-migrations-"));
  const source = new URL("../src/db/migrations/", import.meta.url);
  try {
    const filenames = await readdir(source);
    await Promise.all(
      filenames
        .filter((filename) => filename.endsWith(".sql") && filename !== "0013_agents.sql")
        .map(async (filename) => {
          await writeFile(
            path.join(directory, filename),
            await readFile(new URL(filename, source)),
          );
        }),
    );
    await fn(pathToFileURL(`${directory}${path.sep}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withoutTokenLineageMigration(fn: (migrationsDirectory: URL) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-pre-token-lineage-migrations-"));
  const source = new URL("../src/db/migrations/", import.meta.url);
  try {
    const filenames = await readdir(source);
    await Promise.all(
      filenames
        .filter(
          (filename) =>
            filename.endsWith(".sql") && filename !== "0015_device_session_token_history.sql",
        )
        .map(async (filename) => {
          await writeFile(
            path.join(directory, filename),
            await readFile(new URL(filename, source)),
          );
        }),
    );
    await fn(pathToFileURL(`${directory}${path.sep}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describeWithPostgres("runMigrations", () => {
  it("applies migrations cleanly and is idempotent", async () => {
    await withFreshSchema(async (pool) => {
      await expect(runMigrations(pool)).resolves.toEqual({
        applied: [
          "0001_identity.sql",
          "0002_conversation_core.sql",
          "0003_unicode_channel_slugs.sql",
          "0004_channel_memberships.sql",
          "0005_message_search.sql",
          "0006_message_reactions.sql",
          "0007_read_state_event_capability.sql",
          "0008_hype_comms_rebrand.sql",
          "0009_message_threads.sql",
          "0009_self_direct_messages.sql",
          "0010_conversation_tasks.sql",
          "0011_bot_task_principals.sql",
          "0012_task_actor_attribution.sql",
          "0013_agents.sql",
          "0015_device_session_token_history.sql",
          "0016_announcement_channels.sql",
        ],
      });
      await expect(runMigrations(pool)).resolves.toEqual({ applied: [] });

      const result = await pool.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      expect(result.rows).toEqual([
        { filename: "0001_identity.sql" },
        { filename: "0002_conversation_core.sql" },
        { filename: "0003_unicode_channel_slugs.sql" },
        { filename: "0004_channel_memberships.sql" },
        { filename: "0005_message_search.sql" },
        { filename: "0006_message_reactions.sql" },
        { filename: "0007_read_state_event_capability.sql" },
        { filename: "0008_hype_comms_rebrand.sql" },
        { filename: "0009_message_threads.sql" },
        { filename: "0009_self_direct_messages.sql" },
        { filename: "0010_conversation_tasks.sql" },
        { filename: "0011_bot_task_principals.sql" },
        { filename: "0012_task_actor_attribution.sql" },
        { filename: "0013_agents.sql" },
        { filename: "0015_device_session_token_history.sql" },
        { filename: "0016_announcement_channels.sql" },
      ]);

      const userId = randomUUID();
      const workspaceId = randomUUID();
      const conversationId = randomUUID();
      const otherConversationId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'migration@example.test', 'migration', 'Migration')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ($1, 'Migration', 'migration', $2)`,
        [workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES
           ($1, $2, 'channel', 'Existing ASCII', 'existing-ascii', 'workspace', $3),
           ($4, $2, 'channel', 'Équipe Produit', 'équipe-produit', 'workspace', $3)`,
        [conversationId, workspaceId, userId, otherConversationId],
      );
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, channel_access, created_by)
           VALUES ($1, $2, 'channel', 'Duplicate', 'équipe-produit', 'workspace', $3)`,
          [randomUUID(), workspaceId, userId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, channel_access, created_by)
           VALUES ($1, $2, 'channel', 'Not normalized', $3, 'workspace', $4)`,
          [randomUUID(), workspaceId, "e\u0301quipe", userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, created_by)
           VALUES ($1, $2, 'channel', 'Missing access', 'missing-access', $3)`,
          [randomUUID(), workspaceId, userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
           VALUES ($1, $2, 'direct_message', $3, $3, $3)`,
          [randomUUID(), workspaceId, userId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const threadRootId = randomUUID();
      await pool.query(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, conversation_sequence,
           committed_workspace_sequence, client_message_id, request_fingerprint,
           author_id, thread_root_id, body, body_format
         ) VALUES ($1, $2, $3, 1, 1, $4, $5, $6, NULL, 'Root', 'hmm_markdown_v1')`,
        [threadRootId, workspaceId, conversationId, randomUUID(), Buffer.alloc(32), userId],
      );
      const replyId = randomUUID();
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 2, 2, $4, $5, $6, $7, 'Reply', 'hmm_markdown_v1')`,
          [
            replyId,
            workspaceId,
            conversationId,
            randomUUID(),
            Buffer.alloc(32),
            userId,
            threadRootId,
          ],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      const alternateRootId = randomUUID();
      await pool.query(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, conversation_sequence,
           committed_workspace_sequence, client_message_id, request_fingerprint,
           author_id, thread_root_id, body, body_format
         ) VALUES ($1, $2, $3, 10, 3, $4, $5, $6, NULL, 'Other root', 'hmm_markdown_v1')`,
        [alternateRootId, workspaceId, conversationId, randomUUID(), Buffer.alloc(32), userId],
      );
      await expect(
        pool.query(`UPDATE messages SET thread_root_id = $1 WHERE id = $2`, [
          alternateRootId,
          threadRootId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 1, 3, $4, $5, $6, $7, 'Cross thread', 'hmm_markdown_v1')`,
          [
            randomUUID(),
            workspaceId,
            otherConversationId,
            randomUUID(),
            Buffer.alloc(32),
            userId,
            threadRootId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 3, 4, $4, $5, $6, $7, 'Nested reply', 'hmm_markdown_v1')`,
          [
            randomUUID(),
            workspaceId,
            conversationId,
            randomUUID(),
            Buffer.alloc(32),
            userId,
            replyId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const selfReplyId = randomUUID();
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 3, 5, $4, $5, $6, $1, 'Self thread', 'hmm_markdown_v1')`,
          [selfReplyId, workspaceId, conversationId, randomUUID(), Buffer.alloc(32), userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("renames only the legacy default workspace", async () => {
    await withFreshSchema(async (pool) => {
      await runMigrations(pool);

      const userId = randomUUID();
      const defaultWorkspaceId = randomUUID();
      const legacyNamedCustomWorkspaceId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'rebrand@example.test', 'rebrand', 'Rebrand')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ($1, 'HMM Chat', 'hmm-chat', $3),
           ($2, 'HMM Chat', 'custom-workspace', $3)`,
        [defaultWorkspaceId, legacyNamedCustomWorkspaceId, userId],
      );

      const migration = await readFile(
        new URL("../src/db/migrations/0008_hype_comms_rebrand.sql", import.meta.url),
        "utf8",
      );
      await pool.query(migration);

      const renamed = await pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM workspaces ORDER BY id",
      );
      expect(new Map(renamed.rows.map((row) => [row.id, row.name]))).toEqual(
        new Map([
          [defaultWorkspaceId, "Hype Comms"],
          [legacyNamedCustomWorkspaceId, "HMM Chat"],
        ]),
      );

      await pool.query("UPDATE workspaces SET name = 'Morgan and Dan' WHERE id = $1", [
        defaultWorkspaceId,
      ]);
      await pool.query(migration);
      await expect(
        pool.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [
          defaultWorkspaceId,
        ]),
      ).resolves.toMatchObject({ rows: [{ name: "Morgan and Dan" }] });
    });
  });

  it("keeps previous-server task creates compatible while seeding their actor", async () => {
    await withFreshSchema(async (pool) => {
      await runMigrations(pool);
      const userId = randomUUID();
      const workspaceId = randomUUID();
      const conversationId = randomUUID();
      const taskId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'compatibility@example.test', 'compatibility', 'Compatibility')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ($1, 'Compatibility', 'compatibility', $2)`,
        [workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES ($1, $2, 'channel', 'Compatibility', 'compatibility', 'workspace', $3)`,
        [conversationId, workspaceId, userId],
      );

      await pool.query(
        `INSERT INTO tasks
           (id, workspace_id, conversation_id, number, title, status, priority, rank, created_by)
         VALUES ($1, $2, $3, 1, 'Old server create', 'todo', 'none', 1024, $4)`,
        [taskId, workspaceId, conversationId, userId],
      );
      const actor = await pool.query<{ updated_by: string }>(
        "SELECT updated_by FROM tasks WHERE id = $1",
        [taskId],
      );
      expect(actor.rows).toEqual([{ updated_by: userId }]);
    });
  });

  it("enforces announcement channel modes and tasklessness for old and new writers", async () => {
    await withFreshSchema(async (pool) => {
      await runMigrations(pool);
      const ownerId = randomUUID();
      const memberId = randomUUID();
      const [directUserLowId, directUserHighId] = [ownerId, memberId].sort();
      const workspaceId = randomUUID();
      const chatId = randomUUID();
      const announcementId = randomUUID();
      const directId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'mode-owner@example.test', 'mode-owner', 'Mode Owner'),
                ($2, 'mode-member@example.test', 'mode-member', 'Mode Member')`,
        [ownerId, memberId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ($1, 'Channel modes', 'channel-modes', $2)`,
        [workspaceId, ownerId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
        [workspaceId, ownerId, memberId],
      );

      // These two inserts intentionally use the old-server column list.
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES ($1, $2, 'channel', 'Chat', 'chat', 'workspace', $3)`,
        [chatId, workspaceId, ownerId],
      );
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
         VALUES ($1, $2, 'direct_message', $3, $4, $5)`,
        [directId, workspaceId, directUserLowId, directUserHighId, ownerId],
      );
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, channel_mode, created_by)
         VALUES ($1, $2, 'channel', 'Announcements', 'announcements', 'workspace',
                 'announcement', $3)`,
        [announcementId, workspaceId, ownerId],
      );

      await expect(
        pool.query<{ id: string; channel_mode: string | null }>(
          `SELECT id, channel_mode
             FROM conversations
            WHERE id = ANY($1::uuid[])
            ORDER BY id`,
          [[chatId, announcementId, directId]],
        ),
      ).resolves.toMatchObject({
        rows: expect.arrayContaining([
          { id: chatId, channel_mode: "chat" },
          { id: announcementId, channel_mode: "announcement" },
          { id: directId, channel_mode: null },
        ]),
      });
      await expect(
        pool.query(`UPDATE conversations SET channel_mode = 'chat' WHERE id = $1`, [
          announcementId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO tasks
             (id, workspace_id, conversation_id, number, title, status, priority, rank, created_by)
           VALUES ($1, $2, $3, 1, 'Forbidden task', 'todo', 'none', 1024, $4)`,
          [randomUUID(), workspaceId, announcementId, ownerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const taskId = randomUUID();
      await pool.query(
        `INSERT INTO tasks
           (id, workspace_id, conversation_id, number, title, status, priority, rank, created_by)
         VALUES ($1, $2, $3, 1, 'Chat task', 'todo', 'none', 1024, $4)`,
        [taskId, workspaceId, chatId, ownerId],
      );
      await expect(
        pool.query(`UPDATE tasks SET conversation_id = $1 WHERE id = $2`, [announcementId, taskId]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("upgrades active sessions and records subsequent token rotations", async () => {
    await withFreshSchema(async (pool) => {
      await withoutTokenLineageMigration(async (migrationsDirectory) => {
        await runMigrations(pool, migrationsDirectory);

        const userId = randomUUID();
        const sessionId = randomUUID();
        const previousHash = Buffer.alloc(32, 41);
        const nextHash = Buffer.alloc(32, 42);
        const originalExpiry = "2026-07-25T12:00:00.000Z";
        await pool.query(
          `INSERT INTO users (id, email, username, display_name)
           VALUES ($1, 'upgrade@example.test', 'upgrade', 'Upgrade')`,
          [userId],
        );
        await pool.query(
          `INSERT INTO device_sessions
             (id, user_id, token_hash, label, created_at, last_seen_at, expires_at)
           VALUES ($1, $2, $3, 'Previous server', $4, $4, $5)`,
          [sessionId, userId, previousHash, "2026-07-24T12:00:00.000Z", originalExpiry],
        );

        await expect(runMigrations(pool)).resolves.toEqual({
          applied: ["0015_device_session_token_history.sql"],
        });
        await pool.query(
          `UPDATE device_sessions
              SET token_hash = $2, last_seen_at = $3, expires_at = $4
            WHERE id = $1`,
          [sessionId, nextHash, "2026-07-24T13:00:00.000Z", "2026-08-23T13:00:00.000Z"],
        );
        const history = await pool.query<{
          token_hash: Buffer;
          expires_at: Date;
          rotation_xid: string;
        }>(
          `SELECT token_hash, expires_at, rotation_xid::text
             FROM device_session_token_history
            WHERE device_session_id = $1`,
          [sessionId],
        );

        expect(history.rows).toEqual([
          {
            token_hash: previousHash,
            expires_at: new Date(originalExpiry),
            rotation_xid: expect.stringMatching(/^\d+$/),
          },
        ]);
      });
    });
  });

  it("upgrades existing human, bot, and device-ticket rows for agent identities", async () => {
    await withFreshSchema(async (pool) => {
      await withoutAgentMigration(async (migrationsDirectory) => {
        await runMigrations(pool, migrationsDirectory);

        const ownerId = randomUUID();
        const botId = randomUUID();
        const workspaceId = randomUUID();
        const sessionId = randomUUID();
        const existingTicketId = randomUUID();
        await pool.query(
          `INSERT INTO users (id, email, username, display_name)
           VALUES ($1, 'owner@example.test', 'owner', 'Owner')`,
          [ownerId],
        );
        await pool.query(
          `INSERT INTO workspaces (id, name, slug, created_by)
           VALUES ($1, 'Agent upgrade', 'agent-upgrade', $2)`,
          [workspaceId, ownerId],
        );
        await pool.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
           VALUES ($1, $2, 'owner', 'active')`,
          [workspaceId, ownerId],
        );
        await pool.query(
          `INSERT INTO users (id, email, kind, username, display_name)
           VALUES ($1, NULL, 'bot', 'task-bot', 'Task bot')`,
          [botId],
        );
        await pool.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
           VALUES ($1, $2, 'member', 'active')`,
          [workspaceId, botId],
        );
        await pool.query(
          `INSERT INTO device_sessions
             (id, user_id, token_hash, created_at, last_seen_at, expires_at)
           VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp(),
                   clock_timestamp() + interval '1 day')`,
          [sessionId, ownerId, Buffer.alloc(32, 1)],
        );
        await pool.query(
          `INSERT INTO realtime_tickets
             (id, workspace_id, user_id, device_session_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '1 minute')`,
          [existingTicketId, workspaceId, ownerId, sessionId, Buffer.alloc(32, 2)],
        );

        await pool.query(
          await readFile(new URL("../src/db/migrations/0013_agents.sql", import.meta.url), "utf8"),
        );

        const oldServerUserId = randomUUID();
        await expect(
          pool.query(
            `INSERT INTO users (id, email, username, display_name)
             VALUES ($1, 'old-server@example.test', 'old-server', 'Old server')`,
            [oldServerUserId],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });

        const agentId = randomUUID();
        await pool.query(
          `INSERT INTO users (id, email, kind, username, display_name)
           VALUES ($1, NULL, 'agent', 'hermes_agent', 'Hermes')`,
          [agentId],
        );
        await pool.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
           VALUES ($1, $2, 'member', 'active')`,
          [workspaceId, agentId],
        );
        await expect(
          pool.query(
            `INSERT INTO agents (user_id, workspace_id, created_by)
             VALUES ($1, $2, $3)`,
            [agentId, workspaceId, ownerId],
          ),
        ).resolves.toMatchObject({ rowCount: 1 });

        await expect(
          pool.query<{ id: string; kind: string; email: string | null }>(
            `SELECT id, kind, email::text
               FROM users
              WHERE id = ANY($1::uuid[])
              ORDER BY id`,
            [[ownerId, botId, oldServerUserId, agentId]],
          ),
        ).resolves.toMatchObject({
          rows: expect.arrayContaining([
            { id: ownerId, kind: "human", email: "owner@example.test" },
            { id: botId, kind: "bot", email: null },
            { id: oldServerUserId, kind: "human", email: "old-server@example.test" },
            { id: agentId, kind: "agent", email: null },
          ]),
        });
        await expect(
          pool.query<{ agent_token_id: string | null }>(
            "SELECT agent_token_id FROM realtime_tickets WHERE id = $1",
            [existingTicketId],
          ),
        ).resolves.toMatchObject({ rows: [{ agent_token_id: null }] });
      });
    });
  });

  it("fails loudly when an applied migration file changes", async () => {
    await withFreshSchema(async (pool) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "hmm-migrations-"));
      const migrationUrl = new URL("../src/db/migrations/0001_identity.sql", import.meta.url);
      const copiedMigration = path.join(directory, "0001_identity.sql");
      try {
        await writeFile(copiedMigration, await readFile(migrationUrl, "utf8"));
        const directoryUrl = pathToFileURL(`${directory}${path.sep}`);
        await runMigrations(pool, directoryUrl);

        await writeFile(copiedMigration, `${await readFile(copiedMigration, "utf8")}\n-- edited\n`);

        await expect(runMigrations(pool, directoryUrl)).rejects.toThrow(
          /Migration checksum mismatch for 0001_identity\.sql/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
