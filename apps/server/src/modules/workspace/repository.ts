import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WorkspaceAttachmentOperations } from "./attachment-operations.js";
import { type ExpiredAttachmentRow } from "./attachment-records.js";
import { conversationAudience, conversationVisibilitySql } from "./conversation-access.js";
import { ConversationEventWriter } from "./conversation-events.js";
import { WorkspaceConversationOperations } from "./conversation-operations.js";
import { readConversationPage } from "./conversation-page-reader.js";
import { WorkspaceMessageOperations } from "./message-operations.js";
import { mapStoredConversation } from "./records.js";
import { WorkspaceTaskOperations } from "./task-operations.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { auditAnnouncement, type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import { readWorkspaceMembers } from "./workspace-member-reader.js";
import { readWorkspaceSequence } from "./workspace-sequence.js";
export type { AnnouncementAuditRecord, WorkspaceRepositoryHooks } from "./workspace-hooks.js";

import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  realtimeTicketResponseSchema,
  syncResponseSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  type Conversation,
  type SyncResponse,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hype-comms/contracts";
import type { Pool, QueryResultRow } from "pg";

import { ApiError } from "../../errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { hashToken } from "../identity/tokens.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
import { SYSTEM_USER_ID, type BuiltInChannelDefinition } from "../system-channels/registry.js";
import type { SystemBulletin } from "../system-channels/release-notes.js";
import {
  insertSyncEvent,
  insertSyncEventWithSequence,
  nextWorkspaceSequence,
} from "./sync-events.js";

const REALTIME_TICKET_TTL_MS = 30_000;
const SYNC_RETENTION_DAYS = 90;
const ATTACHMENT_CLEANUP_BATCH_SIZE = 100;
const UNCLAIMED_READY_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

import { iso, mapMessage, type ConversationRow, type MessageRow } from "./records.js";

interface WorkspaceRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_event_sequence: string;
  announcement_channels_available: boolean;
  humans_only_channels_available: boolean;
}

interface EventRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  workspace_sequence: string;
  conversation_id: string | null;
  conversation_sequence: string | null;
  event_type: WorkspaceEvent["type"];
  entity_version: number;
  payload: unknown;
  occurred_at: Date | string;
  visible: boolean;
  participated_thread_notification: boolean;
  conversation_human_only: boolean;
}

interface TicketRow extends QueryResultRow {
  workspace_id: string;
  user_id: string;
  device_session_id: string | null;
  agent_token_id: string | null;
  reaction_events: boolean;
  read_state_events: boolean;
  task_events: boolean;
  announcement_channels: boolean;
  participated_thread_notifications: boolean;
  message_retract_events: boolean;
  member_profiles: boolean;
  ephemeral_activity: boolean;
  group_direct_messages: boolean;
  humans_only_channels: boolean;
  system_channels: boolean;
}

interface RealtimeSessionRow extends QueryResultRow {
  revoked: boolean;
  expired: boolean;
  membership_inactive: boolean;
}

interface RealtimeAgentRow extends QueryResultRow {
  revoked: boolean;
  disabled: boolean;
  membership_inactive: boolean;
}

export interface AttachmentCleanupFailure {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly error: unknown;
}

export type ConsumedRealtimeTicket = RealtimePrincipal;

export interface WorkspacePrincipal {
  readonly workspaceId: string;
  readonly userId: string;
  readonly reactionEvents?: boolean;
  readonly readStateEvents?: boolean;
  readonly taskEvents?: boolean;
  readonly announcementChannels?: boolean;
  readonly participatedThreadNotifications?: boolean;
  readonly messageRetractEvents?: boolean;
  readonly memberProfiles?: boolean;
  readonly ephemeralActivity?: boolean;
  readonly groupDirectMessages?: boolean;
  readonly humansOnlyChannels?: boolean;
  readonly systemChannels?: boolean;
}

export type WorkspaceClientCapabilities = Omit<WorkspacePrincipal, "workspaceId" | "userId">;

