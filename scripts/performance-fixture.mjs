import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../apps/server/dist/config.js";
import { runMigrations } from "../apps/server/dist/db/migrate.js";
import {
  seedDevelopmentDemo,
  writeDevelopmentDemoCallbacks,
} from "../apps/server/dist/dev-seed.js";
import { WorkspaceRepository } from "../apps/server/dist/modules/workspace/repository.js";

// Called after timed operations, against the runner's isolated synthetic database only. Capture
// the actual repository query so the retained plan cannot drift from the SQL the app executes.
export async function explainPerformanceSearch(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const actor = (
      await pool.query(`SELECT users.id, memberships.workspace_id
      FROM users JOIN workspace_memberships memberships ON memberships.user_id = users.id
      WHERE users.username = 'claire'`)
    ).rows[0];
    if (!actor) throw new Error("Benchmark search identity is missing");
    let captured;
    const repository = new WorkspaceRepository({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql, parameters) => {
            if (sql.includes("search_page AS (")) captured = { sql, parameters };
            return client.query(sql, parameters);
          },
          release: () => client.release(),
        };
      },
    });
    const response = await repository.searchMessages(
      { currentUser: { workspaceId: actor.workspace_id, user: { id: actor.id } } },
      "searchneedle",
      undefined,
      25,
    );
    if (!captured) throw new Error("Benchmark did not capture the search query");
    const plan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`,
      captured.parameters,
    );
    return { ...captured, returnedRows: response.results.length, plan: plan.rows[0]["QUERY PLAN"] };
  } finally {
    await pool.end();
  }
}

// Only the runner's newly initialized cluster is used. No caller-supplied database URL.
export async function explainPerformanceSync(databaseUrl, after) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const actor = (
      await pool.query(`SELECT users.id, memberships.workspace_id
      FROM users JOIN workspace_memberships memberships ON memberships.user_id = users.id
      WHERE users.username = 'claire'`)
    ).rows[0];
    if (!actor) throw new Error("Benchmark sync identity is missing");
    let captured;
    const repository = new WorkspaceRepository({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql, parameters) => {
            if (sql.includes("AS visible")) captured = { sql, parameters };
            return client.query(sql, parameters);
          },
          release: () => client.release(),
        };
      },
    });
    const response = await repository.syncPrincipal(
      {
        workspaceId: actor.workspace_id,
        userId: actor.id,
        reactionEvents: true,
        taskEvents: true,
        participatedThreadNotifications: true,
        messageRetractEvents: true,
        groupDirectMessages: true,
        readStateEvents: true,
        memberProfiles: true,
        humansOnlyChannels: true,
        announcementChannels: true,
      },
      after,
      100,
    );
    if (!captured) throw new Error("Benchmark did not capture the sync page query");
    const plan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`,
      captured.parameters,
    );
    return {
      ...captured,
      returnedEvents: response.events.length,
      plan: plan.rows[0]["QUERY PLAN"],
    };
  } finally {
    await pool.end();
  }
}

// Fixture setup after timing, in the runner's newly created cluster. Use the real repository
// transaction and read-state event; the headless renderer intentionally cannot write read cursors.
export async function advancePerformanceReadCursor(databaseUrl, conversationId, messageId) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const actors = (
      await pool.query(`SELECT users.id, memberships.workspace_id
      FROM users JOIN workspace_memberships memberships ON memberships.user_id = users.id
      WHERE users.username = 'claire' AND memberships.status = 'active'`)
    ).rows;
    if (actors.length !== 1) throw new Error("Benchmark receiver identity is ambiguous or missing");
    const actor = actors[0];
    return await new WorkspaceRepository(pool).advanceReadCursor(
      { currentUser: { workspaceId: actor.workspace_id, user: { id: actor.id } } },
      conversationId,
      messageId,
    );
  } finally {
    await pool.end();
  }
}

// Only the runner's newly initialized cluster is used. No caller-supplied database URL.
export async function seedPerformanceFixture(
  databaseUrl,
  apiPort,
  channels,
  messagesPerChannel,
  callbackDirectory,
) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool);
    const config = loadConfig({
      NODE_ENV: "development",
      HYPE_COMMS_DATABASE_URL: databaseUrl,
      HYPE_COMMS_PORT: String(apiPort),
    });
    const demo = await seedDevelopmentDemo(pool, config);
    const owner = (
      await pool.query("SELECT created_by FROM workspaces WHERE id = $1", [demo.workspaceId])
    ).rows[0].created_by;
    const existing = Number(
      (await pool.query("SELECT count(*) FROM conversations WHERE kind = 'channel'")).rows[0].count,
    );
    for (let i = existing; i < channels; i++) {
      await pool.query(
        `INSERT INTO conversations (id, workspace_id, kind, name, slug, channel_access, created_by)
         VALUES ($1, $2, 'channel', $3, $4, 'workspace', $5)`,
        [
          randomUUID(),
          demo.workspaceId,
          `Performance ${String(i).padStart(3, "0")}`,
          `perf-${String(i).padStart(3, "0")}`,
          owner,
        ],
      );
    }
    await pool.query(
      `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
       SELECT c.id, c.workspace_id, m.user_id, 'member'
       FROM conversations c JOIN workspace_memberships m ON m.workspace_id = c.workspace_id
       WHERE c.kind = 'channel' ON CONFLICT DO NOTHING`,
    );
    // Bulk historical fixture. High-water sequences stay consistent; old sync events are not
    // synthesized. New messages are always sent through the real application API.
    const channelRows = (
      await pool.query(
        "SELECT id, name, slug, last_message_sequence FROM conversations WHERE kind = 'channel' ORDER BY slug",
      )
    ).rows;
    let sequence = Number(
      (
        await pool.query("SELECT last_event_sequence FROM workspaces WHERE id = $1", [
          demo.workspaceId,
        ])
      ).rows[0].last_event_sequence,
    );
    for (const channel of channelRows) {
      await pool.query(
        `INSERT INTO messages (id, workspace_id, conversation_id, conversation_sequence,
         committed_workspace_sequence, client_message_id, request_fingerprint, author_id, body, body_format)
         SELECT gen_random_uuid(), $1, $2, $3::bigint + n, $4::bigint + n, gen_random_uuid(),
           decode(repeat('00', 32), 'hex'), $5,
           'Benchmark ' || $6::text || ' item ' || n || E'\n\nSynthetic project update with **markdown**, a [link](https://example.invalid), and \`code\`. Searchneedle status update.',
           'hype_comms_markdown_v1'
         FROM generate_series(1, $7::integer) n`,
        [
          demo.workspaceId,
          channel.id,
          channel.last_message_sequence,
          sequence,
          owner,
          channel.slug,
          messagesPerChannel,
        ],
      );
      sequence += messagesPerChannel;
      await pool.query(
        "UPDATE conversations SET last_message_sequence = last_message_sequence + $2 WHERE id = $1",
        [channel.id, messagesPerChannel],
      );
    }
    await pool.query("UPDATE workspaces SET last_event_sequence = $2 WHERE id = $1", [
      demo.workspaceId,
      sequence,
    ]);
    await pool.query("ANALYZE");
    const counts = (
      await pool.query(`SELECT
      (SELECT count(*)::int FROM conversations) AS conversations,
      (SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM users) AS members`)
    ).rows[0];
    const callbacks = await writeDevelopmentDemoCallbacks(demo, callbackDirectory);
    return { counts, callbacks, channels: channelRows };
  } finally {
    await pool.end();
  }
}
