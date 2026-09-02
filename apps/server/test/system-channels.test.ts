import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, type Pool } from "pg";

import type { CurrentUser, WorkspaceEvent } from "@hype-comms/contracts";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import { loadReleaseNoteBulletins } from "../src/modules/system-channels/release-notes.js";
import {
  SYSTEM_USER_ID,
  type BuiltInChannelDefinition,
} from "../src/modules/system-channels/registry.js";
import {
  type AnnouncementAuditRecord,
  WorkspaceRepository,
} from "../src/modules/workspace/repository.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const now = "2026-07-24T12:00:00.000Z";
const ownerId = "20000000-0000-4000-8000-000000000001";
const memberId = "20000000-0000-4000-8000-000000000002";
const workspaceId = "20000000-0000-4000-8000-000000000004";
const otherWorkspaceId = "20000000-0000-4000-8000-000000000005";
const RELEASE_NOTES_SLUG = "hype/release-notes";

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

function identity(
  id: string,
  username: string,
  role: "owner" | "member",
  workspace = workspaceId,
): AuthenticatedIdentity {
  const user: CurrentUser = {
    user: {
      id,
      kind: "human",
      username,
      displayName: username,
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    email: `${username}@example.com`,
    workspaceId: workspace,
    role,
  };
  return { currentUser: user, sessionId: randomUUID(), principalKind: "human" };
}

const owner = identity(ownerId, "owner", "owner");
const member = identity(memberId, "member", "member");

describe("loadReleaseNoteBulletins", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hype-comms-release-notes-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function directoryUrl(): URL {
    return pathToFileURL(`${directory}/`);
  }

  it("orders releases numerically and stamps each bulletin with its version", async () => {
    await writeFile(path.join(directory, "v0.1.2.md"), "## Highlights\n\n- Second\n");
    await writeFile(path.join(directory, "v0.1.10.md"), "## Highlights\n\n- Tenth\n");
    await writeFile(path.join(directory, "v0.2.0.md"), "## Highlights\n\n- Later\n");
    await writeFile(path.join(directory, "v0.1.1.md"), "## Highlights\n\n- First\n");

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());

    // Oldest first, and 0.1.10 sorts after 0.1.2 rather than lexicographically before it.
    expect(bulletins.map((bulletin) => bulletin.key)).toEqual([
      "v0.1.1",
      "v0.1.2",
      "v0.1.10",
      "v0.2.0",
    ]);
    expect(bulletins[0]?.body).toBe("**Hype Comms v0.1.1**\n\n## Highlights\n\n- First");
  });

  it("skips unreviewed, empty, and non-release files", async () => {
    await writeFile(
      path.join(directory, "v0.1.1.md"),
      "<!-- release-notes:todo Remove this line. -->\n\n## Highlights\n\n- Unreviewed\n",
    );
    await writeFile(path.join(directory, "v0.1.2.md"), "   \n");
    await writeFile(path.join(directory, "README.md"), "## Highlights\n\n- Not a release\n");
    await writeFile(path.join(directory, "v0.1.3-beta.md"), "## Highlights\n\n- Prerelease\n");
    await writeFile(path.join(directory, "v0.1.4.md"), "## Highlights\n\n- Shipped\n");

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());

    expect(bulletins.map((bulletin) => bulletin.key)).toEqual(["v0.1.4"]);
  });

  it("truncates an oversized release note to a body the contract accepts", async () => {
    await writeFile(path.join(directory, "v0.1.1.md"), `## Highlights\n\n- ${"x".repeat(5_000)}\n`);

    const bulletins = await loadReleaseNoteBulletins(directoryUrl());
    const body = bulletins[0]?.body ?? "";

    expect([...body].length).toBeLessThanOrEqual(4_000);
    expect(body).toContain("_Full notes: docs/releases/v0.1.1.md_");
  });

  it("reads the notes bundled with the server when no directory is given", async () => {
    // Exercises the module-relative fallback used under tsx in development.
    const bulletins = await loadReleaseNoteBulletins();

    expect(bulletins.length).toBeGreaterThan(0);
    for (const bulletin of bulletins) {
      expect(bulletin.key).toMatch(/^v\d+\.\d+\.\d+$/);
      expect([...bulletin.body].length).toBeLessThanOrEqual(4_000);
    }
  });
});

