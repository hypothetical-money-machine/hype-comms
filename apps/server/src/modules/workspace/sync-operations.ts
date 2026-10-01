import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  realtimeTicketResponseSchema,
  syncResponseSchema,
  workspaceBootstrapResponseSchema,
  workspaceEventSchema,
  workspaceSchema,
  type SyncResponse,
  type SyncPosition,
  type WorkspaceBootstrapResponse,
  type WorkspaceEvent,
} from "@hype-comms/contracts";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { hashToken } from "../identity/tokens.js";
import type { RealtimePrincipal, RealtimePrincipalRevalidation } from "../realtime/auth.js";
import {
  conversationVisibilitySql,
  WorkspaceAuthorization,
  type ConsumedRealtimeTicket,
} from "./authorization.js";
import { readConversationPage } from "./conversation-page-reader.js";
import { iso } from "./records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import { readWorkspaceMembers } from "./workspace-member-reader.js";
import { readWorkspaceProtocol } from "./protocol-epoch.js";
const REALTIME_TICKET_TTL_MS = 30000;
interface WorkspaceRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_event_sequence: string;
  protocol_epoch: string | null;
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

export type { ConsumedRealtimeTicket } from "./authorization.js";

export interface WorkspacePrincipal {
  readonly workspaceId: string;
  readonly userId: string;
}

// Preserve id::text equality: PostgreSQL prints UUIDs in canonical lowercase form. Guard the
// payload cast so malformed or noncanonical stored references stay invisible instead of failing
// the whole sync page, while allowing the message primary-key index to serve each lookup.
function canonicalUuidSql(expression: string): string {
  return `CASE
    WHEN ${expression} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (${expression})::uuid
  END`;
}

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

