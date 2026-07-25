import { randomUUID } from "node:crypto";

import {
  deviceSessionSchema,
  emailSchema,
  entityIdSchema,
  invitationSchema,
  isoDateTimeSchema,
  userSchema,
  workspaceMembershipSchema,
  workspaceSchema,
  type DeviceSession,
  type Email,
  type EntityId,
  type Invitation,
  type IsoDateTime,
  type MembershipStatus,
  type User,
  type Workspace,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "@hmm-chat/contracts";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { z } from "zod";

import { withTransaction } from "../../db/pool.js";

interface UserRow extends QueryResultRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly avatar_url: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

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

export type IdentityUser = User & { readonly email: Email };
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

export type ConsumeMagicLinkResult =
  | { readonly status: "consumed"; readonly magicLink: MagicLinkRecord }
  | { readonly status: "already_consumed"; readonly magicLink: MagicLinkRecord }
  | { readonly status: "not_found" };

export type RotateDeviceSessionResult =
  | { readonly status: "rotated"; readonly session: DeviceSession }
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

function mapUser(row: UserRow): IdentityUser {
  const user = userSchema.parse({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
  return { ...user, email: emailSchema.parse(row.email) };
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

  async transaction<T>(fn: (repository: IdentityRepository) => Promise<T>): Promise<T> {
    if (this.#transactionPool === null) {
      throw new Error("Nested identity transactions are not supported");
    }
    return withTransaction(this.#transactionPool, async (client) =>
      fn(new IdentityRepository(client)),
    );
  }

  async findUserById(id: EntityId): Promise<IdentityUser | null> {
    const result = await this.#database.query<UserRow>(
      `SELECT id, email, username, display_name, avatar_url, created_at, updated_at
         FROM users
        WHERE id = $1`,
      [id],
    );
    return firstOrNull(result, mapUser);
  }

  async findUserByEmail(email: Email): Promise<IdentityUser | null> {
    const normalizedEmail = emailSchema.parse(email);
    const result = await this.#database.query<UserRow>(
      `SELECT id, email, username, display_name, avatar_url, created_at, updated_at
         FROM users
        WHERE email = $1`,
      [normalizedEmail],
    );
    return firstOrNull(result, mapUser);
  }

  async findUserByUsername(username: string): Promise<IdentityUser | null> {
    const result = await this.#database.query<UserRow>(
      `SELECT id, email, username, display_name, avatar_url, created_at, updated_at
         FROM users
        WHERE username = $1`,
      [username],
    );
    return firstOrNull(result, mapUser);
  }

  async insertUser(input: InsertUserInput): Promise<IdentityUser> {
    const result = await this.#database.query<UserRow>(
      `INSERT INTO users (id, email, username, display_name, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, username, display_name, avatar_url, created_at, updated_at`,
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

  async lockPilotIdentity(): Promise<void> {
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
           (id, workspace_id, kind, name, slug, topic, created_by)
         VALUES ($1, $2, 'channel', 'General', 'general', 'Workspace-wide conversation', $3)
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

  async findInvitationById(id: EntityId): Promise<Invitation | null> {
    const result = await this.#database.query<InvitationRow>(
      `SELECT id, workspace_id, email, role, status, invited_by, expires_at, accepted_at,
              created_at, updated_at
         FROM invitations
        WHERE id = $1`,
      [id],
    );
    return firstOrNull(result, mapInvitation);
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

  async rotateDeviceSession(
    previousTokenHash: Buffer,
    nextTokenHash: Buffer,
    lastSeenAt: IsoDateTime,
  ): Promise<RotateDeviceSessionResult> {
    const result = await this.#database.query<DeviceSessionRow>(
      `UPDATE device_sessions
          SET token_hash = $2, last_seen_at = $3
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $3
        RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at`,
      [previousTokenHash, nextTokenHash, lastSeenAt],
    );
    const session = firstOrNull(result, mapDeviceSession);
    return session === null ? { status: "unavailable" } : { status: "rotated", session };
  }

  async revokeDeviceSession(id: EntityId, revokedAt: IsoDateTime): Promise<DeviceSession | null> {
    const result = await this.#database.query<DeviceSessionRow>(
      `UPDATE device_sessions
          SET revoked_at = $2
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
          SET revoked_at = $3
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id, user_id, label, created_at, last_seen_at, expires_at, revoked_at`,
      [id, userId, revokedAt],
    );
    return firstOrNull(result, mapDeviceSession);
  }

  async revokeAllDeviceSessions(userId: EntityId, revokedAt: IsoDateTime): Promise<number> {
    const result = await this.#database.query(
      `UPDATE device_sessions
          SET revoked_at = $2
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
}
