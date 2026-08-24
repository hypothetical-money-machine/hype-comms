import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ATTACHMENTS_CAPABILITY,
  ATTACHMENT_CONTENT_SHA256_HEADER,
  DEFAULT_AGENCY_AGENT_SCOPES,
  agentCurrentPrincipalSchema,
  agentEnrollmentResponseSchema,
  agentEnrollmentPolicyResponseSchema,
  apiErrorEnvelopeSchema,
  conversationMutationResponseSchema,
  createFileUploadResponseSchema,
  messageHistoryResponseSchema,
  redeemAgentEnrollmentResponseSchema,
  sendMessageResponseSchema,
  syncResponseSchema,
  type RequestAgentEnrollment,
} from "@hype-comms/contracts";
import { escapeIdentifier, Pool, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import {
  AgentEnrollmentModule,
  type AgentEnrollmentActor,
} from "../src/modules/identity/agent-enrollment.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken, issueAgentToken } from "../src/modules/identity/tokens.js";
import { RealtimeEventHub } from "../src/modules/realtime/hub.js";
import { LocalAttachmentStore } from "../src/modules/workspace/file-store.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const ownerId = "10000000-0000-4000-8000-000000000001";
const memberId = "10000000-0000-4000-8000-000000000002";
const workspaceId = "10000000-0000-4000-8000-000000000003";
const generalId = "10000000-0000-4000-8000-000000000004";
const restrictedId = "10000000-0000-4000-8000-000000000005";
const ownerSessionId = "10000000-0000-4000-8000-000000000006";
const ownerSessionToken = "o".repeat(43);

class NoopEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

function ownerActor(
  userId: string = ownerId,
  targetWorkspaceId: string = workspaceId,
): AgentEnrollmentActor {
  return {
    userId,
    workspaceId: targetWorkspaceId,
    kind: "human",
    role: "owner",
    agentTokenId: null,
    scopes: [],
  };
}

function candidateInput(
  username: string,
  restrictedChannelIds: readonly string[] = [],
): { readonly token: string; readonly request: RequestAgentEnrollment } {
  const candidate = issueAgentToken();
  return {
    token: candidate.token,
    request: {
      username,
      displayName: username.replaceAll("-", " "),
      label: `${username} default agency`,
      credentialVerifier: candidate.hash.toString("base64url"),
      restrictedChannelIds: [...restrictedChannelIds],
    },
  };
}

describeWithPostgres("AgentEnrollmentModule", () => {
  const schemaName = `agent_enrollment_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const applicationName = `agent_enrollment_${process.pid}_${randomUUID().slice(0, 8)}`;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  let adminPool: Pool;
  let pool: Pool;
  let identityService: IdentityService;
  let enrollment: AgentEnrollmentModule;
  let now: Date;

  async function waitForBlockedQuery(queryFragment: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const blocked = await adminPool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND position($2 IN query) > 0
            AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0`,
        [applicationName, queryFragment],
      );
      if ((blocked.rows[0]?.count ?? 0) > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for blocked query containing: ${queryFragment}`);
  }

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = new Pool({
      application_name: applicationName,
      connectionString: schemaScopedUrl(testDatabaseUrl, schemaName),
      max: 12,
    });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    now = new Date("2026-08-23T12:00:00.000Z");
    const repository = new IdentityRepository(pool);
    identityService = new IdentityService(
      repository,
      new NoopEmailSender(),
      new SignInThrottle(),
      () => now,
      "http://127.0.0.1:3000",
    );
    enrollment = new AgentEnrollmentModule(pool, () => now);
    await pool.query(`
      TRUNCATE agent_enrollment_policy_transitions, agent_enrollment_transitions,
               agent_enrollment_restricted_channels, agent_enrollments, agent_tokens, agents,
               realtime_tickets, api_idempotency_records, sync_event_audiences, sync_events,
               conversation_read_cursors, message_mentions, attachments, messages,
               conversation_memberships, conversations, device_sessions, magic_link_tokens,
               invitations, workspace_memberships, workspaces, users
      CASCADE
    `);
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'owner@example.test', 'owner', 'Owner'),
              ($2, 'member@example.test', 'member', 'Member')`,
      [ownerId, memberId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Primary', 'primary', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
      [workspaceId, ownerId, memberId],
    );
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by)
       VALUES ($1, $2, 'channel', 'General', 'general', 'workspace', $3),
              ($4, $2, 'channel', 'Secret', 'secret', 'members', $3)`,
      [generalId, workspaceId, ownerId, restrictedId],
    );
    await pool.query(
      `INSERT INTO conversation_memberships
         (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [restrictedId, workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $4::timestamptz + interval '30 days')`,
      [ownerSessionId, ownerId, hashToken(ownerSessionToken), now.toISOString()],
    );
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  it("defaults to required approval, keeps pending requests principal-free, and redeems exactly once", async () => {
    await expect(enrollment.getPolicy(ownerActor())).resolves.toMatchObject({ mode: "required" });
    await pool.query(
      `INSERT INTO conversation_memberships
         (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [restrictedId, workspaceId, memberId],
    );
    await pool.query(
      "DELETE FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2",
      [restrictedId, ownerId],
    );
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [restrictedId, ownerId],
        )
      ).rowCount,
    ).toBe(0);
    const candidate = candidateInput("mira-child", [restrictedId]);
    const requested = await enrollment.request(ownerActor(), candidate.request, "mira-request");

    expect(requested).toMatchObject({
      profile: "default-agency-v1",
      status: "pending_approval",
      restrictedChannelIds: [restrictedId],
    });
    expect(JSON.stringify(requested)).not.toContain(candidate.token);
    await expect(enrollment.redeem(requested.id, candidate.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM users WHERE kind = 'agent'"))
        .rows[0]?.count,
    ).toBe(0);
    expect((await pool.query("SELECT id FROM agent_tokens")).rows).toEqual([]);

    const persisted = await pool.query(
      `SELECT enrollment.id, enrollment.username, enrollment.status,
              enrollment.request_fingerprint, enrollment.credential_verifier,
              transition.reason
         FROM agent_enrollments AS enrollment
         JOIN agent_enrollment_transitions AS transition
           ON transition.enrollment_id = enrollment.id
        WHERE enrollment.id = $1`,
      [requested.id],
    );
    expect(JSON.stringify(persisted.rows)).not.toContain(candidate.token);
    expect(persisted.rows[0]?.credential_verifier).toEqual(hashToken(candidate.token));

    const reviewed = await enrollment.review(ownerActor(), requested.id, "approve");
    await expect(enrollment.review(ownerActor(), requested.id, "approve")).resolves.toEqual(
      reviewed,
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count
             FROM agent_enrollment_transitions
            WHERE enrollment_id = $1 AND reason = 'owner_approved'`,
          [requested.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
    const [first, second] = await Promise.all([
      enrollment.redeem(requested.id, candidate.token),
      enrollment.redeem(requested.id, candidate.token),
    ]);
    expect(first).toEqual(second);
    expect(redeemAgentEnrollmentResponseSchema.parse(first).enrollment.status).toBe("active");
    expect(first.agent.user.id).toBe(second.agent.user.id);

    const tokens = await pool.query<{ id: string; scopes: string[]; token_hash: Buffer }>(
      "SELECT id, scopes, token_hash FROM agent_tokens",
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0]?.scopes).toEqual(DEFAULT_AGENCY_AGENT_SCOPES);
    expect(tokens.rows[0]?.token_hash).toEqual(hashToken(candidate.token));
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM users WHERE kind = 'agent'"))
        .rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [restrictedId, first.agent.user.id],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const authenticated = await identityService.authenticateAgentContext(candidate.token);
    expect(agentCurrentPrincipalSchema.parse(authenticated?.currentUser).scopes).toEqual(
      DEFAULT_AGENCY_AGENT_SCOPES,
    );

    const app = await buildApp({
      cookieSecure: false,
      identity: { service: identityService },
      workspace: {
        repository: new WorkspaceRepository(pool),
        realtimeHub: new RealtimeEventHub(pool),
      },
    });
    apps.push(app);
    const messageId = randomUUID();
    const sent = await app.inject({
      method: "POST",
      url: `/v1/conversations/${restrictedId}/messages`,
      headers: {
        authorization: `Bearer ${candidate.token}`,
        "idempotency-key": messageId,
      },
      payload: {
        threadRootId: null,
        body: "Seated child can write",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: messageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(sent.statusCode).toBe(201);
    const sentMessage = sendMessageResponseSchema.parse(sent.json()).message;
    const history = await app.inject({
      method: "GET",
      url: `/v1/conversations/${restrictedId}/messages?limit=50`,
      headers: { authorization: `Bearer ${candidate.token}` },
    });
    expect(history.statusCode).toBe(200);
    expect(
      messageHistoryResponseSchema
        .parse(history.json())
        .messages.some((message) => message.id === sentMessage.id),
    ).toBe(true);
  });

  it("makes automatic approval explicit, attributable, and sensitive to later policy changes", async () => {
    const automatic = await enrollment.setPolicy(ownerActor(), "automatic");
    expect(automatic.mode).toBe("automatic");
    const policyAudit = await pool.query<{
      from_mode: string;
      to_mode: string;
      actor_user_id: string;
    }>("SELECT from_mode, to_mode, actor_user_id FROM agent_enrollment_policy_transitions");
    expect(policyAudit.rows).toEqual([
      { from_mode: "required", to_mode: "automatic", actor_user_id: ownerId },
    ]);

    const candidate = candidateInput("automatic-child");
    const requested = await enrollment.request(ownerActor(), candidate.request, "automatic-key");
    expect(requested.status).toBe("ready_to_redeem");

    await enrollment.setPolicy(ownerActor(), "required");
    expect((await enrollment.get(ownerActor(), requested.id)).status).toBe("pending_approval");
    await expect(enrollment.redeem(requested.id, candidate.token)).rejects.toMatchObject({
      statusCode: 409,
    });
    await enrollment.review(ownerActor(), requested.id, "approve");
    await expect(enrollment.redeem(requested.id, candidate.token)).resolves.toMatchObject({
      enrollment: { status: "active" },
    });
  });

  it("replays identical idempotent requests and rejects changed fingerprints or duplicate verifiers", async () => {
    const candidate = candidateInput("idempotent-child");
    const first = await enrollment.request(ownerActor(), candidate.request, "same-key");
    await expect(enrollment.request(ownerActor(), candidate.request, "same-key")).resolves.toEqual(
      first,
    );
    await expect(
      enrollment.request(
        ownerActor(),
        { ...candidate.request, displayName: "Changed child" },
        "same-key",
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    await expect(
      enrollment.request(
        ownerActor(),
        {
          ...candidate.request,
          username: "duplicate-verifier",
          displayName: "Duplicate verifier",
        },
        "different-key",
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM agent_enrollments WHERE requested_by = $1",
          [ownerId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("reauthorizes an agent requester before replaying an idempotent response", async () => {
    const inviter = await identityService.createAgent(ownerId, {
      username: "replay-inviter",
      displayName: "Replay Inviter",
    });
    const issued = await identityService.createAgentToken(ownerId, inviter.user.id, {
      label: "Replay inviter agency",
      scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
    });
    const authenticated = await identityService.authenticateAgentContext(issued.token);
    if (authenticated === null) throw new Error("Replay inviter token did not authenticate");
    const actor: AgentEnrollmentActor = {
      userId: inviter.user.id,
      workspaceId,
      kind: "agent",
      role: "member",
      agentTokenId: authenticated.agentTokenId,
      scopes: authenticated.currentUser.scopes,
    };
    const candidate = candidateInput("replay-child");
    const first = await enrollment.request(actor, candidate.request, "replay-request");
    expect(first.requestedBy).toBe(inviter.user.id);

    await identityService.revokeAgentToken(ownerId, inviter.user.id, issued.agentToken.id);

    await expect(
      enrollment.request(actor, candidate.request, "replay-request"),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("rechecks username availability and workspace capacity at redemption", async () => {
    await enrollment.setPolicy(ownerActor(), "automatic");
    const collision = candidateInput("late-collision");
    const collisionRequest = await enrollment.request(
      ownerActor(),
      collision.request,
      "collision-key",
    );
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'collision@example.test', 'late-collision', 'Collision')`,
      [randomUUID()],
    );
    await expect(enrollment.redeem(collisionRequest.id, collision.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });

    const capacity = candidateInput("capacity-child");
    const capacityRequest = await enrollment.request(
      ownerActor(),
      capacity.request,
      "capacity-key",
    );
    await pool.query(
      `WITH generated AS (
         SELECT gen_random_uuid() AS id, value
           FROM generate_series(1, 23) AS value
       ), inserted_users AS (
         INSERT INTO users (id, email, username, display_name)
         SELECT id,
                ('capacity-' || value::text || '@example.test')::public.citext,
                'capacity-' || value::text,
                'Capacity ' || value::text
           FROM generated
         RETURNING id
       )
       INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       SELECT $1, id, 'member', 'active' FROM inserted_users`,
      [workspaceId],
    );
    await expect(enrollment.redeem(capacityRequest.id, capacity.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
    expect((await pool.query("SELECT id FROM agent_tokens")).rows).toEqual([]);
  });

  it("serializes concurrent redemptions at the workspace capacity boundary", async () => {
    await enrollment.setPolicy(ownerActor(), "automatic");
    await pool.query(
      `WITH generated AS (
         SELECT gen_random_uuid() AS id, value
           FROM generate_series(1, 22) AS value
       ), inserted_users AS (
         INSERT INTO users (id, email, username, display_name)
         SELECT id,
                ('boundary-' || value::text || '@example.test')::public.citext,
                'boundary-' || value::text,
                'Boundary ' || value::text
           FROM generated
         RETURNING id
       )
       INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       SELECT $1, id, 'member', 'active' FROM inserted_users`,
      [workspaceId],
    );
    const first = candidateInput("capacity-race-one");
    const second = candidateInput("capacity-race-two");
    const [firstRequest, secondRequest] = await Promise.all([
      enrollment.request(ownerActor(), first.request, "capacity-race-one"),
      enrollment.request(ownerActor(), second.request, "capacity-race-two"),
    ]);

    const results = await Promise.allSettled([
      enrollment.redeem(firstRequest.id, first.token),
      enrollment.redeem(secondRequest.id, second.token),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { name: "ApiError", statusCode: 409, code: "CONFLICT" },
    });
    const activeMembers = await pool.query<{ count: number } & QueryResultRow>(
      `SELECT count(*)::integer AS count
         FROM workspace_memberships
        WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId],
    );
    expect(activeMembers.rows[0]?.count).toBe(25);
    const enrollments = await pool.query<{ status: string } & QueryResultRow>(
      `SELECT status
         FROM agent_enrollments
        WHERE id = ANY($1::uuid[])
        ORDER BY status`,
      [[firstRequest.id, secondRequest.id]],
    );
    expect(enrollments.rows.map((row) => row.status)).toEqual(["active", "ready_to_redeem"]);
    expect((await pool.query("SELECT user_id FROM agents")).rows).toHaveLength(1);
    expect((await pool.query("SELECT id FROM agent_tokens")).rows).toHaveLength(1);
  });

  it("maps a cross-workspace concurrent username collision to one conflict", async () => {
    const secondWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Secondary', 'secondary', $2)`,
      [secondWorkspaceId, memberId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [secondWorkspaceId, memberId],
    );
    const secondOwner = ownerActor(memberId, secondWorkspaceId);
    await Promise.all([
      enrollment.setPolicy(ownerActor(), "automatic"),
      enrollment.setPolicy(secondOwner, "automatic"),
    ]);
    const first = candidateInput("global-collision-child");
    const second = candidateInput("global-collision-child");
    const [firstRequest, secondRequest] = await Promise.all([
      enrollment.request(ownerActor(), first.request, "global-collision-primary"),
      enrollment.request(secondOwner, second.request, "global-collision-secondary"),
    ]);

    const raceLockScope = "agent-enrollment-cross-workspace-username-race";
    await pool.query(`
      CREATE FUNCTION test_block_enrollment_username_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.username = 'global-collision-child' THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended('agent-enrollment-cross-workspace-username-race', 0)
          );
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER test_block_enrollment_username_insert
      BEFORE INSERT ON users
      FOR EACH ROW
      EXECUTE FUNCTION test_block_enrollment_username_insert();
    `);
    const blocker = await pool.connect();
    const blockerPid = await blocker.query<{ pid: number } & QueryResultRow>(
      "SELECT pg_backend_pid()::integer AS pid",
    );
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [raceLockScope]);
    const attempts = [
      enrollment.redeem(firstRequest.id, first.token),
      enrollment.redeem(secondRequest.id, second.token),
    ] as const;
    const settledAttempts = Promise.allSettled(attempts);
    let unlocked = false;
    try {
      let waiterCount = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiters = await pool.query<{ count: number } & QueryResultRow>(
          `SELECT count(DISTINCT waiter.pid)::integer AS count
             FROM pg_locks AS holder
             JOIN pg_locks AS waiter
               ON waiter.locktype = holder.locktype
              AND waiter.database IS NOT DISTINCT FROM holder.database
              AND waiter.classid IS NOT DISTINCT FROM holder.classid
              AND waiter.objid IS NOT DISTINCT FROM holder.objid
              AND waiter.objsubid IS NOT DISTINCT FROM holder.objsubid
              AND waiter.mode = holder.mode
            WHERE holder.pid = $1
              AND holder.locktype = 'advisory'
              AND holder.granted
              AND NOT waiter.granted`,
          [blockerPid.rows[0]?.pid],
        );
        waiterCount = waiters.rows[0]?.count ?? 0;
        if (waiterCount === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiterCount).toBe(2);

      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [raceLockScope]);
      unlocked = true;
      const results = await settledAttempts;

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { name: "ApiError", statusCode: 409, code: "CONFLICT" },
      });
      const enrollmentStates = await pool.query<
        { status: string; workspace_id: string } & QueryResultRow
      >(
        `SELECT status, workspace_id
           FROM agent_enrollments
          WHERE id = ANY($1::uuid[])
          ORDER BY workspace_id`,
        [[firstRequest.id, secondRequest.id]],
      );
      expect(enrollmentStates.rows.map((row) => row.status).sort()).toEqual([
        "active",
        "ready_to_redeem",
      ]);
      expect(
        (await pool.query("SELECT id FROM users WHERE username = 'global-collision-child'")).rows,
      ).toHaveLength(1);
      expect((await pool.query("SELECT user_id FROM agents")).rows).toHaveLength(1);
      expect((await pool.query("SELECT id FROM agent_tokens")).rows).toHaveLength(1);
    } finally {
      if (!unlocked) {
        await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [raceLockScope]);
      }
      await settledAttempts;
      blocker.release();
      await pool.query(`
        DROP TRIGGER IF EXISTS test_block_enrollment_username_insert ON users;
        DROP FUNCTION IF EXISTS test_block_enrollment_username_insert();
      `);
    }
  });

  it("allows only active human owners to review requests or change policy", async () => {
    const candidate = candidateInput("owner-review-only");
    const requested = await enrollment.request(ownerActor(), candidate.request, "review-only-key");
    const memberActor: AgentEnrollmentActor = {
      userId: memberId,
      workspaceId,
      kind: "human",
      role: "member",
      agentTokenId: null,
      scopes: [],
    };
    await expect(enrollment.review(memberActor, requested.id, "approve")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
    await expect(enrollment.setPolicy(memberActor, "automatic")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });

    const inviter = await identityService.createAgent(ownerId, {
      username: "review-agent",
      displayName: "Review Agent",
    });
    const token = await identityService.createAgentToken(ownerId, inviter.user.id, {
      label: "Review attempt",
      scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
    });
    const authenticated = await identityService.authenticateAgentContext(token.token);
    if (authenticated === null) throw new Error("Review agent token did not authenticate");
    const agentActor: AgentEnrollmentActor = {
      userId: inviter.user.id,
      workspaceId,
      kind: "agent",
      role: "member",
      agentTokenId: authenticated.agentTokenId,
      scopes: authenticated.currentUser.scopes,
    };
    await expect(enrollment.review(agentActor, requested.id, "approve")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
    await expect(enrollment.setPolicy(agentActor, "automatic")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  });

  it("expires, rejects, and cancels without activating a candidate", async () => {
    const expiring = candidateInput("expiring-child");
    const expiringRequest = await enrollment.request(ownerActor(), expiring.request, "expiry-key");
    now = new Date(now.getTime() + 25 * 60 * 60 * 1_000);
    expect((await enrollment.get(ownerActor(), expiringRequest.id)).status).toBe("expired");
    await expect(enrollment.redeem(expiringRequest.id, expiring.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
    const expiryAudit = await pool.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status
         FROM agent_enrollment_transitions
        WHERE enrollment_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [expiringRequest.id],
    );
    expect(expiryAudit.rows[0]).toEqual({ from_status: "pending_approval", to_status: "expired" });

    const rejected = candidateInput("rejected-child");
    const rejectedRequest = await enrollment.request(ownerActor(), rejected.request, "reject-key");
    const rejectedReview = await enrollment.review(ownerActor(), rejectedRequest.id, "reject");
    expect(rejectedReview.status).toBe("rejected");
    await expect(enrollment.review(ownerActor(), rejectedRequest.id, "reject")).resolves.toEqual(
      rejectedReview,
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count
             FROM agent_enrollment_transitions
            WHERE enrollment_id = $1 AND reason = 'owner_rejected'`,
          [rejectedRequest.id],
        )
      ).rows[0]?.count,
    ).toBe(1);
    await expect(enrollment.redeem(rejectedRequest.id, rejected.token)).rejects.toMatchObject({
      statusCode: 409,
    });

    const cancelled = candidateInput("cancelled-child");
    const cancelledRequest = await enrollment.request(
      ownerActor(),
      cancelled.request,
      "cancel-key",
    );
    expect((await enrollment.cancel(ownerActor(), cancelledRequest.id)).status).toBe("cancelled");
    expect((await enrollment.cancel(ownerActor(), cancelledRequest.id)).status).toBe("cancelled");
    await expect(enrollment.redeem(cancelledRequest.id, cancelled.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
    expect((await pool.query("SELECT id FROM agent_tokens")).rows).toEqual([]);
  });

  it("records every lifecycle reason with its actor and without credential material", async () => {
    const activatedCandidate = candidateInput("audit-activated");
    const activatedRequest = await enrollment.request(
      ownerActor(),
      activatedCandidate.request,
      "audit-activated",
    );
    await enrollment.review(ownerActor(), activatedRequest.id, "approve");
    const activated = await enrollment.redeem(activatedRequest.id, activatedCandidate.token);
    const activatedIdentity = await identityService.authenticateAgentContext(
      activatedCandidate.token,
    );
    if (activatedIdentity === null) throw new Error("Activated audit agent did not authenticate");
    const activatedActor: AgentEnrollmentActor = {
      userId: activated.agent.user.id,
      workspaceId,
      kind: "agent",
      role: "member",
      agentTokenId: activatedIdentity.agentTokenId,
      scopes: activatedIdentity.currentUser.scopes,
    };

    const requesterCancelledCandidate = candidateInput("audit-requester-cancelled");
    const requesterCancelledRequest = await enrollment.request(
      activatedActor,
      requesterCancelledCandidate.request,
      "audit-requester-cancelled",
    );
    await enrollment.cancel(activatedActor, requesterCancelledRequest.id);

    const rejectedCandidate = candidateInput("audit-rejected");
    const rejectedRequest = await enrollment.request(
      ownerActor(),
      rejectedCandidate.request,
      "audit-rejected",
    );
    await enrollment.review(ownerActor(), rejectedRequest.id, "reject");

    const expiredCandidate = candidateInput("audit-expired");
    const expiredRequest = await enrollment.request(
      ownerActor(),
      expiredCandidate.request,
      "audit-expired",
    );
    now = new Date(now.getTime() + 25 * 60 * 60 * 1_000);
    await enrollment.get(ownerActor(), expiredRequest.id);

    await enrollment.setPolicy(ownerActor(), "automatic");
    const policyCandidate = candidateInput("audit-policy");
    const policyRequest = await enrollment.request(
      ownerActor(),
      policyCandidate.request,
      "audit-policy",
    );
    await enrollment.setPolicy(ownerActor(), "required");
    await enrollment.setPolicy(ownerActor(), "automatic");
    await enrollment.cancel(ownerActor(), policyRequest.id);

    const auditedIds = [
      activatedRequest.id,
      requesterCancelledRequest.id,
      rejectedRequest.id,
      expiredRequest.id,
      policyRequest.id,
    ];
    const audit = await pool.query<
      {
        actor_user_id: string | null;
        enrollment_id: string;
        from_status: string | null;
        reason: string;
        to_status: string;
      } & QueryResultRow
    >(
      `SELECT enrollment_id, from_status, to_status, actor_user_id, reason
         FROM agent_enrollment_transitions
        WHERE enrollment_id = ANY($1::uuid[])`,
      [auditedIds],
    );

    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          enrollment_id: activatedRequest.id,
          from_status: null,
          to_status: "pending_approval",
          actor_user_id: ownerId,
          reason: "approval_required",
        }),
        expect.objectContaining({
          enrollment_id: activatedRequest.id,
          from_status: "pending_approval",
          to_status: "ready_to_redeem",
          actor_user_id: ownerId,
          reason: "owner_approved",
        }),
        expect.objectContaining({
          enrollment_id: activatedRequest.id,
          from_status: "ready_to_redeem",
          to_status: "active",
          actor_user_id: activated.agent.user.id,
          reason: "candidate_redeemed",
        }),
        expect.objectContaining({
          enrollment_id: requesterCancelledRequest.id,
          from_status: "pending_approval",
          to_status: "cancelled",
          actor_user_id: activated.agent.user.id,
          reason: "requester_cancelled",
        }),
        expect.objectContaining({
          enrollment_id: rejectedRequest.id,
          from_status: "pending_approval",
          to_status: "rejected",
          actor_user_id: ownerId,
          reason: "owner_rejected",
        }),
        expect.objectContaining({
          enrollment_id: expiredRequest.id,
          from_status: "pending_approval",
          to_status: "expired",
          actor_user_id: null,
          reason: "ttl_expired",
        }),
        expect.objectContaining({
          enrollment_id: policyRequest.id,
          from_status: null,
          to_status: "ready_to_redeem",
          actor_user_id: ownerId,
          reason: "automatic_policy",
        }),
        expect.objectContaining({
          enrollment_id: policyRequest.id,
          from_status: "ready_to_redeem",
          to_status: "pending_approval",
          actor_user_id: ownerId,
          reason: "workspace_policy_changed",
        }),
        expect.objectContaining({
          enrollment_id: policyRequest.id,
          from_status: "pending_approval",
          to_status: "ready_to_redeem",
          actor_user_id: ownerId,
          reason: "workspace_policy_changed",
        }),
        expect.objectContaining({
          enrollment_id: policyRequest.id,
          from_status: "ready_to_redeem",
          to_status: "cancelled",
          actor_user_id: ownerId,
          reason: "owner_cancelled",
        }),
      ]),
    );
    expect(new Set(audit.rows.map((row) => row.reason))).toEqual(
      new Set([
        "approval_required",
        "owner_approved",
        "candidate_redeemed",
        "requester_cancelled",
        "owner_rejected",
        "ttl_expired",
        "automatic_policy",
        "workspace_policy_changed",
        "owner_cancelled",
      ]),
    );
    const serializedAudit = JSON.stringify(audit.rows);
    for (const candidate of [
      activatedCandidate,
      requesterCancelledCandidate,
      rejectedCandidate,
      expiredCandidate,
      policyCandidate,
    ]) {
      expect(serializedAudit).not.toContain(candidate.token);
    }
  });

  it("rehearses functional rollback while retaining the additive migration", async () => {
    await enrollment.setPolicy(ownerActor(), "automatic");
    const activatedCandidate = candidateInput("rollback-activated-child");
    const activatedRequest = await enrollment.request(
      ownerActor(),
      activatedCandidate.request,
      "rollback-activated-child",
    );
    const activated = await enrollment.redeem(activatedRequest.id, activatedCandidate.token);
    await expect(
      identityService.authenticateAgentContext(activatedCandidate.token),
    ).resolves.not.toBeNull();

    const openCandidate = candidateInput("rollback-open-child");
    const openRequest = await enrollment.request(
      ownerActor(),
      openCandidate.request,
      "rollback-open-child",
    );
    expect(openRequest.status).toBe("ready_to_redeem");

    await enrollment.setPolicy(ownerActor(), "required");
    expect((await enrollment.get(ownerActor(), openRequest.id)).status).toBe("pending_approval");
    expect((await enrollment.cancel(ownerActor(), openRequest.id)).status).toBe("cancelled");
    if (activated.enrollment.activatedAgentTokenId === null) {
      throw new Error("Activated rollback fixture has no token ID");
    }
    await identityService.revokeAgentToken(
      ownerId,
      activated.agent.user.id,
      activated.enrollment.activatedAgentTokenId,
    );
    await expect(
      identityService.authenticateAgentContext(activatedCandidate.token),
    ).resolves.toBeNull();
    await expect(enrollment.getPolicy(ownerActor())).resolves.toMatchObject({ mode: "required" });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM schema_migrations WHERE filename = '0023_default_agent_agency.sql'",
        )
      ).rowCount,
    ).toBe(1);

    // The rehearsal restores the controlled workspace's intended automatic policy after proving
    // the stop/cancel/revoke sequence; a primary workspace would intentionally remain required.
    await enrollment.setPolicy(ownerActor(), "automatic");
    await expect(enrollment.getPolicy(ownerActor())).resolves.toMatchObject({ mode: "automatic" });
  });

  it("rechecks the exact inviter token and permits only the inviter's visible restricted seats", async () => {
    const inviter = await identityService.createAgent(ownerId, {
      username: "atlas",
      displayName: "Atlas",
    });
    const issued = await identityService.createAgentToken(ownerId, inviter.user.id, {
      label: "Atlas agency",
      scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
    });
    await pool.query(
      `INSERT INTO conversation_memberships
         (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [restrictedId, workspaceId, inviter.user.id],
    );
    const authenticated = await identityService.authenticateAgentContext(issued.token);
    if (authenticated === null) throw new Error("Inviter token did not authenticate");
    const actor: AgentEnrollmentActor = {
      userId: inviter.user.id,
      workspaceId,
      kind: "agent",
      role: "member",
      agentTokenId: authenticated.agentTokenId,
      scopes: authenticated.currentUser.scopes,
    };
    await enrollment.setPolicy(ownerActor(), "automatic");
    await pool.query(
      `UPDATE conversation_memberships
          SET left_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE conversation_id = $1 AND user_id = $2`,
      [restrictedId, inviter.user.id],
    );
    const outsideCandidate = candidateInput("outside-seat-child", [restrictedId]);
    await expect(
      enrollment.request(actor, outsideCandidate.request, "outside-seat-child-key"),
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    await pool.query(
      `UPDATE conversation_memberships
          SET left_at = NULL, updated_at = clock_timestamp()
        WHERE conversation_id = $1 AND user_id = $2`,
      [restrictedId, inviter.user.id],
    );

    const archivedCandidate = candidateInput("archived-seat-child", [restrictedId]);
    const archivedRequest = await enrollment.request(
      actor,
      archivedCandidate.request,
      "archived-seat-child-key",
    );
    await pool.query("UPDATE conversations SET is_archived = TRUE WHERE id = $1", [restrictedId]);
    await expect(
      enrollment.redeem(archivedRequest.id, archivedCandidate.token),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    await pool.query("UPDATE conversations SET is_archived = FALSE WHERE id = $1", [restrictedId]);

    const seatCandidate = candidateInput("seat-child", [restrictedId]);
    const seatRequest = await enrollment.request(actor, seatCandidate.request, "seat-child-key");
    await pool.query(
      `UPDATE conversation_memberships
          SET left_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE conversation_id = $1 AND user_id = $2`,
      [restrictedId, inviter.user.id],
    );
    await expect(enrollment.redeem(seatRequest.id, seatCandidate.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
    await pool.query(
      `UPDATE conversation_memberships
          SET left_at = NULL, updated_at = clock_timestamp()
        WHERE conversation_id = $1 AND user_id = $2`,
      [restrictedId, inviter.user.id],
    );
    const delegatedCandidate = candidateInput("delegated-seat-child", [restrictedId]);
    const delegatedRequest = await enrollment.request(
      actor,
      delegatedCandidate.request,
      "delegated-seat-child-key",
    );
    const delegated = await enrollment.redeem(delegatedRequest.id, delegatedCandidate.token);
    expect(delegated.enrollment.status).toBe("active");
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [restrictedId, delegated.agent.user.id],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      identityService.authenticateAgentContext(delegatedCandidate.token),
    ).resolves.not.toBeNull();
    const tokenCandidate = candidateInput("token-child", [restrictedId]);
    const tokenRequest = await enrollment.request(actor, tokenCandidate.request, "token-child-key");
    const replacement = await identityService.createAgentToken(ownerId, inviter.user.id, {
      label: "Atlas replacement",
      scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
    });
    await identityService.revokeAgentToken(ownerId, inviter.user.id, issued.agentToken.id);
    await expect(
      identityService.authenticateAgentContext(replacement.token),
    ).resolves.not.toBeNull();
    await expect(enrollment.redeem(tokenRequest.id, tokenCandidate.token)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
    expect(
      (
        await pool.query(
          `SELECT id
             FROM users
            WHERE username IN (
              'outside-seat-child', 'archived-seat-child', 'seat-child', 'token-child'
            )`,
        )
      ).rows,
    ).toEqual([]);
  });

  it("retries a forced request/revocation deadlock and always leaves the inviter token revoked", async () => {
    const inviter = await identityService.createAgent(ownerId, {
      username: "racing-inviter",
      displayName: "Racing Inviter",
    });
    const issued = await identityService.createAgentToken(ownerId, inviter.user.id, {
      label: "Racing inviter agency",
      scopes: [...DEFAULT_AGENCY_AGENT_SCOPES],
    });
    const authenticated = await identityService.authenticateAgentContext(issued.token);
    if (authenticated === null) throw new Error("Inviter token did not authenticate");
    const actor: AgentEnrollmentActor = {
      userId: inviter.user.id,
      workspaceId,
      kind: "agent",
      role: "member",
      agentTokenId: authenticated.agentTokenId,
      scopes: authenticated.currentUser.scopes,
    };
    const requesterLocked = Promise.withResolvers<void>();
    const continueRequest = Promise.withResolvers<void>();
    const racingEnrollment = new AgentEnrollmentModule(pool, () => now, {
      afterRequesterLocked: async () => {
        requesterLocked.resolve();
        await continueRequest.promise;
      },
    });
    const child = candidateInput("revocation-race-child");
    const requestAttempt = racingEnrollment.request(actor, child.request, "revocation-race");
    await requesterLocked.promise;
    const revocationAttempt = identityService.revokeAgentToken(
      ownerId,
      inviter.user.id,
      issued.agentToken.id,
    );

    try {
      // Revocation now owns the workspace row and waits for request's token SHARE lock. Releasing
      // request makes it wait for that workspace row, forcing PostgreSQL to choose a deadlock
      // victim and exercising both retry-enabled transaction boundaries.
      await waitForBlockedQuery("UPDATE agent_tokens");
      continueRequest.resolve();
      const [requestResult, revocationResult] = await Promise.allSettled([
        requestAttempt,
        revocationAttempt,
      ]);

      expect(revocationResult).toEqual({ status: "fulfilled", value: true });
      if (requestResult.status === "rejected") {
        expect(requestResult.reason).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      } else {
        expect(requestResult.value).toMatchObject({
          status: "pending_approval",
          requestedBy: inviter.user.id,
        });
      }
      await expect(identityService.authenticateAgentContext(issued.token)).resolves.toBeNull();
    } finally {
      continueRequest.resolve();
      await Promise.allSettled([requestAttempt, revocationAttempt]);
    }
  });

  it("serializes the bounded open-request check across different idempotency keys", async () => {
    await pool.query(
      `INSERT INTO agent_enrollments (
         id, workspace_id, profile, status, username, display_name, token_label,
         requested_by, requested_by_kind, requested_by_agent_token_id, idempotency_key,
         request_fingerprint, credential_verifier, expires_at, created_at, updated_at
       )
       SELECT gen_random_uuid(), $1, 'default-agency-v1', 'pending_approval',
              'seed-' || value::text, 'Seed ' || value::text, 'Seed',
              $2, 'human', NULL, 'seed-' || value::text,
              decode(lpad(to_hex(value + 1000), 64, '0'), 'hex'),
              decode(lpad(to_hex(value), 64, '0'), 'hex'),
              $3::timestamptz + interval '1 day', $3, $3
         FROM generate_series(1, 99) AS value`,
      [workspaceId, ownerId, now.toISOString()],
    );
    const first = candidateInput("boundary-one");
    const second = candidateInput("boundary-two");
    const results = await Promise.allSettled([
      enrollment.request(ownerActor(), first.request, "boundary-one"),
      enrollment.request(ownerActor(), second.request, "boundary-two"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 429, code: "RATE_LIMITED" } });
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM agent_enrollments
        WHERE workspace_id = $1
          AND requested_by = $2
          AND status IN ('pending_approval', 'ready_to_redeem')`,
      [workspaceId, ownerId],
    );
    expect(count.rows[0]?.count).toBe(100);
  });

  it("accepts no body when cancelling an enrollment and rejects a JSON body", async () => {
    const app = await buildApp({
      cookieSecure: false,
      identity: {
        service: identityService,
        agentEnrollment: enrollment,
        agentProvisioningEnabled: true,
      },
    });
    apps.push(app);
    const candidate = candidateInput("bodyless-cancel-child");
    const requested = await app.inject({
      method: "POST",
      url: "/v1/agent-enrollments",
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": "bodyless-cancel-request",
      },
      payload: candidate.request,
    });
    const enrollmentId = agentEnrollmentResponseSchema.parse(requested.json()).enrollment.id;

    const withBody = await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${enrollmentId}/cancel`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { unexpected: true },
    });
    const withoutBody = await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${enrollmentId}/cancel`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });

    expect(withBody.statusCode).toBe(400);
    expect(withoutBody.statusCode).toBe(200);
  });

  it("accepts no body when redeeming an enrollment and rejects a JSON body", async () => {
    const app = await buildApp({
      cookieSecure: false,
      identity: {
        service: identityService,
        agentEnrollment: enrollment,
        agentProvisioningEnabled: true,
      },
    });
    apps.push(app);
    const candidate = candidateInput("bodyless-redeem-child");
    const requested = await app.inject({
      method: "POST",
      url: "/v1/agent-enrollments",
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": "bodyless-redeem-request",
      },
      payload: candidate.request,
    });
    const enrollmentId = agentEnrollmentResponseSchema.parse(requested.json()).enrollment.id;
    await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${enrollmentId}/review`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { decision: "approve" },
    });

    const withBody = await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${enrollmentId}/redeem`,
      headers: { authorization: `Enrollment ${candidate.token}` },
      payload: { unexpected: true },
    });
    const withoutBody = await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${enrollmentId}/redeem`,
      headers: { authorization: `Enrollment ${candidate.token}` },
    });

    expect(withBody.statusCode).toBe(400);
    expect(withoutBody.statusCode).toBe(200);
  });

  it("exposes private redemption over Authorization and honors the rollback gate", async () => {
    const app = await buildApp({
      cookieSecure: false,
      identity: {
        service: identityService,
        agentEnrollment: enrollment,
        agentProvisioningEnabled: true,
      },
    });
    apps.push(app);
    const candidate = candidateInput("route-child");
    const request = await app.inject({
      method: "POST",
      url: "/v1/agent-enrollments",
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": "route-request",
      },
      payload: candidate.request,
    });
    expect(request.statusCode).toBe(201);
    expect(request.body).not.toContain(candidate.token);
    const requested = agentEnrollmentResponseSchema.parse(request.json()).enrollment;
    await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${requested.id}/review`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { decision: "approve" },
    });
    const wrongCandidate = candidateInput("wrong-route-child");
    const wrongRedemption = await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${requested.id}/redeem`,
      headers: { authorization: `Enrollment ${wrongCandidate.token}` },
    });
    expect(wrongRedemption.statusCode).toBe(401);
    expect(apiErrorEnvelopeSchema.parse(wrongRedemption.json()).error.code).toBe("UNAUTHORIZED");
    expect(wrongRedemption.body).not.toContain(wrongCandidate.token);
    expect((await pool.query("SELECT id FROM users WHERE username = 'route-child'")).rows).toEqual(
      [],
    );
    const redeemed = await app.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${requested.id}/redeem`,
      headers: { authorization: `Enrollment ${candidate.token}` },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.headers["cache-control"]).toBe("no-store");
    expect(redeemed.body).not.toContain(candidate.token);
    expect(redeemAgentEnrollmentResponseSchema.parse(redeemed.json()).agent.user.username).toBe(
      "route-child",
    );

    const rollbackCandidate = candidateInput("rollback-ready-child");
    const rollbackRequest = await enrollment.request(
      ownerActor(),
      rollbackCandidate.request,
      "rollback-ready-request",
    );
    await enrollment.review(ownerActor(), rollbackRequest.id, "approve");

    const gated = await buildApp({
      cookieSecure: false,
      identity: {
        service: identityService,
        agentEnrollment: enrollment,
        agentProvisioningEnabled: false,
      },
    });
    apps.push(gated);
    const blockedRedemption = await gated.inject({
      method: "POST",
      url: `/v1/agent-enrollments/${rollbackRequest.id}/redeem`,
      headers: { authorization: `Enrollment ${rollbackCandidate.token}` },
    });
    expect(blockedRedemption.statusCode).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(blockedRedemption.json()).error.code).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(blockedRedemption.body).not.toContain(rollbackCandidate.token);
    expect(
      (await pool.query("SELECT id FROM users WHERE username = 'rollback-ready-child'")).rows,
    ).toEqual([]);
    const blocked = await gated.inject({
      method: "POST",
      url: "/v1/agent-enrollments",
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": "blocked-request",
      },
      payload: candidateInput("blocked-child").request,
    });
    expect(blocked.statusCode).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(blocked.json()).error.code).toBe("SERVICE_UNAVAILABLE");

    const policy = await app.inject({
      method: "GET",
      url: "/v1/agent-enrollment-policy",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });
    expect(agentEnrollmentPolicyResponseSchema.parse(policy.json()).policy.mode).toBe("required");
  });

  it("proves an activated default-agency token can work end-to-end without gaining administration", async () => {
    const attachmentRoot = await mkdtemp(path.join(os.tmpdir(), "agent-enrollment-files-"));
    try {
      const workspaceRepository = new WorkspaceRepository(pool, {
        attachmentStore: new LocalAttachmentStore(attachmentRoot),
      });
      const app = await buildApp({
        cookieSecure: false,
        identity: {
          service: identityService,
          agentEnrollment: enrollment,
          agentProvisioningEnabled: true,
        },
        workspace: {
          repository: workspaceRepository,
          realtimeHub: new RealtimeEventHub(pool),
        },
      });
      apps.push(app);
      await enrollment.setPolicy(ownerActor(), "automatic");
      const candidate = candidateInput("working-child");
      const requested = await enrollment.request(ownerActor(), candidate.request, "working-key");
      const activated = await enrollment.redeem(requested.id, candidate.token);
      const authorization = { authorization: `Bearer ${candidate.token}` };
      const capableAuthorization = {
        ...authorization,
        "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
      };
      const uploadReadyFile = async (
        headers: Readonly<Record<string, string>>,
        conversationId: string,
        fileName: string,
        bytes: Buffer,
      ) => {
        const key = randomUUID();
        const contentSha256 = createHash("sha256").update(bytes).digest("hex");
        const upload = await app.inject({
          method: "POST",
          url: "/v1/files/uploads",
          headers: { ...headers, "idempotency-key": `${key}:upload` },
          payload: {
            conversationId,
            fileName,
            contentType: "text/plain",
            sizeBytes: bytes.byteLength,
            contentSha256,
          },
        });
        expect(upload.statusCode).toBe(201);
        const attachment = createFileUploadResponseSchema.parse(upload.json()).attachment;
        const put = await app.inject({
          method: "PUT",
          url: `/v1/files/${attachment.id}/content`,
          headers: { ...headers, "content-type": "text/plain" },
          payload: bytes,
        });
        expect(put.statusCode).toBe(204);
        const completed = await app.inject({
          method: "POST",
          url: `/v1/files/${attachment.id}/complete`,
          headers: { ...headers, "idempotency-key": `${key}:complete` },
          payload: { sizeBytes: bytes.byteLength, contentSha256 },
        });
        expect(completed.statusCode).toBe(200);
        return { attachment, contentSha256 };
      };

      const grandchild = candidateInput("working-grandchild");
      const grandchildRequest = await app.inject({
        method: "POST",
        url: "/v1/agent-enrollments",
        headers: { ...authorization, "idempotency-key": "working-grandchild" },
        payload: grandchild.request,
      });
      expect(grandchildRequest.statusCode).toBe(201);
      expect(
        agentEnrollmentResponseSchema.parse(grandchildRequest.json()).enrollment,
      ).toMatchObject({
        status: "ready_to_redeem",
        requestedBy: activated.agent.user.id,
      });
      expect(grandchildRequest.body).not.toContain(grandchild.token);

      const publicChannels = await app.inject({
        method: "GET",
        url: "/v1/channels?limit=50",
        headers: authorization,
      });
      expect(publicChannels.statusCode).toBe(200);
      expect(publicChannels.json()).toMatchObject({
        channels: [
          expect.objectContaining({
            conversation: expect.objectContaining({ id: generalId }),
            joined: false,
          }),
        ],
      });
      const joinedGeneral = await app.inject({
        method: "PUT",
        url: `/v1/channels/${generalId}/membership`,
        headers: authorization,
      });
      expect(joinedGeneral.statusCode).toBe(200);

      const bootstrap = await app.inject({
        method: "GET",
        url: "/v1/bootstrap",
        headers: capableAuthorization,
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(
        bootstrap
          .json()
          .conversations.map(
            (summary: { conversation: { id: string } }) => summary.conversation.id,
          ),
      ).toContain(generalId);
      expect(
        bootstrap
          .json()
          .conversations.map(
            (summary: { conversation: { id: string } }) => summary.conversation.id,
          ),
      ).not.toContain(restrictedId);

      const bytes = Buffer.from("headless evidence", "utf8");
      const deniedUpload = await app.inject({
        method: "POST",
        url: "/v1/files/uploads",
        headers: { ...authorization, "idempotency-key": randomUUID() },
        payload: {
          conversationId: generalId,
          fileName: "agent-write-denied.txt",
          contentType: "text/plain",
          sizeBytes: bytes.byteLength,
          contentSha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      expect(deniedUpload.statusCode).toBe(403);
      const { attachment, contentSha256 } = await uploadReadyFile(
        { cookie: `hype_comms_session=${ownerSessionToken}` },
        generalId,
        "evidence.txt",
        bytes,
      );
      const ownerEvidenceMessageId = randomUUID();
      const ownerEvidenceMessage = await app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: {
          cookie: `hype_comms_session=${ownerSessionToken}`,
          "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
          "idempotency-key": ownerEvidenceMessageId,
        },
        payload: {
          threadRootId: null,
          body: "Headless evidence is ready",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: ownerEvidenceMessageId,
          mentionedUserIds: [],
          attachmentIds: [attachment.id],
        },
      });
      expect(ownerEvidenceMessage.statusCode).toBe(201);

      const childMessageId = randomUUID();
      const childMessage = await app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: {
          ...capableAuthorization,
          "idempotency-key": childMessageId,
        },
        payload: {
          threadRootId: null,
          body: "@owner headless evidence is ready",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: childMessageId,
          mentionedUserIds: [ownerId],
          attachmentIds: [],
        },
      });
      expect(childMessage.statusCode).toBe(201);
      const sent = sendMessageResponseSchema.parse(childMessage.json());
      expect(sent.attachments).toEqual([]);
      expect(
        (
          await pool.query<{ mentioned_user_id: string }>(
            "SELECT mentioned_user_id FROM message_mentions WHERE message_id = $1",
            [sent.message.id],
          )
        ).rows,
      ).toEqual([{ mentioned_user_id: ownerId }]);

      const mismatchedMentionId = randomUUID();
      const mismatchedMention = await app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: { ...authorization, "idempotency-key": mismatchedMentionId },
        payload: {
          threadRootId: null,
          body: "Owner is not explicitly mentioned",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: mismatchedMentionId,
          mentionedUserIds: [ownerId],
          attachmentIds: [],
        },
      });
      expect(mismatchedMention.statusCode).toBe(400);

      const mentionLookingId = randomUUID();
      const mentionLooking = await app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: { ...authorization, "idempotency-key": mentionLookingId },
        payload: {
          threadRootId: null,
          body: "@owner is plain text without an explicit mention ID",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: mentionLookingId,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      });
      expect(mentionLooking.statusCode).toBe(201);
      const mentionLookingMessage = sendMessageResponseSchema.parse(mentionLooking.json()).message;
      expect(
        (
          await pool.query("SELECT 1 FROM message_mentions WHERE message_id = $1", [
            mentionLookingMessage.id,
          ])
        ).rowCount,
      ).toBe(0);

      const peerBytes = Buffer.from("owner supplied evidence", "utf8");
      const peerFile = await uploadReadyFile(
        { cookie: `hype_comms_session=${ownerSessionToken}` },
        generalId,
        "owner-evidence.txt",
        peerBytes,
      );
      const peerMessageId = randomUUID();
      const peerMessage = await app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: {
          cookie: `hype_comms_session=${ownerSessionToken}`,
          "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
          "idempotency-key": peerMessageId,
        },
        payload: {
          threadRootId: null,
          body: "Peer-owned file for the child",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: peerMessageId,
          mentionedUserIds: [],
          attachmentIds: [peerFile.attachment.id],
        },
      });
      expect(peerMessage.statusCode).toBe(201);

      const [history, files, downloaded, peerDownloaded] = await Promise.all([
        app.inject({
          method: "GET",
          url: `/v1/conversations/${generalId}/messages?limit=50`,
          headers: capableAuthorization,
        }),
        app.inject({
          method: "GET",
          url: `/v1/conversations/${generalId}/files?limit=50`,
          headers: capableAuthorization,
        }),
        app.inject({
          method: "GET",
          url: `/v1/files/${attachment.id}/content`,
          headers: authorization,
        }),
        app.inject({
          method: "GET",
          url: `/v1/files/${peerFile.attachment.id}/content`,
          headers: capableAuthorization,
        }),
      ]);
      expect(history.statusCode).toBe(200);
      expect(history.json().attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: attachment.id, status: "ready" }),
          expect.objectContaining({ id: peerFile.attachment.id, status: "ready" }),
        ]),
      );
      expect(files.statusCode).toBe(200);
      expect(files.json().files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: attachment.id }),
          expect.objectContaining({ id: peerFile.attachment.id }),
        ]),
      );
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload).toEqual(bytes);
      expect(downloaded.headers["content-length"]).toBe(String(bytes.byteLength));
      expect(downloaded.headers[ATTACHMENT_CONTENT_SHA256_HEADER]).toBe(contentSha256);
      expect(peerDownloaded.statusCode).toBe(200);
      expect(peerDownloaded.rawPayload).toEqual(peerBytes);
      expect(peerDownloaded.headers[ATTACHMENT_CONTENT_SHA256_HEADER]).toBe(peerFile.contentSha256);

      const direct = await app.inject({
        method: "POST",
        url: "/v1/direct-conversations",
        headers: authorization,
        payload: { memberId: ownerId },
      });
      expect(direct.statusCode).toBe(201);
      const directId = conversationMutationResponseSchema.parse(direct.json()).conversation
        .conversation.id;
      const directMessageId = randomUUID();
      const directMessage = await app.inject({
        method: "POST",
        url: `/v1/conversations/${directId}/messages`,
        headers: { ...authorization, "idempotency-key": directMessageId },
        payload: {
          threadRootId: null,
          body: "Owner, the DM lane works",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: directMessageId,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      });
      expect(directMessage.statusCode).toBe(201);

      const ownerDirectMessageId = randomUUID();
      const ownerDirectMessage = await app.inject({
        method: "POST",
        url: `/v1/conversations/${directId}/messages`,
        headers: {
          cookie: `hype_comms_session=${ownerSessionToken}`,
          "idempotency-key": ownerDirectMessageId,
        },
        payload: {
          threadRootId: null,
          body: "Incoming owner reply",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: ownerDirectMessageId,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      });
      expect(ownerDirectMessage.statusCode).toBe(201);
      const ownerDirectMessageRecord = sendMessageResponseSchema.parse(
        ownerDirectMessage.json(),
      ).message;
      const directHistory = await app.inject({
        method: "GET",
        url: `/v1/conversations/${directId}/messages?limit=50`,
        headers: authorization,
      });
      expect(directHistory.statusCode).toBe(200);
      expect(
        messageHistoryResponseSchema
          .parse(directHistory.json())
          .messages.some((message) => message.id === ownerDirectMessageRecord.id),
      ).toBe(true);

      const ownerMentionId = randomUUID();
      const ownerMention = await app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: {
          cookie: `hype_comms_session=${ownerSessionToken}`,
          "idempotency-key": ownerMentionId,
        },
        payload: {
          threadRootId: null,
          body: "@working-child please verify",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: ownerMentionId,
          mentionedUserIds: [activated.agent.user.id],
          attachmentIds: [],
        },
      });
      expect(ownerMention.statusCode).toBe(201);
      const mentionedMessage = sendMessageResponseSchema.parse(ownerMention.json()).message;
      const sync = await app.inject({
        method: "GET",
        url: "/v1/sync?after=0&limit=100",
        headers: capableAuthorization,
      });
      expect(sync.statusCode).toBe(200);
      expect(
        syncResponseSchema
          .parse(sync.json())
          .events.some(
            (event) =>
              event.type === "message.created" &&
              event.payload.message.id === mentionedMessage.id &&
              event.payload.mentionedUserIds.includes(activated.agent.user.id),
          ),
      ).toBe(true);

      const restrictedBytes = Buffer.from("restricted owner evidence", "utf8");
      const restrictedFile = await uploadReadyFile(
        { cookie: `hype_comms_session=${ownerSessionToken}` },
        restrictedId,
        "restricted-owner-evidence.txt",
        restrictedBytes,
      );
      const restrictedMessageId = randomUUID();
      const restrictedMessage = await app.inject({
        method: "POST",
        url: `/v1/conversations/${restrictedId}/messages`,
        headers: {
          cookie: `hype_comms_session=${ownerSessionToken}`,
          "idempotency-key": restrictedMessageId,
        },
        payload: {
          threadRootId: null,
          body: "Restricted file",
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId: restrictedMessageId,
          mentionedUserIds: [],
          attachmentIds: [restrictedFile.attachment.id],
        },
      });
      expect(restrictedMessage.statusCode).toBe(201);
      const restrictedMessageRecord = sendMessageResponseSchema.parse(
        restrictedMessage.json(),
      ).message;

      const noReadToken = await identityService.createAgentToken(ownerId, activated.agent.user.id, {
        label: "No workspace read",
        scopes: ["messages:write"],
      });
      const restrictedSendId = randomUUID();

      const denied = await Promise.all([
        app.inject({
          method: "GET",
          url: `/v1/conversations/${restrictedId}/messages?limit=50`,
          headers: authorization,
        }),
        app.inject({
          method: "POST",
          url: `/v1/conversations/${restrictedId}/messages`,
          headers: { ...authorization, "idempotency-key": restrictedSendId },
          payload: {
            threadRootId: null,
            body: "Not seated",
            bodyFormat: "hype_comms_markdown_v1",
            clientMessageId: restrictedSendId,
            mentionedUserIds: [],
            attachmentIds: [],
          },
        }),
        app.inject({
          method: "GET",
          url: `/v1/conversations/${restrictedId}/files?limit=50`,
          headers: capableAuthorization,
        }),
        app.inject({
          method: "POST",
          url: "/v1/attachments/query",
          headers: capableAuthorization,
          payload: { messageIds: [restrictedMessageRecord.id] },
        }),
        app.inject({
          method: "GET",
          url: `/v1/files/${restrictedFile.attachment.id}/content`,
          headers: capableAuthorization,
        }),
        app.inject({
          method: "GET",
          url: `/v1/conversations/${generalId}/files?limit=50`,
          headers: {
            authorization: `Bearer ${noReadToken.token}`,
            "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
          },
        }),
        app.inject({
          method: "POST",
          url: "/v1/channels",
          headers: authorization,
          payload: { name: "No admin", slug: "no-admin", topic: null },
        }),
        app.inject({
          method: "PUT",
          url: `/v1/channels/${restrictedId}/members/${activated.agent.user.id}`,
          headers: authorization,
          payload: { role: "member" },
        }),
        app.inject({
          method: "PUT",
          url: `/v1/conversations/${generalId}/read-cursor`,
          headers: authorization,
          payload: { lastReadMessageId: sent.message.id },
        }),
      ]);
      expect(denied.map((response) => response.statusCode)).toEqual([
        404, 404, 404, 404, 404, 403, 403, 403, 403,
      ]);

      const taskBot = await app.inject({
        method: "POST",
        url: "/v1/agent-enrollments",
        headers: {
          authorization: `Bearer hype_comms_bot_${"b".repeat(43)}`,
          "idempotency-key": "task-bot-denied",
        },
        payload: candidateInput("task-bot-child").request,
      });
      expect(taskBot.statusCode).toBe(401);
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });
});
