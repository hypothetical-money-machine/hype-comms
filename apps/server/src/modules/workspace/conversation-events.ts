import type { WorkspaceEvent } from "@hype-comms/contracts";
import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { ConversationRow } from "./records.js";
import { insertSyncEvent, insertSyncEventWithSequence } from "./sync-events.js";
import type { AuthenticatedTaskIdentity } from "./workspace-identity.js";

/** Conversation mutations publish through the caller's transaction client. */
export class ConversationEventWriter {
  constructor(private readonly announcementChannelsEnabled: boolean) {}
  async insert(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    input: {
      readonly type: WorkspaceEvent["type"];
      readonly conversation: ConversationRow;
      readonly conversationSequence?: string;
      readonly entityVersion?: number;
      readonly payload: WorkspaceEvent["payload"];
      readonly audienceUserIds?: readonly string[];
    },
  ): Promise<WorkspaceEvent> {
    return insertSyncEvent(client, {
      workspaceId: identity.currentUser.workspaceId,
      actorUserId: identity.currentUser.user.id,
      type: input.type,
      conversationId: input.conversation.id,
      conversationSequence: input.conversationSequence,
      entityVersion: input.entityVersion,
      payload: input.payload,
      audienceUserIds: input.audienceUserIds,
    });
  }

  async insertWithSequence(
    client: PoolClient,
    identity: AuthenticatedTaskIdentity,
    sequence: string,
    input: {
      readonly type: WorkspaceEvent["type"];
      readonly conversation: ConversationRow;
      readonly conversationSequence?: string;
      readonly entityVersion?: number;
      readonly payload: WorkspaceEvent["payload"];
      readonly audienceUserIds?: readonly string[];
    },
  ): Promise<WorkspaceEvent> {
    return insertSyncEventWithSequence(client, sequence, {
      workspaceId: identity.currentUser.workspaceId,
      actorUserId: identity.currentUser.user.id,
      type: input.type,
      conversationId: input.conversation.id,
      conversationSequence: input.conversationSequence,
      entityVersion: input.entityVersion,
      payload: input.payload,
      audienceUserIds: input.audienceUserIds,
    });
  }

  async announcementChannelsAvailable(client: PoolClient, workspaceId: string): Promise<boolean> {
    if (this.announcementChannelsEnabled) {
      await client.query(
        `UPDATE workspaces
            SET announcement_channels_available = true
          WHERE id = $1
            AND announcement_channels_available = false`,
        [workspaceId],
      );
    }
    const result = await client.query<
      { announcement_channels_available: boolean } & QueryResultRow
    >(
      `SELECT announcement_channels_available
         FROM workspaces
        WHERE id = $1
        FOR UPDATE`,
      [workspaceId],
    );
    const workspace = result.rows[0];
    if (workspace === undefined) throw new DomainError("access_denied", "Workspace unavailable");
    return workspace.announcement_channels_available;
  }
}
