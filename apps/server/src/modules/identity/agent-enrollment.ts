import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_AGENT_AGENCY_PROFILE,
  DEFAULT_AGENCY_AGENT_SCOPES,
  agentEnrollmentPolicyResponseSchema,
  agentEnrollmentRestrictedChannelSchema,
  agentEnrollmentResponseSchema,
  agentEnrollmentSchema,
  entityIdSchema,
  redeemAgentEnrollmentResponseSchema,
  type AgentEnrollment,
  type AgentEnrollmentPolicy,
  type AgentEnrollmentPolicyMode,
  type AgentEnrollmentRestrictedChannel,
  type AgentScope,
  type AgentTokenSecret,
  type EntityId,
  type RedeemAgentEnrollmentResponse,
  type RequestAgentEnrollment,
} from "@hype-comms/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

import { withTransaction } from "../../db/pool.js";
import { ApiError } from "../../errors.js";
import {
  fingerprintApiRequest,
  lockIdempotencyScope,
  runIdempotentMutation,
} from "../workspace/idempotency.js";
import { insertSyncEvent } from "../workspace/sync-events.js";
import { IdentityRepository } from "./repository.js";

const MAX_ACTIVE_MEMBERS = 25;
const MAX_OPEN_ENROLLMENTS_PER_REQUESTER = 100;
const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_ROUTE = "/v1/agent-enrollments";

export interface AgentEnrollmentActor {
  readonly userId: EntityId;
  readonly workspaceId: EntityId;
  readonly kind: "human" | "agent";
  readonly role: "owner" | "member";
  readonly agentTokenId: EntityId | null;
  readonly scopes: readonly AgentScope[];
}

export interface AgentEnrollmentHooks {
  /** Deterministic concurrency seam used to prove request/revocation lock behavior. */
  readonly afterRequesterLocked?: () => Promise<void>;
}

interface EnrollmentRow extends QueryResultRow {
  readonly id: unknown;
  readonly workspace_id: unknown;
  readonly profile: unknown;
  readonly status: unknown;
  readonly username: unknown;
  readonly display_name: unknown;
  readonly token_label: unknown;
  readonly requested_by: unknown;
  readonly requested_by_kind: unknown;
  readonly expires_at: unknown;
  readonly reviewed_by: unknown;
  readonly reviewed_at: unknown;
  readonly activated_agent_user_id: unknown;
  readonly activated_agent_token_id: unknown;
  readonly activated_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly restricted_channel_ids: unknown;
  readonly credential_verifier?: Buffer;
  readonly requested_by_agent_token_id?: unknown;
}

interface PolicyRow extends QueryResultRow {
  readonly id: unknown;
  readonly agent_enrollment_policy: unknown;
  readonly agent_enrollment_policy_updated_at: unknown;
}

interface CountRow extends QueryResultRow {
  readonly count: number;
}

interface ExistingTokenRow extends QueryResultRow {
  readonly id: string;
}

interface EnrollmentCredentialRow extends QueryResultRow {
  readonly credential_verifier: unknown;
}

interface EnrollmentRestrictedChannelRow extends QueryResultRow {
  readonly enrollment_id: unknown;
  readonly conversation_id: unknown;
  readonly name: unknown;
}

const enrollmentCredentialVerifierBufferSchema = z
  .instanceof(Buffer)
  .refine((value) => value.byteLength === 32, "Expected a SHA-256 credential verifier");

const enrollmentRequesterSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("human"),
      userId: entityIdSchema,
      agentTokenId: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      userId: entityIdSchema,
      agentTokenId: entityIdSchema,
    })
    .strict(),
]);

const redeemSecurityContextSchema = z
  .object({
    enrollment: agentEnrollmentSchema,
    credentialVerifier: enrollmentCredentialVerifierBufferSchema,
    requester: enrollmentRequesterSchema,
  })
  .strict();

type RedeemSecurityContext = z.infer<typeof redeemSecurityContextSchema>;

type RedeemResult =
  | { readonly status: "redeemed"; readonly response: RedeemAgentEnrollmentResponse }
  | { readonly status: "unauthorized" }
  | { readonly status: "not_found" }
  | { readonly status: "unavailable"; readonly message: string };

