import { once } from "node:events";
import { randomUUID } from "node:crypto";

import {
  agentCurrentPrincipalSchema,
  agentTokenSecretSchema,
  apiErrorEnvelopeSchema,
  conversationMutationResponseSchema,
  createAgentTokenResponseSchema,
  createAgentResponseSchema,
  listAgentTokensResponseSchema,
  listAgentsResponseSchema,
  listInvitationsResponseSchema,
  listMembersResponseSchema,
  sendMessageResponseSchema,
  systemConnectedEventSchema,
  userSchema,
  workspaceBootstrapResponseSchema,
} from "@hype-comms/contracts";
import { escapeIdentifier, type Pool, type QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";

import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { RealtimeEventHub } from "../src/modules/realtime/hub.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HMM_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const ownerId = "10000000-0000-4000-8000-000000000001";
const memberId = "10000000-0000-4000-8000-000000000002";
const workspaceId = "10000000-0000-4000-8000-000000000003";
const generalId = "10000000-0000-4000-8000-000000000004";
const ownerSessionId = "10000000-0000-4000-8000-000000000005";
const memberSessionId = "10000000-0000-4000-8000-000000000006";
const now = "2026-07-26T12:00:00.000Z";
const ownerSessionToken = "o".repeat(43);
const memberSessionToken = "m".repeat(43);
const previousDesktopUserSchema = userSchema.extend({
  kind: z.enum(["human", "bot"]).default("human"),
});

interface TokenRow extends QueryResultRow {
  token_hash: Buffer;
  scopes: string[];
  revoked_at: Date | null;
}

class NoopEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

describeWithPostgres("agent identity and owner administration", () => {
  const schemaName = `agents_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const openSockets: WebSocket[] = [];
  let adminPool: Pool;
  let pool: Pool;
  let identityRepository: IdentityRepository;
  let identityService: IdentityService;
  let workspaceRepository: WorkspaceRepository;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 10 });
    await runMigrations(pool);
    identityRepository = new IdentityRepository(pool);
    identityService = new IdentityService(
      identityRepository,
      new NoopEmailSender(),
      new SignInThrottle(),
      () => new Date(now),
      "http://127.0.0.1:3000",
    );
    workspaceRepository = new WorkspaceRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE agent_tokens, agents, realtime_tickets, api_idempotency_records,
               sync_event_audiences, sync_events, conversation_read_cursors, message_mentions,
               messages, conversations, device_sessions, magic_link_tokens, invitations,
               workspace_memberships, workspaces, users
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
       VALUES ($1, 'HMM Chat', 'hmm-chat', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active')`,
      [workspaceId, ownerId, memberId],
    );
    await pool.query(
      `INSERT INTO conversations (id, workspace_id, kind, name, slug, channel_access, created_by)
       VALUES ($1, $2, 'channel', 'General', 'general', 'workspace', $3)`,
      [generalId, workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $5, $5, $5::timestamptz + interval '30 days'),
              ($4, $6, $7, $5, $5, $5::timestamptz + interval '30 days')`,
      [
        ownerSessionId,
        ownerId,
        hashToken(ownerSessionToken),
        memberSessionId,
        now,
        memberId,
        hashToken(memberSessionToken),
      ],
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of openSockets.splice(0)) socket.close();
    await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function appWithWorkspace(
    options: {
      readonly repository?: WorkspaceRepository;
      readonly agentProvisioningEnabled?: boolean;
    } = {},
  ) {
    const repository = options.repository ?? workspaceRepository;
    const agentProvisioningEnabled = options.agentProvisioningEnabled ?? true;
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      cookieSecure: false,
      identity: { service: identityService, agentProvisioningEnabled },
      workspace: {
        repository,
        realtimeHub: new RealtimeEventHub(pool),
      },
    });
    openApps.push(app);
    return app;
  }

  async function createAgent(app: Awaited<ReturnType<typeof buildApp>>) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
      payload: { username: "hermes", displayName: "Hermes" },
    });
    expect(response.statusCode).toBe(201);
    return createAgentResponseSchema.parse(response.json()).agent;
  }

  async function createToken(
    app: Awaited<ReturnType<typeof buildApp>>,
    agentId: string,
    label: string,
    scopes?: string[],
  ) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/tokens`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
      payload: { label, ...(scopes === undefined ? {} : { scopes }) },
    });
    expect(response.statusCode).toBe(201);
    return createAgentTokenResponseSchema.parse(response.json());
  }

  it("refuses agent provisioning while the previous server remains a rollback target", async () => {
    const app = await appWithWorkspace({ agentProvisioningEnabled: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
      payload: { username: "hermes", displayName: "Hermes" },
    });

    expect(response.statusCode).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("SERVICE_UNAVAILABLE");
    expect((await pool.query("SELECT user_id FROM agents")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM users WHERE kind = 'agent'")).rows).toEqual([]);
  });

  it("creates, lists, authenticates, and disables a non-email agent without leaking token hashes", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const created = await createToken(app, agent.user.id, "Hermes gateway");

    expect(agent).toMatchObject({
      user: { username: "hermes", displayName: "Hermes" },
      status: "active",
      role: "member",
      createdBy: ownerId,
    });
    expect(agentTokenSecretSchema.parse(created.token)).toBe(created.token);
    expect(created.agentToken.scopes).toEqual(["workspace:read", "messages:write"]);
    expect(created.agentToken.createdBy).toBe(ownerId);

    const storedUser = await pool.query<{ email: string | null; kind: string }>(
      "SELECT email, kind FROM users WHERE id = $1",
      [agent.user.id],
    );
    const storedToken = await pool.query<TokenRow>(
      "SELECT token_hash, scopes, revoked_at FROM agent_tokens WHERE id = $1",
      [created.agentToken.id],
    );
    expect(storedUser.rows[0]).toEqual({ email: null, kind: "agent" });
    expect(storedToken.rows[0]?.token_hash.equals(hashToken(created.token))).toBe(true);
    expect(storedToken.rows[0]?.scopes).toEqual(["workspace:read", "messages:write"]);

    const [agents, tokens, me, members] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/agents",
        headers: { cookie: `hmm_session=${ownerSessionToken}` },
      }),
      app.inject({
        method: "GET",
        url: `/v1/agents/${agent.user.id}/tokens`,
        headers: { cookie: `hmm_session=${ownerSessionToken}` },
      }),
      app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: `Bearer ${created.token}` },
      }),
      app.inject({
        method: "GET",
        url: "/v1/members",
        headers: { authorization: `Bearer ${created.token}` },
      }),
    ]);
    expect(listAgentsResponseSchema.parse(agents.json()).agents).toEqual([agent]);
    expect(listAgentTokensResponseSchema.parse(tokens.json()).tokens).toHaveLength(1);
    expect(tokens.body).not.toContain(created.token);
    expect(agentCurrentPrincipalSchema.parse(me.json())).toMatchObject({
      type: "agent",
      user: { id: agent.user.id },
      scopes: ["workspace:read", "messages:write"],
    });
    const directoryAgent = { ...agent.user, kind: "human" as const };
    expect(listMembersResponseSchema.parse(members.json()).members).toContainEqual(directoryAgent);
    expect(previousDesktopUserSchema.parse(directoryAgent)).toEqual(directoryAgent);
    expect(
      (
        await pool.query("SELECT last_used_at FROM agent_tokens WHERE id = $1", [
          created.agentToken.id,
        ])
      ).rows[0]?.last_used_at,
    ).not.toBeNull();

    const ambiguous = await app.inject({
      method: "GET",
      url: "/v1/members",
      headers: {
        cookie: `hmm_session=${ownerSessionToken}`,
        authorization: `Bearer ${created.token}`,
      },
    });
    expect(ambiguous.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(ambiguous.json()).error.code).toBe("BAD_REQUEST");

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    const rejected = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(disabled.statusCode).toBe(204);
    expect(rejected.statusCode).toBe(401);
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, agent.user.id],
        )
      ).rows[0]?.status,
    ).toBe("revoked");
    expect(
      (
        await pool.query<TokenRow>("SELECT * FROM agent_tokens WHERE id = $1", [
          created.agentToken.id,
        ])
      ).rows[0]?.revoked_at,
    ).not.toBeNull();
  });

  it("emits a member.updated sync event, in the same transaction, when creating an agent", async () => {
    const app = await appWithWorkspace();
    const before = await pool.query<{ last_event_sequence: string }>(
      "SELECT last_event_sequence FROM workspaces WHERE id = $1",
      [workspaceId],
    );

    const agent = await createAgent(app);

    const events = await pool.query<{
      id: string;
      event_type: string;
      workspace_sequence: string;
      conversation_id: string | null;
      conversation_sequence: string | null;
      actor_user_id: string;
      payload: { member: unknown };
    }>(
      `SELECT id, event_type, workspace_sequence, conversation_id, conversation_sequence,
              actor_user_id, payload
         FROM sync_events
        WHERE workspace_id = $1 AND event_type = 'member.updated'
        ORDER BY workspace_sequence`,
      [workspaceId],
    );
    expect(events.rows).toHaveLength(1);
    const event = events.rows[0];
    expect(event).toMatchObject({
      conversation_id: null,
      conversation_sequence: null,
      actor_user_id: ownerId,
    });
    expect(event?.payload).toEqual({ member: { ...agent.user, kind: "human" } });
    expect(BigInt(event?.workspace_sequence ?? "0")).toBeGreaterThan(
      BigInt(before.rows[0]?.last_event_sequence ?? "0"),
    );

    // Sequence allocation goes through the same workspaces.last_event_sequence counter as
    // workspace mutations, so the counter and the event's own sequence must match exactly.
    const after = await pool.query<{ last_event_sequence: string }>(
      "SELECT last_event_sequence FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    expect(after.rows[0]?.last_event_sequence).toBe(event?.workspace_sequence);

    const audience = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM sync_event_audiences WHERE event_id = $1",
      [event?.id],
    );
    expect(audience.rows.map((row) => row.user_id).sort()).toEqual(
      [ownerId, memberId, agent.user.id].sort(),
    );
  });

  it("emits a member.updated sync event, in the same transaction, when disabling an agent", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const before = await pool.query<{ last_event_sequence: string }>(
      "SELECT last_event_sequence FROM workspaces WHERE id = $1",
      [workspaceId],
    );

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    expect(disabled.statusCode).toBe(204);

    const events = await pool.query<{
      id: string;
      event_type: string;
      workspace_sequence: string;
      conversation_id: string | null;
      conversation_sequence: string | null;
      actor_user_id: string;
      payload: { member: unknown };
    }>(
      `SELECT id, event_type, workspace_sequence, conversation_id, conversation_sequence,
              actor_user_id, payload
         FROM sync_events
        WHERE workspace_id = $1 AND event_type = 'member.updated'
        ORDER BY workspace_sequence`,
      [workspaceId],
    );
    // One from createAgent, one from disableAgent.
    expect(events.rows).toHaveLength(2);
    const event = events.rows[1];
    expect(event).toMatchObject({
      conversation_id: null,
      conversation_sequence: null,
      actor_user_id: ownerId,
    });
    expect(event?.payload).toEqual({ member: { ...agent.user, kind: "human" } });
    expect(BigInt(event?.workspace_sequence ?? "0")).toBeGreaterThan(
      BigInt(before.rows[0]?.last_event_sequence ?? "0"),
    );

    const after = await pool.query<{ last_event_sequence: string }>(
      "SELECT last_event_sequence FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    expect(after.rows[0]?.last_event_sequence).toBe(event?.workspace_sequence);

    // The disabled agent's membership is already 'revoked' by the time the audience is computed,
    // so the default active-member audience excludes it while still reaching everyone else --
    // otherwise the agent would linger as a stale mention target forever.
    const audience = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM sync_event_audiences WHERE event_id = $1",
      [event?.id],
    );
    expect(audience.rows.map((row) => row.user_id).sort()).toEqual([ownerId, memberId].sort());
  });

  it("does not emit an additional member.updated event when disabling an already-disabled agent", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);

    const first = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    expect(first.statusCode).toBe(204);

    const countBeforeSecondDisable = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sync_events
        WHERE workspace_id = $1 AND event_type = 'member.updated'`,
      [workspaceId],
    );

    const second = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    // The repeat disable still reports success -- the row mutations are idempotent -- but it must
    // not fan out a redundant member.updated to every active member.
    expect(second.statusCode).toBe(204);

    const countAfterSecondDisable = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sync_events
        WHERE workspace_id = $1 AND event_type = 'member.updated'`,
      [workspaceId],
    );
    expect(countAfterSecondDisable.rows[0]?.count).toBe(countBeforeSecondDisable.rows[0]?.count);
  });

  it("serves an active-only member directory after a disable, so the invalidation signal is enough", async () => {
    // member.updated cannot carry "removed" -- userSchema has no status field -- so the event is
    // only an invalidation signal and clients re-read the directory. That design is only sound if
    // every authoritative read is already active-only. These assertions pin exactly that.
    const app = await appWithWorkspace();
    const agent = await createAgent(app);

    const beforeMembers = await app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    expect(listMembersResponseSchema.parse(beforeMembers.json()).members).toContainEqual({
      ...agent.user,
      kind: "human",
    });

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    expect(disabled.statusCode).toBe(204);

    const [members, bootstrap] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/members",
        headers: { cookie: `hmm_session=${ownerSessionToken}` },
      }),
      app.inject({
        method: "GET",
        url: "/v1/bootstrap",
        headers: { cookie: `hmm_session=${ownerSessionToken}` },
      }),
    ]);
    const memberIds = listMembersResponseSchema
      .parse(members.json())
      .members.map(({ id }) => id)
      .sort();
    const bootstrapIds = workspaceBootstrapResponseSchema
      .parse(bootstrap.json())
      .members.map(({ id }) => id)
      .sort();
    expect(memberIds).toEqual([ownerId, memberId].sort());
    expect(bootstrapIds).toEqual([ownerId, memberId].sort());

    // Exactly one event announces the disable. A client that re-reads once per event therefore
    // converges in one refetch rather than being told to poll.
    const events = await pool.query<{ id: string; payload: { member: { id: string } } }>(
      `SELECT id, payload
         FROM sync_events
        WHERE workspace_id = $1 AND event_type = 'member.updated'
          AND payload -> 'member' ->> 'id' = $2
        ORDER BY workspace_sequence`,
      [workspaceId, agent.user.id],
    );
    // One from createAgent, one from disableAgent -- and no extras from the disable path.
    expect(events.rows).toHaveLength(2);
    const audience = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM sync_event_audiences WHERE event_id = $1",
      [events.rows[1]?.id],
    );
    expect(audience.rows.map((row) => row.user_id).sort()).toEqual([ownerId, memberId].sort());
    expect(audience.rows.map((row) => row.user_id)).not.toContain(agent.user.id);

    // The server independently rejects the stale mention, so a client that has not yet refetched
    // degrades to a 400 instead of silently addressing a member who can never read it.
    const mentionClientMessageId = randomUUID();
    const mention = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        cookie: `hmm_session=${ownerSessionToken}`,
        "idempotency-key": mentionClientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes are you still there",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: mentionClientMessageId,
        mentionedUserIds: [agent.user.id],
        attachmentIds: [],
      },
    });
    expect(mention.statusCode).toBe(400);
    // The conversation-audience guard rejects it before the member-lookup guard gets a turn:
    // every arm of the audience query filters on workspace_memberships.status = 'active', so a
    // revoked member drops out of the audience first. Pinned to the exact message because which
    // guard fires is the point -- both are active-membership-derived, which is why a client that
    // has not yet re-read its directory cannot get a stale mention past the server.
    expect(apiErrorEnvelopeSchema.parse(mention.json()).error).toMatchObject({
      code: "BAD_REQUEST",
      message: "A mentioned member cannot access this conversation",
    });
  });

  it("requires an active owner human session for every agent administration route", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const created = await createToken(app, agent.user.id, "Gateway");

    const requests = [
      { method: "GET", url: "/v1/agents" },
      {
        method: "POST",
        url: "/v1/agents",
        payload: { username: "other", displayName: "Other" },
      },
      { method: "DELETE", url: `/v1/agents/${agent.user.id}` },
      { method: "GET", url: `/v1/agents/${agent.user.id}/tokens` },
      {
        method: "POST",
        url: `/v1/agents/${agent.user.id}/tokens`,
        payload: { label: "Other" },
      },
      {
        method: "DELETE",
        url: `/v1/agents/${agent.user.id}/tokens/${created.agentToken.id}`,
      },
    ] as const;

    for (const request of requests) {
      const memberResponse = await app.inject({
        ...request,
        headers: { cookie: `hmm_session=${memberSessionToken}` },
      });
      const agentResponse = await app.inject({
        ...request,
        headers: { authorization: `Bearer ${created.token}` },
      });
      expect(memberResponse.statusCode).toBe(403);
      expect(agentResponse.statusCode).toBe(403);
    }
  });

  it("enforces route scopes while allowing the corresponding capability", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const read = await createToken(app, agent.user.id, "Read", ["workspace:read"]);
    const messages = await createToken(app, agent.user.id, "Messages", ["messages:write"]);
    const conversations = await createToken(app, agent.user.id, "Conversations", [
      "conversations:write",
    ]);
    const cursors = await createToken(app, agent.user.id, "Cursors", ["read-cursors:write"]);

    const readRequests = [
      { method: "GET", url: "/v1/bootstrap" },
      { method: "GET", url: "/v1/members" },
      { method: "GET", url: "/v1/conversations" },
      { method: "GET", url: `/v1/conversations/${generalId}/messages` },
      { method: "GET", url: "/v1/sync?after=0" },
      { method: "POST", url: "/v1/realtime/tickets" },
    ] as const;
    for (const request of readRequests) {
      expect(
        (
          await app.inject({
            ...request,
            headers: { authorization: `Bearer ${read.token}` },
          })
        ).statusCode,
      ).toBeLessThan(300);
      expect(
        (
          await app.inject({
            ...request,
            headers: { authorization: `Bearer ${messages.token}` },
          })
        ).statusCode,
      ).toBe(403);
    }

    const firstMessageId = randomUUID();
    const sent = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        authorization: `Bearer ${messages.token}`,
        "idempotency-key": firstMessageId,
      },
      payload: {
        threadRootId: null,
        body: "Hermes is online",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: firstMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(sent.statusCode).toBe(201);
    const message = sendMessageResponseSchema.parse(sent.json()).message;

    const [threadWithReadScope, threadWithoutReadScope] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/messages/${message.id}/thread`,
        headers: { authorization: `Bearer ${read.token}` },
      }),
      app.inject({
        method: "GET",
        url: `/v1/messages/${message.id}/thread`,
        headers: { authorization: `Bearer ${messages.token}` },
      }),
    ]);
    expect(threadWithReadScope.statusCode).toBe(200);
    expect(threadWithoutReadScope.statusCode).toBe(403);

    const channel = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers: { authorization: `Bearer ${conversations.token}` },
      payload: { name: "Agent Work", slug: "agent-work", topic: null },
    });
    const direct = await app.inject({
      method: "POST",
      url: "/v1/direct-conversations",
      headers: { authorization: `Bearer ${conversations.token}` },
      payload: { memberId: ownerId },
    });
    const cursor = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${generalId}/read-cursor`,
      headers: { authorization: `Bearer ${cursors.token}` },
      payload: { lastReadMessageId: message.id },
    });
    expect(channel.statusCode).toBe(201);
    expect(direct.statusCode).toBe(201);
    expect(cursor.statusCode).toBe(200);
    const createdChannelId = conversationMutationResponseSchema.parse(channel.json()).conversation
      .conversation.id;

    const forbiddenWrites = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/channels",
        headers: { authorization: `Bearer ${read.token}` },
        payload: { name: "No", slug: "no", topic: null },
      }),
      app.inject({
        method: "POST",
        url: "/v1/direct-conversations",
        headers: { authorization: `Bearer ${read.token}` },
        payload: { memberId: ownerId },
      }),
      app.inject({
        method: "PATCH",
        url: `/v1/channels/${createdChannelId}`,
        headers: { authorization: `Bearer ${read.token}` },
        payload: { isArchived: true },
      }),
      app.inject({
        method: "POST",
        url: `/v1/conversations/${generalId}/messages`,
        headers: {
          authorization: `Bearer ${read.token}`,
          "idempotency-key": randomUUID(),
        },
        payload: {},
      }),
      app.inject({
        method: "PUT",
        url: `/v1/conversations/${generalId}/read-cursor`,
        headers: { authorization: `Bearer ${read.token}` },
        payload: { lastReadMessageId: message.id },
      }),
    ]);
    expect(forbiddenWrites.map(({ statusCode }) => statusCode)).toEqual([403, 403, 403, 403, 403]);
  });

  it("allows an agent to reply to a bulletin but never publish an announcement root", async () => {
    const app = await appWithWorkspace({
      repository: new WorkspaceRepository(pool, { announcementChannelsEnabled: true }),
    });
    const agent = await createAgent(app);
    const messages = await createToken(app, agent.user.id, "Messages", ["messages:write"]);
    const created = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers: {
        cookie: `hmm_session=${ownerSessionToken}`,
        "x-hmm-chat-capabilities": "announcement-channels-v1,threads-v1",
      },
      payload: {
        name: "Announcements",
        slug: "announcements",
        topic: null,
        access: "workspace",
        channelMode: "announcement",
      },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = conversationMutationResponseSchema.parse(created.json()).conversation
      .conversation.id;
    const bulletinClientMessageId = randomUUID();
    const bulletin = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: {
        cookie: `hmm_session=${ownerSessionToken}`,
        "idempotency-key": bulletinClientMessageId,
        "x-hmm-chat-capabilities": "announcement-channels-v1,threads-v1",
      },
      payload: {
        threadRootId: null,
        body: "Owner bulletin",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: bulletinClientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(bulletin.statusCode).toBe(201);
    const root = sendMessageResponseSchema.parse(bulletin.json()).message;

    const forbiddenClientMessageId = randomUUID();
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${messages.token}`,
        "idempotency-key": forbiddenClientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "Agent root",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: forbiddenClientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(forbidden.statusCode).toBe(403);

    const replyClientMessageId = randomUUID();
    const reply = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: {
        authorization: `Bearer ${messages.token}`,
        "idempotency-key": replyClientMessageId,
      },
      payload: {
        threadRootId: root.id,
        body: "Agent reply",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: replyClientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(reply.statusCode).toBe(201);
    expect(sendMessageResponseSchema.parse(reply.json()).message.threadRootId).toBe(root.id);
  });

  it("preserves agent-authored messages after disablement and counts agents against capacity", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const created = await createToken(app, agent.user.id, "Messages", ["messages:write"]);
    const clientMessageId = randomUUID();
    const sent = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        authorization: `Bearer ${created.token}`,
        "idempotency-key": clientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "Persistent agent authorship",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    const sentMessage = sendMessageResponseSchema.parse(sent.json()).message;
    const mentionClientMessageId = randomUUID();
    const mentioned = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        cookie: `hmm_session=${ownerSessionToken}`,
        "idempotency-key": mentionClientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes please retain this context",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: mentionClientMessageId,
        mentionedUserIds: [agent.user.id],
        attachmentIds: [],
      },
    });
    const mentionedMessage = sendMessageResponseSchema.parse(mentioned.json()).message;
    expect(
      (
        await pool.query(
          "SELECT 1 FROM message_mentions WHERE message_id = $1 AND mentioned_user_id = $2",
          [mentionedMessage.id, agent.user.id],
        )
      ).rowCount,
    ).toBe(1);
    await identityService.disableAgent(ownerId, agent.user.id);

    const history = await workspaceRepository.history(
      {
        currentUser: {
          user: {
            id: ownerId,
            username: "owner",
            displayName: "Owner",
            avatarUrl: null,
            createdAt: now,
            updatedAt: now,
          },
          email: "owner@example.test",
          workspaceId,
          role: "owner",
        },
        sessionId: ownerSessionId,
      },
      generalId,
      undefined,
      50,
    );
    expect(history.messages).toContainEqual(
      expect.objectContaining({ id: sentMessage.id, authorId: agent.user.id }),
    );

    for (let index = 0; index < 22; index += 1) {
      await identityService.createAgent(ownerId, {
        username: `capacity-${index}`,
        displayName: `Capacity ${index}`,
      });
    }
    const competing = await Promise.allSettled([
      identityService.createAgent(ownerId, {
        username: "capacity-final-a",
        displayName: "Capacity Final A",
      }),
      identityService.createAgent(ownerId, {
        username: "capacity-final-b",
        displayName: "Capacity Final B",
      }),
    ]);
    expect(competing.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ statusCode: 409, code: "CONFLICT" }),
      }),
    ]);
    // The disabled agent no longer consumes a slot: owner + member + 23 active agents = 25.
    expect(await identityRepository.countActiveMembers(workspaceId)).toBe(25);
    await expect(
      identityService.createAgent(ownerId, {
        username: "capacity-overflow",
        displayName: "Capacity Overflow",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
  });

  it("stores immutable token scopes and revokes only the selected credential", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const first = await createToken(app, agent.user.id, "First", ["workspace:read"]);
    const second = await createToken(app, agent.user.id, "Second", ["workspace:read"]);

    await expect(
      pool.query("UPDATE agent_tokens SET scopes = ARRAY['messages:write'] WHERE id = $1", [
        first.agentToken.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}/tokens/${first.agentToken.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    const [firstMe, secondMe] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: `Bearer ${first.token}` },
      }),
      app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: `Bearer ${second.token}` },
      }),
    ]);
    expect(revoked.statusCode).toBe(204);
    expect(firstMe.statusCode).toBe(401);
    expect(secondMe.statusCode).toBe(200);
  });

  it("lists and revokes invitations through canonical owner-session routes", async () => {
    const app = await appWithWorkspace();
    const created = await app.inject({
      method: "POST",
      url: "/v1/invitations",
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
      payload: { email: "invitee@example.test", role: "member" },
    });
    const alias = await app.inject({
      method: "POST",
      url: "/v1/auth/invitations",
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
      payload: { email: "alias@example.test", role: "member" },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    const invitation = listInvitationsResponseSchema
      .parse(listed.json())
      .invitations.find(({ email }) => email === "invitee@example.test");
    if (invitation === undefined) throw new Error("Invitation was not listed");
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/invitations/${invitation.id}`,
      headers: { cookie: `hmm_session=${ownerSessionToken}` },
    });
    const memberList = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { cookie: `hmm_session=${memberSessionToken}` },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty("invitations");
    expect(alias.statusCode).toBe(201);
    expect(listed.statusCode).toBe(200);
    expect(revoked.statusCode).toBe(204);
    expect(memberList.statusCode).toBe(403);
    expect(await identityRepository.findInvitationById(invitation.id)).toMatchObject({
      status: "revoked",
    });
  });

  it("binds realtime tickets to agent tokens, permits no Origin, and closes after revocation", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const created = await createToken(app, agent.user.id, "Realtime", ["workspace:read"]);
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/v1/realtime/tickets",
      headers: { authorization: `Bearer ${created.token}` },
    });
    const ticket = ticketResponse.json<{ ticket: string }>().ticket;
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // Start from the current high-water mark rather than 0: creating the agent above already
    // published a member.updated event the agent itself is part of the audience for, and this
    // test is about ticket binding and revocation, not backlog replay.
    const currentSequence = (
      await pool.query<{ last_event_sequence: string }>(
        "SELECT last_event_sequence FROM workspaces WHERE id = $1",
        [workspaceId],
      )
    ).rows[0]?.last_event_sequence;
    const socket = new WebSocket(
      `${address.replace("http://", "ws://")}/v1/realtime?ticket=${ticket}&after=${currentSequence}`,
    );
    openSockets.push(socket);
    const [data] = await once(socket, "message");
    expect(systemConnectedEventSchema.parse(JSON.parse(data.toString()))).toMatchObject({
      payload: { userId: agent.user.id },
    });

    await identityService.revokeAgentToken(ownerId, agent.user.id, created.agentToken.id);
    const closed = once(socket, "close");
    await vi.advanceTimersByTimeAsync(30_000);
    const [closeCode] = await closed;
    expect(closeCode).toBe(4401);

    const principal = {
      workspaceId,
      userId: agent.user.id,
      deviceSessionId: null,
      agentTokenId: created.agentToken.id,
    } as const;
    await expect(workspaceRepository.revalidateRealtimePrincipal(principal)).resolves.toEqual({
      status: "invalid",
      reason: "agent_token_revoked",
    });
  });

  it("revalidates an agent membership as well as its still-active token", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const created = await createToken(app, agent.user.id, "Membership", ["workspace:read"]);
    const identity = await identityService.authenticateAgentContext(created.token);
    if (identity === null) throw new Error("Agent did not authenticate");
    const ticket = await workspaceRepository.issueRealtimeTicket(identity);
    const principal = {
      workspaceId,
      userId: agent.user.id,
      deviceSessionId: null,
      agentTokenId: created.agentToken.id,
    } as const;
    await expect(workspaceRepository.revalidateRealtimePrincipal(principal)).resolves.toEqual({
      status: "valid",
    });

    await pool.query(
      `UPDATE workspace_memberships
          SET status = 'revoked'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, agent.user.id],
    );

    await expect(workspaceRepository.revalidateRealtimePrincipal(principal)).resolves.toEqual({
      status: "invalid",
      reason: "membership_inactive",
    });
    await expect(workspaceRepository.consumeRealtimeTicket(ticket.ticket)).resolves.toBeNull();
  });
});
