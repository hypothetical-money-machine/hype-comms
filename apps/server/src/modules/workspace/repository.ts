import { createHash, randomUUID } from "node:crypto";
import { WorkspaceAttachmentOperations } from "./attachment-operations.js";
import { type ExpiredAttachmentRow } from "./attachment-records.js";
import { conversationAudience } from "./conversation-access.js";
import { ConversationEventWriter } from "./conversation-events.js";
import { WorkspaceConversationOperations } from "./conversation-operations.js";
import { WorkspaceMessageOperations } from "./message-operations.js";
import { mapStoredConversation } from "./records.js";
import { WorkspaceSyncOperations } from "./sync-operations.js";
import { WorkspaceTaskOperations } from "./task-operations.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { auditAnnouncement, type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
export type {
  ConsumedRealtimeTicket,
  WorkspaceClientCapabilities,
  WorkspacePrincipal,
} from "./sync-operations.js";
export type { AnnouncementAuditRecord, WorkspaceRepositoryHooks } from "./workspace-hooks.js";

import type { Pool, QueryResultRow } from "pg";

import { SYSTEM_USER_ID, type BuiltInChannelDefinition } from "../system-channels/registry.js";
import type { SystemBulletin } from "../system-channels/release-notes.js";
import {
  insertSyncEvent,
  insertSyncEventWithSequence,
  nextWorkspaceSequence,
} from "./sync-events.js";
const SYNC_RETENTION_DAYS = 90;
const ATTACHMENT_CLEANUP_BATCH_SIZE = 100;
const UNCLAIMED_READY_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

import { mapMessage, type ConversationRow, type MessageRow } from "./records.js";

export interface AttachmentCleanupFailure {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly error: unknown;
}

export class WorkspaceRepository {
  private readonly syncOperations: WorkspaceSyncOperations;
  private readonly attachments: WorkspaceAttachmentOperations;
  private readonly conversations: WorkspaceConversationOperations;
  private readonly messages: WorkspaceMessageOperations;
  private readonly tasks: WorkspaceTaskOperations;
  private readonly events: ConversationEventWriter;

  constructor(
    private readonly pool: Pool,
    private readonly hooks: WorkspaceRepositoryHooks = {},
  ) {
    this.events = new ConversationEventWriter(this.announcementChannelsEnabled);
    this.tasks = new WorkspaceTaskOperations(pool, this.events);
    this.messages = new WorkspaceMessageOperations(pool, this.events, hooks);
    this.conversations = new WorkspaceConversationOperations(pool, this.events, hooks);
    this.attachments = new WorkspaceAttachmentOperations(pool, hooks);
    this.syncOperations = new WorkspaceSyncOperations(pool, hooks);
  }

  get announcementChannelsEnabled(): boolean {
    return this.hooks.announcementChannelsEnabled ?? false;
  }

  get humansOnlyChannelsEnabled(): boolean {
    return this.hooks.humansOnlyChannelsEnabled ?? false;
  }

  get systemChannelsEnabled(): boolean {
    return this.hooks.systemChannelsEnabled ?? false;
  }

  /** Persist the one-way cutover before this process begins serving default-agency traffic. */
  async enableDefaultAgentAgency(): Promise<void> {
    await this.pool.query(
      `UPDATE workspaces
          SET default_agent_agency_available = true
        WHERE default_agent_agency_available = false`,
    );
  }

  bootstrap(
    ...args: Parameters<WorkspaceSyncOperations["bootstrap"]>
  ): ReturnType<WorkspaceSyncOperations["bootstrap"]> {
    return this.syncOperations.bootstrap(...args);
  }

  listMembers(
    ...args: Parameters<WorkspaceConversationOperations["listMembers"]>
  ): ReturnType<WorkspaceConversationOperations["listMembers"]> {
    return this.conversations.listMembers(...args);
  }

  requireGroupDirectMessagesForConversations(
    ...args: Parameters<
      WorkspaceConversationOperations["requireGroupDirectMessagesForConversations"]
    >
  ): ReturnType<WorkspaceConversationOperations["requireGroupDirectMessagesForConversations"]> {
    return this.conversations.requireGroupDirectMessagesForConversations(...args);
  }

