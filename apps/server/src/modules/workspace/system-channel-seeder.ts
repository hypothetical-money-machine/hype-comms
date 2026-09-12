import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { SYSTEM_USER_ID, type BuiltInChannelDefinition } from "../system-channels/registry.js";
import type { SystemBulletin } from "../system-channels/release-notes.js";
import { conversationAudience } from "./conversation-access.js";
import {
  mapMessage,
  mapStoredConversation,
  type ConversationRow,
  type MessageRow,
} from "./records.js";
import {
  insertSyncEvent,
  insertSyncEventWithSequence,
  nextWorkspaceSequence,
} from "./sync-events.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { auditAnnouncement, type WorkspaceRepositoryHooks } from "./workspace-hooks.js";

/** Initializes built-in channels and publishes each system bulletin once. */
export class SystemChannelSeeder {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: Pick<
      WorkspaceRepositoryHooks,
      "systemChannelsEnabled" | "onAnnouncementAudit"
    > = {},
  ) {}
  get systemChannelsEnabled(): boolean {
    return this.hooks.systemChannelsEnabled ?? false;
  }
  /**
   * Create each built-in channel a workspace is missing and post any release notes it has not
   * received yet.
   *
   * This is the "auditable service publisher" path: it is deliberately unreachable from any route,
   * so the human-owner bulletin gate in API message delivery stays the only way an API request can
   * publish. Every channel and bulletin it writes is reported through the announcement audit hook
   * under the system publisher's own user id.
   *
   * Seeding is idempotent across restarts and concurrent nodes: `system_bulletins` claims each
   * (workspace, channel, bulletin) exactly once, and channel creation relies on the slug's unique
   * index. Failures are reported per workspace and never abort the remaining work.
   */
  async seedSystemChannels(
    definitions: readonly BuiltInChannelDefinition[],
    onError?: (error: unknown, context: { workspaceId: string; slug: string }) => void,
  ): Promise<void> {
    if (definitions.length === 0) return;
    const workspaces = await this.pool.query<{ id: string } & QueryResultRow>(
      `SELECT id FROM workspaces ORDER BY id`,
    );
    if (workspaces.rows.length === 0) return;

    const bulletinsBySlug = new Map<string, readonly SystemBulletin[]>();
    for (const definition of definitions) {
      bulletinsBySlug.set(definition.slug, await definition.loadBulletins());
    }

    for (const workspace of workspaces.rows) {
      if (!(await this.#systemChannelsAvailable(workspace.id))) continue;
      for (const definition of definitions) {
        try {
          const conversation = await this.#ensureSystemChannel(workspace.id, definition);
          for (const bulletin of bulletinsBySlug.get(definition.slug) ?? []) {
            await this.#publishSystemBulletin(conversation, definition.slug, bulletin);
          }
        } catch (error) {
          onError?.(error, { workspaceId: workspace.id, slug: definition.slug });
        }
      }
    }
  }

  /**
   * Request and read the one-way built-in channel cutover for a workspace.
   *
   * Unlike the announcement and humans-only helpers this takes no row lock: the seeder must lock a
   * conversation before the workspace row to match message delivery's order, so locking the
   * workspace first here could deadlock against a member replying in the same channel. The flip is
   * an idempotent one-way UPDATE, so an unlocked read is sufficient.
   *
   * Announcement availability is flipped alongside it. A built-in channel is an announcement
   * channel, so a workspace that can hold one must already be able to represent announcement mode
   * in its stored events.
   */
  async #systemChannelsAvailable(workspaceId: string): Promise<boolean> {
    if (this.systemChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET system_channels_available = true,
                announcement_channels_available = true
          WHERE id = $1
            AND (system_channels_available = false OR announcement_channels_available = false)`,
        [workspaceId],
      );
    }
    const result = await this.pool.query<{ system_channels_available: boolean } & QueryResultRow>(
      `SELECT system_channels_available FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    return result.rows[0]?.system_channels_available ?? false;
  }

  async #ensureSystemChannel(
    workspaceId: string,
    definition: BuiltInChannelDefinition,
  ): Promise<ConversationRow> {
    const result = await runWorkspaceTransaction(this.pool, async (client) => {
      // The publisher needs a membership row because messages.author_id references one. It stays
      // `invited` so it never occupies an active seat, never appears in the member directory, and
      // never joins an event audience.
      await client.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'invited')
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [workspaceId, SYSTEM_USER_ID],
      );
      const created = await client.query<ConversationRow>(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, channel_access, channel_mode, is_system,
            created_by)
         VALUES ($1, $2, 'channel', $3, $4, $5, 'workspace', 'announcement', true, $6)
         ON CONFLICT (workspace_id, slug) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          workspaceId,
          definition.name,
          definition.slug,
          definition.topic,
          SYSTEM_USER_ID,
        ],
      );
      const row = created.rows[0];
      if (row === undefined) {
        const existing = await client.query<ConversationRow>(
          `SELECT * FROM conversations WHERE workspace_id = $1 AND slug = $2`,
          [workspaceId, definition.slug],
        );
        const found = existing.rows[0];
        if (found === undefined) throw new Error("Built-in channel could not be resolved");
        return { conversation: found, created: false };
      }
      const audienceUserIds = await conversationAudience(client, row);
      await insertSyncEvent(client, {
        workspaceId,
        actorUserId: SYSTEM_USER_ID,
        type: "channel.created",
        conversationId: row.id,
        payload: {
          conversation: mapStoredConversation(row),
          participantIds: audienceUserIds,
        },
        audienceUserIds,
      });
      return { conversation: row, created: true };
    });
    if (result.created) {
      auditAnnouncement(this.hooks, {
        operation: "channel.create",
        outcome: "accepted",
        actorUserId: SYSTEM_USER_ID,
        workspaceId,
        conversationId: result.conversation.id,
      });
    }
    return result.conversation;
  }

  /** Returns true when this call delivered the bulletin, false when it was already present. */
  async #publishSystemBulletin(
    conversation: ConversationRow,
    channelSlug: string,
    bulletin: SystemBulletin,
  ): Promise<boolean> {
    const committed = await runWorkspaceTransaction(this.pool, async (client) => {
      // Same lock order as message delivery: the conversation row first, the workspace sequence
      // last. Taking the conversation lock also serializes two nodes seeding the same channel.
      const locked = await client.query<ConversationRow>(
        `SELECT * FROM conversations WHERE id = $1 FOR UPDATE`,
        [conversation.id],
      );
      const current = locked.rows[0];
      if (current === undefined) return null;

      const messageId = randomUUID();
      const claimed = await client.query(
        `INSERT INTO system_bulletins (workspace_id, channel_slug, bulletin_key, message_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, channel_slug, bulletin_key) DO NOTHING`,
        [current.workspace_id, channelSlug, bulletin.key, messageId],
      );
      if (claimed.rowCount === 0) return null;

      const conversationSequenceResult = await client.query<{ next: string } & QueryResultRow>(
        `UPDATE conversations
            SET last_message_sequence = last_message_sequence + 1,
                updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING last_message_sequence::text AS next`,
        [current.id],
      );
      const conversationSequence = conversationSequenceResult.rows[0]?.next;
      if (conversationSequence === undefined)
        throw new Error("Could not allocate bulletin sequence");

      const workspaceSequence = await nextWorkspaceSequence(client, current.workspace_id);
      const inserted = await client.query<MessageRow>(
        `INSERT INTO messages (
           id, workspace_id, conversation_id, conversation_sequence,
           committed_workspace_sequence, client_message_id, request_fingerprint,
           author_id, thread_root_id, body, body_format
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 'hype_comms_markdown_v1')
         RETURNING *`,
        [
          messageId,
          current.workspace_id,
          current.id,
          conversationSequence,
          workspaceSequence,
          randomUUID(),
          createHash("sha256")
            .update(`${current.workspace_id}:${channelSlug}:${bulletin.key}`)
            .digest(),
          SYSTEM_USER_ID,
          bulletin.body,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Bulletin insert returned no row");

      const audienceUserIds = await conversationAudience(client, current);
      // Availability was confirmed before seeding, so stored events keep their channel mode.
      await insertSyncEventWithSequence(client, workspaceSequence, {
        workspaceId: current.workspace_id,
        actorUserId: SYSTEM_USER_ID,
        type: "message.created",
        conversationId: current.id,
        conversationSequence,
        payload: { message: mapMessage(row), mentionedUserIds: [] },
        audienceUserIds,
        stripChannelMode: false,
      });
      return { workspaceId: current.workspace_id, conversationId: current.id };
    });
    if (committed === null) return false;
    auditAnnouncement(this.hooks, {
      operation: "bulletin.publish",
      outcome: "accepted",
      actorUserId: SYSTEM_USER_ID,
      workspaceId: committed.workspaceId,
      conversationId: committed.conversationId,
    });
    return true;
  }
}
