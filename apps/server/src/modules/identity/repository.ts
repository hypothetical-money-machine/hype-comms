import { randomUUID } from "node:crypto";

import {
  agentCurrentPrincipalSchema,
  agentSchema,
  agentTokenSchema,
  authKitProviderSessionIdSchema,
  deviceSessionSchema,
  emailSchema,
  entityIdSchema,
  invitationSchema,
  isoDateTimeSchema,
  userSchema,
  workspaceMembershipSchema,
  workspaceSchema,
  type Agent,
  type AgentCurrentPrincipal,
  type AgentScope,
  type AgentToken,
  type AuthKitProviderSessionId,
  type DeviceSession,
  type Email,
  type EntityId,
  type Invitation,
  type IsoDateTime,
  type MemberTitle,
  type MembershipStatus,
  type User,
  type Workspace,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { z } from "zod";

import { withTransaction, type TransactionOptions } from "../../db/pool.js";
import { ApiError } from "../../errors.js";
import { insertSyncEvent } from "../workspace/sync-events.js";

interface UserRow extends QueryResultRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly kind: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly avatar_url: unknown;
  readonly title: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface AgentRow extends QueryResultRow {
  readonly user_id: unknown;
  readonly workspace_id: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly avatar_url: unknown;
  readonly title: unknown;
  readonly user_created_at: unknown;
  readonly user_updated_at: unknown;
  readonly created_by: unknown;
  readonly agent_created_at: unknown;
  readonly disabled_at: unknown;
}

interface AgentTokenRow extends QueryResultRow {
  readonly id: unknown;
  readonly agent_user_id: unknown;
  readonly label: unknown;
  readonly scopes: unknown;
  readonly created_by: unknown;
  readonly created_at: unknown;
  readonly last_used_at: unknown;
  readonly revoked_at: unknown;
}

interface AuthenticatedAgentRow extends QueryResultRow {
  readonly token_id: unknown;
  readonly workspace_id: unknown;
  readonly user_id: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly avatar_url: unknown;
  readonly title: unknown;
  readonly user_created_at: unknown;
  readonly user_updated_at: unknown;
  readonly role: unknown;
  readonly scopes: unknown;
  readonly last_used_at: unknown;
}

/** How stale an agent token's `last_used_at` may be before authentication refreshes it. */
const AGENT_TOKEN_LAST_USED_REFRESH_MS = 60_000;

interface WorkspaceRow extends QueryResultRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly slug: unknown;
  readonly created_by: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface MembershipRow extends QueryResultRow {
  readonly workspace_id: unknown;
  readonly user_id: unknown;
  readonly role: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface InvitationRow extends QueryResultRow {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly email: unknown;
  readonly role: unknown;
  readonly status: unknown;
  readonly invited_by: unknown;
  readonly expires_at: unknown;
  readonly accepted_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface MagicLinkRow extends QueryResultRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly invitation_id: unknown;
  readonly expires_at: unknown;
  readonly consumed_at: unknown;
  readonly created_at: unknown;
}

interface DeviceSessionRow extends QueryResultRow {
  readonly id: unknown;
  readonly user_id: unknown;
  readonly label: unknown;
  readonly created_at: unknown;
  readonly last_seen_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
}

interface DeviceSessionRotationRow extends DeviceSessionRow {
  readonly rotation_snapshot: unknown;
}

interface RevokedDeviceSessionProviderRow extends QueryResultRow {
  readonly workos_session_id: unknown;
}

interface CountRow extends QueryResultRow {
  readonly count: unknown;
}

interface IdRow extends QueryResultRow {
  readonly id: unknown;
}

const magicLinkRecordSchema = z
  .object({
    id: entityIdSchema,
    email: emailSchema,
    invitationId: entityIdSchema.nullable(),
    expiresAt: isoDateTimeSchema,
    consumedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
const countRowSchema = z.object({ count: z.coerce.number().int().nonnegative() }).strict();

export type IdentityUser = User & { readonly email: Email | null };
export type MagicLinkRecord = z.infer<typeof magicLinkRecordSchema>;

export interface InsertUserInput {
  readonly id: EntityId;
  readonly email: Email;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface InsertWorkspaceInput {
  readonly id: EntityId;
  readonly name: string;
  readonly slug: string;
  readonly createdBy: EntityId;
}

export interface UpsertMembershipInput {
  readonly workspaceId: EntityId;
  readonly userId: EntityId;
  readonly role: WorkspaceRole;
  readonly status: MembershipStatus;
}

export interface InsertInvitationInput {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly email: Email;
  readonly role: "member";
  readonly invitedBy: EntityId;
  readonly expiresAt: IsoDateTime;
}

export interface InsertMagicLinkInput {
  readonly id: EntityId;
  readonly tokenHash: Buffer;
  readonly email: Email;
  readonly invitationId: EntityId | null;
  readonly expiresAt: IsoDateTime;
  readonly createdAt: IsoDateTime;
}

export interface InsertDeviceSessionInput {
  readonly id: EntityId;
  readonly userId: EntityId;
  readonly tokenHash: Buffer;
  readonly label: string | null;
  readonly createdAt: IsoDateTime;
  readonly lastSeenAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

export interface InsertAgentInput {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly username: string;
  readonly displayName: string;
  readonly createdBy: EntityId;
}

export interface InsertAgentTokenInput {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly agentUserId: EntityId;
  readonly tokenHash: Buffer;
  readonly label: string;
  readonly scopes: readonly AgentScope[];
  readonly createdBy: EntityId;
  readonly createdAt: IsoDateTime;
}

export interface AuthenticatedAgent {
  readonly principal: AgentCurrentPrincipal;
  readonly tokenId: EntityId;
}

export type ConsumeMagicLinkResult =
  | { readonly status: "consumed"; readonly magicLink: MagicLinkRecord }
  | { readonly status: "already_consumed"; readonly magicLink: MagicLinkRecord }
  | { readonly status: "not_found" };

export type RotateDeviceSessionResult =
  | { readonly status: "rotated"; readonly session: DeviceSession }
  | { readonly status: "unavailable" };

export interface RefreshDeviceSessionInput {
  readonly previousTokenHash: Buffer;
  readonly nextTokenHash: Buffer;
  readonly refreshedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

export type RefreshDeviceSessionResult =
  | { readonly status: "rotated"; readonly session: DeviceSession }
  | { readonly status: "reused"; readonly deviceSessionId: EntityId }
  | { readonly status: "unavailable" };

function timestamp(value: unknown): string {
  if (!(value instanceof Date)) {
    throw new TypeError("Expected Postgres to return a timestamptz value as a Date");
  }
  return value.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function mapPublicUser(row: UserRow): User {
  const user = userSchema.parse({
    id: row.id,
    kind: row.kind,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    title: row.title,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
  return user;
}

function mapUser(row: UserRow): IdentityUser {
  const user = mapPublicUser(row);
  return { ...user, email: emailSchema.nullable().parse(row.email) };
}

function mapAgent(row: AgentRow): Agent {
  const disabledAt = nullableTimestamp(row.disabled_at);
  return agentSchema.parse({
    user: {
      id: row.user_id,
      kind: "agent",
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      title: row.title,
      createdAt: timestamp(row.user_created_at),
      updatedAt: timestamp(row.user_updated_at),
    },
    workspaceId: row.workspace_id,
    role: "member",
    status: disabledAt === null ? "active" : "disabled",
    createdBy: row.created_by,
    createdAt: timestamp(row.agent_created_at),
    disabledAt,
  });
}

function mapAgentDirectoryUser(user: Agent["user"]): User {
  // Keep member.updated compatible with the previous released `human | bot` User discriminator.
  // The event is only an invalidation signal; agent administration and /auth/me retain `agent`.
  return userSchema.parse({ ...user, kind: "human" });
}

function mapAgentToken(row: AgentTokenRow): AgentToken {
  return agentTokenSchema.parse({
    id: row.id,
    agentUserId: row.agent_user_id,
    label: row.label,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
    lastUsedAt: nullableTimestamp(row.last_used_at),
    revokedAt: nullableTimestamp(row.revoked_at),
  });
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return workspaceSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapMembership(row: MembershipRow): WorkspaceMembership {
  return workspaceMembershipSchema.parse({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapInvitation(row: InvitationRow): Invitation {
  return invitationSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    expiresAt: timestamp(row.expires_at),
    acceptedAt: nullableTimestamp(row.accepted_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapMagicLink(row: MagicLinkRow): MagicLinkRecord {
  return magicLinkRecordSchema.parse({
    id: row.id,
    email: row.email,
    invitationId: row.invitation_id,
    expiresAt: timestamp(row.expires_at),
    consumedAt: nullableTimestamp(row.consumed_at),
    createdAt: timestamp(row.created_at),
  });
}

function mapDeviceSession(row: DeviceSessionRow): DeviceSession {
  return deviceSessionSchema.parse({
    id: row.id,
    userId: row.user_id,
    label: row.label,
    createdAt: timestamp(row.created_at),
    lastSeenAt: timestamp(row.last_seen_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: nullableTimestamp(row.revoked_at),
  });
}

function firstOrNull<Row extends QueryResultRow, Output>(
  result: QueryResult<Row>,
  mapper: (row: Row) => Output,
): Output | null {
  const row = result.rows[0];
  return row === undefined ? null : mapper(row);
}

function isPool(database: Pool | PoolClient): database is Pool {
  return "totalCount" in database;
}

/** Typed persistence operations for the M1 identity model. */
export class IdentityRepository {
  readonly #database: Pool | PoolClient;
  readonly #transactionPool: Pool | null;

  constructor(database: Pool | PoolClient) {
    this.#database = database;
    this.#transactionPool = isPool(database) ? database : null;
  }

  async transaction<T>(
    fn: (repository: IdentityRepository) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    if (this.#transactionPool === null) {
      throw new Error("Nested identity transactions are not supported");
    }
    return withTransaction(
      this.#transactionPool,
      async (client) => fn(new IdentityRepository(client)),
      options,
    );
  }

  /**
   * Agent lifecycle mutations must publish their `member.updated` sync event on the same
   * connection and transaction as the row changes they describe -- otherwise a rollback could
   * leave a committed event behind, or a commit could leave an agent without one. `#database` is
   * only ever the transactional `PoolClient` once `transaction()` has handed a scoped repository
   * to its callback (see the constructor), so this just asserts that invariant instead of
   * threading an extra client parameter through every caller.
   */
  #requireTransactionalClient(caller: string): PoolClient {
    if (this.#transactionPool !== null) {
      throw new Error(`${caller} must run inside repository.transaction(...)`);
    }
    return this.#database as PoolClient;
  }

  async findUserById(id: EntityId): Promise<IdentityUser | null> {
    const result = await this.#database.query<UserRow>(
      `SELECT id, email, kind, username, display_name, avatar_url, title, created_at, updated_at
         FROM users
        WHERE id = $1 AND kind = 'human'`,
      [id],
    );
    return firstOrNull(result, mapUser);
  }

  async findUserByEmail(email: Email): Promise<IdentityUser | null> {
    const normalizedEmail = emailSchema.parse(email);
    const result = await this.#database.query<UserRow>(
      `SELECT id, email, kind, username, display_name, avatar_url, title, created_at, updated_at
         FROM users
        WHERE email = $1`,
      [normalizedEmail],
    );
    return firstOrNull(result, mapUser);
  }

  async findUserByUsername(username: string): Promise<User | null> {
    const result = await this.#database.query<UserRow>(
      `SELECT id, email, kind, username, display_name, avatar_url, title, created_at, updated_at
         FROM users
        WHERE username = $1`,
      [username],
    );
    return firstOrNull(result, mapPublicUser);
  }

  async insertUser(input: InsertUserInput): Promise<IdentityUser> {
    const result = await this.#database.query<UserRow>(
      `INSERT INTO users (id, email, username, display_name, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, kind, username, display_name, avatar_url, created_at, updated_at`,
      [
        input.id,
        emailSchema.parse(input.email),
        input.username,
        input.displayName,
        input.avatarUrl,
      ],
    );
    return mapUser(result.rows[0] as UserRow);
  }

  /** Updates one active member's display-only title and invalidates every member directory. */
  async updateMemberTitle(
    workspaceId: EntityId,
    userId: EntityId,
    title: MemberTitle | null,
  ): Promise<User> {
    const client = this.#requireTransactionalClient("updateMemberTitle");
    const result = await this.#database.query<UserRow>(
      `UPDATE users AS user_account
          SET title = $3,
              updated_at = clock_timestamp()
         FROM workspace_memberships AS membership
        WHERE user_account.id = $2
          AND membership.workspace_id = $1
          AND membership.user_id = user_account.id
          AND membership.status = 'active'
          AND user_account.kind = 'human'
      RETURNING user_account.id, user_account.email, user_account.kind, user_account.username,
                user_account.display_name, user_account.avatar_url, user_account.title,
                user_account.created_at, user_account.updated_at`,
      [workspaceId, userId, title],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
    const user = mapPublicUser(row);
    await insertSyncEvent(client, {
      workspaceId,
      actorUserId: userId,
      type: "member.updated",
      conversationId: null,
      payload: { member: user },
    });
    return user;
  }

  async findWorkspaceById(id: EntityId): Promise<Workspace | null> {
    const result = await this.#database.query<WorkspaceRow>(
      `SELECT id, name, slug, created_by, created_at, updated_at
         FROM workspaces
        WHERE id = $1`,
      [id],
    );
    return firstOrNull(result, mapWorkspace);
  }

  async findFirstWorkspace(): Promise<Workspace | null> {
    const result = await this.#database.query<WorkspaceRow>(
      `SELECT id, name, slug, created_by, created_at, updated_at
         FROM workspaces
        ORDER BY created_at, id
        LIMIT 1`,
    );
    return firstOrNull(result, mapWorkspace);
  }

  async findWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const result = await this.#database.query<WorkspaceRow>(
      `SELECT id, name, slug, created_by, created_at, updated_at
         FROM workspaces
        WHERE slug = $1`,
      [slug],
    );
    return firstOrNull(result, mapWorkspace);
  }

  async lockWorkspace(id: EntityId): Promise<boolean> {
    const result = await this.#database.query<IdRow>(
      "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE",
      [id],
    );
    return result.rows[0] !== undefined;
  }

  async lockWorkspaceMembership(workspaceId: EntityId, userId: EntityId): Promise<void> {
    await this.#database.query(
      `SELECT 1
         FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2
        FOR UPDATE`,
      [workspaceId, userId],
    );
  }

  async lockWorkspaceIdentity(): Promise<void> {
    await this.#database.query("SELECT pg_advisory_xact_lock($1::bigint)", ["3247861932147782"]);
  }

  async insertWorkspace(input: InsertWorkspaceInput): Promise<Workspace> {
    const result = await this.#database.query<WorkspaceRow>(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, created_by, created_at, updated_at`,
      [input.id, input.name, input.slug, input.createdBy],
    );
    return mapWorkspace(result.rows[0] as WorkspaceRow);
  }

  async countActiveMembers(workspaceId: EntityId): Promise<number> {
    const result = await this.#database.query<CountRow>(
      `SELECT count(*)::integer AS count
         FROM workspace_memberships
        WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId],
    );
    return countRowSchema.parse(result.rows[0]).count;
  }

  async upsertMembership(input: UpsertMembershipInput): Promise<WorkspaceMembership> {
    const result = await this.#database.query<MembershipRow>(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = now()
       RETURNING workspace_id, user_id, role, status, created_at, updated_at`,
      [input.workspaceId, input.userId, input.role, input.status],
    );
    if (input.role === "owner" && input.status === "active") {
      await this.#database.query(
        `INSERT INTO conversations
           (id, workspace_id, kind, name, slug, topic, channel_access, created_by)
         VALUES (
           $1, $2, 'channel', 'General', 'general', 'Workspace-wide conversation', 'workspace', $3
         )
         ON CONFLICT (workspace_id, slug) DO NOTHING`,
        [randomUUID(), input.workspaceId, input.userId],
      );
    }
    return mapMembership(result.rows[0] as MembershipRow);
  }

  async findMembership(
    workspaceId: EntityId,
    userId: EntityId,
  ): Promise<WorkspaceMembership | null> {
    const result = await this.#database.query<MembershipRow>(
      `SELECT workspace_id, user_id, role, status, created_at, updated_at
         FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return firstOrNull(result, mapMembership);
  }

  async findActiveMembershipByUserId(userId: EntityId): Promise<WorkspaceMembership | null> {
    const result = await this.#database.query<MembershipRow>(
      `SELECT workspace_id, user_id, role, status, created_at, updated_at
         FROM workspace_memberships
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at, workspace_id
        LIMIT 1`,
      [userId],
    );
    return firstOrNull(result, mapMembership);
  }

  async findActiveOwnerMembership(workspaceId: EntityId): Promise<WorkspaceMembership | null> {
    const result = await this.#database.query<MembershipRow>(
      `SELECT workspace_id, user_id, role, status, created_at, updated_at
         FROM workspace_memberships
        WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'
        ORDER BY created_at, user_id
        LIMIT 1`,
      [workspaceId],
    );
    return firstOrNull(result, mapMembership);
  }

  async listActiveMembers(workspaceId: EntityId): Promise<WorkspaceMembership[]> {
    const result = await this.#database.query<MembershipRow>(
      `SELECT workspace_id, user_id, role, status, created_at, updated_at
         FROM workspace_memberships
        WHERE workspace_id = $1 AND status = 'active'
        ORDER BY created_at, user_id`,
      [workspaceId],
    );
    return result.rows.map(mapMembership);
  }

  async insertInvitation(input: InsertInvitationInput): Promise<Invitation> {
    const result = await this.#database.query<InvitationRow>(
      `INSERT INTO invitations
         (id, workspace_id, email, role, status, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
                 created_at, updated_at`,
      [
        input.id,
        input.workspaceId,
        emailSchema.parse(input.email),
        input.role,
        input.invitedBy,
        input.expiresAt,
      ],
    );
    return mapInvitation(result.rows[0] as InvitationRow);
  }

  async findPendingInvitation(workspaceId: EntityId, email: Email): Promise<Invitation | null> {
    const result = await this.#database.query<InvitationRow>(
      `SELECT id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
              created_at, updated_at
         FROM invitations
        WHERE workspace_id = $1 AND email = $2 AND status = 'pending'`,
      [workspaceId, emailSchema.parse(email)],
    );
    return firstOrNull(result, mapInvitation);
  }

  async findPendingInvitationByEmail(email: Email): Promise<Invitation | null> {
    const result = await this.#database.query<InvitationRow>(
      `SELECT id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
              created_at, updated_at
         FROM invitations
        WHERE email = $1 AND status = 'pending'
        ORDER BY created_at DESC, id
        LIMIT 1`,
      [emailSchema.parse(email)],
    );
    return firstOrNull(result, mapInvitation);
  }

  async findInvitationById(id: EntityId, lock = false): Promise<Invitation | null> {
    const result = await this.#database.query<InvitationRow>(
      `SELECT id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
              created_at, updated_at
         FROM invitations
        WHERE id = $1
        ${lock ? "FOR UPDATE" : ""}`,
      [id],
    );
    return firstOrNull(result, mapInvitation);
  }

  async listInvitations(workspaceId: EntityId): Promise<Invitation[]> {
    const result = await this.#database.query<InvitationRow>(
      `SELECT id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
              created_at, updated_at
         FROM invitations
        WHERE workspace_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1000`,
      [workspaceId],
    );
    return result.rows.map(mapInvitation);
  }

  async markInvitationAccepted(id: EntityId, acceptedAt: IsoDateTime): Promise<Invitation | null> {
    const result = await this.#database.query<InvitationRow>(
      `UPDATE invitations
          SET status = 'accepted', accepted_at = $2, updated_at = now()
        WHERE id = $1 AND status = 'pending' AND expires_at > $2
        RETURNING id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
                  created_at, updated_at`,
      [id, acceptedAt],
    );
    return firstOrNull(result, mapInvitation);
  }

  async markInvitationRevoked(id: EntityId): Promise<Invitation | null> {
    const result = await this.#database.query<InvitationRow>(
      `UPDATE invitations
          SET status = 'revoked', updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
                  created_at, updated_at`,
      [id],
    );
    return firstOrNull(result, mapInvitation);
  }

  async expireInvitations(expiredBefore: IsoDateTime): Promise<number> {
    const result = await this.#database.query(
      `UPDATE invitations
          SET status = 'expired', updated_at = now()
        WHERE status = 'pending' AND expires_at <= $1`,
      [expiredBefore],
    );
    return result.rowCount ?? 0;
  }

  async insertMagicLink(input: InsertMagicLinkInput): Promise<MagicLinkRecord> {
    const result = await this.#database.query<MagicLinkRow>(
      `INSERT INTO magic_link_tokens
         (id, token_hash, email, invitation_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, invitation_id, expires_at, consumed_at, created_at`,
      [
        input.id,
        input.tokenHash,
        emailSchema.parse(input.email),
        input.invitationId,
        input.expiresAt,
        input.createdAt,
      ],
    );
    return mapMagicLink(result.rows[0] as MagicLinkRow);
  }

  async findMagicLinkByTokenHash(tokenHash: Buffer): Promise<MagicLinkRecord | null> {
    const result = await this.#database.query<MagicLinkRow>(
      `SELECT id, email, invitation_id, expires_at, consumed_at, created_at
         FROM magic_link_tokens
        WHERE token_hash = $1`,
      [tokenHash],
    );
    return firstOrNull(result, mapMagicLink);
  }

  async consumeMagicLink(
    tokenHash: Buffer,
    consumedAt: IsoDateTime,
  ): Promise<ConsumeMagicLinkResult> {
    const result = await this.#database.query<MagicLinkRow>(
      `UPDATE magic_link_tokens
          SET consumed_at = $2
        WHERE token_hash = $1 AND consumed_at IS NULL
        RETURNING id, email, invitation_id, expires_at, consumed_at, created_at`,
      [tokenHash, consumedAt],
    );
    const consumed = firstOrNull(result, mapMagicLink);
    if (consumed !== null) return { status: "consumed", magicLink: consumed };

    const existing = await this.findMagicLinkByTokenHash(tokenHash);
    return existing === null
      ? { status: "not_found" }
      : { status: "already_consumed", magicLink: existing };
  }

  async insertDeviceSession(input: InsertDeviceSessionInput): Promise<DeviceSession> {
    const result = await this.#database.query<DeviceSessionRow>(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, label, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at`,
      [
        input.id,
        input.userId,
        input.tokenHash,
        input.label,
        input.createdAt,
        input.lastSeenAt,
        input.expiresAt,
      ],
    );
    return mapDeviceSession(result.rows[0] as DeviceSessionRow);
  }

  async findDeviceSessionByTokenHash(tokenHash: Buffer): Promise<DeviceSession | null> {
    const result = await this.#database.query<DeviceSessionRow>(
      `SELECT id, user_id, label, created_at, last_seen_at, expires_at, revoked_at
         FROM device_sessions
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return firstOrNull(result, mapDeviceSession);
  }

  /**
   * Revokes the presented local credential and returns its optional provider session identifier in
   * the same statement. A malformed legacy value is treated as absent after the local revocation;
   * upstream logout metadata must never be able to make local sign-out fail.
   */
  async revokeDeviceSessionByTokenHash(
    tokenHash: Buffer,
    revokedAt: IsoDateTime,
  ): Promise<AuthKitProviderSessionId | null> {
    const result = await this.#database.query<RevokedDeviceSessionProviderRow>(
      `WITH target AS MATERIALIZED (
         SELECT id, workos_session_id
           FROM device_sessions
          WHERE token_hash = $1 AND revoked_at IS NULL
          FOR UPDATE
       ),
       revoked AS (
         UPDATE device_sessions AS session
            SET revoked_at = $2,
                workos_session_id = NULL
           FROM target
          WHERE session.id = target.id AND session.revoked_at IS NULL
         RETURNING target.workos_session_id
       )
       SELECT workos_session_id FROM revoked`,
      [tokenHash, revokedAt],
    );
    const parsed = authKitProviderSessionIdSchema.safeParse(result.rows[0]?.workos_session_id);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Rotation is also the renewal point of the sliding refresh window: `expiresAt`, when given,
   * moves the stored expiry forward, and omitting it leaves the expiry untouched. The guard is
   * evaluated against the pre-update row, so a revoked or already-expired session is still refused
   * and no renewal can bring one back to life.
   */
  async rotateDeviceSession(
    previousTokenHash: Buffer,
    nextTokenHash: Buffer,
    lastSeenAt: IsoDateTime,
    expiresAt?: IsoDateTime,
  ): Promise<RotateDeviceSessionResult> {
    const result = await this.#database.query<DeviceSessionRow>(
      `UPDATE device_sessions
          SET token_hash = $2,
              last_seen_at = $3,
              expires_at = coalesce($4::timestamptz, expires_at)
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $3
        RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at`,
      [previousTokenHash, nextTokenHash, lastSeenAt, expiresAt ?? null],
    );
    const session = firstOrNull(result, mapDeviceSession);
    return session === null ? { status: "unavailable" } : { status: "rotated", session };
  }

  /**
   * Rotate a refresh credential or revoke its device lineage when a historical credential is
   * presented after its rotation committed. The update captures its starting MVCC snapshot while
   * remaining the only statement on the normal path. If a concurrent rotation wins the row lock,
   * its transaction is absent from this attempt's snapshot and must not be mistaken for reuse.
   */
  async refreshDeviceSession(
    input: RefreshDeviceSessionInput,
  ): Promise<RefreshDeviceSessionResult> {
    return this.transaction(async (repository) => {
      const rotation = await repository.#database.query<DeviceSessionRotationRow>(
        `WITH rotation_attempt AS MATERIALIZED (
           SELECT pg_current_snapshot() AS snapshot
         ), rotated AS (
           UPDATE device_sessions
              SET token_hash = $2,
                  last_seen_at = $3,
                  expires_at = $4
             FROM rotation_attempt
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $3
           RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at
         )
         SELECT rotation_attempt.snapshot::text AS rotation_snapshot,
                rotated.id, rotated.user_id, rotated.label, rotated.created_at,
                rotated.last_seen_at, rotated.expires_at, rotated.revoked_at
           FROM rotation_attempt
           LEFT JOIN rotated ON true`,
        [input.previousTokenHash, input.nextTokenHash, input.refreshedAt, input.expiresAt],
      );
      const row = rotation.rows[0];
      if (row === undefined || typeof row.rotation_snapshot !== "string") {
        throw new TypeError("Expected Postgres to return the rotation snapshot as text");
      }
      if (typeof row.id === "string") {
        return { status: "rotated", session: mapDeviceSession(row) };
      }

      const history = await repository.#database.query<IdRow>(
        `SELECT device_session_id AS id
           FROM device_session_token_history
          WHERE token_hash = $1
            AND expires_at > $2
            AND pg_visible_in_snapshot(rotation_xid, $3::pg_snapshot)`,
        [input.previousTokenHash, input.refreshedAt, row.rotation_snapshot],
      );
      const deviceSessionId = history.rows[0]?.id;
      if (typeof deviceSessionId !== "string") return { status: "unavailable" };

      const id = entityIdSchema.parse(deviceSessionId);
      await repository.revokeDeviceSession(id, input.refreshedAt);
      return { status: "reused", deviceSessionId: id };
    });
  }

  async deleteExpiredDeviceSessionTokenHistory(expiredAt: IsoDateTime): Promise<number> {
    const result = await this.#database.query(
      "DELETE FROM device_session_token_history WHERE expires_at <= $1",
      [expiredAt],
    );
    return result.rowCount ?? 0;
  }

  async revokeDeviceSession(id: EntityId, revokedAt: IsoDateTime): Promise<DeviceSession | null> {
    const result = await this.#database.query<DeviceSessionRow>(
      `UPDATE device_sessions
          SET revoked_at = $2,
              workos_session_id = NULL
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at`,
      [id, revokedAt],
    );
    return firstOrNull(result, mapDeviceSession);
  }

  async revokeDeviceSessionForUser(
    id: EntityId,
    userId: EntityId,
    revokedAt: IsoDateTime,
  ): Promise<DeviceSession | null> {
    const result = await this.#database.query<DeviceSessionRow>(
      `UPDATE device_sessions
          SET revoked_at = $3,
              workos_session_id = NULL
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at`,
      [id, userId, revokedAt],
    );
    return firstOrNull(result, mapDeviceSession);
  }

  async revokeAllDeviceSessions(userId: EntityId, revokedAt: IsoDateTime): Promise<number> {
    const result = await this.#database.query(
      `UPDATE device_sessions
          SET revoked_at = $2,
              workos_session_id = NULL
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  async listDeviceSessions(userId: EntityId): Promise<DeviceSession[]> {
    const result = await this.#database.query<DeviceSessionRow>(
      `SELECT id, user_id, label, created_at, last_seen_at, expires_at, revoked_at
         FROM device_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC, id`,
      [userId],
    );
    return result.rows.map(mapDeviceSession);
  }

  async insertAgent(input: InsertAgentInput): Promise<Agent> {
    // Must be inside repository.transaction(...): the user/membership/agent rows and the
    // member.updated sync event below have to commit or roll back together. The event only
    // invalidates the client's member directory, so if it committed without the rows the client
    // would re-read a directory that does not contain the agent yet -- and if the rows committed
    // without the event, an already-bootstrapped client would never learn to re-read at all.
    const client = this.#requireTransactionalClient("insertAgent");
    await this.#database.query(
      `INSERT INTO users (id, email, username, display_name, avatar_url, kind)
       VALUES ($1, NULL, $2, $3, NULL, 'agent')`,
      [input.id, input.username, input.displayName],
    );
    await this.upsertMembership({
      workspaceId: input.workspaceId,
      userId: input.id,
      role: "member",
      status: "active",
    });
    await this.#database.query(
      `INSERT INTO agents (user_id, workspace_id, created_by)
       VALUES ($1, $2, $3)`,
      [input.id, input.workspaceId, input.createdBy],
    );
    const agent = await this.findAgent(input.workspaceId, input.id);
    if (agent === null) throw new Error("Agent insert returned no row");
    // member.updated invalidates the recipient's workspace member directory: it announces THAT
    // the directory changed, not what it now is. Clients re-read GET /v1/members (or bootstrap)
    // and replace their list; they must not upsert this payload. See the doc comment on
    // memberUpdatedEventSchema for why the payload cannot be authoritative.
    //
    // Audience omitted: defaults to every active workspace member, same as workspace mutations,
    // so every already-bootstrapped client is told to re-read and picks up the new agent.
    await insertSyncEvent(client, {
      workspaceId: input.workspaceId,
      actorUserId: input.createdBy,
      type: "member.updated",
      conversationId: null,
      payload: { member: mapAgentDirectoryUser(agent.user) },
    });
    return agent;
  }

  async findAgent(workspaceId: EntityId, userId: EntityId): Promise<Agent | null> {
    const result = await this.#database.query<AgentRow>(
      `SELECT agent.user_id,
              agent.workspace_id,
              user_account.username,
              user_account.display_name,
              user_account.avatar_url,
              user_account.title,
              user_account.created_at AS user_created_at,
              user_account.updated_at AS user_updated_at,
              agent.created_by,
              agent.created_at AS agent_created_at,
              agent.disabled_at
         FROM agents AS agent
         JOIN users AS user_account ON user_account.id = agent.user_id
        WHERE agent.workspace_id = $1 AND agent.user_id = $2`,
      [workspaceId, userId],
    );
    return firstOrNull(result, mapAgent);
  }

  async listAgents(workspaceId: EntityId): Promise<Agent[]> {
    const result = await this.#database.query<AgentRow>(
      `SELECT agent.user_id,
              agent.workspace_id,
              user_account.username,
              user_account.display_name,
              user_account.avatar_url,
              user_account.title,
              user_account.created_at AS user_created_at,
              user_account.updated_at AS user_updated_at,
              agent.created_by,
              agent.created_at AS agent_created_at,
              agent.disabled_at
         FROM agents AS agent
        JOIN users AS user_account ON user_account.id = agent.user_id
        WHERE agent.workspace_id = $1
        ORDER BY agent.created_at, agent.user_id
        LIMIT 1000`,
      [workspaceId],
    );
    return result.rows.map(mapAgent);
  }

  async disableAgent(
    workspaceId: EntityId,
    userId: EntityId,
    disabledAt: IsoDateTime,
    actorUserId: EntityId,
  ): Promise<void> {
    // Same transactional requirement as insertAgent: the membership revocation and the
    // member.updated event must commit or roll back together, or a disabled agent could linger
    // as a stale mention target for clients that never hear about the change.
    const client = this.#requireTransactionalClient("disableAgent");
    // Only rows that are still enabled match this WHERE, so rowCount tells us whether this call
    // is the one that actually transitioned the agent -- a repeat disable (disabled_at already
    // set) updates nothing here and must not fan out another member.updated event, even though
    // the membership/token revocations below stay idempotent and safe to re-run regardless.
    const disableResult = await this.#database.query(
      `UPDATE agents
          SET disabled_at = $3
        WHERE workspace_id = $1 AND user_id = $2 AND disabled_at IS NULL`,
      [workspaceId, userId, disabledAt],
    );
    const didTransition = (disableResult.rowCount ?? 0) > 0;
    await this.#database.query(
      `UPDATE workspace_memberships
          SET status = 'revoked', updated_at = $3
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId, disabledAt],
    );
    await this.#database.query(
      `UPDATE agent_tokens
          SET revoked_at = coalesce(revoked_at, $3)
        WHERE workspace_id = $1 AND agent_user_id = $2`,
      [workspaceId, userId, disabledAt],
    );
    if (!didTransition) return;
    const agent = await this.findAgent(workspaceId, userId);
    if (agent === null) throw new Error("disableAgent could not find the agent it just updated");
    // Same contract as insertAgent: this invalidates the recipient's member directory rather
    // than describing the agent's new state. That is what makes disable work at all -- the
    // payload's User cannot say "removed" (userSchema has no status field), but the directory
    // the client re-reads is already correct, because GET /v1/members and bootstrap both join
    // workspace_memberships on status = 'active' and the UPDATE above set 'revoked'.
    //
    // The membership row above is already 'revoked', so the default active-member audience
    // correctly excludes the agent itself while still reaching every other bootstrapped client.
    await insertSyncEvent(client, {
      workspaceId,
      actorUserId,
      type: "member.updated",
      conversationId: null,
      payload: { member: mapAgentDirectoryUser(agent.user) },
    });
  }

  async insertAgentToken(input: InsertAgentTokenInput): Promise<AgentToken> {
    const result = await this.#database.query<AgentTokenRow>(
      `INSERT INTO agent_tokens (
         id, workspace_id, agent_user_id, token_hash, label, scopes, created_by, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)
       RETURNING id, agent_user_id, label, scopes, created_by, created_at, last_used_at, revoked_at`,
      [
        input.id,
        input.workspaceId,
        input.agentUserId,
        input.tokenHash,
        input.label,
        [...input.scopes],
        input.createdBy,
        input.createdAt,
      ],
    );
    return mapAgentToken(result.rows[0] as AgentTokenRow);
  }

  async listAgentTokens(workspaceId: EntityId, agentUserId: EntityId): Promise<AgentToken[]> {
    const result = await this.#database.query<AgentTokenRow>(
      `SELECT id, agent_user_id, label, scopes, created_by, created_at, last_used_at, revoked_at
        FROM agent_tokens
        WHERE workspace_id = $1 AND agent_user_id = $2
        ORDER BY created_at, id
        LIMIT 1000`,
      [workspaceId, agentUserId],
    );
    return result.rows.map(mapAgentToken);
  }

  async revokeAgentToken(
    workspaceId: EntityId,
    agentUserId: EntityId,
    tokenId: EntityId,
    revokedAt: IsoDateTime,
  ): Promise<boolean> {
    const result = await this.#database.query<IdRow>(
      `UPDATE agent_tokens
          SET revoked_at = coalesce(revoked_at, $4)
        WHERE workspace_id = $1 AND agent_user_id = $2 AND id = $3
        RETURNING id`,
      [workspaceId, agentUserId, tokenId, revokedAt],
    );
    return result.rows[0] !== undefined;
  }

  async authenticateAgentToken(
    tokenHash: Buffer,
    usedAt: IsoDateTime,
  ): Promise<AuthenticatedAgent | null> {
    const result = await this.#database.query<AuthenticatedAgentRow>(
      `SELECT token.id AS token_id,
              token.workspace_id,
              token.agent_user_id AS user_id,
              user_account.username,
              user_account.display_name,
              user_account.avatar_url,
              user_account.title,
              user_account.created_at AS user_created_at,
              user_account.updated_at AS user_updated_at,
              membership.role,
              token.scopes,
              token.last_used_at
         FROM agent_tokens AS token
         JOIN agents AS agent
           ON agent.user_id = token.agent_user_id
          AND agent.workspace_id = token.workspace_id
         JOIN users AS user_account
           ON user_account.id = agent.user_id
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = token.workspace_id
          AND membership.user_id = token.agent_user_id
        WHERE token.token_hash = $1
          AND token.revoked_at IS NULL
          AND agent.disabled_at IS NULL
          AND user_account.kind = 'agent'
          AND membership.status = 'active'
          AND membership.role = 'member'`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    // `last_used_at` is an audit breadcrumb, not a session clock. Writing it on every request
    // turns each authentication into a write that takes a row lock, so concurrent requests
    // carrying the same token serialize on it. Refreshing at most once per interval keeps the
    // breadcrumb useful and leaves the hot path a lock-free read.
    const lastUsedAt = nullableTimestamp(row.last_used_at);
    const staleBefore = new Date(
      Date.parse(usedAt) - AGENT_TOKEN_LAST_USED_REFRESH_MS,
    ).toISOString();
    if (lastUsedAt === null || lastUsedAt < staleBefore) {
      await this.#database.query(
        `UPDATE agent_tokens
            SET last_used_at = $2
          WHERE id = $1
            AND (last_used_at IS NULL OR last_used_at < $3)`,
        [row.token_id, usedAt, staleBefore],
      );
    }

    return {
      tokenId: entityIdSchema.parse(row.token_id),
      principal: agentCurrentPrincipalSchema.parse({
        type: "agent",
        user: {
          id: row.user_id,
          kind: "agent",
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          createdAt: timestamp(row.user_created_at),
          updatedAt: timestamp(row.user_updated_at),
        },
        workspaceId: row.workspace_id,
        role: row.role,
        scopes: row.scopes,
      }),
    };
  }
}