  requireGroupDirectMessagesForMessages(
    ...args: Parameters<WorkspaceConversationOperations["requireGroupDirectMessagesForMessages"]>
  ): ReturnType<WorkspaceConversationOperations["requireGroupDirectMessagesForMessages"]> {
    return this.conversations.requireGroupDirectMessagesForMessages(...args);
  }

  requireGroupDirectMessagesForAttachments(
    ...args: Parameters<WorkspaceConversationOperations["requireGroupDirectMessagesForAttachments"]>
  ): ReturnType<WorkspaceConversationOperations["requireGroupDirectMessagesForAttachments"]> {
    return this.conversations.requireGroupDirectMessagesForAttachments(...args);
  }

  canViewConversation(
    ...args: Parameters<WorkspaceConversationOperations["canViewConversation"]>
  ): ReturnType<WorkspaceConversationOperations["canViewConversation"]> {
    return this.conversations.canViewConversation(...args);
  }

  communicationPaths(
    ...args: Parameters<WorkspaceConversationOperations["communicationPaths"]>
  ): ReturnType<WorkspaceConversationOperations["communicationPaths"]> {
    return this.conversations.communicationPaths(...args);
  }

  listConversations(
    ...args: Parameters<WorkspaceConversationOperations["listConversations"]>
  ): ReturnType<WorkspaceConversationOperations["listConversations"]> {
    return this.conversations.listConversations(...args);
  }

  listPublicChannels(
    ...args: Parameters<WorkspaceConversationOperations["listPublicChannels"]>
  ): ReturnType<WorkspaceConversationOperations["listPublicChannels"]> {
    return this.conversations.listPublicChannels(...args);
  }

  joinPublicChannel(
    ...args: Parameters<WorkspaceConversationOperations["joinPublicChannel"]>
  ): ReturnType<WorkspaceConversationOperations["joinPublicChannel"]> {
    return this.conversations.joinPublicChannel(...args);
  }

  createChannel(
    ...args: Parameters<WorkspaceConversationOperations["createChannel"]>
  ): ReturnType<WorkspaceConversationOperations["createChannel"]> {
    return this.conversations.createChannel(...args);
  }

  listChannelMembers(
    ...args: Parameters<WorkspaceConversationOperations["listChannelMembers"]>
  ): ReturnType<WorkspaceConversationOperations["listChannelMembers"]> {
    return this.conversations.listChannelMembers(...args);
  }

  upsertChannelMember(
    ...args: Parameters<WorkspaceConversationOperations["upsertChannelMember"]>
  ): ReturnType<WorkspaceConversationOperations["upsertChannelMember"]> {
    return this.conversations.upsertChannelMember(...args);
  }

  removeChannelMember(
    ...args: Parameters<WorkspaceConversationOperations["removeChannelMember"]>
  ): ReturnType<WorkspaceConversationOperations["removeChannelMember"]> {
    return this.conversations.removeChannelMember(...args);
  }

