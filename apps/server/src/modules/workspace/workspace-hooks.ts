import { type AttachmentStore } from "./file-store.js";

export interface WorkspaceRepositoryHooks {
  /**
   * Test seam for deterministically interleaving a committed write after bootstrap establishes
   * its transaction snapshot.
   */
  readonly afterBootstrapCursorRead?: () => Promise<void>;
  /** Requests the one-way cluster cutover; persisted availability remains authoritative afterward. */
  readonly announcementChannelsEnabled?: boolean;
  /** Requests the one-way cluster cutover; persisted availability remains authoritative afterward. */
  readonly humansOnlyChannelsEnabled?: boolean;
  /** Requests the one-way cluster cutover; persisted availability remains authoritative afterward. */
  readonly systemChannelsEnabled?: boolean;
  /** Structured operational record; message bodies are deliberately never included. */
  readonly onAnnouncementAudit?: (record: AnnouncementAuditRecord) => void;
  /** Test seam for holding the message-delivery conversation lock. */
  readonly afterConversationLocked?: () => Promise<void>;
  /** Test seam for holding message delivery after its authorization locks and reads. */
  readonly afterMessageAuthorizationLocked?: () => Promise<void>;
  /** Test seam for holding the conversation lock before an archive commits. */
  readonly afterArchiveConversationLocked?: () => Promise<void>;
  /** Test seam for holding the conversation lock before a member removal commits. */
  readonly afterRemoveChannelMemberConversationLocked?: () => Promise<void>;
  /** Local or remote object bytes for staged attachments. */
  readonly attachmentStore?: AttachmentStore;
}

export interface AnnouncementAuditRecord {
  readonly operation: "channel.create" | "bulletin.publish";
  readonly outcome: "accepted" | "rejected";
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly conversationId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly reason?: string | undefined;
}

export function auditAnnouncement(
  hooks: Pick<WorkspaceRepositoryHooks, "onAnnouncementAudit">,
  record: AnnouncementAuditRecord,
): void {
  try {
    hooks.onAnnouncementAudit?.(record);
  } catch {
    // Audit delivery must not turn an otherwise valid or intentionally rejected request into a
    // different API outcome. The production hook is synchronous structured logging.
  }
}