function timestamp(value: unknown): string {
  if (!(value instanceof Date)) {
    throw new TypeError("Expected Postgres to return a timestamptz value as a Date");
  }
  return value.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function mapEnrollment(row: EnrollmentRow): AgentEnrollment {
  return agentEnrollmentSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    profile: row.profile,
    status: row.status,
    username: row.username,
    displayName: row.display_name,
    label: row.token_label,
    requestedBy: row.requested_by,
    requestedByKind: row.requested_by_kind,
    restrictedChannelIds: row.restricted_channel_ids,
    expiresAt: timestamp(row.expires_at),
    reviewedBy: row.reviewed_by,
    reviewedAt: nullableTimestamp(row.reviewed_at),
    activatedAgentUserId: row.activated_agent_user_id,
    activatedAgentTokenId: row.activated_agent_token_id,
    activatedAt: nullableTimestamp(row.activated_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function redeemSecurityContext(row: EnrollmentRow): RedeemSecurityContext {
  const enrollment = mapEnrollment(row);
  return redeemSecurityContextSchema.parse({
    enrollment,
    credentialVerifier: row.credential_verifier,
    requester: {
      kind: enrollment.requestedByKind,
      userId: enrollment.requestedBy,
      agentTokenId: row.requested_by_agent_token_id ?? null,
    },
  });
}

function mapPolicy(row: PolicyRow): AgentEnrollmentPolicy {
  return agentEnrollmentPolicyResponseSchema.shape.policy.parse({
    workspaceId: row.id,
    mode: row.agent_enrollment_policy,
    updatedAt: timestamp(row.agent_enrollment_policy_updated_at),
  });
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function isUniqueConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

function credentialHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function verifierBuffer(verifier: string): Buffer {
  const decoded = Buffer.from(verifier, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== verifier) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid enrollment credential verifier");
  }
  return decoded;
}

function enrollmentSelect(where: string, suffix = ""): string {
  return `SELECT enrollment.*,
                 seats.restricted_channel_ids
            FROM agent_enrollments AS enrollment
            LEFT JOIN LATERAL (
              SELECT coalesce(
                       array_agg(seat.conversation_id ORDER BY seat.conversation_id),
                       ARRAY[]::uuid[]
                     ) AS restricted_channel_ids
                FROM agent_enrollment_restricted_channels AS seat
               WHERE seat.enrollment_id = enrollment.id
            ) AS seats ON true
           WHERE ${where}
           ${suffix}`;
}

async function enrollmentById(
  client: PoolClient,
  enrollmentId: EntityId,
  lock = false,
): Promise<EnrollmentRow | null> {
  const result = await client.query<EnrollmentRow>(
    enrollmentSelect("enrollment.id = $1", lock ? "FOR UPDATE OF enrollment" : ""),
    [enrollmentId],
  );
  return result.rows[0] ?? null;
}

async function recordTransition(
  client: PoolClient,
  enrollmentId: EntityId,
  workspaceId: EntityId,
  fromStatus: AgentEnrollment["status"] | null,
  toStatus: AgentEnrollment["status"],
  actorUserId: EntityId | null,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_enrollment_transitions
       (id, enrollment_id, workspace_id, from_status, to_status, actor_user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), enrollmentId, workspaceId, fromStatus, toStatus, actorUserId, reason],
  );
}

async function expireEnrollmentIfDue(
  client: PoolClient,
  row: EnrollmentRow,
  now: Date,
): Promise<EnrollmentRow> {
  const enrollment = mapEnrollment(row);
  if (
    (enrollment.status !== "pending_approval" && enrollment.status !== "ready_to_redeem") ||
    Date.parse(enrollment.expiresAt) > now.getTime()
  ) {
    return row;
  }
  await client.query(
    `UPDATE agent_enrollments
        SET status = 'expired', updated_at = $2
      WHERE id = $1`,
    [enrollment.id, now],
  );
  await recordTransition(
    client,
    enrollment.id,
    enrollment.workspaceId,
    enrollment.status,
    "expired",
    null,
    "ttl_expired",
  );
  const expired = await enrollmentById(client, enrollment.id);
  if (expired === null) throw new Error("Expired enrollment disappeared");
  return expired;
}

/**
 * Deep module for agent enrollment. Its interface deliberately exposes lifecycle operations rather
 * than persistence details; policy, idempotency, authorization rechecks, capacity, credential
 * activation, restricted-channel seating, sync events, and audit all remain local here.
 */
export class AgentEnrollmentModule {
  readonly #pool: Pool;
  readonly #clock: () => Date;
  readonly #hooks: AgentEnrollmentHooks;

  constructor(pool: Pool, clock: () => Date = () => new Date(), hooks: AgentEnrollmentHooks = {}) {
    this.#pool = pool;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    // Enrollment shares membership/conversation-before-workspace ordering with delivery, while
    // legacy owner-token mutations take workspace-before-token. PostgreSQL can pick either side
    // as a deadlock victim, so replay this DB-only unit of work from a fresh transaction.
    return withTransaction(this.#pool, operation, { deadlockRetries: 2 });
  }

  async getPolicy(actor: AgentEnrollmentActor): Promise<AgentEnrollmentPolicy> {
    return this.#transaction(async (client) => {
      await this.#requireOwner(client, actor, false);
      const result = await client.query<PolicyRow>(
        `SELECT id, agent_enrollment_policy, agent_enrollment_policy_updated_at
           FROM workspaces
          WHERE id = $1`,
        [actor.workspaceId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
      return mapPolicy(row);
    });
  }

  async setPolicy(
    actor: AgentEnrollmentActor,
    mode: AgentEnrollmentPolicyMode,
  ): Promise<AgentEnrollmentPolicy> {
    return this.#transaction(async (client) => {
      await this.#requireOwner(client, actor, true);
      const now = this.#clock();
      await this.#expireWorkspaceEnrollments(client, actor.workspaceId, now);
      const current = await client.query<PolicyRow>(
        `SELECT id, agent_enrollment_policy, agent_enrollment_policy_updated_at
           FROM workspaces
          WHERE id = $1
          FOR UPDATE`,
        [actor.workspaceId],
      );
      const previous = current.rows[0];
      if (previous === undefined) throw new ApiError(404, "NOT_FOUND", "Workspace not found");
      if (previous.agent_enrollment_policy !== mode) {
        const fromStatus = mode === "automatic" ? "pending_approval" : "ready_to_redeem";
        const toStatus = mode === "automatic" ? "ready_to_redeem" : "pending_approval";
        const affected = await client.query<{ id: string } & QueryResultRow>(
          `UPDATE agent_enrollments
              SET status = $3, updated_at = $4
            WHERE workspace_id = $1
              AND status = $2
              AND reviewed_by IS NULL
            RETURNING id`,
          [actor.workspaceId, fromStatus, toStatus, now],
        );
        for (const enrollment of affected.rows) {
          await recordTransition(
            client,
            enrollment.id,
            actor.workspaceId,
            fromStatus,
            toStatus,
            actor.userId,
            "workspace_policy_changed",
          );
        }
        await client.query(
          `UPDATE workspaces
              SET agent_enrollment_policy = $2,
                  agent_enrollment_policy_updated_at = $3
            WHERE id = $1`,
          [actor.workspaceId, mode, now],
        );
        await client.query(
          `INSERT INTO agent_enrollment_policy_transitions
             (id, workspace_id, from_mode, to_mode, actor_user_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            actor.workspaceId,
            previous.agent_enrollment_policy,
            mode,
            actor.userId,
            now,
          ],
        );
      }
      const updated = await client.query<PolicyRow>(
        `SELECT id, agent_enrollment_policy, agent_enrollment_policy_updated_at
           FROM workspaces
          WHERE id = $1`,
        [actor.workspaceId],
      );
      return mapPolicy(updated.rows[0] as PolicyRow);
    });
  }

  async request(
    actor: AgentEnrollmentActor,
    input: RequestAgentEnrollment,
    idempotencyKey: string,
  ): Promise<AgentEnrollment> {
    const response = await this.#transaction(async (client) => {
      // A cached response is still privileged enrollment information. Hold the requester's
      // authority rows for the whole transaction so replay and revocation serialize against the
      // same live authorization state.
      await this.#requireRequester(client, actor, true);
      await this.#hooks.afterRequesterLocked?.();
      return runIdempotentMutation(
        client,
        {
          actorUserId: actor.userId,
          route: REQUEST_ROUTE,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: agentEnrollmentResponseSchema,
        },
        async () => {
          const now = this.#clock();
          await this.#expireWorkspaceEnrollments(client, actor.workspaceId, now);
          // Different idempotency keys for the same requester still share one live-row bound.
          // Serialize the count+insert pair across every server process before enforcing it.
          await lockIdempotencyScope(
            client,
            `agent-enrollment-open:${actor.workspaceId}:${actor.userId}`,
          );

          const open = await client.query<CountRow>(
            `SELECT count(*)::integer AS count
               FROM agent_enrollments
              WHERE workspace_id = $1
                AND requested_by = $2
                AND status IN ('pending_approval', 'ready_to_redeem')`,
            [actor.workspaceId, actor.userId],
          );
          if ((open.rows[0]?.count ?? 0) >= MAX_OPEN_ENROLLMENTS_PER_REQUESTER) {
            throw new ApiError(429, "RATE_LIMITED", "Too many open agent enrollments");
          }

          const verifier = verifierBuffer(input.credentialVerifier);
          const existingToken = await client.query<ExistingTokenRow>(
            "SELECT id FROM agent_tokens WHERE token_hash = $1",
            [verifier],
          );
          if (existingToken.rows[0] !== undefined) {
            throw new ApiError(409, "CONFLICT", "That credential is already active");
          }
          if (
            (await client.query("SELECT 1 FROM users WHERE username = $1", [input.username]))
              .rowCount
          ) {
            throw new ApiError(409, "CONFLICT", "That username is already in use");
          }
          await this.#requireSeatAuthority(client, actor, input.restrictedChannelIds, false);

          const policy = await client.query<PolicyRow>(
            `SELECT id, agent_enrollment_policy, agent_enrollment_policy_updated_at
               FROM workspaces
              WHERE id = $1
              FOR UPDATE`,
            [actor.workspaceId],
          );
          const mode = policy.rows[0]?.agent_enrollment_policy;
          if (mode !== "required" && mode !== "automatic") {
            throw new ApiError(404, "NOT_FOUND", "Workspace not found");
          }
          const enrollmentId = randomUUID();
          const status = mode === "automatic" ? "ready_to_redeem" : "pending_approval";
          const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
          try {
            await client.query(
              `INSERT INTO agent_enrollments (
                 id, workspace_id, profile, status, username, display_name, token_label,
                 requested_by, requested_by_kind, requested_by_agent_token_id, idempotency_key,
                 request_fingerprint, credential_verifier, expires_at, created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
              [
                enrollmentId,
                actor.workspaceId,
                DEFAULT_AGENT_AGENCY_PROFILE,
                status,
                input.username,
                input.displayName,
                input.label,
                actor.userId,
                actor.kind,
                actor.agentTokenId,
                idempotencyKey,
                fingerprintApiRequest(input),
                verifier,
                expiresAt,
                now,
              ],
            );
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "23505") {
              throw new ApiError(409, "CONFLICT", "Enrollment credential is already in use");
            }
            throw error;
          }
          for (const conversationId of [...input.restrictedChannelIds].sort()) {
            await client.query(
              `INSERT INTO agent_enrollment_restricted_channels
                 (enrollment_id, workspace_id, conversation_id)
               VALUES ($1, $2, $3)`,
              [enrollmentId, actor.workspaceId, conversationId],
            );
          }
          await recordTransition(
            client,
            enrollmentId,
            actor.workspaceId,
            null,
            status,
            actor.userId,
            mode === "automatic" ? "automatic_policy" : "approval_required",
          );
          const inserted = await enrollmentById(client, enrollmentId);
          if (inserted === null) throw new Error("Enrollment insert returned no row");
          return agentEnrollmentResponseSchema.parse({ enrollment: mapEnrollment(inserted) });
        },
      );
    });
    return response.enrollment;
  }

  async list(
    actor: AgentEnrollmentActor,
    includeRestrictedChannelReviewDetails = false,
  ): Promise<AgentEnrollment[]> {
    return this.#transaction(async (client) => {
      const owner = actor.kind === "human" && actor.role === "owner";
      if (owner && includeRestrictedChannelReviewDetails) {
        await this.#requireOwner(client, actor, true);
      } else {
        await this.#requireStatusReader(client, actor);
      }
      await this.#expireWorkspaceEnrollments(client, actor.workspaceId, this.#clock());
      const result = await client.query<EnrollmentRow>(
        enrollmentSelect(
          `enrollment.workspace_id = $1${owner ? "" : " AND enrollment.requested_by = $2"}`,
          "ORDER BY enrollment.created_at DESC, enrollment.id DESC LIMIT 1000",
        ),
        owner ? [actor.workspaceId] : [actor.workspaceId, actor.userId],
      );
      const enrollments = result.rows.map(mapEnrollment);
      if (!owner || !includeRestrictedChannelReviewDetails) return enrollments;
      const openEnrollmentIds = enrollments
        .filter(
          (enrollment) =>
            enrollment.status === "pending_approval" || enrollment.status === "ready_to_redeem",
        )
        .map((enrollment) => enrollment.id);
      if (openEnrollmentIds.length === 0) return enrollments;

      const channels = await client.query<EnrollmentRestrictedChannelRow>(
        `SELECT seat.enrollment_id, seat.conversation_id, conversation.name
           FROM agent_enrollment_restricted_channels AS seat
           JOIN conversations AS conversation
             ON conversation.id = seat.conversation_id
            AND conversation.workspace_id = seat.workspace_id
          WHERE seat.workspace_id = $1
            AND seat.enrollment_id = ANY($2::uuid[])
          ORDER BY seat.enrollment_id, seat.conversation_id`,
        [actor.workspaceId, openEnrollmentIds],
      );
      const channelsByEnrollment = new Map<EntityId, AgentEnrollmentRestrictedChannel[]>();
      for (const row of channels.rows) {
        const enrollmentId = entityIdSchema.parse(row.enrollment_id);
        const channel = agentEnrollmentRestrictedChannelSchema.parse({
          conversationId: row.conversation_id,
          name: row.name,
        });
        const projected = channelsByEnrollment.get(enrollmentId) ?? [];
        projected.push(channel);
        channelsByEnrollment.set(enrollmentId, projected);
      }
      return enrollments.map((enrollment) =>
        enrollment.status === "pending_approval" || enrollment.status === "ready_to_redeem"
          ? agentEnrollmentSchema.parse({
              ...enrollment,
              restrictedChannels: channelsByEnrollment.get(enrollment.id) ?? [],
            })
          : enrollment,
      );
    });
  }

  async get(actor: AgentEnrollmentActor, enrollmentId: EntityId): Promise<AgentEnrollment> {
    return this.#transaction(async (client) => {
      await this.#requireStatusReader(client, actor);
      const found = await enrollmentById(client, enrollmentId, true);
      if (found === null || found.workspace_id !== actor.workspaceId) {
        throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
      }
      if (
        !(actor.kind === "human" && actor.role === "owner") &&
        found.requested_by !== actor.userId
      ) {
        throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
      }
      return mapEnrollment(await expireEnrollmentIfDue(client, found, this.#clock()));
    });
  }

  async review(
    actor: AgentEnrollmentActor,
    enrollmentId: EntityId,
    decision: "approve" | "reject",
  ): Promise<AgentEnrollment> {
    return this.#transaction(async (client) => {
      await this.#requireOwner(client, actor, true);
      const found = await enrollmentById(client, enrollmentId, true);
      if (found === null || found.workspace_id !== actor.workspaceId) {
        throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
      }
      const current = await expireEnrollmentIfDue(client, found, this.#clock());
      if (current.status === "expired") {
        return mapEnrollment(current);
      }
      const target = decision === "approve" ? "ready_to_redeem" : "rejected";
      if (
        current.status === target &&
        current.reviewed_by === actor.userId &&
        current.reviewed_at !== null
      ) {
        return mapEnrollment(current);
      }
      if (
        (current.status !== "pending_approval" && current.status !== "ready_to_redeem") ||
        current.reviewed_by !== null
      ) {
        throw new ApiError(409, "CONFLICT", "Agent enrollment can no longer be reviewed");
      }
      const now = this.#clock();
      await client.query(
        `UPDATE agent_enrollments
            SET status = $2, reviewed_by = $3, reviewed_at = $4, updated_at = $4
          WHERE id = $1`,
        [enrollmentId, target, actor.userId, now],
      );
      await recordTransition(
        client,
        enrollmentId,
        actor.workspaceId,
        current.status as AgentEnrollment["status"],
        target,
        actor.userId,
        decision === "approve" ? "owner_approved" : "owner_rejected",
      );
      const updated = await enrollmentById(client, enrollmentId);
      if (updated === null) throw new Error("Reviewed enrollment disappeared");
      return mapEnrollment(updated);
    });
  }

  async cancel(actor: AgentEnrollmentActor, enrollmentId: EntityId): Promise<AgentEnrollment> {
    return this.#transaction(async (client) => {
      await this.#requireStatusReader(client, actor);
      const found = await enrollmentById(client, enrollmentId, true);
      if (found === null || found.workspace_id !== actor.workspaceId) {
        throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
      }
      const isOwner = actor.kind === "human" && actor.role === "owner";
      if (!isOwner && found.requested_by !== actor.userId) {
        throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
      }
      const current = await expireEnrollmentIfDue(client, found, this.#clock());
      if (current.status === "cancelled") return mapEnrollment(current);
      if (current.status === "expired") return mapEnrollment(current);
      if (current.status !== "pending_approval" && current.status !== "ready_to_redeem") {
        throw new ApiError(409, "CONFLICT", "Agent enrollment can no longer be cancelled");
      }
      const now = this.#clock();
      await client.query(
        `UPDATE agent_enrollments
            SET status = 'cancelled', updated_at = $2
          WHERE id = $1`,
        [enrollmentId, now],
      );
      await recordTransition(
        client,
        enrollmentId,
        actor.workspaceId,
        current.status as AgentEnrollment["status"],
        "cancelled",
        actor.userId,
        isOwner ? "owner_cancelled" : "requester_cancelled",
      );
      const updated = await enrollmentById(client, enrollmentId);
      if (updated === null) throw new Error("Cancelled enrollment disappeared");
      return mapEnrollment(updated);
    });
  }

  async redeem(
    enrollmentId: EntityId,
    candidateCredential: AgentTokenSecret,
  ): Promise<RedeemAgentEnrollmentResponse> {
    const candidateHash = credentialHash(candidateCredential);
    let outcome: RedeemResult;
    try {
      outcome = await this.#transaction(async (client): Promise<RedeemResult> => {
        const identityRepository = new IdentityRepository(client);
        const found = await enrollmentById(client, enrollmentId, true);
        if (found === null) return { status: "not_found" };
        const foundSecurity = redeemSecurityContext(found);
        if (!sameHash(foundSecurity.credentialVerifier, candidateHash)) {
          return { status: "unauthorized" };
        }
        if (foundSecurity.enrollment.status === "active") {
          const { enrollment } = foundSecurity;
          if (enrollment.activatedAgentUserId === null) {
            throw new Error("Active enrollment has no activated agent user id");
          }
          const agent = await identityRepository.findAgent(
            enrollment.workspaceId,
            enrollment.activatedAgentUserId,
          );
          if (agent === null) throw new Error("Activated enrollment has no agent row");
          return {
            status: "redeemed",
            response: redeemAgentEnrollmentResponseSchema.parse({ enrollment, agent }),
          };
        }

        const currentRow = await expireEnrollmentIfDue(client, found, this.#clock());
        const currentSecurity = redeemSecurityContext(currentRow);
        const { enrollment: current, requester } = currentSecurity;
        if (current.status !== "ready_to_redeem") {
          return {
            status: "unavailable",
            message:
              current.status === "pending_approval"
                ? "Agent enrollment is awaiting owner approval"
                : "Agent enrollment can no longer be redeemed",
          };
        }
        const actor: AgentEnrollmentActor = {
          userId: requester.userId,
          workspaceId: current.workspaceId,
          kind: requester.kind,
          role: requester.kind === "human" ? "owner" : "member",
          agentTokenId: requester.agentTokenId,
          scopes: requester.kind === "agent" ? (["agents:invite"] as const) : ([] as const),
        };
        try {
          await this.#requireSeatAuthority(client, actor, current.restrictedChannelIds, true);
        } catch (error) {
          if (error instanceof ApiError) {
            return {
              status: "unavailable",
              message: "The requester can no longer seat the child in every requested channel",
            };
          }
          throw error;
        }
        // Existing revocation and channel-membership mutations lock the relevant membership or
        // conversation before they allocate the workspace sequence. Hold those same share locks
        // before taking the workspace row, so redemption cannot deadlock with either path and the
        // authority rechecks remain stable through activation.
        const workspace = await client.query<PolicyRow>(
          `SELECT id, agent_enrollment_policy, agent_enrollment_policy_updated_at
             FROM workspaces
            WHERE id = $1
            FOR UPDATE`,
          [current.workspaceId],
        );
        const policy = workspace.rows[0]?.agent_enrollment_policy;
        if (policy !== "automatic" && current.reviewedBy === null) {
          return { status: "unavailable", message: "Agent enrollment requires owner approval" };
        }
        // Inviter token revocation is serialized through the same workspace row. Re-read after
        // obtaining it: if revocation committed first we deny, and if redemption holds the row
        // first activation is the earlier linearized operation.
        if (!(await this.#requesterStillAuthorized(client, currentSecurity))) {
          return { status: "unavailable", message: "The enrollment requester is no longer active" };
        }
        const capacity = await client.query<CountRow>(
          `SELECT count(*)::integer AS count
             FROM workspace_memberships
            WHERE workspace_id = $1 AND status = 'active'`,
          [current.workspaceId],
        );
        if ((capacity.rows[0]?.count ?? 0) >= MAX_ACTIVE_MEMBERS) {
          return { status: "unavailable", message: "The workspace is at capacity" };
        }
        if (
          (await client.query("SELECT 1 FROM users WHERE username = $1", [current.username]))
            .rowCount
        ) {
          return { status: "unavailable", message: "That username is already in use" };
        }
        const existingToken = await client.query<ExistingTokenRow>(
          "SELECT id FROM agent_tokens WHERE token_hash = $1",
          [candidateHash],
        );
        if (existingToken.rows[0] !== undefined) {
          return { status: "unavailable", message: "That credential is already active" };
        }

        const now = this.#clock();
        const childUserId = randomUUID();
        const childTokenId = randomUUID();
        const agent = await identityRepository.insertAgent({
          id: childUserId,
          workspaceId: current.workspaceId,
          username: current.username,
          displayName: current.displayName,
          createdBy: current.requestedBy,
        });
        await identityRepository.insertAgentToken({
          id: childTokenId,
          workspaceId: current.workspaceId,
          agentUserId: childUserId,
          tokenHash: candidateHash,
          label: current.label,
          scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
          createdBy: current.requestedBy,
          createdAt: now.toISOString(),
        });
        for (const conversationId of current.restrictedChannelIds) {
          await client.query(
            `INSERT INTO conversation_memberships
               (conversation_id, workspace_id, user_id, role)
             VALUES ($1, $2, $3, 'member')`,
            [conversationId, current.workspaceId, childUserId],
          );
        }
        await client.query(
          `UPDATE agent_enrollments
              SET status = 'active',
                  activated_agent_user_id = $2,
                  activated_agent_token_id = $3,
                  activated_at = $4,
                  updated_at = $4
            WHERE id = $1`,
          [enrollmentId, childUserId, childTokenId, now],
        );
        await recordTransition(
          client,
          enrollmentId,
          current.workspaceId,
          "ready_to_redeem",
          "active",
          childUserId,
          "candidate_redeemed",
        );

        for (const conversationId of current.restrictedChannelIds) {
          const audience = await client.query<{ user_id: string } & QueryResultRow>(
            `SELECT membership.user_id
               FROM conversation_memberships AS membership
               JOIN workspace_memberships AS workspace_membership
                 ON workspace_membership.workspace_id = membership.workspace_id
                AND workspace_membership.user_id = membership.user_id
              WHERE membership.conversation_id = $1
                AND membership.left_at IS NULL
                AND workspace_membership.status = 'active'
              ORDER BY membership.user_id`,
            [conversationId],
          );
          await insertSyncEvent(client, {
            workspaceId: current.workspaceId,
            actorUserId: current.requestedBy,
            type: "channel.membership_changed",
            conversationId,
            payload: { memberId: childUserId, action: "added" },
            audienceUserIds: audience.rows.map((entry) => entry.user_id),
          });
        }
        const activated = await enrollmentById(client, enrollmentId);
        if (activated === null) throw new Error("Activated enrollment disappeared");
        return {
          status: "redeemed",
          response: redeemAgentEnrollmentResponseSchema.parse({
            enrollment: mapEnrollment(activated),
            agent,
          }),
        };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error, "users_username_key")) {
        throw new ApiError(409, "CONFLICT", "That username is already in use");
      }
      throw error;
    }

    if (outcome.status === "redeemed") return outcome.response;
    if (outcome.status === "not_found") {
      throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
    }
    if (outcome.status === "unauthorized") {
      throw new ApiError(401, "UNAUTHORIZED", "Enrollment credential is invalid");
    }
    throw new ApiError(409, "CONFLICT", outcome.message);
  }

  async authenticateRedemptionCredential(
    enrollmentId: EntityId,
    candidateCredential: AgentTokenSecret,
  ): Promise<void> {
    // This read-only preflight prevents the rollout gate from becoming an authentication oracle.
    // redeem() repeats the comparison while holding its transaction lock before making any write.
    const result = await this.#pool.query<EnrollmentCredentialRow>(
      `SELECT credential_verifier
         FROM agent_enrollments
        WHERE id = $1`,
      [enrollmentId],
    );
    const found = result.rows[0];
    if (found === undefined) {
      throw new ApiError(404, "NOT_FOUND", "Agent enrollment not found");
    }
    const candidateHash = credentialHash(candidateCredential);
    const verifier = enrollmentCredentialVerifierBufferSchema.parse(found.credential_verifier);
    if (!sameHash(verifier, candidateHash)) {
      throw new ApiError(401, "UNAUTHORIZED", "Enrollment credential is invalid");
    }
  }

  async #requireRequester(
    client: PoolClient,
    actor: AgentEnrollmentActor,
    lock: boolean,
  ): Promise<void> {
    if (actor.kind === "human") {
      await this.#requireOwner(client, actor, lock);
      return;
    }
    if (actor.agentTokenId === null || !actor.scopes.includes("agents:invite")) {
      throw new ApiError(403, "FORBIDDEN", "Agent token requires the agents:invite scope");
    }
    const result = await client.query(
      `SELECT 1
         FROM agent_tokens AS token
         JOIN agents AS agent
           ON agent.workspace_id = token.workspace_id
          AND agent.user_id = token.agent_user_id
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = token.workspace_id
          AND membership.user_id = token.agent_user_id
        WHERE token.id = $1
          AND token.workspace_id = $2
          AND token.agent_user_id = $3
          AND token.revoked_at IS NULL
          AND 'agents:invite' = ANY(token.scopes)
          AND agent.disabled_at IS NULL
          AND membership.status = 'active'
          AND membership.role = 'member'
        ${lock ? "FOR SHARE OF token, agent, membership" : ""}`,
      [actor.agentTokenId, actor.workspaceId, actor.userId],
    );
    if (result.rowCount !== 1) {
      throw new ApiError(403, "FORBIDDEN", "The agent may no longer request enrollments");
    }
  }

  async #requireOwner(
    client: PoolClient,
    actor: AgentEnrollmentActor,
    lock: boolean,
  ): Promise<void> {
    if (actor.kind !== "human" || actor.role !== "owner" || actor.agentTokenId !== null) {
      throw new ApiError(403, "FORBIDDEN", "An active workspace owner session is required");
    }
    const result = await client.query(
      `SELECT 1
         FROM workspace_memberships AS membership
         JOIN users AS user_account ON user_account.id = membership.user_id
        WHERE membership.workspace_id = $1
          AND membership.user_id = $2
          AND membership.status = 'active'
          AND membership.role = 'owner'
          AND user_account.kind = 'human'
        ${lock ? "FOR SHARE OF membership, user_account" : ""}`,
      [actor.workspaceId, actor.userId],
    );
    if (result.rowCount !== 1) {
      throw new ApiError(403, "FORBIDDEN", "An active workspace owner session is required");
    }
  }

  async #requireStatusReader(client: PoolClient, actor: AgentEnrollmentActor): Promise<void> {
    if (actor.kind === "human") {
      await this.#requireOwner(client, actor, false);
    } else {
      await this.#requireRequester(client, actor, false);
    }
  }

  async #requesterStillAuthorized(
    client: PoolClient,
    context: RedeemSecurityContext,
  ): Promise<boolean> {
    const { enrollment, requester } = context;
    if (requester.kind === "human") {
      const result = await client.query(
        `SELECT 1
           FROM workspace_memberships AS membership
           JOIN users AS user_account ON user_account.id = membership.user_id
          WHERE membership.workspace_id = $1
            AND membership.user_id = $2
            AND membership.status = 'active'
            AND membership.role = 'owner'
            AND user_account.kind = 'human'
          `,
        [enrollment.workspaceId, requester.userId],
      );
      return result.rowCount === 1;
    }
    const result = await client.query(
      `SELECT 1
         FROM agent_tokens AS token
         JOIN agents AS agent
           ON agent.workspace_id = token.workspace_id
          AND agent.user_id = token.agent_user_id
         JOIN workspace_memberships AS membership
           ON membership.workspace_id = token.workspace_id
          AND membership.user_id = token.agent_user_id
        WHERE token.id = $1
          AND token.workspace_id = $2
          AND token.agent_user_id = $3
          AND token.revoked_at IS NULL
          AND 'agents:invite' = ANY(token.scopes)
          AND agent.disabled_at IS NULL
          AND membership.status = 'active'
        `,
      [requester.agentTokenId, enrollment.workspaceId, requester.userId],
    );
    return result.rowCount === 1;
  }

  async #requireSeatAuthority(
    client: PoolClient,
    actor: AgentEnrollmentActor,
    conversationIds: readonly EntityId[],
    lock: boolean,
  ): Promise<void> {
    if (conversationIds.length === 0) return;
    const result =
      actor.kind === "human"
        ? await client.query<{ id: string } & QueryResultRow>(
            `SELECT conversation.id
               FROM conversations AS conversation
              WHERE conversation.workspace_id = $1
                AND conversation.id = ANY($2::uuid[])
                AND conversation.kind = 'channel'
                AND conversation.channel_access = 'members'
                AND NOT conversation.human_only
                AND NOT conversation.is_archived
              ${lock ? "FOR SHARE OF conversation" : ""}`,
            [actor.workspaceId, [...conversationIds]],
          )
        : await client.query<{ id: string } & QueryResultRow>(
            `SELECT conversation.id
               FROM conversations AS conversation
               JOIN conversation_memberships AS membership
                 ON membership.conversation_id = conversation.id
                AND membership.workspace_id = conversation.workspace_id
                AND membership.user_id = $2
                AND membership.left_at IS NULL
              WHERE conversation.workspace_id = $1
                AND conversation.id = ANY($3::uuid[])
                AND conversation.kind = 'channel'
                AND conversation.channel_access = 'members'
                AND NOT conversation.human_only
                AND NOT conversation.is_archived
              ${lock ? "FOR SHARE OF conversation, membership" : ""}`,
            [actor.workspaceId, actor.userId, [...conversationIds]],
          );
    if (result.rowCount !== conversationIds.length) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Every requested restricted channel must be valid and visible to the requester",
      );
    }
  }

  async #expireWorkspaceEnrollments(
    client: PoolClient,
    workspaceId: EntityId,
    now: Date,
  ): Promise<void> {
    const expired = await client.query<
      {
        id: string;
        from_status: AgentEnrollment["status"];
      } & QueryResultRow
    >(
      `WITH due AS (
         SELECT id, status AS from_status
           FROM agent_enrollments
          WHERE workspace_id = $1
            AND status IN ('pending_approval', 'ready_to_redeem')
            AND expires_at <= $2
          FOR UPDATE
       ), updated AS (
         UPDATE agent_enrollments AS enrollment
            SET status = 'expired', updated_at = $2
           FROM due
          WHERE enrollment.id = due.id
         RETURNING enrollment.id, due.from_status
       )
       SELECT id, from_status FROM updated`,
      [workspaceId, now],
    );
    for (const enrollment of expired.rows) {
      await recordTransition(
        client,
        enrollment.id,
        workspaceId,
        enrollment.from_status,
        "expired",
        null,
        "ttl_expired",
      );
    }
  }
}
