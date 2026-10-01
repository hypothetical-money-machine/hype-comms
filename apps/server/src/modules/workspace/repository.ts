import type { Pool } from "pg";
import { WorkspaceAttachmentOperations } from "./attachment-operations.js";
import { WorkspaceAuthorization } from "./authorization.js";
import { ConversationEventWriter } from "./conversation-events.js";
import { WorkspaceConversationOperations } from "./conversation-operations.js";
import { WorkspaceMessageOperations } from "./message-operations.js";
import { WorkspaceSyncOperations } from "./sync-operations.js";
import { SystemChannelSeeder } from "./system-channel-seeder.js";
import { WorkspaceTaskOperations } from "./task-operations.js";
import { type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import { enableDefaultAgentAgency } from "./workspace-initialization.js";
import { WorkspaceRetention } from "./workspace-retention.js";
export type { ConsumedRealtimeTicket } from "./authorization.js";
export type { WorkspacePrincipal } from "./sync-operations.js";
export type { AnnouncementAuditRecord, WorkspaceRepositoryHooks } from "./workspace-hooks.js";
export type { AttachmentCleanupFailure } from "./workspace-retention.js";

export class WorkspaceRepository {
  private readonly retention: WorkspaceRetention;
  private readonly systemChannelSeeder: SystemChannelSeeder;
  private readonly syncOperations: WorkspaceSyncOperations;
  private readonly attachments: WorkspaceAttachmentOperations;
  private readonly conversations: WorkspaceConversationOperations;
  private readonly messages: WorkspaceMessageOperations;
  private readonly tasks: WorkspaceTaskOperations;
  private readonly events: ConversationEventWriter;
  private readonly authz: WorkspaceAuthorization;

  constructor(
    private readonly pool: Pool,
    private readonly hooks: WorkspaceRepositoryHooks = {},
  ) {
    this.events = new ConversationEventWriter(this.announcementChannelsEnabled);
    this.tasks = new WorkspaceTaskOperations(pool, this.events);
    this.messages = new WorkspaceMessageOperations(pool, this.events, hooks);
    this.authz = new WorkspaceAuthorization(pool);
    this.syncOperations = new WorkspaceSyncOperations(pool, hooks, this.authz);
    this.conversations = new WorkspaceConversationOperations(pool, this.events, hooks, this.authz);
    this.attachments = new WorkspaceAttachmentOperations(pool, hooks);
    this.retention = new WorkspaceRetention(pool, hooks);
    this.systemChannelSeeder = new SystemChannelSeeder(pool, hooks);
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

  enableDefaultAgentAgency(): Promise<void> {
    return enableDefaultAgentAgency(this.pool);
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

  /** Uses current workspace membership and canonical visibility for ephemeral delivery. */
  canViewConversation(
    ...args: Parameters<WorkspaceAuthorization["canViewConversation"]>
  ): ReturnType<WorkspaceAuthorization["canViewConversation"]> {
    return this.authz.canViewConversation(...args);
  }

  /**
   * Owner-only administration: every undirected communication link between two distinct active
   * human or agent members, aggregated from committed messages and memberships. Message bodies
   * are never read; only counts and timestamps leave the database. Owner authorization happens
   * at the route, where the authenticated principal's role is already resolved per request.
   *
   * Deliberate scope decisions:
   * - Bots are excluded. They are integrations rather than members: their channel access comes
   *   from `bot_channel_grants` rather than membership semantics, so treating them as pair
   *   endpoints would fabricate links no human recognizes.
   * - Deactivated members are excluded from both endpoints of every path, so revoked members'
   *   DM history does not resurface in the owner's report.
   * - Pairs that share channels but have exchanged no messages are still reported (as potential
   *   paths), but sort strictly below pairs with actual message volume.
   *
   * Both reads run in one repeatable-read snapshot so `members` and `paths` can never disagree,
   * and the result is bounded by the contract's path cap -- with endpoints restricted to active
   * human/agent members the pair count is at most C(25,2), which equals the cap exactly.
   */
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

  seedSystemChannels(
    ...args: Parameters<SystemChannelSeeder["seedSystemChannels"]>
  ): ReturnType<SystemChannelSeeder["seedSystemChannels"]> {
    return this.systemChannelSeeder.seedSystemChannels(...args);
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

  deleteExpiredState(
    ...args: Parameters<WorkspaceRetention["deleteExpiredState"]>
  ): ReturnType<WorkspaceRetention["deleteExpiredState"]> {
    return this.retention.deleteExpiredState(...args);
  }
}