/** Owns bootstrap snapshots, replay reads and realtime ticket lifecycle. */
export class WorkspaceSyncOperations {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: Pick<
      WorkspaceRepositoryHooks,
      "announcementChannelsEnabled" | "humansOnlyChannelsEnabled" | "afterBootstrapCursorRead"
    > = {},
    private readonly authz: WorkspaceAuthorization = new WorkspaceAuthorization(pool),
  ) {}
  get announcementChannelsEnabled(): boolean {
    return this.hooks.announcementChannelsEnabled ?? false;
  }
  get humansOnlyChannelsEnabled(): boolean {
    return this.hooks.humansOnlyChannelsEnabled ?? false;
  }
  async bootstrap(identity: AuthenticatedIdentity): Promise<WorkspaceBootstrapResponse> {
    if (this.announcementChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET announcement_channels_available = true
          WHERE id = $1
            AND protocol_epoch IS NOT NULL
            AND announcement_channels_available = false`,
        [identity.currentUser.workspaceId],
      );
    }
    if (this.humansOnlyChannelsEnabled) {
      await this.pool.query(
        `UPDATE workspaces
            SET humans_only_channels_available = true
          WHERE id = $1
            AND protocol_epoch IS NOT NULL
            AND humans_only_channels_available = false`,
        [identity.currentUser.workspaceId],
      );
    }
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const workspaceResult = await client.query<WorkspaceRow>(
          `SELECT id, name, slug, created_by, created_at, updated_at, last_event_sequence, protocol_epoch,
                  announcement_channels_available, humans_only_channels_available
           FROM workspaces
          WHERE id = $1`,
          [identity.currentUser.workspaceId],
        );
        const workspace = workspaceResult.rows[0];
        if (workspace === undefined)
          throw new DomainError("access_denied", "Workspace unavailable");
        if (workspace.protocol_epoch === null)
          throw new DomainError("unavailable", "Workspace protocol cutover has not completed");
        await this.hooks.afterBootstrapCursorRead?.();
        const members = await readWorkspaceMembers(client, workspace.id);
        // Bootstrap only ever carries the first page; the client pages the rest through
        // GET /v2/conversations, so a workspace can grow past the response cap without bricking.
        const page = await readConversationPage(
          client,
          identity,
          null,
          CONVERSATION_PAGE_DEFAULT_LIMIT,
        );
        return workspaceBootstrapResponseSchema.parse({
          currentUser: identity.currentUser,
          workspace: mapWorkspace(workspace),
          members,
          conversations: page.conversations,
          conversationsNextCursor: page.nextCursor,
          conversationsHasMore: page.hasMore,
          syncCursor: { epoch: workspace.protocol_epoch, sequence: workspace.last_event_sequence },
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
  async sync(
    identity: AuthenticatedIdentity,
    after: SyncPosition,
    limit: number,
  ): Promise<SyncResponse> {
    return this.syncPrincipal(
      {
        workspaceId: identity.currentUser.workspaceId,
        userId: identity.currentUser.user.id,
      },
      after,
      limit,
    );
  }

  async syncPrincipal(
    principal: WorkspacePrincipal,
    after: SyncPosition,
    limit: number,
  ): Promise<SyncResponse> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const protocol = await readWorkspaceProtocol(client, principal.workspaceId);
        const highWaterCursor = { epoch: protocol.epoch, sequence: protocol.sequence };
        if (after.epoch !== protocol.epoch)
          throw new DomainError("sync_epoch_mismatch", "The workspace replay epoch changed");
        const afterSequence = BigInt(after.sequence);
        const highWaterSequence = BigInt(highWaterCursor.sequence);
        if (afterSequence > highWaterSequence || afterSequence < BigInt(protocol.replayFloor)) {
          throw new DomainError("sync_position_expired", "The sync cursor is no longer valid");
        }
        const earliest = await client.query<
          {
            sequence: string | null;
          } & QueryResultRow
        >(
          `SELECT min(workspace_sequence)::text AS sequence
           FROM sync_events
          WHERE workspace_id = $1`,
          [principal.workspaceId],
        );
        const earliestSequence = earliest.rows[0]?.sequence ?? null;
        const retainedCursorFloor =
          earliestSequence === null ? highWaterSequence : BigInt(earliestSequence) - 1n;
        if (afterSequence < retainedCursorFloor) {
          throw new DomainError("sync_position_expired", "The sync cursor has expired");
        }
        const rows = await client.query<EventRow>(
          `SELECT event.*,
                coalesce(
                  (
                    SELECT conversation.human_only
                      FROM conversations AS conversation
                     WHERE conversation.id = event.conversation_id
                       AND conversation.workspace_id = event.workspace_id
                  ),
                  false
                ) AS conversation_human_only,
                (
                  EXISTS (
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
                    event.event_type <> 'message.created'
                    OR EXISTS (
                      SELECT 1
                        FROM messages AS created_message
                       WHERE created_message.id = ${canonicalUuidSql("event.payload #>> '{message,id}'")}
                         AND created_message.workspace_id = event.workspace_id
                         AND created_message.deleted_at IS NULL
                    )
                  )
                  AND (
                    event.event_type NOT IN ('reaction.added', 'reaction.removed')
                    OR EXISTS (
                      SELECT 1
                        FROM messages AS reaction_message
                       WHERE reaction_message.id = ${canonicalUuidSql("event.payload #>> '{reaction,messageId}'")}
                         AND reaction_message.workspace_id = event.workspace_id
                         AND reaction_message.deleted_at IS NULL
                    )
                  )


                ) AS visible
           FROM sync_events AS event
          WHERE event.workspace_id = $1
            AND event.workspace_sequence > $3::bigint
            AND event.workspace_sequence <= $5::bigint
          ORDER BY event.workspace_sequence
          LIMIT $4`,
          [
            principal.workspaceId,
            principal.userId,
            after.sequence,
            limit + 1,
            highWaterCursor.sequence,
          ],
        );
        const scanned = rows.rows.slice(0, limit);
        const nextCursor = {
          epoch: protocol.epoch,
          sequence: scanned.at(-1)?.workspace_sequence ?? after.sequence,
        };
        const response = syncResponseSchema.parse({
          events: scanned
            .filter((row) => row.visible)
            .map((row) => this.#mapEvent(row, protocol.epoch)),
          nextCursor,
          highWaterCursor,
          hasMore: rows.rows.length > limit,
        });
        return response;
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }
  async issueRealtimeTicket(identity: AuthenticatedIdentity) {
    const deviceSessionId = identity.sessionId ?? null;
    const agentTokenId = identity.agentTokenId ?? null;
    if ((deviceSessionId === null) === (agentTokenId === null)) {
      throw new Error("Realtime tickets require exactly one authenticated credential");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_MS);
    return runWorkspaceTransaction(this.pool, async (client) => {
      const protocol = await readWorkspaceProtocol(client, identity.currentUser.workspaceId);
      await client.query(
        `INSERT INTO realtime_tickets
         (id, workspace_id, user_id, device_session_id, agent_token_id, token_hash, expires_at, protocol_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          identity.currentUser.workspaceId,
          identity.currentUser.user.id,
          deviceSessionId,
          agentTokenId,
          hashToken(token),
          expiresAt,
          protocol.epoch,
        ],
      );
      return realtimeTicketResponseSchema.parse({
        ticket: token,
        position: { epoch: protocol.epoch, sequence: protocol.sequence },
        expiresAt: expiresAt.toISOString(),
      });
    });
  }

  consumeRealtimeTicket(token: string): Promise<ConsumedRealtimeTicket | null> {
    return this.authz.consumeRealtimeTicket(token);
  }

  /** Re-check the connection's bound credential and current workspace membership. */
  revalidateRealtimePrincipal(
    principal: RealtimePrincipal,
  ): Promise<RealtimePrincipalRevalidation> {
    return this.authz.revalidateRealtimePrincipal(principal);
  }
  #mapEvent(row: EventRow, epoch: string): WorkspaceEvent {
    let event = workspaceEventSchema.parse({
      version: 1,
      id: row.id,
      type: row.event_type,
      occurredAt: iso(row.occurred_at),
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      position: { epoch, sequence: row.workspace_sequence },
      conversationSequence: row.conversation_sequence,
      entityVersion: row.entity_version,
      delivery: "at_least_once",
      payload: row.payload,
    });
    // Pre-upgrade events stored the members enum for humans-only channels. Keep retained JSON
    // unchanged while delivering the same access mode as the authoritative conversation snapshot.
    if (
      row.conversation_human_only &&
      (event.type === "channel.created" || event.type === "channel.archived")
    ) {
      event = workspaceEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          conversation: { ...event.payload.conversation, access: "humans" },
        },
      });
    }
    if (event.type !== "message.created") return event;
    // Recipient-specific reasons come only from this principal's scoped relation, never shared JSON.
    return workspaceEventSchema.parse({
      ...event,
      payload: {
        message: event.payload.message,
        mentionedUserIds: event.payload.mentionedUserIds,
        ...(row.participated_thread_notification
          ? { recipientNotificationReason: "participated_thread_reply" }
          : {}),
      },
    });
  }
}
