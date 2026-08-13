import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  authKitProviderSessionIdSchema,
  emailSchema,
  entityIdSchema,
  isoDateTimeSchema,
  sessionTokenSchema,
  type EntityId,
  type IsoDateTime,
  type SessionToken,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { withTransaction } from "../../db/pool.js";
import { issueToken } from "./tokens.js";

const AUTHKIT_HANDOFF_TTL_MS = 5 * 60 * 1_000;
const WORKOS_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_MEMBERS = 25;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PROVIDER_STATE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const WORKOS_EVENT_ID_PATTERN = /^event_[A-Za-z0-9]+$/;
const WORKOS_SESSION_ID_PATTERN = /^session_[A-Za-z0-9]+$/;
const WORKOS_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

interface AuthKitTransactionRow extends QueryResultRow {
  readonly id: string;
  readonly provider_state_hash: Buffer;
  readonly verifier_nonce: Buffer | null;
  readonly verifier_ciphertext: Buffer | null;
  readonly verifier_authentication_tag: Buffer | null;
  readonly desktop_code_challenge: string;
  readonly desktop_state: string;
  readonly expires_at: Date;
}

interface ExternalIdentityLocatorRow extends QueryResultRow {
  readonly user_id: string;
}

interface ExternalIdentityRow extends QueryResultRow {
  readonly provider_subject: string;
  readonly user_id: string;
}

interface HumanUserRow extends QueryResultRow {
  readonly id: string;
  readonly email: string;
}

interface MembershipRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly role: "owner" | "member";
  readonly status: "invited" | "active" | "revoked";
}

interface ActiveHumanRow extends HumanUserRow, MembershipRow {}

interface InvitationRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: "member";
}

interface CountRow extends QueryResultRow {
  readonly count: number;
}

interface HandoffRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly desktop_code_challenge: string;
  readonly workos_session_id: string;
}

interface DeletedAuthKitStateRow extends QueryResultRow {
  readonly transactions: number;
  readonly handoffs: number;
  readonly events: number;
  readonly sessions: number;
}

interface RevokedAuthKitSessionsRow extends QueryResultRow {
  readonly active: number;
  readonly revoked: number;
}

interface PreparedAuthKitRollbackRow extends RevokedAuthKitSessionsRow {
  readonly transactions: number;
  readonly handoffs: number;
  readonly events: number;
  readonly session_links: number;
}

interface ActiveAuthKitDeviceSessionRow extends QueryResultRow {
  readonly device_session_id: unknown;
  readonly provider_subject: unknown;
  readonly workos_session_id: unknown;
}

export interface CreateAuthKitTransactionInput {
  readonly providerState: string;
  readonly providerCodeVerifier: string;
  readonly desktopCodeChallenge: string;
  readonly desktopState: string;
  readonly expiresAt: Date;
}

export type ConsumedAuthKitTransaction = CreateAuthKitTransactionInput;

export interface AdmitAuthKitIdentityInput {
  readonly providerSubject: string;
  readonly verifiedEmail: string;
  readonly workosSessionId: string;
  readonly desktopCodeChallenge: string;
  readonly now: Date;
}

export interface AuthKitHandoff {
  readonly handoffCode: string;
  readonly expiresAt: Date;
}

export interface ExchangeAuthKitHandoffInput {
  readonly handoffCode: string;
  readonly codeVerifier: string;
  readonly label: string | null;
  readonly now: Date;
}

export interface ExchangedAuthKitSession {
  readonly token: SessionToken;
  readonly expiresAt: IsoDateTime;
  readonly userId: EntityId;
}

export interface ApplyWorkOSSessionRevokedEventInput {
  readonly eventId: string;
  readonly workosSessionId: string;
  readonly occurredAt: Date;
  readonly now: Date;
}

export interface DeletedAuthKitState {
  readonly transactions: number;
  readonly handoffs: number;
  readonly events: number;
  readonly sessions: number;
}

export interface ActiveAuthKitDeviceSession {
  readonly deviceSessionId: EntityId;
  readonly providerSubject: string;
  readonly workosSessionId: string;
}

export interface RevokedAuthKitSessions {
  /** Active AuthKit-created local sessions observed while their rows were locked. */
  readonly active: number;
  /** Sessions transitioned to revoked by this operation. */
  readonly revoked: number;
}

