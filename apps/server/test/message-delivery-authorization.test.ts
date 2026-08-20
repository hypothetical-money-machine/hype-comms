import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeIdentifier, Pool, type PoolClient } from "pg";

import type {
  AgentCurrentPrincipal,
  CurrentUser,
  SendConversationMessageRequest,
} from "@hype-comms/contracts";

import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { ApiError } from "../src/errors.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import type { AuthenticatedIdentity } from "../src/modules/identity/service.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const now = "2026-08-09T12:00:00.000Z";
const ownerId = "10000000-0000-4000-8000-000000000001";
const memberId = "10000000-0000-4000-8000-000000000002";
const observerId = "10000000-0000-4000-8000-000000000003";
const workspaceId = "10000000-0000-4000-8000-000000000004";
const generalId = "10000000-0000-4000-8000-000000000005";
const agentId = "10000000-0000-4000-8000-000000000006";
const agentTokenId = "10000000-0000-4000-8000-000000000007";

class NoopEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

function identity(
  id: string,
  username: string,
  displayName: string,
  role: "owner" | "member",
): AuthenticatedIdentity {
  const currentUser: CurrentUser = {
    user: {
      id,
      kind: "human",
      username,
      displayName,
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
    },
    email: `${username}@example.com`,
    workspaceId,
    role,
  };
  return { currentUser, sessionId: randomUUID(), principalKind: "human" };
}

const owner = identity(ownerId, "owner", "Owner", "owner");
const member = identity(memberId, "member", "Member", "member");

const agentPrincipal: AgentCurrentPrincipal = {
  type: "agent",
  user: {
    id: agentId,
    kind: "agent",
    username: "delivery-agent",
    displayName: "Delivery Agent",
    avatarUrl: null,
    createdAt: now,
    updatedAt: now,
  },
  workspaceId,
  role: "member",
  scopes: ["workspace:read", "messages:write"],
};
const agent: AuthenticatedIdentity = {
  currentUser: agentPrincipal,
  principalKind: "agent",
  agentTokenId,
};

function message(clientMessageId: string, body = "hello"): SendConversationMessageRequest {
  return {
    threadRootId: null,
    body,
    bodyFormat: "hype_comms_markdown_v1",
    clientMessageId,
    mentionedUserIds: [],
    attachmentIds: [],
  };
}

type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

