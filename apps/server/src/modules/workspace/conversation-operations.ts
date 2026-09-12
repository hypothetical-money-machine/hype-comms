import type { SyncPosition } from "@hype-comms/contracts";
import {
  channelMembershipMutationResponseSchema,
  channelMembersResponseSchema,
  COMMUNICATION_PATHS_MAX_PATHS,
  communicationPathsResponseSchema,
  CONVERSATION_PAGE_MAX_LIMIT,
  conversationMutationResponseSchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  listPublicChannelsResponseSchema,
  type ChannelAccess,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type CommunicationPathsResponse,
  type ConversationMutationResponse,
  type ConversationSummary,
  type CreateChannelRequest,
  type DirectConversationRequest,
  type GroupDirectConversationRequest,
  type ListConversationsResponse,
  type ListMembersResponse,
  type ListPublicChannelsResponse,
  type UpsertChannelMemberRequest,
} from "@hype-comms/contracts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import {
  conversationAudience,
  conversationVisibilitySql,
  requireVisibleConversation,
} from "./conversation-access.js";
import type { ConversationEventWriter } from "./conversation-events.js";
import {
  decodeConversationCursor,
  encodeConversationCursor,
  readConversationPage,
} from "./conversation-page-reader.js";
import { readConversationSummaries } from "./conversation-summary-reader.js";
import {
  fingerprintApiRequest,
  lockIdempotencyScope,
  runIdempotentMutation,
} from "./idempotency.js";
import {
  iso,
  mapConversation,
  nullableIso,
  participants,
  type ConversationRow,
} from "./records.js";
import { mapTask, type TaskRow } from "./task-records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { mapUser, type UserRow } from "./user-records.js";
import { requireActivePrincipal } from "./workspace-access.js";
import { auditAnnouncement, type WorkspaceRepositoryHooks } from "./workspace-hooks.js";
import { readWorkspaceMembers } from "./workspace-member-reader.js";
import { readWorkspacePosition } from "./workspace-sequence.js";

interface PublicChannelRow extends ConversationRow {
  joined: boolean;
}

interface ConversationMembershipRow extends QueryResultRow {
  conversation_id: string;
  workspace_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: Date | string;
  left_at: Date | string | null;
  updated_at: Date | string;
}

interface ChannelMemberRow extends UserRow {
  role: "owner" | "member";
  joined_at: Date | string;
}

interface CommunicationPathRow extends QueryResultRow {
  member_a_id: string;
  member_b_id: string;
  direct_message_count: string;
  shared_channel_count: string;
  channel_message_count: string;
  last_activity_at: Date | string | null;
}

/**
 * The canonical low/high ordering behind the `(workspace_id, dm_user_low_id, dm_user_high_id)`
 * unique index. Every DM lookup and insert derives its pair here so the two cannot drift.
 */
function directMessagePair(
  actorId: string,
  memberId: string,
): {
  low: string;
  high: string;
} {
  const pair = [actorId, memberId].sort();
  const low = pair[0];
  const high = pair[1];
  if (low === undefined || high === undefined) throw new Error("Invalid direct-message pair");
  return { low, high };
}