export interface PreparedAuthKitRollback extends RevokedAuthKitSessions {
  readonly transactions: number;
  readonly handoffs: number;
  readonly events: number;
  readonly sessionLinks: number;
}

export class AuthKitAdmissionDeniedError extends Error {
  constructor() {
    super("AuthKit identity admission was denied");
    this.name = "AuthKitAdmissionDeniedError";
  }
}

export class AuthKitCredentialRejectedError extends Error {
  constructor() {
    super("AuthKit credential was rejected");
    this.name = "AuthKitCredentialRejectedError";
  }
}

function hashCredential(credential: string): Buffer {
  return createHash("sha256").update(credential, "utf8").digest();
}

function requirePattern(value: string, pattern: RegExp, description: string): string {
  if (!pattern.test(value)) throw new TypeError(`Expected ${description}`);
  return value;
}

function requireWorkOSId(value: string, pattern: RegExp, description: string): string {
  if (value.length > 255) throw new TypeError(`Expected ${description}`);
  return requirePattern(value, pattern, description);
}

function requireDate(value: Date, description: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Expected ${description}`);
  }
  return value;
}

function requireLabel(value: string | null): string | null {
  if (value !== null && value.length > 200) {
    throw new TypeError("Expected a device label no longer than 200 characters");
  }
  return value;
}

function transactionAssociatedData(input: {
  readonly id: string;
  readonly providerStateHash: Uint8Array;
  readonly desktopCodeChallenge: string;
  readonly desktopState: string;
  readonly expiresAt: Date;
}): Buffer {
  return Buffer.from(
    [
      "hype-comms:authkit-transaction:v1",
      input.id,
      Buffer.from(input.providerStateHash).toString("base64url"),
      input.desktopCodeChallenge,
      input.desktopState,
      input.expiresAt.toISOString(),
    ].join("\0"),
    "utf8",
  );
}

function encryptVerifier(
  encryptionKey: Uint8Array,
  verifier: string,
  associatedData: Uint8Array,
): { readonly nonce: Buffer; readonly ciphertext: Buffer; readonly authenticationTag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
  return { nonce, ciphertext, authenticationTag: cipher.getAuthTag() };
}

function decryptVerifier(
  encryptionKey: Uint8Array,
  encrypted: {
    readonly nonce: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly authenticationTag: Uint8Array;
  },
  associatedData: Uint8Array,
): string {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, encrypted.nonce);
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(encrypted.authenticationTag));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export function deriveAuthKitPkceCodeChallenge(verifier: string): string {
  const parsed = requirePattern(verifier, PKCE_VERIFIER_PATTERN, "an RFC 7636 code verifier");
  return createHash("sha256").update(parsed, "ascii").digest("base64url");
}

function verifyPkceCodeChallenge(verifier: string, expectedChallenge: string): boolean {
  const actual = Buffer.from(deriveAuthKitPkceCodeChallenge(verifier), "ascii");
  const expected = Buffer.from(expectedChallenge, "ascii");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function usernameBase(email: string): string {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  const sanitized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 80) || "member";
}

function displayName(email: string): string {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  return localPart.trim().slice(0, 80) || "Member";
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

/**
 * Emergency rollback boundary that deliberately needs only PostgreSQL, not a working WorkOS
 * provider or the transaction-encryption key.
 */
export async function revokeAllActiveAuthKitSessions(
  pool: Pool,
  nowValue: Date,
): Promise<RevokedAuthKitSessions> {
  const now = requireDate(nowValue, "an AuthKit bulk revocation date");

  return withTransaction(pool, async (client) => {
    const result = await client.query<RevokedAuthKitSessionsRow>(
      `WITH active_authkit_sessions AS MATERIALIZED (
         SELECT id
           FROM device_sessions
          WHERE workos_session_id IS NOT NULL
            AND revoked_at IS NULL
          FOR UPDATE
       ),
       revoked_authkit_sessions AS (
         UPDATE device_sessions AS session
            SET revoked_at = $1,
                workos_session_id = NULL
           FROM active_authkit_sessions AS active
          WHERE session.id = active.id
            AND session.workos_session_id IS NOT NULL
            AND session.revoked_at IS NULL
         RETURNING session.id
       )
       SELECT (SELECT count(*)::integer FROM active_authkit_sessions) AS active,
              (SELECT count(*)::integer FROM revoked_authkit_sessions) AS revoked`,
      [now],
    );
    const counts = result.rows[0];
    if (counts === undefined) throw new Error("AuthKit bulk revocation returned no result");
    return { active: counts.active, revoked: counts.revoked };
  });
}

/**
 * Final pre-rollback boundary. Once admission is gated, serving instances are drained, and
 * webhook delivery is disabled, this atomically revokes every remaining linked local session,
 * removes every provider link, and purges state an older binary would not know how to maintain.
 */
export async function prepareAuthKitRollback(
  pool: Pool,
  nowValue: Date,
): Promise<PreparedAuthKitRollback> {
  const now = requireDate(nowValue, "an AuthKit rollback preparation date");
  return withTransaction(pool, async (client) => {
    const result = await client.query<PreparedAuthKitRollbackRow>(
      `WITH linked_authkit_sessions AS MATERIALIZED (
         SELECT id, revoked_at
           FROM device_sessions
          WHERE workos_session_id IS NOT NULL
          FOR UPDATE
       ),
       retired_authkit_sessions AS (
         UPDATE device_sessions AS session
            SET revoked_at = COALESCE(session.revoked_at, $1),
                workos_session_id = NULL
           FROM linked_authkit_sessions AS linked
          WHERE session.id = linked.id
            AND session.workos_session_id IS NOT NULL
         RETURNING linked.revoked_at AS previous_revoked_at
       ),
       deleted_transactions AS (
         DELETE FROM authkit_transactions
         RETURNING 1
       ),
       deleted_handoffs AS (
         DELETE FROM authkit_handoffs
         RETURNING 1
       ),
       deleted_events AS (
         DELETE FROM workos_events
         RETURNING 1
       )
       SELECT (
                SELECT count(*)::integer
                  FROM linked_authkit_sessions
                 WHERE revoked_at IS NULL
              ) AS active,
              (
                SELECT count(*)::integer
                  FROM retired_authkit_sessions
                 WHERE previous_revoked_at IS NULL
              ) AS revoked,
              (SELECT count(*)::integer FROM deleted_transactions) AS transactions,
              (SELECT count(*)::integer FROM deleted_handoffs) AS handoffs,
              (SELECT count(*)::integer FROM deleted_events) AS events,
              (SELECT count(*)::integer FROM retired_authkit_sessions) AS session_links`,
      [now],
    );
    const prepared = result.rows[0];
    if (prepared === undefined) throw new Error("AuthKit rollback preparation returned no result");
    return {
      active: prepared.active,
      revoked: prepared.revoked,
      transactions: prepared.transactions,
      handoffs: prepared.handoffs,
      events: prepared.events,
      sessionLinks: prepared.session_links,
    };
  });
}

/**
 * Provider-independent retention. This deliberately needs only the database so secret loss or a
 * provider rollback cannot strand encrypted one-use state or no-longer-needed provider links.
 */
export async function deleteExpiredAuthKitState(
  pool: Pool,
  nowValue: Date,
): Promise<DeletedAuthKitState> {
  const now = requireDate(nowValue, "an AuthKit state cleanup date");
  const eventsBefore = new Date(now.getTime() - WORKOS_EVENT_RETENTION_MS);
  const result = await pool.query<DeletedAuthKitStateRow>(
    `WITH deleted_transactions AS (
       DELETE FROM authkit_transactions
        WHERE expires_at <= $1
       RETURNING 1
     ),
     deleted_handoffs AS (
       DELETE FROM authkit_handoffs
        WHERE expires_at <= $1
       RETURNING 1
     ),
     deleted_events AS (
       DELETE FROM workos_events
        WHERE processed_at <= $2
       RETURNING 1
     ),
     retired_session_links AS (
       UPDATE device_sessions
          SET revoked_at = COALESCE(revoked_at, $1),
              workos_session_id = NULL
        WHERE workos_session_id IS NOT NULL
          AND (revoked_at IS NOT NULL OR expires_at <= $1)
       RETURNING 1
     )
     SELECT (SELECT count(*)::integer FROM deleted_transactions) AS transactions,
            (SELECT count(*)::integer FROM deleted_handoffs) AS handoffs,
            (SELECT count(*)::integer FROM deleted_events) AS events,
            (SELECT count(*)::integer FROM retired_session_links) AS sessions`,
    [now, eventsBefore],
  );
  const deleted = result.rows[0];
  if (deleted === undefined) throw new Error("AuthKit state cleanup returned no result");
  return {
    transactions: deleted.transactions,
    handoffs: deleted.handoffs,
    events: deleted.events,
    sessions: deleted.sessions,
  };
}

/**
 * Persistent, provider-facing AuthKit state built on the current identity/session schema.
 * Provider credentials never leave this boundary: only hashes, an encrypted PKCE verifier, and
 * the upstream session identifier needed for revocation are retained.
 */
export class AuthKitRepository {
  readonly #pool: Pool;
  readonly #encryptionKey: Buffer;

  constructor(pool: Pool, encryptionKey: Uint8Array) {
    if (encryptionKey.byteLength !== 32) {
      throw new TypeError("AuthKit transaction encryption key must be exactly 32 bytes");
    }
    this.#pool = pool;
    this.#encryptionKey = Buffer.from(encryptionKey);
  }

  async createTransaction(input: CreateAuthKitTransactionInput): Promise<void> {
    const providerState = requirePattern(
      input.providerState,
      PROVIDER_STATE_PATTERN,
      "an opaque OAuth state value",
    );
    const providerCodeVerifier = requirePattern(
      input.providerCodeVerifier,
      PKCE_VERIFIER_PATTERN,
      "an RFC 7636 code verifier",
    );
    const desktopCodeChallenge = requirePattern(
      input.desktopCodeChallenge,
      PKCE_VALUE_PATTERN,
      "a desktop PKCE challenge",
    );
    const desktopState = requirePattern(
      input.desktopState,
      PKCE_VALUE_PATTERN,
      "a desktop OAuth state value",
    );
    const expiresAt = requireDate(input.expiresAt, "a transaction expiry date");
    const id = randomUUID();
    const providerStateHash = hashCredential(providerState);
    const associatedData = transactionAssociatedData({
      id,
      providerStateHash,
      desktopCodeChallenge,
      desktopState,
      expiresAt,
    });
    const encrypted = encryptVerifier(this.#encryptionKey, providerCodeVerifier, associatedData);

    await this.#pool.query(
      `INSERT INTO authkit_transactions (
         id,
         provider_state_hash,
         verifier_nonce,
         verifier_ciphertext,
         verifier_authentication_tag,
         desktop_code_challenge,
         desktop_state,
         expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        providerStateHash,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authenticationTag,
        desktopCodeChallenge,
        desktopState,
        expiresAt,
      ],
    );
  }

  async consumeTransaction(
    providerStateValue: string,
    nowValue: Date,
  ): Promise<ConsumedAuthKitTransaction | null> {
    const providerState = requirePattern(
      providerStateValue,
      PROVIDER_STATE_PATTERN,
      "an opaque OAuth state value",
    );
    const now = requireDate(nowValue, "a transaction consumption date");
    const providerStateHash = hashCredential(providerState);

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<AuthKitTransactionRow>(
        `SELECT id,
                provider_state_hash,
                verifier_nonce,
                verifier_ciphertext,
                verifier_authentication_tag,
                desktop_code_challenge,
                desktop_state,
                expires_at
           FROM authkit_transactions
          WHERE provider_state_hash = $1
            AND consumed_at IS NULL
            AND expires_at > $2
          FOR UPDATE`,
        [providerStateHash, now],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (
        row.verifier_nonce === null ||
        row.verifier_ciphertext === null ||
        row.verifier_authentication_tag === null
      ) {
        throw new Error("Unconsumed AuthKit transaction has no encrypted verifier");
      }

      const associatedData = transactionAssociatedData({
        id: row.id,
        providerStateHash: row.provider_state_hash,
        desktopCodeChallenge: row.desktop_code_challenge,
        desktopState: row.desktop_state,
        expiresAt: row.expires_at,
      });
      const providerCodeVerifier = requirePattern(
        decryptVerifier(
          this.#encryptionKey,
          {
            nonce: row.verifier_nonce,
            ciphertext: row.verifier_ciphertext,
            authenticationTag: row.verifier_authentication_tag,
          },
          associatedData,
        ),
        PKCE_VERIFIER_PATTERN,
        "an RFC 7636 code verifier",
      );
      const consumed = await client.query(
        `UPDATE authkit_transactions
            SET consumed_at = $2,
                verifier_nonce = NULL,
                verifier_ciphertext = NULL,
                verifier_authentication_tag = NULL
          WHERE id = $1 AND consumed_at IS NULL`,
        [row.id, now],
      );
      if (consumed.rowCount !== 1) {
        throw new Error("AuthKit transaction was not consumed exactly once");
      }

      return {
        providerState,
        providerCodeVerifier,
        desktopCodeChallenge: requirePattern(
          row.desktop_code_challenge,
          PKCE_VALUE_PATTERN,
          "a desktop PKCE challenge",
        ),
        desktopState: requirePattern(
          row.desktop_state,
          PKCE_VALUE_PATTERN,
          "a desktop OAuth state value",
        ),
        expiresAt: row.expires_at,
      };
    });
  }

  async admitIdentity(input: AdmitAuthKitIdentityInput): Promise<AuthKitHandoff> {
    const providerSubject = requireWorkOSId(
      input.providerSubject,
      WORKOS_USER_ID_PATTERN,
      "a WorkOS user ID",
    );
    const verifiedEmail = emailSchema.parse(input.verifiedEmail);
    const workosSessionId = requireWorkOSId(
      input.workosSessionId,
      WORKOS_SESSION_ID_PATTERN,
      "a WorkOS session ID",
    );
    const desktopCodeChallenge = requirePattern(
      input.desktopCodeChallenge,
      PKCE_VALUE_PATTERN,
      "a desktop PKCE challenge",
    );
    const now = requireDate(input.now, "an identity admission date");
    const issuedHandoff = issueToken();
    const expiresAt = new Date(now.getTime() + AUTHKIT_HANDOFF_TTL_MS);

    try {
      await withTransaction(this.#pool, async (client) => {
        const admitted = await this.#resolveIdentity(client, {
          providerSubject,
          verifiedEmail,
          now,
        });
        await client.query(
          `INSERT INTO authkit_handoffs (
             id,
             code_hash,
             workspace_id,
             user_id,
             desktop_code_challenge,
             workos_session_id,
             expires_at,
             created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            issuedHandoff.hash,
            admitted.workspaceId,
            admitted.userId,
            desktopCodeChallenge,
            workosSessionId,
            expiresAt,
            now,
          ],
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AuthKitAdmissionDeniedError();
      throw error;
    }

    return { handoffCode: issuedHandoff.token, expiresAt };
  }

  async exchangeHandoff(input: ExchangeAuthKitHandoffInput): Promise<ExchangedAuthKitSession> {
    const handoffCode = requirePattern(
      input.handoffCode,
      PKCE_VALUE_PATTERN,
      "an AuthKit handoff code",
    );
    const codeVerifier = requirePattern(
      input.codeVerifier,
      PKCE_VERIFIER_PATTERN,
      "an RFC 7636 code verifier",
    );
    const label = requireLabel(input.label);
    const now = requireDate(input.now, "a handoff exchange date");
    const session = issueToken();
    const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS);

    return withTransaction(this.#pool, async (client) => {
      const result = await client.query<HandoffRow>(
        `SELECT handoff.id,
                handoff.workspace_id,
                handoff.user_id,
                handoff.desktop_code_challenge,
                handoff.workos_session_id
           FROM authkit_handoffs AS handoff
           JOIN users AS app_user
             ON app_user.id = handoff.user_id
            AND app_user.kind = 'human'
           JOIN workspace_memberships AS membership
             ON membership.workspace_id = handoff.workspace_id
            AND membership.user_id = handoff.user_id
            AND membership.status = 'active'
          WHERE handoff.code_hash = $1
            AND handoff.consumed_at IS NULL
            AND handoff.expires_at > $2
          FOR UPDATE OF handoff, membership`,
        [hashCredential(handoffCode), now],
      );
      const handoff = result.rows[0];
      if (
        handoff === undefined ||
        !verifyPkceCodeChallenge(codeVerifier, handoff.desktop_code_challenge)
      ) {
        throw new AuthKitCredentialRejectedError();
      }

      await this.#lockWorkOSSession(client, handoff.workos_session_id);
      const revoked = await client.query(
        `SELECT 1
           FROM workos_events
          WHERE workos_session_id = $1 AND event_type = 'session.revoked'
          LIMIT 1`,
        [handoff.workos_session_id],
      );
      if (revoked.rows[0] !== undefined) throw new AuthKitCredentialRejectedError();

      const consumed = await client.query(
        `UPDATE authkit_handoffs
            SET consumed_at = $2
          WHERE id = $1 AND consumed_at IS NULL`,
        [handoff.id, now],
      );
      if (consumed.rowCount !== 1) throw new AuthKitCredentialRejectedError();

      await client.query(
        `INSERT INTO device_sessions (
           id,
           user_id,
           token_hash,
           label,
           created_at,
           last_seen_at,
           expires_at,
           workos_session_id
         )
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
        [
          randomUUID(),
          handoff.user_id,
          session.hash,
          label,
          now,
          expiresAt,
          handoff.workos_session_id,
        ],
      );

      return {
        token: sessionTokenSchema.parse(session.token),
        expiresAt: isoDateTimeSchema.parse(expiresAt.toISOString()),
        userId: entityIdSchema.parse(handoff.user_id),
      };
    });
  }

  async applyWorkOSSessionRevokedEvent(
    input: ApplyWorkOSSessionRevokedEventInput,
  ): Promise<boolean> {
    const eventId = requireWorkOSId(input.eventId, WORKOS_EVENT_ID_PATTERN, "a WorkOS event ID");
    const workosSessionId = requireWorkOSId(
      input.workosSessionId,
      WORKOS_SESSION_ID_PATTERN,
      "a WorkOS session ID",
    );
    const occurredAt = requireDate(input.occurredAt, "a WorkOS event occurrence date");
    const now = requireDate(input.now, "a WorkOS event processing date");

    return withTransaction(this.#pool, async (client) => {
      await this.#lockWorkOSSession(client, workosSessionId);
      const inserted = await client.query(
        `INSERT INTO workos_events (
           event_id,
           event_type,
           workos_session_id,
           occurred_at,
           processed_at
         )
         VALUES ($1, 'session.revoked', $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, workosSessionId, occurredAt, now],
      );
      if (inserted.rowCount !== 1) return false;

      await client.query(
        `UPDATE device_sessions
            SET revoked_at = $2,
                workos_session_id = NULL
          WHERE workos_session_id = $1 AND revoked_at IS NULL`,
        [workosSessionId, now],
      );
      return true;
    });
  }

  /**
   * Fail-closed rollback boundary for operators. This deliberately excludes magic-link sessions
   * and already-revoked rows, and counts the exact locked set before updating it transactionally.
   */
  async revokeAllActiveAuthKitSessions(nowValue: Date): Promise<RevokedAuthKitSessions> {
    return revokeAllActiveAuthKitSessions(this.#pool, nowValue);
  }

  async listActiveAuthKitDeviceSessions(nowValue: Date): Promise<ActiveAuthKitDeviceSession[]> {
    const now = requireDate(nowValue, "an AuthKit session reconciliation date");
    const result = await this.#pool.query<ActiveAuthKitDeviceSessionRow>(
      `SELECT session.id AS device_session_id,
              identity.provider_subject,
              session.workos_session_id
         FROM device_sessions AS session
         JOIN external_identities AS identity
           ON identity.provider = 'workos' AND identity.user_id = session.user_id
        WHERE session.workos_session_id IS NOT NULL
          AND session.revoked_at IS NULL
          AND session.expires_at > $1
        ORDER BY identity.provider_subject, session.id`,
      [now],
    );
    return result.rows.map((row) => ({
      deviceSessionId: entityIdSchema.parse(row.device_session_id),
      providerSubject: requireWorkOSId(
        String(row.provider_subject),
        WORKOS_USER_ID_PATTERN,
        "a WorkOS user ID",
      ),
      workosSessionId: authKitProviderSessionIdSchema.parse(row.workos_session_id),
    }));
  }

  async revokeAuthKitDeviceSessions(
    deviceSessionIdsValue: readonly string[],
    nowValue: Date,
  ): Promise<number> {
    const deviceSessionIds = [
      ...new Set(deviceSessionIdsValue.map((id) => entityIdSchema.parse(id))),
    ];
    if (deviceSessionIds.length === 0) return 0;
    const now = requireDate(nowValue, "an AuthKit session reconciliation date");
    const result = await this.#pool.query(
      `UPDATE device_sessions
          SET revoked_at = $2,
              workos_session_id = NULL
        WHERE id = ANY($1::uuid[])
          AND workos_session_id IS NOT NULL
          AND revoked_at IS NULL`,
      [deviceSessionIds, now],
    );
    return result.rowCount ?? 0;
  }

  async deleteExpiredState(nowValue: Date): Promise<DeletedAuthKitState> {
    return deleteExpiredAuthKitState(this.#pool, nowValue);
  }

  async #resolveIdentity(
    client: PoolClient,
    input: {
      readonly providerSubject: string;
      readonly verifiedEmail: string;
      readonly now: Date;
    },
  ): Promise<{ readonly userId: string; readonly workspaceId: string }> {
    const locator = await client.query<ExternalIdentityLocatorRow>(
      `SELECT user_id
         FROM external_identities
        WHERE provider = 'workos' AND provider_subject = $1`,
      [input.providerSubject],
    );
    const mappedUserId = locator.rows[0]?.user_id;
    if (mappedUserId !== undefined) {
      const user = await this.#lockHumanUserById(client, mappedUserId);
      const membership = await this.#lockActiveMembership(client, mappedUserId);
      const mapping = await this.#lockExternalIdentityBySubject(client, input.providerSubject);
      if (
        user === null ||
        membership === null ||
        mapping === null ||
        mapping.user_id !== mappedUserId ||
        user.email !== input.verifiedEmail
      ) {
        throw new AuthKitAdmissionDeniedError();
      }
      await this.#bindIdentity(client, {
        userId: mappedUserId,
        providerSubject: input.providerSubject,
        verifiedEmail: input.verifiedEmail,
        now: input.now,
      });
      return { userId: mappedUserId, workspaceId: membership.workspace_id };
    }

    const active = await this.#lockActiveHumanByEmail(client, input.verifiedEmail);
    if (active !== null) {
      await this.#bindIdentity(client, {
        userId: active.id,
        providerSubject: input.providerSubject,
        verifiedEmail: input.verifiedEmail,
        now: input.now,
      });
      return { userId: active.id, workspaceId: active.workspace_id };
    }

    return this.#activateInvitation(client, input);
  }

  async #activateInvitation(
    client: PoolClient,
    input: {
      readonly providerSubject: string;
      readonly verifiedEmail: string;
      readonly now: Date;
    },
  ): Promise<{ readonly userId: string; readonly workspaceId: string }> {
    const invitationResult = await client.query<InvitationRow>(
      `SELECT id, workspace_id, role
         FROM invitations
        WHERE email = $1
          AND status = 'pending'
          AND expires_at > $2
        ORDER BY created_at DESC, id
        LIMIT 1
        FOR UPDATE`,
      [input.verifiedEmail, input.now],
    );
    const invitation = invitationResult.rows[0];
    if (invitation === undefined) throw new AuthKitAdmissionDeniedError();

    const user =
      (await this.#lockHumanUserByEmail(client, input.verifiedEmail)) ??
      (await this.#insertHumanUser(client, input.verifiedEmail));
    const membership = await this.#lockMembership(client, invitation.workspace_id, user.id);
    const workspace = await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [
      invitation.workspace_id,
    ]);
    if (workspace.rows[0] === undefined) throw new AuthKitAdmissionDeniedError();

    if (membership?.status !== "active") {
      const countResult = await client.query<CountRow>(
        `SELECT count(*)::integer AS count
           FROM workspace_memberships
          WHERE workspace_id = $1 AND status = 'active'`,
        [invitation.workspace_id],
      );
      if ((countResult.rows[0]?.count ?? MAX_ACTIVE_MEMBERS) >= MAX_ACTIVE_MEMBERS) {
        throw new AuthKitAdmissionDeniedError();
      }
    }

    const accepted = await client.query(
      `UPDATE invitations
          SET status = 'accepted', accepted_at = $2, updated_at = $2
        WHERE id = $1 AND status = 'pending' AND expires_at > $2`,
      [invitation.id, input.now],
    );
    if (accepted.rowCount !== 1) throw new AuthKitAdmissionDeniedError();

    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status, updated_at)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET role = CASE
                    WHEN workspace_memberships.status = 'active'
                      THEN workspace_memberships.role
                    ELSE EXCLUDED.role
                  END,
           status = 'active',
           updated_at = EXCLUDED.updated_at`,
      [invitation.workspace_id, user.id, invitation.role, input.now],
    );
    await this.#bindIdentity(client, {
      userId: user.id,
      providerSubject: input.providerSubject,
      verifiedEmail: input.verifiedEmail,
      now: input.now,
    });
    return { userId: user.id, workspaceId: invitation.workspace_id };
  }

  async #bindIdentity(
    client: PoolClient,
    input: {
      readonly userId: string;
      readonly providerSubject: string;
      readonly verifiedEmail: string;
      readonly now: Date;
    },
  ): Promise<void> {
    const existingResult = await client.query<ExternalIdentityRow>(
      `SELECT provider_subject, user_id
         FROM external_identities
        WHERE provider = 'workos' AND user_id = $1
        FOR UPDATE`,
      [input.userId],
    );
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      if (existing.provider_subject !== input.providerSubject) {
        throw new AuthKitAdmissionDeniedError();
      }
      await client.query(
        `UPDATE external_identities
            SET last_verified_email = $3,
                last_authenticated_at = $4,
                updated_at = $4
          WHERE provider = 'workos' AND provider_subject = $2 AND user_id = $1`,
        [input.userId, input.providerSubject, input.verifiedEmail, input.now],
      );
      return;
    }

    await client.query(
      `INSERT INTO external_identities (
         id,
         provider,
         provider_subject,
         user_id,
         last_verified_email,
         last_authenticated_at,
         created_at,
         updated_at
       )
       VALUES ($1, 'workos', $2, $3, $4, $5, $5, $5)`,
      [randomUUID(), input.providerSubject, input.userId, input.verifiedEmail, input.now],
    );
  }

  async #lockExternalIdentityBySubject(
    client: PoolClient,
    providerSubject: string,
  ): Promise<ExternalIdentityRow | null> {
    const result = await client.query<ExternalIdentityRow>(
      `SELECT provider_subject, user_id
         FROM external_identities
        WHERE provider = 'workos' AND provider_subject = $1
        FOR UPDATE`,
      [providerSubject],
    );
    return result.rows[0] ?? null;
  }

  async #lockHumanUserById(client: PoolClient, userId: string): Promise<HumanUserRow | null> {
    const result = await client.query<HumanUserRow>(
      `SELECT id, email
         FROM users
        WHERE id = $1 AND kind = 'human'
        FOR UPDATE`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async #lockHumanUserByEmail(client: PoolClient, email: string): Promise<HumanUserRow | null> {
    const result = await client.query<HumanUserRow>(
      `SELECT id, email
         FROM users
        WHERE email = $1 AND kind = 'human'
        FOR UPDATE`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  async #lockActiveHumanByEmail(client: PoolClient, email: string): Promise<ActiveHumanRow | null> {
    const result = await client.query<ActiveHumanRow>(
      `SELECT app_user.id,
              app_user.email,
              membership.workspace_id,
              membership.role,
              membership.status
         FROM users AS app_user
         JOIN workspace_memberships AS membership ON membership.user_id = app_user.id
        WHERE app_user.email = $1
          AND app_user.kind = 'human'
          AND membership.status = 'active'
        ORDER BY membership.created_at, membership.workspace_id
        LIMIT 1
        FOR UPDATE OF app_user, membership`,
      [email],
    );
    return result.rows[0] ?? null;
  }

  async #lockActiveMembership(client: PoolClient, userId: string): Promise<MembershipRow | null> {
    const result = await client.query<MembershipRow>(
      `SELECT workspace_id, role, status
         FROM workspace_memberships
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at, workspace_id
        LIMIT 1
        FOR UPDATE`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async #lockMembership(
    client: PoolClient,
    workspaceId: string,
    userId: string,
  ): Promise<MembershipRow | null> {
    const result = await client.query<MembershipRow>(
      `SELECT workspace_id, role, status
         FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2
        FOR UPDATE`,
      [workspaceId, userId],
    );
    return result.rows[0] ?? null;
  }

  async #insertHumanUser(client: PoolClient, email: string): Promise<HumanUserRow> {
    const base = usernameBase(email);
    let suffix = 1;
    while (true) {
      const suffixText = suffix === 1 ? "" : `-${suffix}`;
      const username = `${base.slice(0, 80 - suffixText.length)}${suffixText}`;
      const result = await client.query<HumanUserRow>(
        `INSERT INTO users (id, email, username, display_name, avatar_url)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT DO NOTHING
         RETURNING id, email`,
        [randomUUID(), email, username, displayName(email)],
      );
      const inserted = result.rows[0];
      if (inserted !== undefined) return inserted;

      const byEmail = await this.#lockHumanUserByEmail(client, email);
      if (byEmail !== null) return byEmail;
      suffix += 1;
    }
  }

  async #lockWorkOSSession(client: PoolClient, workosSessionId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [workosSessionId]);
  }
}