describeWithPostgres("message-delivery authorization", () => {
  const schemaName = `message_delivery_authorization_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const applicationName = `delivery_${process.pid}_${randomUUID().slice(0, 8)}`;
  let adminPool: Pool;
  let pool: Pool;
  let identityService: IdentityService;
  let repository: WorkspaceRepository;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = new Pool({
      application_name: applicationName,
      connectionString: schemaScopedUrl(testDatabaseUrl, schemaName),
      max: 8,
    });
    await runMigrations(pool);
    identityService = new IdentityService(
      new IdentityRepository(pool),
      new NoopEmailSender(),
      new SignInThrottle(),
      () => new Date(now),
      "http://127.0.0.1:3000",
    );
    repository = new WorkspaceRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE realtime_tickets, api_idempotency_records, sync_event_audiences,
               sync_events, conversation_read_cursors, message_reactions, message_mentions,
               attachments, messages,
               conversation_memberships, conversations, device_sessions, magic_link_tokens,
               invitations, workspace_memberships, workspaces, users
      CASCADE
    `);
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'owner@example.com', 'owner', 'Owner'),
              ($2, 'member@example.com', 'member', 'Member'),
              ($3, 'observer@example.com', 'observer', 'Observer')`,
      [ownerId, memberId, observerId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Hype Comms', 'hype-comms', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'),
              ($1, $3, 'member', 'active'),
              ($1, $4, 'member', 'active')`,
      [workspaceId, ownerId, memberId, observerId],
    );
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by)
       VALUES ($1, $2, 'channel', 'General', 'general', 'workspace', $3)`,
      [generalId, workspaceId, ownerId],
    );
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function waitForBlockedTransaction(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const blocked = await adminPool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event_type = 'Lock'`,
        [applicationName],
      );
      if ((blocked.rows[0]?.count ?? 0) > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for a transaction to block on the conversation lock");
  }

  async function waitForBlockedQuery(queryFragment: string): Promise<{
    readonly blocking_pids: number[];
    readonly query: string;
    readonly state: string;
    readonly wait_event_type: string | null;
  }> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const blocked = await adminPool.query<{
        blocking_pids: number[];
        query: string;
        state: string;
        wait_event_type: string | null;
      }>(
        `SELECT pg_blocking_pids(pid) AS blocking_pids,
                query,
                state,
                wait_event_type
           FROM pg_stat_activity
          WHERE application_name = $1
            AND position($2 IN query) > 0
            AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0`,
        [applicationName, queryFragment],
      );
      const activity = blocked.rows[0];
      if (activity !== undefined) return activity;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for blocked query containing: ${queryFragment}`);
  }

  async function waitForQueryActivity(
    pid: number,
    queryFragment: string,
  ): Promise<{
    readonly blocking_pids: number[];
    readonly query: string;
    readonly state: string;
    readonly wait_event_type: string | null;
  }> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await adminPool.query<{
        blocking_pids: number[];
        query: string;
        state: string;
        wait_event_type: string | null;
      }>(
        `SELECT pg_blocking_pids(pid) AS blocking_pids,
                query,
                state,
                wait_event_type
           FROM pg_stat_activity
          WHERE pid = $1
            AND position($2 IN query) > 0`,
        [pid, queryFragment],
      );
      const activity = result.rows[0];
      if (activity !== undefined) return activity;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for query activity containing: ${queryFragment}`);
  }

  async function insertActiveAgent(): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       VALUES ($1, NULL, 'agent', 'delivery-agent', 'Delivery Agent')`,
      [agentId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [workspaceId, agentId],
    );
    await pool.query(
      `INSERT INTO agents (user_id, workspace_id, created_by)
       VALUES ($1, $2, $3)`,
      [agentId, workspaceId, ownerId],
    );
  }

  async function reactivateAgent(): Promise<void> {
    await pool.query(
      `UPDATE agents SET disabled_at = NULL WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, agentId],
    );
    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'active', updated_at = clock_timestamp()
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, agentId],
    );
  }

  async function expectCommittedSendArtifacts(
    actorUserId: string,
    clientMessageId: string,
  ): Promise<void> {
    const result = await pool.query<{
      event_count: number;
      idempotency_count: number;
      message_count: number;
    }>(
      `SELECT (SELECT count(*)::integer
                 FROM messages
                WHERE author_id = $1
                  AND client_message_id = $2::uuid) AS message_count,
              (SELECT count(*)::integer
                 FROM sync_events
                WHERE event_type = 'message.created'
                  AND actor_user_id = $1
                  AND payload -> 'message' ->> 'clientMessageId' = $2::text) AS event_count,
              (SELECT count(*)::integer
                 FROM api_idempotency_records
                WHERE actor_user_id = $1
                  AND idempotency_key = $2::text) AS idempotency_count`,
      [actorUserId, clientMessageId],
    );
    expect(result.rows[0]).toEqual({
      event_count: 1,
      idempotency_count: 1,
      message_count: 1,
    });
  }

  async function beginAgentDisable(client: PoolClient): Promise<void> {
    await client.query("BEGIN");
    const transactionalRepository = new IdentityRepository(client);
    await transactionalRepository.lockWorkspaceMembership(workspaceId, agentId);
    await transactionalRepository.lockWorkspace(workspaceId);
    await transactionalRepository.disableAgent(workspaceId, agentId, now, ownerId);
  }

  async function expectNoSendArtifacts(input: {
    readonly actorUserId: string;
    readonly clientMessageId: string;
    readonly conversationId: string;
    readonly expectedConversationSequence: string;
    readonly expectedWorkspaceSequence: string;
  }): Promise<void> {
    const result = await pool.query<{
      conversation_sequence: string;
      event_count: number;
      idempotency_count: number;
      message_count: number;
      workspace_sequence: string;
    }>(
      `WITH matching_messages AS (
         SELECT id
           FROM messages
          WHERE author_id = $1
            AND client_message_id = $2::uuid
       ), matching_events AS (
         SELECT id
           FROM sync_events
          WHERE event_type = 'message.created'
            AND payload -> 'message' ->> 'clientMessageId' = $2::text
       )
       SELECT (SELECT count(*)::integer FROM matching_messages) AS message_count,
              (SELECT count(*)::integer
                 FROM api_idempotency_records
                WHERE actor_user_id = $1
                  AND idempotency_key = $2::text) AS idempotency_count,
              (SELECT count(*)::integer FROM matching_events) AS event_count,
              (SELECT last_message_sequence::text
                 FROM conversations
                WHERE id = $3::uuid) AS conversation_sequence,
              (SELECT last_event_sequence::text
                 FROM workspaces
                WHERE id = $4::uuid) AS workspace_sequence`,
      [input.actorUserId, input.clientMessageId, input.conversationId, workspaceId],
    );

    expect(result.rows[0]).toEqual({
      conversation_sequence: input.expectedConversationSequence,
      event_count: 0,
      idempotency_count: 0,
      message_count: 0,
      workspace_sequence: input.expectedWorkspaceSequence,
    });
  }

  it("writes nothing when channel removal commits while a send waits", async () => {
    const created = await repository.createChannel(owner, {
      name: "Leads",
      slug: "leads",
      topic: null,
      access: "members",
    });
    const conversationId = created.conversation.conversation.id;
    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" });

    const removalLocked = Promise.withResolvers<void>();
    const continueRemoval = Promise.withResolvers<void>();
    const removingRepository = new WorkspaceRepository(pool, {
      afterRemoveChannelMemberConversationLocked: async () => {
        removalLocked.resolve();
        await continueRemoval.promise;
      },
    });
    const sendLocked = Promise.withResolvers<void>();
    const sendingRepository = new WorkspaceRepository(pool, {
      afterConversationLocked: async () => sendLocked.resolve(),
    });
    const input = message(randomUUID(), "removed sender");

    try {
      const removing = removingRepository.removeChannelMember(owner, conversationId, memberId);
      await removalLocked.promise;
      const sending = settle(sendingRepository.sendMessage(member, conversationId, input));
      await waitForBlockedTransaction();
      continueRemoval.resolve();
      const removed = await removing;

      await sendLocked.promise;
      expect(await sending).toMatchObject({
        status: "rejected",
        reason: {
          statusCode: 404,
          code: "NOT_FOUND",
        } satisfies Partial<ApiError>,
      });
      await expectNoSendArtifacts({
        actorUserId: memberId,
        clientMessageId: input.clientMessageId,
        conversationId,
        expectedConversationSequence: "0",
        expectedWorkspaceSequence: removed.syncCursor,
      });
    } finally {
      continueRemoval.resolve();
    }
  });

  it("writes nothing when workspace membership revocation commits while a send waits", async () => {
    const blocker = await pool.connect();
    const sendLocked = Promise.withResolvers<void>();
    const sendingRepository = new WorkspaceRepository(pool, {
      afterConversationLocked: async () => sendLocked.resolve(),
    });
    const input = message(randomUUID(), "revoked sender");

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE", [generalId]);
      await blocker.query(
        `UPDATE workspace_memberships
            SET status = 'revoked', updated_at = clock_timestamp()
          WHERE workspace_id = $1
            AND user_id = $2`,
        [workspaceId, memberId],
      );
      const sending = settle(sendingRepository.sendMessage(member, generalId, input));
      await waitForBlockedTransaction();
      await blocker.query("COMMIT");

      await sendLocked.promise;
      expect(await sending).toMatchObject({
        status: "rejected",
        reason: {
          statusCode: 401,
          code: "UNAUTHORIZED",
        } satisfies Partial<ApiError>,
      });
      await expectNoSendArtifacts({
        actorUserId: memberId,
        clientMessageId: input.clientMessageId,
        conversationId: generalId,
        expectedConversationSequence: "0",
        expectedWorkspaceSequence: "0",
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("makes a human revocation wait when authorization has already read active", async () => {
    const revoker = await pool.connect();
    const authorizationLocked = Promise.withResolvers<void>();
    const continueSend = Promise.withResolvers<void>();
    const sendingRepository = new WorkspaceRepository(pool, {
      afterMessageAuthorizationLocked: async () => {
        authorizationLocked.resolve();
        await continueSend.promise;
      },
    });
    const input = message(randomUUID(), "last authorized human message");
    const queryMarker = "revoke-human-after-authorization";
    let sending: ReturnType<WorkspaceRepository["sendMessage"]> | undefined;
    let revoking: ReturnType<PoolClient["query"]> | undefined;

    try {
      await revoker.query("BEGIN");
      const pidResult = await revoker.query<{ pid: number }>(
        "SELECT pg_backend_pid()::integer AS pid",
      );
      const pid = pidResult.rows[0]?.pid;
      if (pid === undefined) throw new Error("Could not read revoker backend PID");

      sending = sendingRepository.sendMessage(member, generalId, input);
      await authorizationLocked.promise;
      revoking = revoker.query(
        `/* revoke-human-after-authorization */
         UPDATE workspace_memberships
            SET status = 'revoked', updated_at = clock_timestamp()
          WHERE workspace_id = $1
            AND user_id = $2`,
        [workspaceId, memberId],
      );

      const activity = await waitForQueryActivity(pid, queryMarker);
      expect(activity).toMatchObject({
        state: "active",
        wait_event_type: "Lock",
      });
      expect(activity.blocking_pids.length).toBeGreaterThan(0);

      continueSend.resolve();
      await expect(sending).resolves.toMatchObject({
        message: { authorId: memberId, clientMessageId: input.clientMessageId },
      });
      await revoking;
      await revoker.query("COMMIT");

      const membership = await pool.query<{ status: string }>(
        `SELECT status
           FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberId],
      );
      expect(membership.rows[0]?.status).toBe("revoked");
      await expectCommittedSendArtifacts(memberId, input.clientMessageId);
    } finally {
      continueSend.resolve();
      await Promise.allSettled([sending, revoking].filter((promise) => promise !== undefined));
      await revoker.query("ROLLBACK");
      revoker.release();
    }
  });

  it("makes disableAgent wait when agent authorization has already read active", async () => {
    await insertActiveAgent();
    const authorizationLocked = Promise.withResolvers<void>();
    const continueSend = Promise.withResolvers<void>();
    const sendingRepository = new WorkspaceRepository(pool, {
      afterMessageAuthorizationLocked: async () => {
        authorizationLocked.resolve();
        await continueSend.promise;
      },
    });
    const input = message(randomUUID(), "last authorized agent message");
    let sending: ReturnType<WorkspaceRepository["sendMessage"]> | undefined;
    let disabling: ReturnType<IdentityService["disableAgent"]> | undefined;

    try {
      sending = sendingRepository.sendMessage(agent, generalId, input);
      await authorizationLocked.promise;
      disabling = identityService.disableAgent(ownerId, agentId);

      const activity = await waitForBlockedQuery("FROM workspace_memberships");
      expect(activity).toMatchObject({ state: "active", wait_event_type: "Lock" });
      expect(activity.blocking_pids.length).toBeGreaterThan(0);

      continueSend.resolve();
      await expect(sending).resolves.toMatchObject({
        message: { authorId: agentId, clientMessageId: input.clientMessageId },
      });
      await expect(disabling).resolves.toBe(true);

      const membership = await pool.query<{ status: string }>(
        `SELECT status
           FROM workspace_memberships
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, agentId],
      );
      expect(membership.rows[0]?.status).toBe("revoked");
      await expectCommittedSendArtifacts(agentId, input.clientMessageId);
    } finally {
      continueSend.resolve();
      await Promise.allSettled([sending, disabling].filter((promise) => promise !== undefined));
    }
  });

  it("does not deadlock delivery and agent revocation in either lock-arrival order", async () => {
    await insertActiveAgent();

    for (let iteration = 0; iteration < 3; iteration += 1) {
      await reactivateAgent();
      const authorizationLocked = Promise.withResolvers<void>();
      const continueSend = Promise.withResolvers<void>();
      const sendingRepository = new WorkspaceRepository(pool, {
        afterMessageAuthorizationLocked: async () => {
          authorizationLocked.resolve();
          await continueSend.promise;
        },
      });
      const deliveryFirstInput = message(randomUUID(), `delivery first ${iteration}`);
      const sending = settle(sendingRepository.sendMessage(agent, generalId, deliveryFirstInput));
      let disabling: Promise<Settled<boolean>> | undefined;
      try {
        await authorizationLocked.promise;
        disabling = settle(identityService.disableAgent(ownerId, agentId));
        await waitForBlockedQuery("FROM workspace_memberships");
        continueSend.resolve();

        expect(await sending).toMatchObject({ status: "fulfilled" });
        expect(await disabling).toEqual({ status: "fulfilled", value: true });
      } finally {
        continueSend.resolve();
        await Promise.allSettled([sending, disabling].filter((promise) => promise !== undefined));
      }

      await reactivateAgent();
      const revoker = await pool.connect();
      const revocationFirstInput = message(randomUUID(), `revocation first ${iteration}`);
      let revocationFirstSend:
        Promise<Settled<Awaited<ReturnType<WorkspaceRepository["sendMessage"]>>>> | undefined;
      try {
        await beginAgentDisable(revoker);
        revocationFirstSend = settle(
          repository.sendMessage(agent, generalId, revocationFirstInput),
        );
        const activity = await waitForBlockedQuery("FOR SHARE OF membership");
        expect(activity.blocking_pids.length).toBeGreaterThan(0);
        await revoker.query("COMMIT");
        expect(await revocationFirstSend).toMatchObject({
          status: "rejected",
          reason: { statusCode: 401, code: "UNAUTHORIZED" } satisfies Partial<ApiError>,
        });
      } finally {
        await revoker.query("ROLLBACK");
        revoker.release();
      }
    }
  });

  it("writes nothing when archive commits while a send waits", async () => {
    const created = await repository.createChannel(owner, {
      name: "Announcements",
      slug: "announcements",
      topic: null,
      access: "workspace",
    });
    const conversationId = created.conversation.conversation.id;
    const archiveLocked = Promise.withResolvers<void>();
    const continueArchive = Promise.withResolvers<void>();
    const archivingRepository = new WorkspaceRepository(pool, {
      afterArchiveConversationLocked: async () => {
        archiveLocked.resolve();
        await continueArchive.promise;
      },
    });
    const sendLocked = Promise.withResolvers<void>();
    const sendingRepository = new WorkspaceRepository(pool, {
      afterConversationLocked: async () => sendLocked.resolve(),
    });
    const input = message(randomUUID(), "archived conversation");

    try {
      const archiving = archivingRepository.archiveChannel(owner, conversationId);
      await archiveLocked.promise;
      const sending = settle(sendingRepository.sendMessage(owner, conversationId, input));
      await waitForBlockedTransaction();
      continueArchive.resolve();
      const archived = await archiving;

      await sendLocked.promise;
      expect(await sending).toMatchObject({
        status: "rejected",
        reason: {
          statusCode: 404,
          code: "NOT_FOUND",
        } satisfies Partial<ApiError>,
      });
      await expectNoSendArtifacts({
        actorUserId: ownerId,
        clientMessageId: input.clientMessageId,
        conversationId,
        expectedConversationSequence: "0",
        expectedWorkspaceSequence: archived.syncCursor,
      });
    } finally {
      continueArchive.resolve();
    }
  });

  it("replays a committed message after archive for a still-authorized sender", async () => {
    const created = await repository.createChannel(owner, {
      name: "Shipping",
      slug: "shipping",
      topic: null,
      access: "workspace",
    });
    const conversationId = created.conversation.conversation.id;
    const sendLocked = Promise.withResolvers<void>();
    const continueSend = Promise.withResolvers<void>();
    const sendingRepository = new WorkspaceRepository(pool, {
      afterConversationLocked: async () => {
        sendLocked.resolve();
        await continueSend.promise;
      },
    });
    const input = message(randomUUID(), "ship it");
    let sending: ReturnType<WorkspaceRepository["sendMessage"]> | undefined;
    let archiving: ReturnType<WorkspaceRepository["archiveChannel"]> | undefined;

    try {
      sending = sendingRepository.sendMessage(owner, conversationId, input);
      await sendLocked.promise;
      archiving = repository.archiveChannel(owner, conversationId);
      await waitForBlockedTransaction();
      continueSend.resolve();

      const sent = await sending;
      await archiving;
      await expect(repository.sendMessage(owner, conversationId, input)).resolves.toEqual(sent);
      await expect(
        repository.sendMessage(owner, conversationId, {
          ...input,
          clientMessageId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" } satisfies Partial<ApiError>);
    } finally {
      continueSend.resolve();
      await Promise.allSettled([sending, archiving].filter((promise) => promise !== undefined));
    }
  });

  it("does not replay a committed message after the sender loses channel membership", async () => {
    const created = await repository.createChannel(owner, {
      name: "Leadership",
      slug: "leadership",
      topic: null,
      access: "members",
    });
    const conversationId = created.conversation.conversation.id;
    await repository.upsertChannelMember(owner, conversationId, memberId, { role: "member" });
    const input = message(randomUUID(), "before removal");
    await repository.sendMessage(member, conversationId, input);
    await repository.removeChannelMember(owner, conversationId, memberId);

    await expect(repository.sendMessage(member, conversationId, input)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<ApiError>);
  });

  it("does not replay a committed message after workspace membership revocation", async () => {
    const input = message(randomUUID(), "before workspace revocation");
    await repository.sendMessage(member, generalId, input);
    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'revoked', updated_at = clock_timestamp()
        WHERE workspace_id = $1
          AND user_id = $2`,
      [workspaceId, memberId],
    );

    for (const attempt of [input, { ...input, clientMessageId: randomUUID() }]) {
      await expect(repository.sendMessage(member, generalId, attempt)).rejects.toMatchObject({
        statusCode: 401,
        code: "UNAUTHORIZED",
      } satisfies Partial<ApiError>);
    }
  });

  it("collapses concurrent duplicate sends to one canonical message", async () => {
    const clientMessageId = randomUUID();
    const [first, duplicate] = await Promise.all([
      repository.sendMessage(owner, generalId, message(clientMessageId)),
      repository.sendMessage(owner, generalId, message(clientMessageId)),
    ]);

    expect(duplicate).toEqual(first);
    const artifacts = await pool.query<{
      event_count: number;
      idempotency_count: number;
      message_count: number;
    }>(
      `SELECT (SELECT count(*)::integer
                 FROM messages
                WHERE author_id = $1
                  AND client_message_id = $2::uuid) AS message_count,
              (SELECT count(*)::integer
                 FROM sync_events
                WHERE event_type = 'message.created'
                  AND payload -> 'message' ->> 'clientMessageId' = $2::text) AS event_count,
              (SELECT count(*)::integer
                 FROM api_idempotency_records
                WHERE actor_user_id = $1
                  AND idempotency_key = $2::text) AS idempotency_count`,
      [ownerId, clientMessageId],
    );
    expect(artifacts.rows[0]).toEqual({
      event_count: 1,
      idempotency_count: 1,
      message_count: 1,
    });
  });
});