function mapWorkspace(row: WorkspaceRow) {
  return workspaceSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export class WorkspaceRepository {
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

  async bootstrap(
    identity: AuthenticatedIdentity,
    includeGroupDirectMessages = true,
    includeSystemChannels = false,
  ): Promise<WorkspaceBootstrapResponse> {
    if (this.announcementChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET announcement_channels_available = true
          WHERE id = $1
            AND announcement_channels_available = false`,
        [identity.currentUser.workspaceId],
      );
    }
    if (this.humansOnlyChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET humans_only_channels_available = true
          WHERE id = $1
            AND humans_only_channels_available = false`,
        [identity.currentUser.workspaceId],
      );
    }
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const workspaceResult = await client.query<WorkspaceRow>(
          `SELECT id, name, slug, created_by, created_at, updated_at, last_event_sequence,
                  announcement_channels_available, humans_only_channels_available
           FROM workspaces
          WHERE id = $1`,
          [identity.currentUser.workspaceId],
        );
        const workspace = workspaceResult.rows[0];
        if (workspace === undefined) throw new ApiError(403, "FORBIDDEN", "Workspace unavailable");
        await this.hooks.afterBootstrapCursorRead?.();
        const members = await readWorkspaceMembers(client, workspace.id);
        // Bootstrap only ever carries the first page; the client pages the rest through
        // GET /v1/conversations, so a workspace can grow past the response cap without bricking.
        const page = await readConversationPage(
          client,
          identity,
          null,
          CONVERSATION_PAGE_DEFAULT_LIMIT,
          includeGroupDirectMessages,
          includeSystemChannels,
        );
        return workspaceBootstrapResponseSchema.parse({
          currentUser: identity.currentUser,
          workspace: mapWorkspace(workspace),
          members,
          conversations: page.conversations,
          conversationsNextCursor: page.nextCursor,
          conversationsHasMore: page.hasMore,
          syncCursor: workspace.last_event_sequence,
          featureFlags: {
            channels: true,
            directMessages: true,
            mentions: true,
            announcementChannels: workspace.announcement_channels_available,
            humansOnlyChannels: workspace.humans_only_channels_available,
          },
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
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

  async sync(
    identity: AuthenticatedIdentity,
    after: string,
    limit: number,
    capabilities: WorkspaceClientCapabilities = {},
  ): Promise<SyncResponse> {
    return this.syncPrincipal(
      {
        ...capabilities,
        workspaceId: identity.currentUser.workspaceId,
        userId: identity.currentUser.user.id,
      },
      after,
      limit,
    );
  }

  async syncPrincipal(
    principal: WorkspacePrincipal,
    after: string,
    limit: number,
  ): Promise<SyncResponse> {
    const client = await this.pool.connect();
    try {
      const highWaterCursor = await readWorkspaceSequence(client, principal.workspaceId);
      const afterSequence = BigInt(after);
      const highWaterSequence = BigInt(highWaterCursor);
      if (afterSequence > highWaterSequence) {
        throw new ApiError(410, "CURSOR_EXPIRED", "The sync cursor is no longer valid");
      }
      const earliest = await client.query<{ sequence: string | null } & QueryResultRow>(
        `SELECT min(workspace_sequence)::text AS sequence
           FROM sync_events
          WHERE workspace_id = $1`,
        [principal.workspaceId],
      );
      const earliestSequence = earliest.rows[0]?.sequence ?? null;
      const retainedCursorFloor =
        earliestSequence === null ? highWaterSequence : BigInt(earliestSequence) - 1n;
      if (afterSequence !== 0n && afterSequence < retainedCursorFloor) {
        throw new ApiError(410, "CURSOR_EXPIRED", "The sync cursor has expired");
      }
      const rows = await client.query<EventRow>(
        `SELECT event.*,
                coalesce(
                  (
                    SELECT conversation.human_only
                      FROM conversations AS conversation
                     WHERE conversation.id = event.conversation_id
                  ),
                  false
                ) AS conversation_human_only,
                (
                  $7::boolean
                  AND EXISTS (
                    SELECT 1
                      FROM sync_event_notification_reasons AS notification_reason
                     WHERE notification_reason.event_id = event.id
                       AND notification_reason.user_id = $2
                       AND notification_reason.reason = 'participated_thread_reply'
                  )
                ) AS participated_thread_notification,
                (
                  EXISTS (
                    SELECT 1
                      FROM sync_event_audiences AS audience
                     WHERE audience.event_id = event.id
                       AND audience.user_id = $2
                  )
                  AND (
                    event.conversation_id IS NULL
                    OR EXISTS (
                      SELECT 1
                        FROM conversations AS conversation
                       WHERE conversation.id = event.conversation_id
                         AND conversation.workspace_id = event.workspace_id
                         AND ${conversationVisibilitySql("conversation", "$2")}
                    )
                    OR (
                      event.event_type = 'channel.membership_changed'
                      AND event.payload ->> 'action' = 'removed'
                      AND event.payload ->> 'memberId' = $2::text
                      AND NOT EXISTS (
                        SELECT 1
                          FROM conversations AS removed_membership_conversation
                         WHERE removed_membership_conversation.id = event.conversation_id
                           AND removed_membership_conversation.human_only
                      )
                    )
                  )
                  AND (
                    $5::boolean
                    OR event.event_type NOT IN ('reaction.added', 'reaction.removed')
                  )
                  AND (
                    $6::boolean
                    OR event.event_type NOT IN ('task.created', 'task.updated')
                  )
                  AND (
                    $8::boolean
                    OR event.event_type <> 'message.retracted'
                  )
                  AND (
                    event.event_type <> 'message.created'
                    OR EXISTS (
                      SELECT 1
                        FROM messages AS created_message
                       WHERE created_message.id::text = event.payload #>> '{message,id}'
                         AND created_message.workspace_id = event.workspace_id
                         AND created_message.deleted_at IS NULL
                    )
                  )
                  AND (
                    event.event_type NOT IN ('reaction.added', 'reaction.removed')
                    OR EXISTS (
                      SELECT 1
                        FROM messages AS reaction_message
                       WHERE reaction_message.id::text = event.payload #>> '{reaction,messageId}'
                         AND reaction_message.workspace_id = event.workspace_id
                         AND reaction_message.deleted_at IS NULL
                    )
                  )
                  AND (
                    $9::boolean
                    OR event.conversation_id IS NULL
                    OR NOT EXISTS (
                      SELECT 1
                        FROM conversations AS group_conversation
                       WHERE group_conversation.id = event.conversation_id
                          AND group_conversation.workspace_id = event.workspace_id
                          AND group_conversation.kind = 'group_direct_message'
                    )
                  )
                  AND (
                    $10::boolean
                    OR event.conversation_id IS NULL
                    OR NOT EXISTS (
                      SELECT 1
                        FROM conversations AS system_conversation
                       WHERE system_conversation.id = event.conversation_id
                          AND system_conversation.workspace_id = event.workspace_id
                          AND system_conversation.is_system
                    )
                  )
                ) AS visible
           FROM sync_events AS event
          WHERE event.workspace_id = $1
            AND event.workspace_sequence > $3::bigint
          ORDER BY event.workspace_sequence
          LIMIT $4`,
        [
          principal.workspaceId,
          principal.userId,
          after,
          limit + 1,
          principal.reactionEvents ?? false,
          principal.taskEvents ?? false,
          principal.participatedThreadNotifications ?? false,
          principal.messageRetractEvents ?? false,
          principal.groupDirectMessages ?? false,
          principal.systemChannels ?? false,
        ],
      );
      const scanned = rows.rows.slice(0, limit);
      const nextCursor = scanned.at(-1)?.workspace_sequence ?? after;
      const response = syncResponseSchema.parse({
        events: scanned
          .filter((row) => row.visible)
          .map((row) =>
            this.#mapEvent(
              row,
              principal.readStateEvents ?? false,
              principal.participatedThreadNotifications ?? false,
              principal.memberProfiles ?? false,
              principal.humansOnlyChannels ?? false,
            ),
          ),
        nextCursor,
        highWaterCursor,
        hasMore: rows.rows.length > limit,
      });
      let events = response.events;
      if (!(principal.announcementChannels ?? false)) {
        events = events.map((event) => this.#legacyAnnouncementEvent(event));
      }
      return events === response.events ? response : ({ ...response, events } as SyncResponse);
    } finally {
      client.release();
    }
  }

  async issueRealtimeTicket(
    identity: AuthenticatedIdentity,
    capabilities: WorkspaceClientCapabilities = {},
  ) {
    const {
      reactionEvents = false,
      readStateEvents = false,
      taskEvents = false,
      announcementChannels = false,
      participatedThreadNotifications = false,
      messageRetractEvents = false,
      memberProfiles = false,
      ephemeralActivity = false,
      groupDirectMessages = false,
      humansOnlyChannels = false,
      systemChannels = false,
    } = capabilities;
    const deviceSessionId = identity.sessionId ?? null;
    const agentTokenId = identity.agentTokenId ?? null;
    if ((deviceSessionId === null) === (agentTokenId === null)) {
      throw new Error("Realtime tickets require exactly one authenticated credential");
    }
    const token = randomBytes(32).toString("base64url");
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_MS);
    await this.pool.query(
      `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, agent_token_id, token_hash, expires_at,
          reaction_events, read_state_events, task_events, announcement_channels,
          participated_thread_notifications, message_retract_events, member_profiles,
          ephemeral_activity, group_direct_messages, humans_only_channels, system_channels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        randomUUID(),
        identity.currentUser.workspaceId,
        identity.currentUser.user.id,
        deviceSessionId,
        agentTokenId,
        hash,
        expiresAt,
        reactionEvents,
        readStateEvents,
        taskEvents,
        announcementChannels,
        participatedThreadNotifications,
        messageRetractEvents,
        memberProfiles,
        ephemeralActivity,
        groupDirectMessages,
        humansOnlyChannels,
        systemChannels,
      ],
    );
    return realtimeTicketResponseSchema.parse({
      ticket: token,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async consumeRealtimeTicket(token: string): Promise<ConsumedRealtimeTicket | null> {
    const hash = hashToken(token);
    const result = await this.pool.query<TicketRow>(
      `WITH consumed_ticket AS (
         UPDATE realtime_tickets AS ticket
            SET consumed_at = clock_timestamp()
          WHERE ticket.token_hash = $1
            AND ticket.consumed_at IS NULL
            AND ticket.expires_at > clock_timestamp()
         RETURNING ticket.workspace_id,
                   ticket.user_id,
                   ticket.device_session_id,
                   ticket.agent_token_id,
                   ticket.reaction_events,
                   ticket.read_state_events,
                   ticket.task_events,
                   ticket.announcement_channels,
                   ticket.participated_thread_notifications,
                   ticket.message_retract_events,
                   ticket.member_profiles,
                   ticket.ephemeral_activity,
                   ticket.group_direct_messages,
                   ticket.humans_only_channels,
                   ticket.system_channels
       )
       SELECT ticket.workspace_id,
              ticket.user_id,
              ticket.device_session_id,
              ticket.agent_token_id,
              ticket.reaction_events,
              ticket.read_state_events,
              ticket.task_events,
              ticket.announcement_channels,
              ticket.participated_thread_notifications,
              ticket.message_retract_events,
              ticket.member_profiles,
              ticket.ephemeral_activity,
              ticket.group_direct_messages,
              ticket.humans_only_channels,
              ticket.system_channels
         FROM consumed_ticket AS ticket
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = ticket.workspace_id
          AND membership.user_id = ticket.user_id
          AND membership.status = 'active'
        WHERE (
            (
              ticket.device_session_id IS NOT NULL
              AND ticket.agent_token_id IS NULL
              AND EXISTS (
                SELECT 1
                  FROM device_sessions AS session
                 WHERE session.id = ticket.device_session_id
                   AND session.user_id = ticket.user_id
                   AND session.revoked_at IS NULL
                   AND session.expires_at > clock_timestamp()
              )
            )
            OR
            (
              ticket.device_session_id IS NULL
              AND ticket.agent_token_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM agent_tokens AS agent_token
                  JOIN agents AS agent
                    ON agent.user_id = agent_token.agent_user_id
                   AND agent.workspace_id = agent_token.workspace_id
                 WHERE agent_token.id = ticket.agent_token_id
                   AND agent_token.workspace_id = ticket.workspace_id
                   AND agent_token.agent_user_id = ticket.user_id
                   AND agent_token.revoked_at IS NULL
                   AND agent.disabled_at IS NULL
              )
            )
          )`,
      [hash],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.device_session_id !== null && row.agent_token_id === null) {
      return {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        deviceSessionId: row.device_session_id,
        agentTokenId: null,
        reactionEvents: row.reaction_events,
        readStateEvents: row.read_state_events,
        taskEvents: row.task_events,
        announcementChannels: row.announcement_channels,
        participatedThreadNotifications: row.participated_thread_notifications,
        messageRetractEvents: row.message_retract_events,
        memberProfiles: row.member_profiles,
        ephemeralActivity: row.ephemeral_activity,
        groupDirectMessages: row.group_direct_messages,
        humansOnlyChannels: row.humans_only_channels,
        systemChannels: row.system_channels,
      };
    }
    if (row.device_session_id === null && row.agent_token_id !== null) {
      return {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        deviceSessionId: null,
        agentTokenId: row.agent_token_id,
        reactionEvents: row.reaction_events,
        readStateEvents: row.read_state_events,
        taskEvents: row.task_events,
        announcementChannels: row.announcement_channels,
        participatedThreadNotifications: row.participated_thread_notifications,
        messageRetractEvents: row.message_retract_events,
        memberProfiles: row.member_profiles,
        ephemeralActivity: row.ephemeral_activity,
        groupDirectMessages: row.group_direct_messages,
        humansOnlyChannels: row.humans_only_channels,
        systemChannels: row.system_channels,
      };
    }
    throw new Error("Consumed realtime ticket has an invalid credential binding");
  }

  /**
   * Re-check a live realtime connection's bound credential and workspace membership.
   *
   * This is a read-only counterpart to {@link consumeRealtimeTicket}: it consumes nothing and
   * mutates nothing, so the realtime heartbeat can call it repeatedly. A socket authorized
   * minutes ago must not outlive a revoked/expired credential or a revoked membership.
   */
  async revalidateRealtimePrincipal(
    principal: RealtimePrincipal,
  ): Promise<RealtimePrincipalRevalidation> {
    if (principal.agentTokenId !== null) {
      const result = await this.pool.query<RealtimeAgentRow>(
        `SELECT token.revoked_at IS NOT NULL AS revoked,
                agent.disabled_at IS NOT NULL AS disabled,
                coalesce(membership.status, 'revoked') <> 'active' AS membership_inactive
           FROM agent_tokens AS token
           LEFT JOIN agents AS agent
             ON agent.user_id = token.agent_user_id
            AND agent.workspace_id = token.workspace_id
           LEFT JOIN workspace_memberships AS membership
             ON membership.user_id = token.agent_user_id
            AND membership.workspace_id = token.workspace_id
          WHERE token.id = $1
            AND token.workspace_id = $2
            AND token.agent_user_id = $3`,
        [principal.agentTokenId, principal.workspaceId, principal.userId],
      );
      const row = result.rows[0];
      if (row === undefined) return { status: "invalid", reason: "unknown_agent_token" };
      if (row.revoked) return { status: "invalid", reason: "agent_token_revoked" };
      if (row.disabled) return { status: "invalid", reason: "agent_disabled" };
      if (row.membership_inactive) {
        return { status: "invalid", reason: "membership_inactive" };
      }
      return { status: "valid" };
    }

    const result = await this.pool.query<RealtimeSessionRow>(
      `SELECT session.revoked_at IS NOT NULL AS revoked,
              session.expires_at <= clock_timestamp() AS expired,
              coalesce(membership.status, 'revoked') <> 'active' AS membership_inactive
         FROM device_sessions AS session
         LEFT JOIN workspace_memberships AS membership
           ON membership.user_id = session.user_id
          AND membership.workspace_id = $2
        WHERE session.id = $1
          AND session.user_id = $3`,
      [principal.deviceSessionId, principal.workspaceId, principal.userId],
    );
    const row = result.rows[0];
    if (row === undefined) return { status: "invalid", reason: "unknown_session" };
    if (row.revoked) return { status: "invalid", reason: "session_revoked" };
    if (row.expired) return { status: "invalid", reason: "session_expired" };
    if (row.membership_inactive) return { status: "invalid", reason: "membership_inactive" };
    return { status: "valid" };
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

  #mapEvent(
    row: EventRow,
    readStateEvents: boolean,
    participatedThreadNotifications: boolean,
    memberProfiles: boolean,
    humansOnlyChannels: boolean,
  ): WorkspaceEvent {
    let event = workspaceEventSchema.parse({
      version: 1,
      id: row.id,
      type: row.event_type,
      occurredAt: iso(row.occurred_at),
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      workspaceSequence: row.workspace_sequence,
      conversationSequence: row.conversation_sequence,
      entityVersion: row.entity_version,
      delivery: "at_least_once",
      payload: row.payload,
    });
    if (humansOnlyChannels && row.conversation_human_only) {
      event = this.#humansOnlyChannelEvent(event);
    } else if (!humansOnlyChannels) {
      // HTTP already converts access: "humans" → "members" for clients that did not negotiate
      // humans-only-channels-v1. Realtime and HTTP sync share this mapper; leave the stored
      // payload canonical while projecting the legacy enum so 0.1.35 clients do not drop the event.
      event = this.#legacyHumansOnlyChannelEvent(event);
    }
    if (event.type === "message.created") {
      // Never trust shared event JSON to carry a recipient-specific reason. Rebuild the payload
      // from canonical message fields and add the reason only from the scoped relation selected
      // for this principal and an explicitly negotiated capability.
      return workspaceEventSchema.parse({
        ...event,
        payload: {
          message: event.payload.message,
          mentionedUserIds: event.payload.mentionedUserIds,
          ...(participatedThreadNotifications && row.participated_thread_notification
            ? { recipientNotificationReason: "participated_thread_reply" }
            : {}),
        },
      });
    }
    if (event.type === "member.updated" && !memberProfiles) {
      return this.#legacyMemberProfileEvent(event);
    }
    if (event.type !== "read_cursor.updated" || readStateEvents) return event;
    // Older clients validate v1 event payloads strictly. Keep the stored event canonical while
    // projecting its legacy shape for devices that did not negotiate read-state events.
    return {
      ...event,
      payload: { readCursor: event.payload.readCursor },
    };
  }

  #legacyAnnouncementEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (
      event.type !== "channel.created" &&
      event.type !== "channel.archived" &&
      event.type !== "direct_conversation.created"
    ) {
      return event;
    }
    const conversation: Partial<Conversation> = { ...event.payload.conversation };
    delete conversation.channelMode;
    return {
      ...event,
      payload: { ...event.payload, conversation },
    } as unknown as WorkspaceEvent;
  }

  #humansOnlyChannelEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "channel.created" && event.type !== "channel.archived") return event;
    return workspaceEventSchema.parse({
      ...event,
      payload: {
        ...event.payload,
        conversation: { ...event.payload.conversation, access: "humans" },
      },
    });
  }

  #legacyHumansOnlyChannelEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "channel.created" && event.type !== "channel.archived") return event;
    if (event.payload.conversation.access !== "humans") return event;
    return workspaceEventSchema.parse({
      ...event,
      payload: {
        ...event.payload,
        conversation: { ...event.payload.conversation, access: "members" },
      },
    });
  }

  #legacyMemberProfileEvent(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type !== "member.updated") return event;
    const member: Partial<typeof event.payload.member> = { ...event.payload.member };
    delete member.title;
    return { ...event, payload: { member } } as unknown as WorkspaceEvent;
  }
}