describeWithPostgres("seedSystemChannels", () => {
  const schemaName = `system_channels_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let audits: AnnouncementAuditRecord[];

  const bulletins = [
    { key: "v0.1.1", body: "**Hype Comms v0.1.1**\n\nFirst release" },
    { key: "v0.1.2", body: "**Hype Comms v0.1.2**\n\nSecond release" },
  ];
  const definition: BuiltInChannelDefinition = {
    slug: RELEASE_NOTES_SLUG,
    name: "Release notes",
    topic: "What changed in each release.",
    loadBulletins: async () => bulletins,
  };

  function repositoryFor(systemChannelsEnabled: boolean): WorkspaceRepository {
    return new WorkspaceRepository(pool, {
      systemChannelsEnabled,
      onAnnouncementAudit: (record) => audits.push(record),
    });
  }

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 8 });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    audits = [];
    await pool.query(`
      TRUNCATE realtime_tickets, sync_event_audiences, sync_events, system_bulletins,
               conversation_read_cursors, messages, conversation_memberships, conversations,
               workspace_memberships, workspaces, users
      CASCADE
    `);
    // Truncating users also removes the publisher migration 0030 installs, so restore it.
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       VALUES ($1, NULL, 'bot', 'hype-comms-system', 'Hype Comms')`,
      [SYSTEM_USER_ID],
    );
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'owner@example.com', 'owner', 'Owner'),
              ($2, 'member@example.com', 'member', 'Member')`,
      [ownerId, memberId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Hype Comms', 'hype-comms', $2), ($3, 'Second', 'second', $2)`,
      [workspaceId, ownerId, otherWorkspaceId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active'),
              ($4, $2, 'owner', 'active')`,
      [workspaceId, ownerId, memberId, otherWorkspaceId],
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function channelRow(workspace = workspaceId) {
    const result = await pool.query<{
      id: string;
      name: string;
      channel_mode: string;
      channel_access: string;
      is_system: boolean;
      created_by: string;
    }>(`SELECT * FROM conversations WHERE workspace_id = $1 AND slug = $2`, [
      workspace,
      RELEASE_NOTES_SLUG,
    ]);
    return result.rows[0];
  }

  async function bodies(workspace = workspaceId): Promise<string[]> {
    const result = await pool.query<{ body: string }>(
      `SELECT message.body
         FROM messages AS message
         JOIN conversations AS conversation ON conversation.id = message.conversation_id
        WHERE conversation.workspace_id = $1
          AND conversation.slug = $2
        ORDER BY message.conversation_sequence`,
      [workspace, RELEASE_NOTES_SLUG],
    );
    return result.rows.map((row) => row.body);
  }

  it("seeds nothing until the cutover is enabled", async () => {
    await repositoryFor(false).seedSystemChannels([definition]);

    expect(await channelRow()).toBeUndefined();
    expect(audits).toEqual([]);
    const workspace = await pool.query<{ system_channels_available: boolean }>(
      `SELECT system_channels_available FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    expect(workspace.rows[0]?.system_channels_available).toBe(false);
  });

  it("creates the built-in channel and posts every bundled release note in order", async () => {
    await repositoryFor(true).seedSystemChannels([definition]);

    const channel = await channelRow();
    expect(channel).toMatchObject({
      name: "Release notes",
      channel_mode: "announcement",
      channel_access: "workspace",
      is_system: true,
      created_by: SYSTEM_USER_ID,
    });
    expect(await bodies()).toEqual([bulletins[0]?.body, bulletins[1]?.body]);

    // The publisher holds a seat only so messages.author_id resolves; it never becomes active.
    const membership = await pool.query<{ status: string; role: string }>(
      `SELECT status, role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, SYSTEM_USER_ID],
    );
    expect(membership.rows[0]).toEqual({ status: "invited", role: "member" });

    expect(audits).toEqual([
      expect.objectContaining({ operation: "channel.create", outcome: "accepted" }),
      expect.objectContaining({ operation: "bulletin.publish", outcome: "accepted" }),
      expect.objectContaining({ operation: "bulletin.publish", outcome: "accepted" }),
      expect.objectContaining({ operation: "channel.create", outcome: "accepted" }),
      expect.objectContaining({ operation: "bulletin.publish", outcome: "accepted" }),
      expect.objectContaining({ operation: "bulletin.publish", outcome: "accepted" }),
    ]);
    for (const record of audits) {
      expect(record.actorUserId).toBe(SYSTEM_USER_ID);
      expect(record).not.toHaveProperty("body");
    }

    // Every workspace gets its own copy.
    expect(await bodies(otherWorkspaceId)).toHaveLength(2);
  });

  it("flips the announcement cutover alongside its own so stored events keep channel mode", async () => {
    await repositoryFor(true).seedSystemChannels([definition]);

    const workspace = await pool.query<{
      system_channels_available: boolean;
      announcement_channels_available: boolean;
    }>(
      `SELECT system_channels_available, announcement_channels_available
         FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    expect(workspace.rows[0]).toEqual({
      system_channels_available: true,
      announcement_channels_available: true,
    });

    const stored = await pool.query<{ payload: { conversation?: { channelMode?: string } } }>(
      `SELECT payload FROM sync_events WHERE event_type = 'channel.created' AND workspace_id = $1`,
      [workspaceId],
    );
    expect(stored.rows[0]?.payload.conversation?.channelMode).toBe("announcement");
  });

  it("is idempotent across repeated and concurrent runs", async () => {
    await repositoryFor(true).seedSystemChannels([definition]);
    await repositoryFor(true).seedSystemChannels([definition]);
    await Promise.all([
      repositoryFor(true).seedSystemChannels([definition]),
      repositoryFor(true).seedSystemChannels([definition]),
    ]);

    expect(await bodies()).toHaveLength(2);
    const channels = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM conversations WHERE slug = $1`,
      [RELEASE_NOTES_SLUG],
    );
    expect(channels.rows[0]?.count).toBe("2");
    const claims = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM system_bulletins`,
    );
    expect(claims.rows[0]?.count).toBe("4");
  });

  it("posts only the release notes a workspace has not already received", async () => {
    await repositoryFor(true).seedSystemChannels([definition]);
    const withNewRelease: BuiltInChannelDefinition = {
      ...definition,
      loadBulletins: async () => [
        ...bulletins,
        { key: "v0.1.3", body: "**Hype Comms v0.1.3**\n\nThird release" },
      ],
    };

    await repositoryFor(true).seedSystemChannels([withNewRelease]);

    expect(await bodies()).toEqual([
      bulletins[0]?.body,
      bulletins[1]?.body,
      "**Hype Comms v0.1.3**\n\nThird release",
    ]);
  });

  it("hides built-in channels from clients that cannot parse the reserved namespace", async () => {
    const repository = repositoryFor(true);
    await repository.seedSystemChannels([definition]);

    const legacy = await repository.bootstrap(owner, true, false);
    expect(legacy.conversations.map((summary) => summary.conversation.slug)).not.toContain(
      RELEASE_NOTES_SLUG,
    );

    const capable = await repository.bootstrap(owner, true, true);
    const builtIn = capable.conversations.find(
      (summary) => summary.conversation.slug === RELEASE_NOTES_SLUG,
    );
    expect(builtIn?.conversation).toMatchObject({
      isBuiltIn: true,
      channelMode: "announcement",
      name: "Release notes",
    });

    // Paging must agree with the page the cursor came from.
    const legacyList = await repository.listConversations(owner, undefined, 50, true, false);
    expect(legacyList.conversations.map((summary) => summary.conversation.slug)).not.toContain(
      RELEASE_NOTES_SLUG,
    );
  });

  it("withholds built-in channel events from sync until the client advertises support", async () => {
    const repository = repositoryFor(true);
    await repository.seedSystemChannels([definition]);

    const conversationIdOf = (event: WorkspaceEvent): string | null => event.conversationId;
    const channel = await channelRow();

    const legacy = await repository.sync(member, "0", 100, {});
    expect(legacy.events.map(conversationIdOf)).not.toContain(channel?.id);

    const capable = await repository.sync(member, "0", 100, {
      systemChannels: true,
      announcementChannels: true,
    });
    const delivered = capable.events.filter((event) => conversationIdOf(event) === channel?.id);
    expect(delivered.map((event) => event.type)).toEqual([
      "channel.created",
      "message.created",
      "message.created",
    ]);
  });

  it("keeps built-in channels out of the public directory and refuses to archive them", async () => {
    const repository = repositoryFor(true);
    await repository.seedSystemChannels([definition]);
    const channel = await channelRow();

    const directory = await repository.listPublicChannels(owner, undefined, 50);
    expect(directory.channels.map((entry) => entry.conversation.slug)).not.toContain(
      RELEASE_NOTES_SLUG,
    );

    await expect(repository.archiveChannel(owner, channel?.id ?? "")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("lets members react and reply in threads while refusing new root bulletins", async () => {
    const repository = repositoryFor(true);
    await repository.seedSystemChannels([definition]);
    const channel = await channelRow();
    const root = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 ORDER BY conversation_sequence LIMIT 1`,
      [channel?.id],
    );
    const rootId = root.rows[0]?.id ?? "";

    const reply = await repository.sendMessage(member, channel?.id ?? "", {
      threadRootId: rootId,
      body: "Nice release",
      bodyFormat: "hype_comms_markdown_v1",
      clientMessageId: randomUUID(),
      mentionedUserIds: [],
      attachmentIds: [],
    });
    expect(reply.message.threadRootId).toBe(rootId);

    await expect(repository.addReaction(member, rootId, "🎉")).resolves.toMatchObject({
      reaction: { emoji: "🎉" },
    });

    // Even the owner cannot publish a bulletin here; only the seeder writes root messages.
    await expect(
      repository.sendMessage(owner, channel?.id ?? "", {
        threadRootId: null,
        body: "My own announcement",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: randomUUID(),
        mentionedUserIds: [],
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Only Hype Comms posts in this channel",
    });
  });

  it("reserves the hype/ namespace at the database boundary", async () => {
    await expect(
      pool.query(
        `INSERT INTO conversations (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES ($1, $2, 'channel', 'Sneaky', $3, 'workspace', $4)`,
        [randomUUID(), workspaceId, RELEASE_NOTES_SLUG, ownerId],
      ),
    ).rejects.toMatchObject({ constraint: "conversations_system_valid" });

    await repositoryFor(true).seedSystemChannels([definition]);
    const channel = await channelRow();
    await expect(
      pool.query(`UPDATE conversations SET is_system = false WHERE id = $1`, [channel?.id]),
    ).rejects.toMatchObject({ constraint: "conversations_system_immutable" });
  });
});
