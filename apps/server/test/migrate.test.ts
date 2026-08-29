import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  agentCurrentPrincipalSchema,
  agentTokenSchema,
  listAgentTokensResponseSchema,
  workspaceEventSchema,
} from "@hype-comms/contracts";
import { escapeIdentifier, type Pool, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
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

/** Materializes the migration directory minus one file, so its own effect can be observed. */
async function withoutMigrations(
  excludedFilenames: readonly string[],
  fn: (migrationsDirectory: URL) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-partial-migrations-"));
  const source = new URL("../src/db/migrations/", import.meta.url);
  try {
    const filenames = await readdir(source);
    await Promise.all(
      filenames
        .filter((filename) => filename.endsWith(".sql") && !excludedFilenames.includes(filename))
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

async function withoutMigration(
  excludedFilename: string,
  fn: (migrationsDirectory: URL) => Promise<void>,
): Promise<void> {
  await withoutMigrations([excludedFilename], fn);
}

async function withoutAgentMigration(fn: (migrationsDirectory: URL) => Promise<void>) {
  await withoutMigrations(
    [
      "0013_agents.sql",
      "0023_default_agent_agency.sql",
      "0025_public_channel_membership.sql",
      "0027_read_only_agent_attachments.sql",
      "0028_channel_webhooks.sql",
    ],
    fn,
  );
}

async function withoutTokenLineageMigration(fn: (migrationsDirectory: URL) => Promise<void>) {
  await withoutMigration("0015_device_session_token_history.sql", fn);
}

async function withoutTechnicalRebrandMigration(fn: (migrationsDirectory: URL) => Promise<void>) {
  await withoutMigration("0018_hype_comms_technical_rebrand.sql", fn);
}

async function withoutDesktopAuthVariantMigration(fn: (migrationsDirectory: URL) => Promise<void>) {
  await withoutMigration("0019_desktop_auth_variants.sql", fn);
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
          "0014_participated_thread_notifications.sql",
          "0015_device_session_token_history.sql",
          "0016_announcement_channels.sql",
          "0017_workos_authkit.sql",
          "0018_hype_comms_technical_rebrand.sql",
          "0019_desktop_auth_variants.sql",
          "0020_message_attachments.sql",
          "0021_message_retract.sql",
          "0022_member_title.sql",
          "0023_default_agent_agency.sql",
          "0024_ephemeral_activity_capability.sql",
          "0025_public_channel_membership.sql",
          "0026_group_direct_messages.sql",
          "0027_read_only_agent_attachments.sql",
          "0028_channel_webhooks.sql",
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
        { filename: "0014_participated_thread_notifications.sql" },
        { filename: "0015_device_session_token_history.sql" },
        { filename: "0016_announcement_channels.sql" },
        { filename: "0017_workos_authkit.sql" },
        { filename: "0018_hype_comms_technical_rebrand.sql" },
        { filename: "0019_desktop_auth_variants.sql" },
        { filename: "0020_message_attachments.sql" },
        { filename: "0021_message_retract.sql" },
        { filename: "0022_member_title.sql" },
        { filename: "0023_default_agent_agency.sql" },
        { filename: "0024_ephemeral_activity_capability.sql" },
        { filename: "0025_public_channel_membership.sql" },
        { filename: "0026_group_direct_messages.sql" },
        { filename: "0027_read_only_agent_attachments.sql" },
        { filename: "0028_channel_webhooks.sql" },
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
         ) VALUES ($1, $2, $3, 1, 1, $4, $5, $6, NULL, 'Root', 'hype_comms_markdown_v1')`,
        [threadRootId, workspaceId, conversationId, randomUUID(), Buffer.alloc(32), userId],
      );
      const replyId = randomUUID();
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 2, 2, $4, $5, $6, $7, 'Reply', 'hype_comms_markdown_v1')`,
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
         ) VALUES ($1, $2, $3, 10, 3, $4, $5, $6, NULL, 'Other root', 'hype_comms_markdown_v1')`,
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
           ) VALUES ($1, $2, $3, 1, 3, $4, $5, $6, $7, 'Cross thread', 'hype_comms_markdown_v1')`,
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
           ) VALUES ($1, $2, $3, 3, 4, $4, $5, $6, $7, 'Nested reply', 'hype_comms_markdown_v1')`,
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
           ) VALUES ($1, $2, $3, 3, 5, $4, $5, $6, $1, 'Self thread', 'hype_comms_markdown_v1')`,
          [selfReplyId, workspaceId, conversationId, randomUUID(), Buffer.alloc(32), userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        pool.query(`UPDATE messages SET deleted_at = clock_timestamp() WHERE id = $1`, [
          threadRootId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query<{ body: string }>("SELECT body FROM messages WHERE id = $1", [threadRootId]),
      ).resolves.toMatchObject({ rows: [{ body: "Root" }] });
      await expect(
        pool.query(`UPDATE messages SET edited_at = clock_timestamp() WHERE id = $1`, [
          threadRootId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(`UPDATE messages SET body = '' WHERE id = $1`, [threadRootId]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO sync_events (
             id, workspace_id, workspace_sequence, conversation_id, conversation_sequence,
             event_type, actor_user_id, entity_version, payload
           ) VALUES ($1, $2, 1, $3, 1, 'message.retracted', $4, 1, $5::jsonb)`,
          [
            randomUUID(),
            workspaceId,
            conversationId,
            userId,
            JSON.stringify({
              messageId: threadRootId,
              deletedAt: "2026-08-20T17:00:00.000Z",
            }),
          ],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `INSERT INTO sync_events (
             id, workspace_id, workspace_sequence, conversation_id, conversation_sequence,
             event_type, actor_user_id, entity_version, payload
           ) VALUES ($1, $2, 2, $3, 1, 'message.edited', $4, 1, '{}'::jsonb)`,
          [randomUUID(), workspaceId, conversationId, userId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'realtime_tickets'
              AND column_name = 'message_retract_events'`,
        ),
      ).resolves.toMatchObject({ rows: [{ column_name: "message_retract_events" }] });
      await expect(
        pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'users'
              AND column_name = 'title'`,
        ),
      ).resolves.toMatchObject({ rows: [{ column_name: "title" }] });
      await expect(
        pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'realtime_tickets'
              AND column_name = 'member_profiles'`,
        ),
      ).resolves.toMatchObject({ rows: [{ column_name: "member_profiles" }] });
      await expect(
        pool.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'realtime_tickets'
              AND column_name = 'group_direct_messages'`,
        ),
      ).resolves.toMatchObject({ rows: [{ column_name: "group_direct_messages" }] });
    });
  });

  it("defaults existing and previous-server AuthKit transactions to production", async () => {
    await withFreshSchema(async (pool) => {
      await withoutDesktopAuthVariantMigration(async (migrationsDirectory) => {
        await runMigrations(pool, migrationsDirectory);
      });
      const existingId = randomUUID();
      const createdAt = new Date("2026-08-15T12:00:00.000Z");
      const expiresAt = new Date(createdAt.getTime() + 10 * 60_000);
      await pool.query(
        `INSERT INTO authkit_transactions (
           id, provider_state_hash, verifier_nonce, verifier_ciphertext,
           verifier_authentication_tag, desktop_code_challenge, desktop_state,
           expires_at, consumed_at, created_at
         ) VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5, $6, $6)`,
        [existingId, Buffer.alloc(32, 1), "c".repeat(43), "s".repeat(43), expiresAt, createdAt],
      );

      await expect(runMigrations(pool)).resolves.toEqual({
        applied: ["0019_desktop_auth_variants.sql"],
      });

      const previousServerId = randomUUID();
      await pool.query(
        `INSERT INTO authkit_transactions (
           id, provider_state_hash, verifier_nonce, verifier_ciphertext,
           verifier_authentication_tag, desktop_code_challenge, desktop_state,
           expires_at, consumed_at, created_at
         ) VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5, $6, $6)`,
        [
          previousServerId,
          Buffer.alloc(32, 2),
          "d".repeat(43),
          "t".repeat(43),
          expiresAt,
          createdAt,
        ],
      );
      const variants = await pool.query<{ id: string; desktop_auth_variant: string }>(
        `SELECT id, desktop_auth_variant
           FROM authkit_transactions
          ORDER BY id`,
      );
      expect(new Map(variants.rows.map((row) => [row.id, row.desktop_auth_variant]))).toEqual(
        new Map([
          [existingId, "production"],
          [previousServerId, "production"],
        ]),
      );
      await expect(
        pool.query(
          `UPDATE authkit_transactions SET desktop_auth_variant = 'preview' WHERE id = $1`,
          [existingId],
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

  it("rewrites legacy body formats, the default slug, and the body-format constraint", async () => {
    await withFreshSchema(async (pool) => {
      const userId = randomUUID();
      const defaultWorkspaceId = randomUUID();
      const customWorkspaceId = randomUUID();
      const conversationId = randomUUID();
      const legacyMessageId = randomUUID();
      const legacyClientMessageId = randomUUID();
      const legacyEventId = randomUUID();
      const legacyEventOccurredAt = "2026-01-01T00:00:00.000Z";
      const legacyEventEnvelope = {
        version: 1,
        id: legacyEventId,
        type: "message.created",
        occurredAt: legacyEventOccurredAt,
        workspaceId: defaultWorkspaceId,
        conversationId,
        workspaceSequence: "1",
        conversationSequence: "1",
        entityVersion: 1,
        delivery: "at_least_once",
      };

      await withoutTechnicalRebrandMigration(async (migrationsDirectory) => {
        await runMigrations(pool, migrationsDirectory);
      });

      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'technical-rebrand@example.test', 'technical', 'Technical')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ($1, 'Hype Comms', 'hmm-chat', $3),
           ($2, 'Custom', 'custom-workspace', $3)`,
        [defaultWorkspaceId, customWorkspaceId, userId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`,
        [defaultWorkspaceId, userId],
      );
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES ($1, $2, 'channel', 'General', 'general', 'workspace', $3)`,
        [conversationId, defaultWorkspaceId, userId],
      );
      await pool.query(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, conversation_sequence,
           committed_workspace_sequence, client_message_id, request_fingerprint,
           author_id, thread_root_id, body, body_format
         ) VALUES ($1, $2, $3, 1, 1, $4, $5, $6, NULL, 'Legacy', 'hmm_markdown_v1')`,
        [
          legacyMessageId,
          defaultWorkspaceId,
          conversationId,
          legacyClientMessageId,
          Buffer.alloc(32),
          userId,
        ],
      );
      // Retained events embed the message verbatim, so the literal also lives in JSONB.
      const legacyEventPayload = {
        message: {
          id: legacyMessageId,
          conversationId,
          conversationSequence: "1",
          version: 1,
          clientMessageId: legacyClientMessageId,
          authorId: userId,
          threadRootId: null,
          body: "Legacy",
          bodyFormat: "hmm_markdown_v1",
          editedAt: null,
          deletedAt: null,
          createdAt: legacyEventOccurredAt,
          updatedAt: legacyEventOccurredAt,
        },
        mentionedUserIds: [],
      };
      await pool.query(
        `INSERT INTO sync_events (
           id, workspace_id, workspace_sequence, conversation_id, conversation_sequence,
           event_type, actor_user_id, entity_version, payload, occurred_at
         ) VALUES ($1, $2, 1, $3, 1, 'message.created', $4, 1, $5::jsonb, $6)`,
        [
          legacyEventId,
          defaultWorkspaceId,
          conversationId,
          userId,
          JSON.stringify(legacyEventPayload),
          legacyEventOccurredAt,
        ],
      );
      // Non-vacuity: this is exactly what WorkspaceRepository.#mapEvent feeds the strict schema,
      // and it throws until 0018 rewrites the retained payload.
      expect(() =>
        workspaceEventSchema.parse({ ...legacyEventEnvelope, payload: legacyEventPayload }),
      ).toThrow();

      await expect(runMigrations(pool)).resolves.toEqual({
        applied: ["0018_hype_comms_technical_rebrand.sql"],
      });

      const retainedEvent = await pool.query<{ payload: unknown; body_format: string | null }>(
        `SELECT payload, payload #>> '{message,bodyFormat}' AS body_format
           FROM sync_events
          WHERE id = $1`,
        [legacyEventId],
      );
      const [retainedRow] = retainedEvent.rows;
      if (retainedRow === undefined) {
        throw new Error("The retained sync event disappeared during the migration.");
      }
      expect(retainedRow.body_format).toBe("hype_comms_markdown_v1");
      // Catch-up sync and realtime reconnection both go through this parse.
      expect(() =>
        workspaceEventSchema.parse({ ...legacyEventEnvelope, payload: retainedRow.payload }),
      ).not.toThrow();

      await expect(
        pool.query<{ body_format: string }>("SELECT body_format FROM messages WHERE id = $1", [
          legacyMessageId,
        ]),
      ).resolves.toMatchObject({ rows: [{ body_format: "hype_comms_markdown_v1" }] });
      const slugs = await pool.query<{ id: string; slug: string }>(
        "SELECT id, slug FROM workspaces",
      );
      expect(new Map(slugs.rows.map((row) => [row.id, row.slug]))).toEqual(
        new Map([
          [defaultWorkspaceId, "hype-comms"],
          [customWorkspaceId, "custom-workspace"],
        ]),
      );

      // The recreated CHECK has to accept the new literal and keep rejecting the old one.
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 2, 2, $4, $5, $6, NULL, 'Current', 'hype_comms_markdown_v1')`,
          [
            randomUUID(),
            defaultWorkspaceId,
            conversationId,
            randomUUID(),
            Buffer.alloc(32),
            userId,
          ],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `INSERT INTO messages (
             id, workspace_id, conversation_id, conversation_sequence,
             committed_workspace_sequence, client_message_id, request_fingerprint,
             author_id, thread_root_id, body, body_format
           ) VALUES ($1, $2, $3, 3, 3, $4, $5, $6, NULL, 'Legacy again', 'hmm_markdown_v1')`,
          [
            randomUUID(),
            defaultWorkspaceId,
            conversationId,
            randomUUID(),
            Buffer.alloc(32),
            userId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("revokes every pre-cutover device session so old tokens stop authenticating", async () => {
    await withFreshSchema(async (pool) => {
      const userId = randomUUID();
      const activeSessionId = randomUUID();
      const revokedSessionId = randomUUID();
      const alreadyRevokedAt = "2026-01-02T03:04:05.000Z";
      // The cookie rename does not change the token, so this is exactly what a pre-cutover client
      // replays as hype_comms_session=<old value>.
      const legacyToken = "legacy-pre-cutover-session-token";
      const legacyTokenHash = hashToken(legacyToken);

      await withoutTechnicalRebrandMigration(async (migrationsDirectory) => {
        await runMigrations(pool, migrationsDirectory);
      });

      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'session-cutover@example.test', 'cutover', 'Cutover')`,
        [userId],
      );
      await pool.query(
        `INSERT INTO device_sessions
           (id, user_id, token_hash, label, created_at, last_seen_at, expires_at,
            revoked_at, workos_session_id)
         VALUES
           ($1, $3, $4, 'Pre-cutover laptop', clock_timestamp(), clock_timestamp(),
            clock_timestamp() + interval '30 days', NULL, 'session_precutoveractive1'),
           ($2, $3, $5, 'Already signed out', clock_timestamp(), clock_timestamp(),
            clock_timestamp() + interval '30 days', $6, NULL)`,
        [
          activeSessionId,
          revokedSessionId,
          userId,
          legacyTokenHash,
          Buffer.alloc(32, 7),
          alreadyRevokedAt,
        ],
      );

      // Non-vacuity: this is the lookup IdentityService.authenticateContext performs, and it
      // still returns the session until 0018 revokes it.
      const repository = new IdentityRepository(pool);
      await expect(repository.findDeviceSessionByTokenHash(legacyTokenHash)).resolves.toMatchObject(
        { id: activeSessionId },
      );

      await expect(runMigrations(pool)).resolves.toEqual({
        applied: ["0018_hype_comms_technical_rebrand.sql"],
      });

      await expect(repository.findDeviceSessionByTokenHash(legacyTokenHash)).resolves.toBeNull();
      const sessions = await pool.query<{
        id: string;
        revoked_at: Date | null;
        workos_session_id: string | null;
      }>("SELECT id, revoked_at, workos_session_id FROM device_sessions ORDER BY id");
      const revocations = new Map(
        sessions.rows.map((row) => [
          row.id,
          { at: row.revoked_at, provider: row.workos_session_id },
        ]),
      );
      expect(revocations.get(activeSessionId)?.at).toBeInstanceOf(Date);
      // Revoking drops the provider session link, matching revokeAllDeviceSessions.
      expect(revocations.get(activeSessionId)?.provider).toBeNull();
      // An earlier sign-out keeps its own timestamp instead of being restamped.
      expect(revocations.get(revokedSessionId)?.at).toEqual(new Date(alreadyRevokedAt));
    });
  });

  it("leaves the legacy slug alone when the renamed slug already exists", async () => {
    await withFreshSchema(async (pool) => {
      const userId = randomUUID();
      const legacyWorkspaceId = randomUUID();
      const renamedWorkspaceId = randomUUID();

      await withoutTechnicalRebrandMigration(async (migrationsDirectory) => {
        await runMigrations(pool, migrationsDirectory);
      });

      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'slug-collision@example.test', 'collision', 'Collision')`,
        [userId],
      );
      // workspaces.slug is UNIQUE, so an unguarded rename would abort the migration and
      // crash-loop the server on every boot.
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES
           ($1, 'Legacy', 'hmm-chat', $3),
           ($2, 'Hype Comms', 'hype-comms', $3)`,
        [legacyWorkspaceId, renamedWorkspaceId, userId],
      );

      await expect(runMigrations(pool)).resolves.toEqual({
        applied: ["0018_hype_comms_technical_rebrand.sql"],
      });

      const slugs = await pool.query<{ id: string; slug: string }>(
        "SELECT id, slug FROM workspaces",
      );
      expect(new Map(slugs.rows.map((row) => [row.id, row.slug]))).toEqual(
        new Map([
          [legacyWorkspaceId, "hmm-chat"],
          [renamedWorkspaceId, "hype-comms"],
        ]),
      );
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

  it("preserves pre-0023 agents while adding explicit equivalents for their old access", async () => {
    await withFreshSchema(async (pool) => {
      await withoutMigrations(
        [
          "0023_default_agent_agency.sql",
          "0025_public_channel_membership.sql",
          "0026_group_direct_messages.sql",
          "0027_read_only_agent_attachments.sql",
          "0028_channel_webhooks.sql",
        ],
        async (migrationsDirectory) => {
          await runMigrations(pool, migrationsDirectory);

          const ownerId = randomUUID();
          const workspaceId = randomUUID();
          const agentId = randomUUID();
          const tokenId = randomUUID();
          const publicChannelId = randomUUID();
          const archivedPublicChannelId = randomUUID();
          const legacyToken = `hype_comms_agent_${"l".repeat(43)}`;
          const legacyTokenHash = hashToken(legacyToken);
          const createdAt = "2026-08-22T12:00:00.000Z";
          const legacyScopes = [
            "workspace:read",
            "messages:write",
            "conversations:write",
            "read-cursors:write",
          ] as const;
          const migratedScopes = [...legacyScopes, "channels:join", "attachments:write"] as const;

          await pool.query(
            `INSERT INTO users (id, email, kind, username, display_name, created_at, updated_at)
           VALUES
             ($1, 'legacy-owner@example.test', 'human', 'legacy-owner', 'Legacy owner', $3, $3),
             ($2, NULL, 'agent', 'legacy_agent', 'Legacy agent', $3, $3)`,
            [ownerId, agentId, createdAt],
          );
          await pool.query(
            `INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at)
           VALUES ($1, 'Legacy agents', 'legacy-agents', $2, $3, $3)`,
            [workspaceId, ownerId, createdAt],
          );
          await pool.query(
            `INSERT INTO workspace_memberships
             (workspace_id, user_id, role, status, created_at, updated_at)
           VALUES
             ($1, $2, 'owner', 'active', $4, $4),
             ($1, $3, 'member', 'active', $4, $4)`,
            [workspaceId, ownerId, agentId, createdAt],
          );
          await pool.query(
            `INSERT INTO agents
             (user_id, workspace_id, created_by, created_at)
           VALUES ($1, $2, $3, $4)`,
            [agentId, workspaceId, ownerId, createdAt],
          );
          await pool.query(
            `INSERT INTO conversations
             (id, workspace_id, kind, name, slug, channel_access, is_archived, created_by)
           VALUES
             ($1, $2, 'channel', 'Public', 'public', 'workspace', false, $4),
             ($3, $2, 'channel', 'Archived public', 'archived-public', 'workspace', true, $4)`,
            [publicChannelId, workspaceId, archivedPublicChannelId, ownerId],
          );
          await pool.query(
            `INSERT INTO agent_tokens
             (id, workspace_id, agent_user_id, token_hash, label, scopes,
              created_by, created_at, last_used_at)
           VALUES ($1, $2, $3, $4, 'Legacy runtime', $5::text[], $6, $7, $7)`,
            [tokenId, workspaceId, agentId, legacyTokenHash, [...legacyScopes], ownerId, createdAt],
          );

          const preMigrationRepository = new IdentityRepository(pool);
          const agentBefore = await preMigrationRepository.findAgent(workspaceId, agentId);
          expect(agentBefore).not.toBeNull();
          await expect(
            pool.query<{ scopes: string[] }>("SELECT scopes FROM agent_tokens WHERE id = $1", [
              tokenId,
            ]),
          ).resolves.toMatchObject({ rows: [{ scopes: [...legacyScopes] }] });

          await expect(runMigrations(pool)).resolves.toEqual({
            applied: [
              "0023_default_agent_agency.sql",
              "0025_public_channel_membership.sql",
              "0026_group_direct_messages.sql",
              "0027_read_only_agent_attachments.sql",
              "0028_channel_webhooks.sql",
            ],
          });

          const repository = new IdentityRepository(pool);
          await expect(repository.findAgent(workspaceId, agentId)).resolves.toEqual(agentBefore);
          await expect(repository.listAgentTokens(workspaceId, agentId)).resolves.toEqual([
            expect.objectContaining({
              id: tokenId,
              agentUserId: agentId,
              scopes: [...legacyScopes],
              revokedAt: null,
            }),
          ]);
          await expect(repository.listAgentTokens(workspaceId, agentId, true)).resolves.toEqual([
            expect.objectContaining({
              id: tokenId,
              scopes: [...legacyScopes],
              effectiveScopes: [...migratedScopes],
            }),
          ]);
          await expect(
            pool.query<{
              scopes: string[];
              inherited_channels_join: boolean;
              inherited_attachments_write: boolean;
            }>(
              `SELECT scopes, inherited_channels_join, inherited_attachments_write
                 FROM agent_tokens
                WHERE id = $1`,
              [tokenId],
            ),
          ).resolves.toMatchObject({
            rows: [
              {
                scopes: [...legacyScopes],
                inherited_channels_join: true,
                inherited_attachments_write: true,
              },
            ],
          });
          await expect(
            pool.query<{ conversation_id: string; left_at: Date | null; role: string }>(
              `SELECT conversation_id, left_at, role
               FROM conversation_memberships
              WHERE user_id = $1`,
              [agentId],
            ),
          ).resolves.toMatchObject({
            rows: expect.arrayContaining([
              { conversation_id: publicChannelId, left_at: null, role: "member" },
              { conversation_id: archivedPublicChannelId, left_at: null, role: "member" },
            ]),
            rowCount: 2,
          });

          const service = new IdentityService(
            repository,
            { async sendMagicLink() {} },
            new SignInThrottle(),
            () => new Date(createdAt),
            "http://127.0.0.1:3000",
          );
          await expect(service.authenticateAgentContext(legacyToken)).resolves.toMatchObject({
            principalKind: "agent",
            agentTokenId: tokenId,
            currentUser: {
              type: "agent",
              user: { id: agentId, kind: "agent", username: "legacy_agent" },
              workspaceId,
              role: "member",
              scopes: [...legacyScopes],
            },
            authorizationScopes: [...migratedScopes],
          });
          const rollbackCompatibleService = new IdentityService(
            repository,
            { async sendMagicLink() {} },
            new SignInThrottle(),
            () => new Date(createdAt),
            "http://127.0.0.1:3000",
            undefined,
            false,
          );
          await expect(
            rollbackCompatibleService.authenticateAgentContext(legacyToken),
          ).resolves.toMatchObject({
            currentUser: { scopes: [...legacyScopes] },
            authorizationScopes: [...migratedScopes],
          });
          const legacyScopeSchema = z.enum([
            "workspace:read",
            "messages:write",
            "conversations:write",
            "read-cursors:write",
            "direct-conversations:write",
            "agents:invite",
          ]);
          const legacyPrincipalSchema = agentCurrentPrincipalSchema.safeExtend({
            scopes: z.array(legacyScopeSchema),
          });
          const enabledIdentity = await service.authenticateAgentContext(legacyToken);
          if (enabledIdentity === null) throw new Error("Legacy token did not authenticate");
          expect(() => legacyPrincipalSchema.parse(enabledIdentity.currentUser)).not.toThrow();
          const legacyTokenListSchema = listAgentTokensResponseSchema.extend({
            tokens: z.array(agentTokenSchema.safeExtend({ scopes: z.array(legacyScopeSchema) })),
          });
          const rollbackTokenList = await service.listAgentTokens(ownerId, agentId);
          expect(() =>
            legacyTokenListSchema.parse({
              tokens: rollbackTokenList,
            }),
          ).not.toThrow();
          await expect(service.listAgentTokens(ownerId, agentId, true)).resolves.toEqual([
            expect.objectContaining({
              id: tokenId,
              scopes: [...legacyScopes],
              effectiveScopes: [...migratedScopes],
            }),
          ]);
        },
      );
    });
  });

  it("enforces the stored shape of group direct conversations", async () => {
    await withFreshSchema(async (pool) => {
      await runMigrations(pool);
      const ownerId = randomUUID();
      const firstMemberId = randomUUID();
      const secondMemberId = randomUUID();
      const extraMemberId = randomUUID();
      const botId = randomUUID();
      const workspaceId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name)
         VALUES ($1, 'group-owner@example.test', 'group-owner', 'Group Owner'),
                ($2, 'group-first@example.test', 'group-first', 'Group First'),
                ($3, 'group-second@example.test', 'group-second', 'Group Second'),
                ($4, 'group-extra@example.test', 'group-extra', 'Group Extra')`,
        [ownerId, firstMemberId, secondMemberId, extraMemberId],
      );
      await pool.query(
        `INSERT INTO users (id, kind, username, display_name)
         VALUES ($1, 'bot', 'group-task-bot', 'Group Task Bot')`,
        [botId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ($1, 'Group constraints', 'group-constraints', $2)`,
        [workspaceId, ownerId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active'),
                ($1, $3, 'member', 'active'),
                ($1, $4, 'member', 'active'),
                ($1, $5, 'member', 'active'),
                ($1, $6, 'member', 'active')`,
        [workspaceId, ownerId, firstMemberId, secondMemberId, extraMemberId, botId],
      );

      const validGroupId = randomUUID();
      const creation = await pool.connect();
      try {
        await creation.query("BEGIN");
        await creation.query(
          `INSERT INTO conversations (id, workspace_id, kind, created_by)
           VALUES ($1, $2, 'group_direct_message', $3)`,
          [validGroupId, workspaceId, ownerId],
        );
        await creation.query(
          `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, 'owner'),
                  ($1, $2, $4, 'member'),
                  ($1, $2, $5, 'member')`,
          [validGroupId, workspaceId, ownerId, firstMemberId, secondMemberId],
        );
        await creation.query(
          `UPDATE conversations
              SET group_memberships_locked = true
            WHERE id = $1`,
          [validGroupId],
        );
        await creation.query("COMMIT");
      } finally {
        creation.release();
      }
      await expect(
        pool.query(
          `SELECT 1
             FROM conversations
            WHERE id = $1
              AND kind = 'group_direct_message'
              AND group_memberships_locked`,
          [validGroupId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      const ordinaryChannelId = randomUUID();
      await pool.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES ($1, $2, 'channel', 'Ordinary channel', 'ordinary-channel', 'workspace', $3)`,
        [ordinaryChannelId, workspaceId, ownerId],
      );

      await expect(
        pool.query(
          `INSERT INTO conversations (id, workspace_id, kind, created_by)
           VALUES ($1, $2, 'group_direct_message', $3)`,
          [randomUUID(), workspaceId, ownerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, 'member')`,
          [validGroupId, workspaceId, extraMemberId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `UPDATE conversation_memberships
              SET left_at = clock_timestamp()
            WHERE conversation_id = $1 AND user_id = $2`,
          [validGroupId, firstMemberId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `UPDATE conversation_memberships
              SET conversation_id = $1
            WHERE conversation_id = $2 AND user_id = $3`,
          [ordinaryChannelId, validGroupId, firstMemberId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(
        (
          await pool.query(
            `SELECT 1
               FROM conversation_memberships
              WHERE conversation_id = $1`,
            [validGroupId],
          )
        ).rowCount,
      ).toBe(3);
      await expect(
        pool.query("UPDATE conversations SET created_by = $1 WHERE id = $2", [
          firstMemberId,
          validGroupId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE conversations SET created_by = $1 WHERE id = $2", [
          extraMemberId,
          validGroupId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      expect(
        (
          await pool.query<{ created_by: string } & QueryResultRow>(
            "SELECT created_by FROM conversations WHERE id = $1",
            [validGroupId],
          )
        ).rows[0]?.created_by,
      ).toBe(ownerId);
      await expect(
        pool.query(
          `DELETE FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2`,
          [validGroupId, firstMemberId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const botGroup = await pool.connect();
      try {
        await botGroup.query("BEGIN");
        const botGroupId = randomUUID();
        await botGroup.query(
          `INSERT INTO conversations (id, workspace_id, kind, created_by)
           VALUES ($1, $2, 'group_direct_message', $3)`,
          [botGroupId, workspaceId, ownerId],
        );
        await botGroup.query(
          `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, 'owner'),
                  ($1, $2, $4, 'member'),
                  ($1, $2, $5, 'member')`,
          [botGroupId, workspaceId, ownerId, firstMemberId, botId],
        );
        await botGroup.query(
          "UPDATE conversations SET group_memberships_locked = true WHERE id = $1",
          [botGroupId],
        );
        await expect(botGroup.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
        await botGroup.query("ROLLBACK");
      } finally {
        botGroup.release();
      }
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, channel_access, created_by)
           VALUES ($1, $2, 'group_direct_message', 'workspace', $3)`,
          [randomUUID(), workspaceId, ownerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversations
             (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
           VALUES ($1, $2, 'group_direct_message', $3, $3, $3)`,
          [randomUUID(), workspaceId, ownerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO conversations (id, workspace_id, kind, name, created_by)
           VALUES ($1, $2, 'group_direct_message', 'Malformed group', $3)`,
          [randomUUID(), workspaceId, ownerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("DELETE FROM conversations WHERE id = $1", [validGroupId]),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("fails loudly when an applied migration file changes", async () => {
    await withFreshSchema(async (pool) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-migrations-"));
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
