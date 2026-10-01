import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { createTestDatabase, describeWithPostgres, type TestDatabase } from "./support/database.js";

describeWithPostgres("read-only agent attachment migration", () => {
  it("adds compatibility markers without changing legacy scope arrays", async () => {
    const migrationsDirectory = await mkdtemp(
      path.join(os.tmpdir(), "agent-attachment-migrations-"),
    );
    const sourceMigrations = new URL("../src/db/migrations/", import.meta.url);
    let database: TestDatabase | undefined;
    try {
      for (const filename of await readdir(sourceMigrations)) {
        if (!filename.endsWith(".sql") || filename === "0027_read_only_agent_attachments.sql") {
          continue;
        }
        await writeFile(
          path.join(migrationsDirectory, filename),
          await readFile(new URL(filename, sourceMigrations)),
        );
      }
      database = await createTestDatabase({ migrate: false, poolSize: 2 });
      const pool = database.pool;
      await runMigrations(pool, pathToFileURL(`${migrationsDirectory}${path.sep}`));

      const migrationOwnerId = randomUUID();
      const migrationAgentId = randomUUID();
      const migrationWorkspaceId = randomUUID();
      const writerTokenId = randomUUID();
      const readerTokenId = randomUUID();
      const revokedTokenId = randomUUID();
      const oldWriterTokenId = randomUUID();
      const newNarrowTokenId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, username, display_name, kind)
         VALUES ($1, 'migration-owner@example.test', 'migration-owner', 'Migration Owner', 'human'),
                ($2, NULL, 'migration-agent', 'Migration Agent', 'agent')`,
        [migrationOwnerId, migrationAgentId],
      );
      await pool.query(
        `INSERT INTO workspaces (id, name, slug, created_by)
         VALUES ($1, 'Migration Workspace', 'migration-workspace', $2)`,
        [migrationWorkspaceId, migrationOwnerId],
      );
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
        [migrationWorkspaceId, migrationOwnerId, migrationAgentId],
      );
      await pool.query(
        `INSERT INTO agents (user_id, workspace_id, created_by)
         VALUES ($1, $2, $3)`,
        [migrationAgentId, migrationWorkspaceId, migrationOwnerId],
      );
      await pool.query(
        `INSERT INTO agent_tokens
           (id, workspace_id, agent_user_id, token_hash, label, scopes, created_by)
         VALUES
           ($1, $2, $3, $4, 'Existing writer', $5, $6),
           ($7, $2, $3, $8, 'Existing reader', $9, $6)`,
        [
          writerTokenId,
          migrationWorkspaceId,
          migrationAgentId,
          Buffer.alloc(32, 1),
          ["workspace:read", "messages:write", "direct-conversations:write"],
          migrationOwnerId,
          readerTokenId,
          Buffer.alloc(32, 2),
          ["workspace:read"],
        ],
      );
      await pool.query(
        `INSERT INTO agent_tokens
           (id, workspace_id, agent_user_id, token_hash, label, scopes, created_by, revoked_at)
         VALUES ($1, $2, $3, $4, 'Existing revoked writer', $5, $6, clock_timestamp())`,
        [
          revokedTokenId,
          migrationWorkspaceId,
          migrationAgentId,
          Buffer.alloc(32, 3),
          ["workspace:read", "messages:write"],
          migrationOwnerId,
        ],
      );

      await runMigrations(pool);

      const legacyScopesSchema = z.array(
        z.enum([
          "workspace:read",
          "messages:write",
          "conversations:write",
          "read-cursors:write",
          "direct-conversations:write",
          "agents:invite",
        ]),
      );
      const tokens = await pool.query<{
        id: string;
        scopes: string[];
        inherited_channels_join: boolean;
        inherited_attachments_write: boolean;
      }>(
        `SELECT id, scopes, inherited_channels_join, inherited_attachments_write
           FROM agent_tokens
          ORDER BY label`,
      );
      expect(tokens.rows).toEqual([
        {
          id: readerTokenId,
          scopes: ["workspace:read"],
          inherited_channels_join: true,
          inherited_attachments_write: false,
        },
        {
          id: revokedTokenId,
          scopes: ["workspace:read", "messages:write"],
          inherited_channels_join: false,
          inherited_attachments_write: false,
        },
        {
          id: writerTokenId,
          scopes: ["workspace:read", "messages:write", "direct-conversations:write"],
          inherited_channels_join: true,
          inherited_attachments_write: true,
        },
      ]);
      for (const token of tokens.rows) legacyScopesSchema.parse(token.scopes);

      const repository = new IdentityRepository(pool);
      const effectiveTokens = await repository.listAgentTokens(
        migrationWorkspaceId,
        migrationAgentId,
        true,
      );
      expect(effectiveTokens.find((token) => token.id === readerTokenId)).toMatchObject({
        scopes: ["workspace:read"],
        effectiveScopes: ["workspace:read", "channels:join"],
      });
      expect(effectiveTokens.find((token) => token.id === writerTokenId)).toMatchObject({
        scopes: ["workspace:read", "messages:write", "direct-conversations:write"],
        effectiveScopes: [
          "workspace:read",
          "messages:write",
          "direct-conversations:write",
          "channels:join",
          "attachments:write",
        ],
      });

      // An old writer omits the marker columns; the trigger derives its legacy capabilities.
      await pool.query(
        `INSERT INTO agent_tokens
           (id, workspace_id, agent_user_id, token_hash, label, scopes, created_by)
         VALUES ($1, $2, $3, $4, 'Post-migration old writer', $5, $6)`,
        [
          oldWriterTokenId,
          migrationWorkspaceId,
          migrationAgentId,
          Buffer.alloc(32, 4),
          ["workspace:read", "messages:write"],
          migrationOwnerId,
        ],
      );
      await repository.insertAgentToken({
        id: newNarrowTokenId,
        workspaceId: migrationWorkspaceId,
        agentUserId: migrationAgentId,
        tokenHash: Buffer.alloc(32, 5),
        label: "Post-migration new writer",
        scopes: ["workspace:read", "messages:write"],
        createdBy: migrationOwnerId,
        createdAt: new Date().toISOString(),
      });
      await expect(
        pool.query<{
          id: string;
          inherited_channels_join: boolean;
          inherited_attachments_write: boolean;
        }>(
          `SELECT id, inherited_channels_join, inherited_attachments_write
             FROM agent_tokens
            WHERE id = ANY($1::uuid[])
            ORDER BY id`,
          [[oldWriterTokenId, newNarrowTokenId].sort()],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            id: [oldWriterTokenId, newNarrowTokenId].sort()[0],
            inherited_channels_join:
              [oldWriterTokenId, newNarrowTokenId].sort()[0] === oldWriterTokenId,
            inherited_attachments_write:
              [oldWriterTokenId, newNarrowTokenId].sort()[0] === oldWriterTokenId,
          },
          {
            id: [oldWriterTokenId, newNarrowTokenId].sort()[1],
            inherited_channels_join:
              [oldWriterTokenId, newNarrowTokenId].sort()[1] === oldWriterTokenId,
            inherited_attachments_write:
              [oldWriterTokenId, newNarrowTokenId].sort()[1] === oldWriterTokenId,
          },
        ],
      });
      await expect(
        pool.query("UPDATE agent_tokens SET scopes = ARRAY['workspace:read'] WHERE id = $1", [
          writerTokenId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE agent_tokens SET inherited_channels_join = false WHERE id = $1", [
          writerTokenId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await database?.dispose();
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });
});