  /**
   * Create each built-in channel a workspace is missing and post any release notes it has not
   * received yet.
   *
   * This is the "auditable service publisher" path: it is deliberately unreachable from any route,
   * so the human-owner bulletin gate in {@link sendMessage} stays the only way an API request can
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
    return runWorkspaceTransaction(this.pool, async (client) => {
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
        return found;
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
      auditAnnouncement(this.hooks, {
        operation: "channel.create",
        outcome: "accepted",
        actorUserId: SYSTEM_USER_ID,
        workspaceId,
        conversationId: row.id,
      });
      return row;
    });
  }

  /** Returns true when this call delivered the bulletin, false when it was already present. */
  async #publishSystemBulletin(
    conversation: ConversationRow,
    channelSlug: string,
    bulletin: SystemBulletin,
  ): Promise<boolean> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      // Same lock order as message delivery: the conversation row first, the workspace sequence
      // last. Taking the conversation lock also serializes two nodes seeding the same channel.
      const locked = await client.query<ConversationRow>(
        `SELECT * FROM conversations WHERE id = $1 FOR UPDATE`,
        [conversation.id],
      );
      const current = locked.rows[0];
      if (current === undefined) return false;

      const messageId = randomUUID();
      const claimed = await client.query(
        `INSERT INTO system_bulletins (workspace_id, channel_slug, bulletin_key, message_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, channel_slug, bulletin_key) DO NOTHING`,
        [current.workspace_id, channelSlug, bulletin.key, messageId],
      );
      if (claimed.rowCount === 0) return false;

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
      auditAnnouncement(this.hooks, {
        operation: "bulletin.publish",
        outcome: "accepted",
        actorUserId: SYSTEM_USER_ID,
        workspaceId: current.workspace_id,
        conversationId: current.id,
      });
      return true;
    });
  }

  archiveChannel(
    ...args: Parameters<WorkspaceConversationOperations["archiveChannel"]>
  ): ReturnType<WorkspaceConversationOperations["archiveChannel"]> {
    return this.conversations.archiveChannel(...args);
  }

  createDirectConversation(
    ...args: Parameters<WorkspaceConversationOperations["createDirectConversation"]>
  ): ReturnType<WorkspaceConversationOperations["createDirectConversation"]> {
    return this.conversations.createDirectConversation(...args);
  }

  createGroupDirectConversation(
    ...args: Parameters<WorkspaceConversationOperations["createGroupDirectConversation"]>
  ): ReturnType<WorkspaceConversationOperations["createGroupDirectConversation"]> {
    return this.conversations.createGroupDirectConversation(...args);
  }

  findDirectConversation(
    ...args: Parameters<WorkspaceConversationOperations["findDirectConversation"]>
  ): ReturnType<WorkspaceConversationOperations["findDirectConversation"]> {
    return this.conversations.findDirectConversation(...args);
  }

  history(
    ...args: Parameters<WorkspaceMessageOperations["history"]>
  ): ReturnType<WorkspaceMessageOperations["history"]> {
    return this.messages.history(...args);
  }

  contextHistory(
    ...args: Parameters<WorkspaceMessageOperations["contextHistory"]>
  ): ReturnType<WorkspaceMessageOperations["contextHistory"]> {
    return this.messages.contextHistory(...args);
  }

  thread(
    ...args: Parameters<WorkspaceMessageOperations["thread"]>
  ): ReturnType<WorkspaceMessageOperations["thread"]> {
    return this.messages.thread(...args);
  }

  messageById(
    ...args: Parameters<WorkspaceMessageOperations["messageById"]>
  ): ReturnType<WorkspaceMessageOperations["messageById"]> {
    return this.messages.messageById(...args);
  }

  createFileUpload(
    ...args: Parameters<WorkspaceAttachmentOperations["createFileUpload"]>
  ): ReturnType<WorkspaceAttachmentOperations["createFileUpload"]> {
    return this.attachments.createFileUpload(...args);
  }

  putFileContent(
    ...args: Parameters<WorkspaceAttachmentOperations["putFileContent"]>
  ): ReturnType<WorkspaceAttachmentOperations["putFileContent"]> {
    return this.attachments.putFileContent(...args);
  }

  completeFileUpload(
    ...args: Parameters<WorkspaceAttachmentOperations["completeFileUpload"]>
  ): ReturnType<WorkspaceAttachmentOperations["completeFileUpload"]> {
    return this.attachments.completeFileUpload(...args);
  }

  listConversationFiles(
    ...args: Parameters<WorkspaceAttachmentOperations["listConversationFiles"]>
  ): ReturnType<WorkspaceAttachmentOperations["listConversationFiles"]> {
    return this.attachments.listConversationFiles(...args);
  }

  listMessageAttachments(
    ...args: Parameters<WorkspaceAttachmentOperations["listMessageAttachments"]>
  ): ReturnType<WorkspaceAttachmentOperations["listMessageAttachments"]> {
    return this.attachments.listMessageAttachments(...args);
  }

  readFileContent(
    ...args: Parameters<WorkspaceAttachmentOperations["readFileContent"]>
  ): ReturnType<WorkspaceAttachmentOperations["readFileContent"]> {
    return this.attachments.readFileContent(...args);
  }

  listMessageReactions(
    ...args: Parameters<WorkspaceMessageOperations["listMessageReactions"]>
  ): ReturnType<WorkspaceMessageOperations["listMessageReactions"]> {
    return this.messages.listMessageReactions(...args);
  }

  addReaction(
    ...args: Parameters<WorkspaceMessageOperations["addReaction"]>
  ): ReturnType<WorkspaceMessageOperations["addReaction"]> {
    return this.messages.addReaction(...args);
  }

  removeReaction(
    ...args: Parameters<WorkspaceMessageOperations["removeReaction"]>
  ): ReturnType<WorkspaceMessageOperations["removeReaction"]> {
    return this.messages.removeReaction(...args);
  }

  searchMessages(
    ...args: Parameters<WorkspaceMessageOperations["searchMessages"]>
  ): ReturnType<WorkspaceMessageOperations["searchMessages"]> {
    return this.messages.searchMessages(...args);
  }

  listConversationTasks(
    ...args: Parameters<WorkspaceTaskOperations["listConversationTasks"]>
  ): ReturnType<WorkspaceTaskOperations["listConversationTasks"]> {
    return this.tasks.listConversationTasks(...args);
  }

  listMyTasks(
    ...args: Parameters<WorkspaceTaskOperations["listMyTasks"]>
  ): ReturnType<WorkspaceTaskOperations["listMyTasks"]> {
    return this.tasks.listMyTasks(...args);
  }

  listChannelTasks(
    ...args: Parameters<WorkspaceTaskOperations["listChannelTasks"]>
  ): ReturnType<WorkspaceTaskOperations["listChannelTasks"]> {
    return this.tasks.listChannelTasks(...args);
  }

  getTask(
    ...args: Parameters<WorkspaceTaskOperations["getTask"]>
  ): ReturnType<WorkspaceTaskOperations["getTask"]> {
    return this.tasks.getTask(...args);
  }

  getChannelTaskByNumber(
    ...args: Parameters<WorkspaceTaskOperations["getChannelTaskByNumber"]>
  ): ReturnType<WorkspaceTaskOperations["getChannelTaskByNumber"]> {
    return this.tasks.getChannelTaskByNumber(...args);
  }

  createTask(
    ...args: Parameters<WorkspaceTaskOperations["createTask"]>
  ): ReturnType<WorkspaceTaskOperations["createTask"]> {
    return this.tasks.createTask(...args);
  }

  createChannelTask(
    ...args: Parameters<WorkspaceTaskOperations["createChannelTask"]>
  ): ReturnType<WorkspaceTaskOperations["createChannelTask"]> {
    return this.tasks.createChannelTask(...args);
  }

  updateTask(
    ...args: Parameters<WorkspaceTaskOperations["updateTask"]>
  ): ReturnType<WorkspaceTaskOperations["updateTask"]> {
    return this.tasks.updateTask(...args);
  }

  moveTask(
    ...args: Parameters<WorkspaceTaskOperations["moveTask"]>
  ): ReturnType<WorkspaceTaskOperations["moveTask"]> {
    return this.tasks.moveTask(...args);
  }

  sendMessage(
    ...args: Parameters<WorkspaceMessageOperations["sendMessage"]>
  ): ReturnType<WorkspaceMessageOperations["sendMessage"]> {
    return this.messages.sendMessage(...args);
  }

  retractMessage(
    ...args: Parameters<WorkspaceMessageOperations["retractMessage"]>
  ): ReturnType<WorkspaceMessageOperations["retractMessage"]> {
    return this.messages.retractMessage(...args);
  }

  advanceReadCursor(
    ...args: Parameters<WorkspaceMessageOperations["advanceReadCursor"]>
  ): ReturnType<WorkspaceMessageOperations["advanceReadCursor"]> {
    return this.messages.advanceReadCursor(...args);
  }

  sync(
    ...args: Parameters<WorkspaceSyncOperations["sync"]>
  ): ReturnType<WorkspaceSyncOperations["sync"]> {
    return this.syncOperations.sync(...args);
  }

  syncPrincipal(
    ...args: Parameters<WorkspaceSyncOperations["syncPrincipal"]>
  ): ReturnType<WorkspaceSyncOperations["syncPrincipal"]> {
    return this.syncOperations.syncPrincipal(...args);
  }

  issueRealtimeTicket(
    ...args: Parameters<WorkspaceSyncOperations["issueRealtimeTicket"]>
  ): ReturnType<WorkspaceSyncOperations["issueRealtimeTicket"]> {
    return this.syncOperations.issueRealtimeTicket(...args);
  }

  consumeRealtimeTicket(
    ...args: Parameters<WorkspaceSyncOperations["consumeRealtimeTicket"]>
  ): ReturnType<WorkspaceSyncOperations["consumeRealtimeTicket"]> {
    return this.syncOperations.consumeRealtimeTicket(...args);
  }

  revalidateRealtimePrincipal(
    ...args: Parameters<WorkspaceSyncOperations["revalidateRealtimePrincipal"]>
  ): ReturnType<WorkspaceSyncOperations["revalidateRealtimePrincipal"]> {
    return this.syncOperations.revalidateRealtimePrincipal(...args);
  }

  async deleteExpiredState(): Promise<readonly AttachmentCleanupFailure[]> {
    await this.pool.query(
      `DELETE FROM sync_events
        WHERE created_at < clock_timestamp() - make_interval(days => $1)`,
      [SYNC_RETENTION_DAYS],
    );
    await this.pool.query(
      `DELETE FROM realtime_tickets
        WHERE expires_at < clock_timestamp() - interval '1 hour'`,
    );
    return [
      ...(await this.#deleteExpiredAttachments("pending")),
      ...(await this.#deleteExpiredAttachments("unclaimed-ready")),
    ];
  }

  async #deleteExpiredAttachments(
    kind: "pending" | "unclaimed-ready",
  ): Promise<AttachmentCleanupFailure[]> {
    const store = this.hooks.attachmentStore;
    if (store === undefined) return [];

    const failures: AttachmentCleanupFailure[] = [];

    while (true) {
      const batch = await runWorkspaceTransaction(this.pool, async (client) => {
        const expired =
          kind === "pending"
            ? await client.query<ExpiredAttachmentRow>(
                `SELECT id, workspace_id
                   FROM attachments
                  WHERE status = 'pending'
                    AND upload_expires_at <= clock_timestamp()
                  ORDER BY upload_expires_at, id
                  LIMIT $1
                  FOR UPDATE SKIP LOCKED`,
                [ATTACHMENT_CLEANUP_BATCH_SIZE],
              )
            : await client.query<ExpiredAttachmentRow>(
                `SELECT id, workspace_id
                   FROM attachments
                  WHERE status = 'ready'
                    AND message_id IS NULL
                    AND content_received_at <= clock_timestamp() - make_interval(secs => $1)
                  ORDER BY content_received_at, id
                  LIMIT $2
                  FOR UPDATE SKIP LOCKED`,
                [UNCLAIMED_READY_ATTACHMENT_RETENTION_MS / 1_000, ATTACHMENT_CLEANUP_BATCH_SIZE],
              );
        if (expired.rows.length === 0) {
          return { deleted: 0, selected: 0, failures: [] satisfies AttachmentCleanupFailure[] };
        }

        const deleted: string[] = [];
        const batchFailures: AttachmentCleanupFailure[] = [];
        for (const attachment of expired.rows) {
          try {
            // Keep the row until byte removal succeeds, so a later pass can retry safely.
            await store.remove(attachment.workspace_id, attachment.id);
            deleted.push(attachment.id);
          } catch (error) {
            batchFailures.push({
              attachmentId: attachment.id,
              workspaceId: attachment.workspace_id,
              error,
            });
          }
        }
        if (deleted.length > 0) {
          await client.query("DELETE FROM attachments WHERE id = ANY($1::uuid[])", [deleted]);
        }
        return { deleted: deleted.length, selected: expired.rows.length, failures: batchFailures };
      });
      failures.push(...batch.failures);
      if (batch.selected < ATTACHMENT_CLEANUP_BATCH_SIZE || batch.deleted === 0) {
        return failures;
      }
    }
  }
}