/** Owns conversation and membership transactions, including affected task events. */
export class WorkspaceConversationOperations {
  constructor(
    private readonly pool: Pool,
    private readonly events: ConversationEventWriter,
    private readonly hooks: Pick<
      WorkspaceRepositoryHooks,
      | "humansOnlyChannelsEnabled"
      | "onAnnouncementAudit"
      | "afterArchiveConversationLocked"
      | "afterRemoveChannelMemberConversationLocked"
    > = {},
  ) {}
  get humansOnlyChannelsEnabled(): boolean {
    return this.hooks.humansOnlyChannelsEnabled ?? false;
  }
  async listMembers(identity: AuthenticatedIdentity): Promise<ListMembersResponse> {
    const client = await this.pool.connect();
    try {
      return listMembersResponseSchema.parse({
        members: await readWorkspaceMembers(client, identity.currentUser.workspaceId),
      });
    } finally {
      client.release();
    }
  }
  /**
   * Reuses the canonical conversation visibility predicate for ephemeral delivery. The active
   * workspace-membership join makes each best-effort authorization reflect revocation immediately
   * instead of waiting for the socket heartbeat to close the connection. The capability argument
   * is bound into the realtime ticket, so an older device cannot discover a group conversation
   * through typing frames merely because another device for the same user supports groups.
   */
  async canViewConversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
  ): Promise<boolean> {
    const result = await this.pool.query<
      {
        visible: boolean;
      } & QueryResultRow
    >(
      `SELECT EXISTS (
         SELECT 1
           FROM conversations AS conversation
           JOIN workspace_memberships AS active_membership
             ON active_membership.workspace_id = conversation.workspace_id
            AND active_membership.user_id = $2
            AND active_membership.status = 'active'
          WHERE conversation.id = $3
            AND conversation.workspace_id = $1
            AND ${conversationVisibilitySql("conversation", "$2")}
       ) AS visible`,
      [workspaceId, userId, conversationId],
    );
    return result.rows[0]?.visible ?? false;
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
  async communicationPaths(identity: AuthenticatedIdentity): Promise<CommunicationPathsResponse> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const members = await readWorkspaceMembers(client, identity.currentUser.workspaceId);
        const result = await client.query<CommunicationPathRow>(
          // `actor` is the active human/agent member set; every path endpoint comes from it.
          // `accessible` mirrors channel visibility: humans implicitly see public channels,
          // while agents and restricted-channel members require a live conversation seat. Bots
          // are deliberately absent here -- their grant-based access never produces a
          // member-to-member path under the scope decisions above.
          `WITH actor AS (
           SELECT membership.user_id AS user_id, user_account.kind
             FROM workspace_memberships AS membership
             JOIN users AS user_account ON user_account.id = membership.user_id
            WHERE membership.workspace_id = $1
              AND membership.status = 'active'
              AND user_account.kind IN ('human', 'agent')
         ),
         accessible AS (
           SELECT actor.user_id AS user_id,
                  conversation.id AS conversation_id
             FROM actor
             JOIN conversations AS conversation
               ON conversation.workspace_id = $1
              AND conversation.kind = 'channel'
              AND conversation.is_archived = false
              AND (conversation.channel_access = 'workspace' OR conversation.human_only)
              AND actor.kind = 'human'
            UNION
           SELECT conversation_membership.user_id AS user_id,
                  conversation_membership.conversation_id AS conversation_id
             FROM conversation_memberships AS conversation_membership
             JOIN conversations AS conversation
               ON conversation.id = conversation_membership.conversation_id
              AND conversation.kind = 'channel'
              AND conversation.is_archived = false
             JOIN actor ON actor.user_id = conversation_membership.user_id
            WHERE conversation_membership.workspace_id = $1
              AND conversation_membership.left_at IS NULL
              AND NOT conversation.human_only
         ),
         dm_source AS (
           SELECT conversation.dm_user_low_id AS member_a_id,
                  conversation.dm_user_high_id AS member_b_id,
                  COUNT(message.id) AS direct_message_count,
                  MAX(message.created_at) AS last_dm_at
             FROM conversations AS conversation
             JOIN actor AS low ON low.user_id = conversation.dm_user_low_id
             JOIN actor AS high ON high.user_id = conversation.dm_user_high_id
             JOIN messages AS message
               ON message.conversation_id = conversation.id
              AND message.deleted_at IS NULL
            WHERE conversation.workspace_id = $1
              AND conversation.kind = 'direct_message'
              AND conversation.dm_user_low_id <> conversation.dm_user_high_id
            GROUP BY 1, 2
            UNION ALL
           SELECT LEAST(message.author_id, recipient.user_id) AS member_a_id,
                  GREATEST(message.author_id, recipient.user_id) AS member_b_id,
                  COUNT(message.id) AS direct_message_count,
                  MAX(message.created_at) AS last_dm_at
             FROM conversations AS conversation
             JOIN messages AS message
               ON message.conversation_id = conversation.id
              AND message.deleted_at IS NULL
             JOIN actor AS author ON author.user_id = message.author_id
             JOIN conversation_memberships AS recipient_membership
               ON recipient_membership.conversation_id = conversation.id
              AND recipient_membership.left_at IS NULL
              AND recipient_membership.user_id <> message.author_id
             JOIN actor AS recipient ON recipient.user_id = recipient_membership.user_id
            WHERE conversation.workspace_id = $1
              AND conversation.kind = 'group_direct_message'
            GROUP BY 1, 2
         ),
         dm AS (
           SELECT member_a_id,
                  member_b_id,
                  SUM(direct_message_count) AS direct_message_count,
                  MAX(last_dm_at) AS last_dm_at
             FROM dm_source
            GROUP BY 1, 2
         ),
         shared AS (
            SELECT sender.user_id AS member_a_id,
                   peer.user_id AS member_b_id,
                   COUNT(DISTINCT sender.conversation_id) AS shared_channel_count
              FROM accessible AS sender
              JOIN accessible AS peer
                ON peer.conversation_id = sender.conversation_id
               AND peer.user_id > sender.user_id
             GROUP BY 1, 2
         ),
         channel_activity AS (
           SELECT LEAST(message.author_id, recipient.user_id) AS member_a_id,
                  GREATEST(message.author_id, recipient.user_id) AS member_b_id,
                  COUNT(*) AS channel_message_count,
                  MAX(message.created_at) AS last_channel_at
             FROM messages AS message
             JOIN actor AS author ON author.user_id = message.author_id
             JOIN conversations AS conversation
               ON conversation.id = message.conversation_id
              AND conversation.kind = 'channel'
             JOIN accessible AS recipient
               ON recipient.conversation_id = message.conversation_id
              AND recipient.user_id <> message.author_id
            WHERE message.workspace_id = $1
              AND message.deleted_at IS NULL
            GROUP BY 1, 2
         )
         SELECT COALESCE(dm.member_a_id, shared.member_a_id, activity.member_a_id) AS member_a_id,
                COALESCE(dm.member_b_id, shared.member_b_id, activity.member_b_id) AS member_b_id,
                COALESCE(dm.direct_message_count, 0) AS direct_message_count,
                COALESCE(shared.shared_channel_count, 0) AS shared_channel_count,
                COALESCE(activity.channel_message_count, 0) AS channel_message_count,
                GREATEST(dm.last_dm_at, activity.last_channel_at) AS last_activity_at
           FROM dm
           FULL OUTER JOIN shared
             ON shared.member_a_id = dm.member_a_id
            AND shared.member_b_id = dm.member_b_id
           FULL OUTER JOIN channel_activity AS activity
             ON activity.member_a_id = COALESCE(dm.member_a_id, shared.member_a_id)
            AND activity.member_b_id = COALESCE(dm.member_b_id, shared.member_b_id)
          ORDER BY COALESCE(dm.direct_message_count, 0)
                 + COALESCE(activity.channel_message_count, 0) DESC,
                 COALESCE(shared.shared_channel_count, 0) DESC,
                 member_a_id,
                 member_b_id
          LIMIT $2`,
          [identity.currentUser.workspaceId, COMMUNICATION_PATHS_MAX_PATHS],
        );
        return communicationPathsResponseSchema.parse({
          generatedAt: new Date().toISOString(),
          members,
          paths: result.rows.map((row) => ({
            memberAId: row.member_a_id,
            memberBId: row.member_b_id,
            directMessageCount: Number(row.direct_message_count),
            sharedChannelCount: Number(row.shared_channel_count),
            channelMessageCount: Number(row.channel_message_count),
            lastActivityAt: nullableIso(row.last_activity_at),
          })),
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listConversations(
    identity: AuthenticatedIdentity,
    after: string | undefined,
    limit: number,
  ): Promise<ListConversationsResponse> {
    const anchorId = decodeConversationCursor(after);
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const page = await readConversationPage(client, identity, anchorId, limit);
        return listConversationsResponseSchema.parse({
          conversations: page.conversations,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listPublicChannels(
    identity: AuthenticatedIdentity,
    after: string | undefined,
    limit: number,
  ): Promise<ListPublicChannelsResponse> {
    const anchorId = decodeConversationCursor(after);
    const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), CONVERSATION_PAGE_MAX_LIMIT);
    const result = await this.pool.query<PublicChannelRow>(
      `SELECT conversation.*,
              CASE
                WHEN actor.kind = 'human' THEN true
                ELSE EXISTS (
                  SELECT 1
                    FROM conversation_memberships AS membership
                   WHERE membership.conversation_id = conversation.id
                     AND membership.user_id = $2
                     AND membership.left_at IS NULL
                )
              END AS joined
         FROM conversations AS conversation
         JOIN workspace_memberships AS workspace_membership
           ON workspace_membership.workspace_id = conversation.workspace_id
          AND workspace_membership.user_id = $2
          AND workspace_membership.status = 'active'
         JOIN users AS actor
           ON actor.id = workspace_membership.user_id
          AND actor.kind IN ('human', 'agent')
        WHERE conversation.workspace_id = $1
          AND conversation.kind = 'channel'
          AND conversation.channel_access = 'workspace'
          AND conversation.is_archived = false
          AND NOT conversation.is_system
          AND (
            $3::uuid IS NULL
            OR (
              lower(conversation.name),
              conversation.created_at,
              conversation.id
            ) > (
              SELECT lower(anchor.name), anchor.created_at, anchor.id
                FROM conversations AS anchor
               WHERE anchor.id = $3::uuid
                 AND anchor.workspace_id = $1
                 AND anchor.kind = 'channel'
                 AND anchor.channel_access = 'workspace'
                 AND NOT anchor.is_system
            )
          )
        ORDER BY lower(conversation.name), conversation.created_at, conversation.id
        LIMIT $4`,
      [identity.currentUser.workspaceId, identity.currentUser.user.id, anchorId, pageLimit + 1],
    );
    const selected = result.rows.slice(0, pageLimit);
    const last = selected.at(-1);
    const nextCursor =
      result.rows.length > pageLimit && last !== undefined
        ? encodeConversationCursor(last.id)
        : null;
    return listPublicChannelsResponseSchema.parse({
      channels: selected.map((row) => ({ conversation: mapConversation(row), joined: row.joined })),
      nextCursor,
      hasMore: nextCursor !== null,
    });
  }

  async joinPublicChannel(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const locked = await client.query<ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE id = $1
            AND workspace_id = $2
            AND kind = 'channel'
            AND channel_access = 'workspace'
            AND is_archived = false
          FOR UPDATE`,
        [conversationId, identity.currentUser.workspaceId],
      );
      const conversation = locked.rows[0];
      if (conversation === undefined) {
        throw new DomainError("not_found", "Channel not found");
      }
      const principal = await requireActivePrincipal(client, identity);
      if (principal.kind === "human") {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, conversation),
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      }
      const existing = await client.query<ConversationMembershipRow>(
        `SELECT *
           FROM conversation_memberships
          WHERE conversation_id = $1
            AND user_id = $2
          FOR UPDATE`,
        [conversationId, identity.currentUser.user.id],
      );
      if (existing.rows[0]?.left_at === null) {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, conversation),
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      }
      const audienceBefore = await conversationAudience(client, conversation);
      await client.query(
        `INSERT INTO conversation_memberships
           (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')
         ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET role = 'member',
               joined_at = clock_timestamp(),
               left_at = NULL,
               updated_at = clock_timestamp()`,
        [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const audienceAfter = await conversationAudience(client, conversation);
      const event = await this.events.insert(client, identity, {
        type: "channel.membership_changed",
        conversation,
        payload: { memberId: identity.currentUser.user.id, action: "added" },
        audienceUserIds: [...new Set([...audienceBefore, ...audienceAfter])],
      });
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, conversation),
        syncCursor: event.position,
      });
    });
  }

  async createChannel(
    identity: AuthenticatedIdentity,
    input: CreateChannelRequest,
    idempotencyKey?: string,
    correlationId?: string,
    defaultAgentAgencyEnabled = true,
  ): Promise<ConversationMutationResponse> {
    let acceptedAnnouncementId: string | undefined;
    const response = await runWorkspaceTransaction(this.pool, async (client) => {
      const create = async (): Promise<ConversationMutationResponse> => {
        const channelMode = input.channelMode ?? "chat";
        const principal =
          input.access === "humans"
            ? await this.#requireHumansOnlyCreator(client, identity)
            : await requireActivePrincipal(client, identity);
        const storedAccess: Exclude<ChannelAccess, "humans"> =
          input.access === "humans" ? "members" : input.access;
        if (
          input.access === "humans" &&
          !(await this.#humansOnlyChannelsAvailable(client, identity.currentUser.workspaceId))
        ) {
          throw new DomainError("access_denied", "Humans-only channels are unavailable");
        }
        if (channelMode === "announcement") {
          const announcementChannelsAvailable = await this.events.announcementChannelsAvailable(
            client,
            identity.currentUser.workspaceId,
          );
          const allowed =
            announcementChannelsAvailable &&
            principal.kind === "human" &&
            principal.role === "owner";
          if (!allowed) {
            auditAnnouncement(this.hooks, {
              operation: "channel.create",
              outcome: "rejected",
              actorUserId: identity.currentUser.user.id,
              workspaceId: identity.currentUser.workspaceId,
              correlationId,
              reason: "not_authorized",
            });
            throw new DomainError(
              "access_denied",
              "Only workspace owners can create announcements",
            );
          }
        }
        const created = await client
          .query<ConversationRow>(
            `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, channel_access, channel_mode, created_by,
            agent_membership_required, human_only)
         VALUES ($1, $2, 'channel', $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              input.name,
              input.slug,
              input.topic,
              storedAccess,
              channelMode,
              identity.currentUser.user.id,
              defaultAgentAgencyEnabled,
              input.access === "humans",
            ],
          )
          .catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "23505") {
              throw new DomainError("conflict", "A channel with that slug already exists");
            }
            throw error;
          });
        const row = created.rows[0];
        if (row === undefined) throw new Error("Channel insert returned no row");
        if (input.access === "members" || principal.kind === "agent") {
          await client.query(
            `INSERT INTO conversation_memberships
             (conversation_id, workspace_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')
           ON CONFLICT (conversation_id, user_id) DO UPDATE
             SET role = 'owner',
                 left_at = NULL,
                 updated_at = clock_timestamp()`,
            [row.id, row.workspace_id, identity.currentUser.user.id],
          );
        }
        const audienceUserIds = await conversationAudience(client, row);
        const event = await this.events.insert(client, identity, {
          type: "channel.created",
          conversation: row,
          payload: {
            conversation: mapConversation(row),
            participantIds: audienceUserIds,
          },
          audienceUserIds,
        });
        if (channelMode === "announcement") {
          acceptedAnnouncementId = row.id;
        }
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, row),
          syncCursor: event.position,
        });
      };
      if (idempotencyKey === undefined) return create();
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: "/v1/channels",
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: conversationMutationResponseSchema,
        },
        create,
      );
    });
    if (acceptedAnnouncementId !== undefined) {
      auditAnnouncement(this.hooks, {
        operation: "channel.create",
        outcome: "accepted",
        actorUserId: identity.currentUser.user.id,
        workspaceId: identity.currentUser.workspaceId,
        conversationId: acceptedAnnouncementId,
        correlationId,
      });
    }
    return response;
  }

  async listChannelMembers(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ChannelMembersResponse> {
    const client = await this.pool.connect();
    try {
      const conversation = await requireVisibleConversation(
        client,
        identity,
        conversationId,
        false,
      );
      if (conversation.kind !== "channel") {
        throw new DomainError("not_found", "Channel not found");
      }
      return this.#channelMembers(client, identity, conversation);
    } finally {
      client.release();
    }
  }

  async upsertChannelMember(
    identity: AuthenticatedIdentity,
    conversationId: string,
    memberId: string,
    input: UpsertChannelMemberRequest,
  ): Promise<ChannelMembershipMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const conversation = await this.#requireManagedChannel(client, identity, conversationId);
      const target = await client.query(
        `SELECT 1
           FROM workspace_memberships AS membership
           JOIN users AS user_account ON user_account.id = membership.user_id
          WHERE membership.workspace_id = $1
            AND membership.user_id = $2
            AND membership.status = 'active'
            AND user_account.kind IN ('human', 'agent')`,
        [identity.currentUser.workspaceId, memberId],
      );
      if (target.rowCount !== 1) throw new DomainError("not_found", "Member not found");

      await lockIdempotencyScope(client, `channel-membership:${conversationId}:${memberId}`);

      const existing = await client.query<ConversationMembershipRow>(
        `SELECT *
           FROM conversation_memberships
          WHERE conversation_id = $1
            AND user_id = $2
          FOR UPDATE`,
        [conversationId, memberId],
      );
      const current = existing.rows[0];
      if (current?.left_at === null && current.role === input.role) {
        return channelMembershipMutationResponseSchema.parse({
          channelMembers: await this.#channelMembers(client, identity, conversation),
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      }
      if (current?.left_at === null && current.role === "owner" && input.role === "member") {
        await this.#requireAnotherChannelOwner(client, conversationId, memberId);
      }
      const audienceBefore = await conversationAudience(client, conversation);
      await client.query(
        `INSERT INTO conversation_memberships
           (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET role = EXCLUDED.role,
               joined_at = CASE
                 WHEN conversation_memberships.left_at IS NULL
                   THEN conversation_memberships.joined_at
                 ELSE clock_timestamp()
               END,
               left_at = NULL,
               updated_at = clock_timestamp()`,
        [conversationId, identity.currentUser.workspaceId, memberId, input.role],
      );
      const audienceAfter = await conversationAudience(client, conversation);
      const action = current === undefined || current.left_at !== null ? "added" : "updated";
      const event = await this.events.insert(client, identity, {
        type: "channel.membership_changed",
        conversation,
        payload: { memberId, action },
        audienceUserIds: [...new Set([...audienceBefore, ...audienceAfter])],
      });
      return channelMembershipMutationResponseSchema.parse({
        channelMembers: await this.#channelMembers(client, identity, conversation),
        syncCursor: event.position,
      });
    });
  }

  async removeChannelMember(
    identity: AuthenticatedIdentity,
    conversationId: string,
    memberId: string,
  ): Promise<ChannelMembershipMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const conversation = await this.#requireManagedChannel(client, identity, conversationId);
      await this.hooks.afterRemoveChannelMemberConversationLocked?.();
      await lockIdempotencyScope(client, `channel-membership:${conversationId}:${memberId}`);
      const existing = await client.query<ConversationMembershipRow>(
        `SELECT *
           FROM conversation_memberships
          WHERE conversation_id = $1
            AND user_id = $2
            AND left_at IS NULL
          FOR UPDATE`,
        [conversationId, memberId],
      );
      const current = existing.rows[0];
      if (current === undefined) {
        return channelMembershipMutationResponseSchema.parse({
          channelMembers: await this.#channelMembers(client, identity, conversation),
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      }
      if (current.role === "owner") {
        await this.#requireAnotherChannelOwner(client, conversationId, memberId);
      }
      const audienceBefore = await conversationAudience(client, conversation);
      await client.query(
        `UPDATE conversation_memberships
            SET left_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE conversation_id = $1
            AND user_id = $2`,
        [conversationId, memberId],
      );
      const audienceAfter = await conversationAudience(client, conversation);
      const unassigned = await client.query<TaskRow>(
        `UPDATE tasks
            SET assignee_id = NULL,
                version = version + 1,
                updated_by = $3,
                updated_at = clock_timestamp()
          WHERE conversation_id = $1
            AND assignee_id = $2
          RETURNING *`,
        [conversationId, memberId, identity.currentUser.user.id],
      );
      for (const row of unassigned.rows) {
        const task = mapTask(row);
        await this.events.insert(client, identity, {
          type: "task.updated",
          conversation,
          entityVersion: task.version,
          payload: { task },
          audienceUserIds: audienceAfter,
        });
      }
      const event = await this.events.insert(client, identity, {
        type: "channel.membership_changed",
        conversation,
        payload: { memberId, action: "removed" },
        audienceUserIds: [...new Set([...audienceBefore, ...audienceAfter])],
      });
      return channelMembershipMutationResponseSchema.parse({
        channelMembers: await this.#channelMembers(client, identity, conversation),
        syncCursor: event.position,
      });
    });
  }

  async archiveChannel(
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      const locked = await client.query<ConversationRow>(
        `SELECT *
           FROM conversations AS conversation
          WHERE conversation.id = $1
            AND conversation.workspace_id = $2
            AND conversation.kind = 'channel'
            AND conversation.slug <> 'general'
            AND NOT conversation.is_system
            AND ${conversationVisibilitySql("conversation", "$3")}
          FOR UPDATE`,
        [conversationId, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      const current = locked.rows[0];
      if (current === undefined) {
        throw new DomainError("not_found", "Channel not found or cannot be archived");
      }
      await this.hooks.afterArchiveConversationLocked?.();
      const principal = await requireActivePrincipal(client, identity);
      if (principal.kind !== "human" || principal.role !== "owner") {
        throw new DomainError("access_denied", "Only the workspace owner can archive channels");
      }
      if (current.is_archived) {
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, current),
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      }
      const updated = await client.query<ConversationRow>(
        `UPDATE conversations
            SET is_archived = true, updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING *`,
        [conversationId],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("Channel archive returned no row");
      const audienceUserIds = await conversationAudience(client, row);
      const event = await this.events.insert(client, identity, {
        type: "channel.archived",
        conversation: row,
        payload: {
          conversation: mapConversation(row),
          participantIds: audienceUserIds,
        },
        audienceUserIds,
      });
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, row),
        syncCursor: event.position,
      });
    });
  }

  async createDirectConversation(
    identity: AuthenticatedIdentity,
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse> {
    return runWorkspaceTransaction(this.pool, async (client) => {
      await this.#requireActiveConversationParticipants(client, identity, [input.memberId]);
      const { low, high } = directMessagePair(identity.currentUser.user.id, input.memberId);
      const inserted = await client.query<ConversationRow>(
        `INSERT INTO conversations
           (id, workspace_id, kind, dm_user_low_id, dm_user_high_id, created_by)
         VALUES ($1, $2, 'direct_message', $3, $4, $5)
         ON CONFLICT (workspace_id, dm_user_low_id, dm_user_high_id) DO NOTHING
         RETURNING *`,
        [randomUUID(), identity.currentUser.workspaceId, low, high, identity.currentUser.user.id],
      );
      let row = inserted.rows[0];
      let syncCursor: SyncPosition;
      if (row === undefined) {
        const existing = await client.query<ConversationRow>(
          `SELECT *
             FROM conversations
            WHERE workspace_id = $1
              AND dm_user_low_id = $2
              AND dm_user_high_id = $3`,
          [identity.currentUser.workspaceId, low, high],
        );
        row = existing.rows[0];
        if (row === undefined) throw new Error("Direct conversation conflict returned no row");
        syncCursor = await readWorkspacePosition(client, identity.currentUser.workspaceId);
      } else {
        const participantIds = participants(row);
        const event = await this.events.insert(client, identity, {
          type: "direct_conversation.created",
          conversation: row,
          payload: {
            conversation: mapConversation(row),
            participantIds,
          },
          audienceUserIds: participantIds,
        });
        syncCursor = event.position;
      }
      return conversationMutationResponseSchema.parse({
        conversation: await this.#conversationSummary(client, identity, row),
        syncCursor,
      });
    });
  }

  async createGroupDirectConversation(
    identity: AuthenticatedIdentity,
    input: GroupDirectConversationRequest,
    idempotencyKey: string,
  ): Promise<ConversationMutationResponse> {
    const memberIds = [...input.memberIds].sort();
    if (memberIds.includes(identity.currentUser.user.id)) {
      throw new DomainError("invalid_input", "The caller is already a group participant");
    }
    return runWorkspaceTransaction(this.pool, async (client) => {
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: "/v1/group-direct-conversations",
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest({ memberIds }),
          responseStatus: 201,
          responseSchema: conversationMutationResponseSchema,
        },
        async () => {
          await this.#requireActiveConversationParticipants(client, identity, memberIds);
          const inserted = await client.query<ConversationRow>(
            `INSERT INTO conversations
               (id, workspace_id, kind, created_by)
             VALUES ($1, $2, 'group_direct_message', $3)
             RETURNING *`,
            [randomUUID(), identity.currentUser.workspaceId, identity.currentUser.user.id],
          );
          const conversation = inserted.rows[0];
          if (conversation === undefined) {
            throw new Error("Group direct conversation insert returned no row");
          }
          const participantIds = [identity.currentUser.user.id, ...memberIds].sort();
          await client.query(
            `INSERT INTO conversation_memberships
               (conversation_id, workspace_id, user_id, role)
             SELECT $1,
                    $2,
                    participant.user_id,
                    CASE WHEN participant.user_id = $3 THEN 'owner' ELSE 'member' END
               FROM unnest($4::uuid[]) AS participant(user_id)`,
            [
              conversation.id,
              identity.currentUser.workspaceId,
              identity.currentUser.user.id,
              participantIds,
            ],
          );
          await client.query(
            `UPDATE conversations
                SET group_memberships_locked = true
              WHERE id = $1
                AND workspace_id = $2
                AND kind = 'group_direct_message'`,
            [conversation.id, identity.currentUser.workspaceId],
          );
          const event = await this.events.insert(client, identity, {
            type: "direct_conversation.created",
            conversation,
            payload: { conversation: mapConversation(conversation), participantIds },
            audienceUserIds: participantIds,
          });
          return conversationMutationResponseSchema.parse({
            conversation: await this.#conversationSummary(client, identity, conversation),
            syncCursor: event.position,
          });
        },
      );
    });
  }

  async findDirectConversation(
    identity: AuthenticatedIdentity,
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse | null> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        const { low, high } = directMessagePair(identity.currentUser.user.id, input.memberId);
        const existing = await client.query<ConversationRow>(
          `SELECT conversation.*
             FROM conversations AS conversation
            WHERE conversation.workspace_id = $1
              AND conversation.kind = 'direct_message'
              AND conversation.dm_user_low_id = $2
              AND conversation.dm_user_high_id = $3
              AND EXISTS (
                SELECT 1
                  FROM workspace_memberships AS actor_membership
                  JOIN users AS actor ON actor.id = actor_membership.user_id
                 WHERE actor_membership.workspace_id = conversation.workspace_id
                   AND actor_membership.user_id = $4
                   AND actor_membership.status = 'active'
                   AND actor.kind IN ('human', 'agent')
              )
              AND EXISTS (
                SELECT 1
                  FROM workspace_memberships AS target_membership
                  JOIN users AS target ON target.id = target_membership.user_id
                 WHERE target_membership.workspace_id = conversation.workspace_id
                   AND target_membership.user_id = $5
                   AND target_membership.status = 'active'
                   AND target.kind IN ('human', 'agent')
              )`,
          [
            identity.currentUser.workspaceId,
            low,
            high,
            identity.currentUser.user.id,
            input.memberId,
          ],
        );
        const row = existing.rows[0];
        if (row === undefined) return null;
        return conversationMutationResponseSchema.parse({
          conversation: await this.#conversationSummary(client, identity, row),
          syncCursor: await readWorkspacePosition(client, identity.currentUser.workspaceId),
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async #conversationSummary(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<ConversationSummary> {
    const [summary] = await readConversationSummaries(client, identity.currentUser.user.id, [
      conversation,
    ]);
    if (summary === undefined) throw new Error("Conversation summary is missing");
    return summary;
  }

  async #requireHumansOnlyCreator(
    client: PoolClient,
    identity: AuthenticatedIdentity,
  ): Promise<{
    readonly role: "owner" | "member";
    readonly kind: "human";
  }> {
    const result = await client.query<
      {
        user_id: string;
        role: "owner" | "member";
        status: "invited" | "active" | "revoked";
        kind: "human";
      } & QueryResultRow
    >(
      `SELECT membership.user_id, membership.role, membership.status, user_account.kind
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $1
          AND user_account.kind = 'human'
        ORDER BY membership.user_id
        FOR UPDATE OF membership`,
      [identity.currentUser.workspaceId],
    );
    const principal = result.rows.find((row) => row.user_id === identity.currentUser.user.id);
    if (principal === undefined || principal.status !== "active") {
      throw new DomainError("access_denied", "Only humans can create humans-only channels");
    }
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      identity.currentUser.workspaceId,
    ]);
    return { role: principal.role, kind: principal.kind };
  }

  async #requireActiveConversationParticipants(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    memberIds: readonly string[],
  ): Promise<void> {
    const actorId = identity.currentUser.user.id;
    const participantIds = [...new Set([actorId, ...memberIds])].sort();
    const result = await client.query<
      {
        id: string;
      } & QueryResultRow
    >(
      `SELECT membership.user_id AS id
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $1
          AND membership.user_id = ANY($2::uuid[])
          AND membership.status = 'active'
          AND user_account.kind IN ('human', 'agent')
        ORDER BY membership.user_id
        FOR UPDATE OF membership`,
      [identity.currentUser.workspaceId, participantIds],
    );
    const activeIds = new Set(result.rows.map((row) => row.id));
    if (!activeIds.has(actorId)) {
      throw new DomainError("access_denied", "Workspace unavailable");
    }
    if (memberIds.some((id) => !activeIds.has(id))) {
      throw new DomainError("not_found", "One or more members were not found");
    }
    // Membership rows are locked in deterministic UUID order before the workspace row. Agent
    // disable and human membership revocation use the same membership-before-workspace order, so
    // a DM cannot be created with a participant who is concurrently leaving the workspace.
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [
      identity.currentUser.workspaceId,
    ]);
  }

  async #requireManagedChannel(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversationId: string,
  ): Promise<ConversationRow> {
    // Membership mutations take message delivery's canonical conversation row lock before
    // inspecting or changing conversation_memberships.
    const conversation = await requireVisibleConversation(
      client,
      identity,
      conversationId,
      true,
      true,
    );
    await requireActivePrincipal(client, identity);
    if (
      conversation.kind !== "channel" ||
      conversation.channel_access !== "members" ||
      conversation.human_only
    ) {
      throw new DomainError("not_found", "Managed channel not found");
    }
    const role = await this.#membershipRole(client, identity, conversation);
    if (role !== "owner") {
      throw new DomainError("access_denied", "Only a channel owner can manage members");
    }
    return conversation;
  }

  async #requireAnotherChannelOwner(
    client: PoolClient,
    conversationId: string,
    excludedUserId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1
         FROM conversation_memberships AS membership
         JOIN workspace_memberships AS workspace_membership
           ON workspace_membership.workspace_id = membership.workspace_id
          AND workspace_membership.user_id = membership.user_id
        WHERE membership.conversation_id = $1
          AND membership.user_id <> $2
          AND membership.role = 'owner'
          AND membership.left_at IS NULL
          AND workspace_membership.status = 'active'
        LIMIT 1`,
      [conversationId, excludedUserId],
    );
    if (result.rowCount !== 1) {
      throw new DomainError("conflict", "A channel must retain at least one owner");
    }
  }

  async #channelMembers(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<ChannelMembersResponse> {
    const result = conversation.human_only
      ? await client.query<ChannelMemberRow>(
          `SELECT user_account.id, user_account.kind, user_account.username,
                    user_account.display_name, user_account.avatar_url, user_account.title,
                    user_account.created_at, user_account.updated_at,
                    'member'::text AS role, workspace_membership.created_at AS joined_at
               FROM workspace_memberships AS workspace_membership
               JOIN users AS user_account ON user_account.id = workspace_membership.user_id
              WHERE workspace_membership.workspace_id = $1
                AND workspace_membership.status = 'active'
                AND user_account.kind = 'human'
              ORDER BY lower(user_account.display_name), user_account.id`,
          [conversation.workspace_id],
        )
      : conversation.channel_access === "workspace"
        ? await client.query<ChannelMemberRow>(
            `SELECT user_account.id, user_account.kind, user_account.username,
                    user_account.display_name,
                    user_account.avatar_url, user_account.title, user_account.created_at,
                    user_account.updated_at,
                    CASE
                      WHEN user_account.kind = 'human' AND user_account.id = $2 THEN 'owner'
                      WHEN user_account.kind = 'agent' THEN public_membership.role
                      ELSE 'member'
                    END AS role,
                    CASE
                      WHEN user_account.kind = 'human' THEN workspace_membership.created_at
                      WHEN user_account.kind = 'agent' THEN public_membership.joined_at
                      ELSE bot_grant.created_at
                    END AS joined_at
               FROM users AS user_account
               JOIN workspace_memberships AS workspace_membership
                 ON workspace_membership.user_id = user_account.id
               LEFT JOIN conversation_memberships AS public_membership
                 ON public_membership.conversation_id = $3
                AND public_membership.user_id = user_account.id
                AND public_membership.left_at IS NULL
               LEFT JOIN bot_channel_grants AS bot_grant
                 ON bot_grant.conversation_id = $3
                AND bot_grant.bot_user_id = user_account.id
              WHERE workspace_membership.workspace_id = $1
                AND workspace_membership.status = 'active'
                AND (
                  user_account.kind = 'human'
                  OR (
                    user_account.kind = 'agent'
                    AND public_membership.user_id IS NOT NULL
                  )
                  OR bot_grant.bot_user_id IS NOT NULL
                )
              ORDER BY lower(user_account.display_name), user_account.id`,
            [conversation.workspace_id, conversation.created_by, conversation.id],
          )
        : await client.query<ChannelMemberRow>(
            `SELECT audience.*
               FROM (
                 SELECT user_account.id, user_account.kind, user_account.username,
                        user_account.display_name, user_account.avatar_url, user_account.title,
                        user_account.created_at, user_account.updated_at,
                        membership.role, membership.joined_at
                   FROM conversation_memberships AS membership
                   JOIN workspace_memberships AS workspace_membership
                     ON workspace_membership.workspace_id = membership.workspace_id
                    AND workspace_membership.user_id = membership.user_id
                   JOIN users AS user_account ON user_account.id = membership.user_id
                  WHERE membership.conversation_id = $1
                    AND membership.left_at IS NULL
                    AND workspace_membership.status = 'active'
                    AND user_account.kind IN ('human', 'agent')
                    AND (NOT $2::boolean OR user_account.kind = 'human')
                 UNION ALL
                 SELECT user_account.id, user_account.kind, user_account.username,
                        user_account.display_name, user_account.avatar_url, user_account.title,
                        user_account.created_at, user_account.updated_at,
                        'member'::text AS role, grant_record.created_at AS joined_at
                   FROM bot_channel_grants AS grant_record
                   JOIN workspace_memberships AS workspace_membership
                     ON workspace_membership.workspace_id = grant_record.workspace_id
                    AND workspace_membership.user_id = grant_record.bot_user_id
                   JOIN users AS user_account ON user_account.id = grant_record.bot_user_id
                  WHERE grant_record.conversation_id = $1
                    AND workspace_membership.status = 'active'
                    AND user_account.kind = 'bot'
                    AND NOT $2::boolean
               ) AS audience
              ORDER BY lower(audience.display_name), audience.id`,
            [conversation.id, conversation.human_only],
          );
    const role = await this.#membershipRole(client, identity, conversation);
    return channelMembersResponseSchema.parse({
      conversationId: conversation.id,
      access: conversation.human_only ? "humans" : conversation.channel_access,
      members: result.rows.map((row) => ({
        user: mapUser(row),
        role: row.role,
        joinedAt: iso(row.joined_at),
      })),
      canManage:
        conversation.channel_access === "members" && !conversation.human_only && role === "owner",
    });
  }

  async #membershipRole(
    client: PoolClient,
    identity: AuthenticatedIdentity,
    conversation: ConversationRow,
  ): Promise<"owner" | "member" | null> {
    if (conversation.kind === "direct_message") return null;
    const result = await client.query<
      {
        role: "owner" | "member";
      } & QueryResultRow
    >(
      `SELECT role
         FROM conversation_memberships
        WHERE conversation_id = $1
          AND user_id = $2
          AND left_at IS NULL`,
      [conversation.id, identity.currentUser.user.id],
    );
    return result.rows[0]?.role ?? null;
  }

  async #humansOnlyChannelsAvailable(client: PoolClient, workspaceId: string): Promise<boolean> {
    if (this.humansOnlyChannelsEnabled) {
      await client.query(
        `UPDATE workspaces
            SET humans_only_channels_available = true
          WHERE id = $1
            AND humans_only_channels_available = false`,
        [workspaceId],
      );
    }
    const result = await client.query<
      {
        humans_only_channels_available: boolean;
      } & QueryResultRow
    >(
      `SELECT humans_only_channels_available
         FROM workspaces
        WHERE id = $1
        FOR UPDATE`,
      [workspaceId],
    );
    const workspace = result.rows[0];
    if (workspace === undefined) throw new DomainError("access_denied", "Workspace unavailable");
    return workspace.humans_only_channels_available;
  }
}
