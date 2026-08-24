import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  agentCurrentPrincipalSchema,
  agentTokenSecretSchema,
  apiErrorEnvelopeSchema,
  channelMembersResponseSchema,
  communicationPathsResponseSchema,
  conversationMutationResponseSchema,
  createAgentTokenResponseSchema,
  createAgentResponseSchema,
  createFileUploadResponseSchema,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
  listAgentTokensResponseSchema,
  listAgentsResponseSchema,
  listConversationsResponseSchema,
  listInvitationsResponseSchema,
  listMembersResponseSchema,
  listPublicChannelsResponseSchema,
  messageSearchResponseSchema,
  messageThreadResponseSchema,
  sendMessageResponseSchema,
  syncResponseSchema,
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
import { LocalAttachmentStore } from "../src/modules/workspace/file-store.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
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
const groupCapabilityHeader = {
  "x-hype-comms-capabilities": GROUP_DIRECT_MESSAGES_CAPABILITY,
} as const;
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
  let attachmentRoot: string;

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
    attachmentRoot = await mkdtemp(join(tmpdir(), "agent-integration-attachments-"));
    workspaceRepository = new WorkspaceRepository(pool, {
      attachmentStore: new LocalAttachmentStore(attachmentRoot),
    });
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE agent_tokens, agents, realtime_tickets, api_idempotency_records,
               sync_event_audiences, sync_events, conversation_read_cursors, message_mentions,
               attachments, messages, conversations, device_sessions, magic_link_tokens, invitations,
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
       VALUES ($1, 'Hype Comms', 'hype-comms', $2)`,
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
    await rm(attachmentRoot, { recursive: true, force: true });
  });

  async function appWithWorkspace(
    options: {
      readonly repository?: WorkspaceRepository;
      readonly agentProvisioningEnabled?: boolean;
      readonly defaultAgentAgencyEnabled?: boolean;
    } = {},
  ) {
    const repository = options.repository ?? workspaceRepository;
    const agentProvisioningEnabled = options.agentProvisioningEnabled ?? true;
    const defaultAgentAgencyEnabled = options.defaultAgentAgencyEnabled ?? true;
    const service =
      defaultAgentAgencyEnabled === identityService.defaultAgentAgencyEnabled
        ? identityService
        : new IdentityService(
            identityRepository,
            new NoopEmailSender(),
            new SignInThrottle(),
            () => new Date(now),
            "http://127.0.0.1:3000",
            undefined,
            defaultAgentAgencyEnabled,
          );
    const app = await buildApp({
      allowedOrigins: ["app://bundle"],
      cookieSecure: false,
      identity: {
        service,
        agentProvisioningEnabled,
      },
      workspace: {
        repository,
        realtimeHub: new RealtimeEventHub(pool),
      },
    });
    openApps.push(app);
    return app;
  }

  async function createAgent(
    app: Awaited<ReturnType<typeof buildApp>>,
    options: { readonly seatPublicChannels?: boolean } = {},
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { username: "hermes", displayName: "Hermes" },
    });
    expect(response.statusCode).toBe(201);
    const agent = createAgentResponseSchema.parse(response.json()).agent;
    if (options.seatPublicChannels ?? true) {
      await pool.query(
        `INSERT INTO conversation_memberships
           (conversation_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')
         ON CONFLICT (conversation_id, user_id) DO UPDATE
           SET left_at = NULL, updated_at = clock_timestamp()`,
        [generalId, workspaceId, agent.user.id],
      );
    }
    return agent;
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { username: "hermes", displayName: "Hermes" },
    });

    expect(response.statusCode).toBe(503);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("SERVICE_UNAVAILABLE");
    expect((await pool.query("SELECT user_id FROM agents")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM users WHERE kind = 'agent'")).rows).toEqual([]);
  });

  it("keeps legacy token minting available but rejects new scopes during rollback", async () => {
    const enabledApp = await appWithWorkspace();
    const agent = await createAgent(enabledApp);
    const rollbackApp = await appWithWorkspace({ agentProvisioningEnabled: false });
    const legacy = await rollbackApp.inject({
      method: "POST",
      url: `/v1/agents/${agent.user.id}/tokens`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: {
        label: "Rollback break-glass",
        scopes: ["workspace:read", "messages:write", "conversations:write", "read-cursors:write"],
      },
    });

    expect(legacy.statusCode).toBe(201);
    expect(createAgentTokenResponseSchema.parse(legacy.json()).agentToken.scopes).toEqual([
      "workspace:read",
      "messages:write",
      "conversations:write",
      "read-cursors:write",
    ]);

    for (const scope of [
      "direct-conversations:write",
      "channels:join",
      "agents:invite",
      "attachments:write",
    ] as const) {
      const rejected = await rollbackApp.inject({
        method: "POST",
        url: `/v1/agents/${agent.user.id}/tokens`,
        headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
        payload: { label: `Rejected ${scope}`, scopes: ["workspace:read", scope] },
      });

      expect(rejected.statusCode).toBe(503);
      expect(apiErrorEnvelopeSchema.parse(rejected.json()).error.code).toBe("SERVICE_UNAVAILABLE");
    }

    const stored = await pool.query<{ scopes: string[] } & QueryResultRow>(
      "SELECT scopes FROM agent_tokens WHERE agent_user_id = $1 ORDER BY created_at, id",
      [agent.user.id],
    );
    expect(stored.rows.map((row) => row.scopes)).toEqual([
      ["workspace:read", "messages:write", "conversations:write", "read-cursors:write"],
    ]);
  });

  it("keeps default-agency mutations closed until every server is compatible", async () => {
    const enabledApp = await appWithWorkspace();
    const agent = await createAgent(enabledApp, { seatPublicChannels: false });
    const gatedApp = await appWithWorkspace({ defaultAgentAgencyEnabled: false });
    const headers = { cookie: `hype_comms_session=${ownerSessionToken}` };

    const createAnother = await gatedApp.inject({
      method: "POST",
      url: "/v1/agents",
      headers,
      payload: { username: "gated-agent", displayName: "Gated Agent" },
    });
    const createTokenResponse = await gatedApp.inject({
      method: "POST",
      url: `/v1/agents/${agent.user.id}/tokens`,
      headers,
      payload: { label: "Gated token", scopes: ["workspace:read"] },
    });
    const listChannels = await gatedApp.inject({ method: "GET", url: "/v1/channels", headers });
    const joinChannel = await gatedApp.inject({
      method: "PUT",
      url: `/v1/channels/${generalId}/membership`,
      headers,
    });
    const createGroup = await gatedApp.inject({
      method: "POST",
      url: "/v1/group-direct-conversations",
      headers: { ...headers, "idempotency-key": "gated-group" },
      payload: { memberIds: [memberId, agent.user.id] },
    });

    for (const response of [
      createAnother,
      createTokenResponse,
      listChannels,
      joinChannel,
      createGroup,
    ]) {
      expect(response.statusCode).toBe(503);
      expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("SERVICE_UNAVAILABLE");
    }
    await expect(pool.query("SELECT user_id FROM agents")).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("SELECT id FROM agent_tokens")).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query(
        "SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2",
        [generalId, agent.user.id],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query("SELECT 1 FROM conversations WHERE kind = 'group_direct_message'"),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("persists the channel seating cutover across mixed compatible server settings", async () => {
    const gatedApp = await appWithWorkspace({ defaultAgentAgencyEnabled: false });
    const legacyAgentId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       VALUES ($1, NULL, 'agent', 'rolling-agent', 'Rolling Agent')`,
      [legacyAgentId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [workspaceId, legacyAgentId],
    );
    // Omitting the marker models the fixed-point writer still serving during expansion.
    await pool.query(
      `INSERT INTO agents (user_id, workspace_id, created_by)
       VALUES ($1, $2, $3)`,
      [legacyAgentId, workspaceId, ownerId],
    );
    const headers = { cookie: `hype_comms_session=${ownerSessionToken}` };
    const before = await gatedApp.inject({
      method: "POST",
      url: "/v1/channels",
      headers,
      payload: { name: "Before agency cutover", slug: "before-agency-cutover", topic: null },
    });
    expect(before.statusCode).toBe(201);
    const beforeId = conversationMutationResponseSchema.parse(before.json()).conversation
      .conversation.id;

    await appWithWorkspace({ defaultAgentAgencyEnabled: true });
    const after = await gatedApp.inject({
      method: "POST",
      url: "/v1/channels",
      headers,
      payload: { name: "After agency cutover", slug: "after-agency-cutover", topic: null },
    });
    expect(after.statusCode).toBe(201);
    const afterId = conversationMutationResponseSchema.parse(after.json()).conversation.conversation
      .id;

    const channels = await pool.query<
      { id: string; agent_membership_required: boolean; seated: boolean } & QueryResultRow
    >(
      `SELECT conversation.id,
              conversation.agent_membership_required,
              EXISTS (
                SELECT 1
                  FROM conversation_memberships AS membership
                 WHERE membership.conversation_id = conversation.id
                   AND membership.user_id = $3
                   AND membership.left_at IS NULL
              ) AS seated
         FROM conversations AS conversation
        WHERE conversation.id = ANY($1::uuid[])
          AND conversation.workspace_id = $2
        ORDER BY conversation.id`,
      [[beforeId, afterId], workspaceId, legacyAgentId],
    );
    const byId = new Map(channels.rows.map((row) => [row.id, row]));
    expect(byId.get(beforeId)).toMatchObject({
      agent_membership_required: false,
      seated: true,
    });
    expect(byId.get(afterId)).toMatchObject({
      agent_membership_required: true,
      seated: false,
    });
    await expect(
      pool.query<{ default_agent_agency_available: boolean } & QueryResultRow>(
        "SELECT default_agent_agency_available FROM workspaces WHERE id = $1",
        [workspaceId],
      ),
    ).resolves.toMatchObject({ rows: [{ default_agent_agency_available: true }] });
  });

  it("negotiates effective scopes in token creation responses", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app);
    const ownerHeaders = { cookie: `hype_comms_session=${ownerSessionToken}` };

    const legacyResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agent.user.id}/tokens`,
      headers: ownerHeaders,
      payload: { label: "Legacy client", scopes: ["workspace:read"] },
    });
    expect(legacyResponse.statusCode).toBe(201);
    expect(
      createAgentTokenResponseSchema.parse(legacyResponse.json()).agentToken,
    ).not.toHaveProperty("effectiveScopes");

    const capableResponse = await app.inject({
      method: "POST",
      url: `/v1/agents/${agent.user.id}/tokens`,
      headers: {
        ...ownerHeaders,
        "x-hype-comms-capabilities": AGENT_EFFECTIVE_SCOPES_CAPABILITY,
      },
      payload: { label: "Capable client", scopes: ["workspace:read"] },
    });
    expect(capableResponse.statusCode).toBe(201);
    const capable = createAgentTokenResponseSchema.parse(capableResponse.json());
    expect(capable.agentToken).toMatchObject({
      scopes: ["workspace:read"],
      effectiveScopes: ["workspace:read"],
    });

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/agents/${agent.user.id}/tokens`,
      headers: {
        ...ownerHeaders,
        "x-hype-comms-capabilities": AGENT_EFFECTIVE_SCOPES_CAPABILITY,
      },
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listAgentTokensResponseSchema
      .parse(listResponse.json())
      .tokens.find((token) => token.id === capable.agentToken.id);
    expect(listed).toEqual(capable.agentToken);
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
        headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      }),
      app.inject({
        method: "GET",
        url: `/v1/agents/${agent.user.id}/tokens`,
        headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
    expect(tokens.json().tokens[0]).not.toHaveProperty("effectiveScopes");
    expect(tokens.body).not.toContain(created.token);
    expect(agentCurrentPrincipalSchema.parse(me.json())).toMatchObject({
      type: "agent",
      user: { id: agent.user.id },
      scopes: ["workspace:read", "messages:write"],
    });
    expect(me.json()).not.toHaveProperty("effectiveScopes");
    const [effectiveTokens, effectiveMe, effectiveBootstrap] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/agents/${agent.user.id}/tokens`,
        headers: {
          cookie: `hype_comms_session=${ownerSessionToken}`,
          "x-hype-comms-capabilities": AGENT_EFFECTIVE_SCOPES_CAPABILITY,
        },
      }),
      app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: {
          authorization: `Bearer ${created.token}`,
          "x-hype-comms-capabilities": AGENT_EFFECTIVE_SCOPES_CAPABILITY,
        },
      }),
      app.inject({
        method: "GET",
        url: "/v1/bootstrap",
        headers: {
          authorization: `Bearer ${created.token}`,
          "x-hype-comms-capabilities": AGENT_EFFECTIVE_SCOPES_CAPABILITY,
        },
      }),
    ]);
    expect(listAgentTokensResponseSchema.parse(effectiveTokens.json()).tokens[0]).toMatchObject({
      scopes: ["workspace:read", "messages:write"],
      effectiveScopes: ["workspace:read", "messages:write"],
    });
    expect(agentCurrentPrincipalSchema.parse(effectiveMe.json())).toMatchObject({
      scopes: ["workspace:read", "messages:write"],
      effectiveScopes: ["workspace:read", "messages:write"],
    });
    expect(
      workspaceBootstrapResponseSchema.parse(effectiveBootstrap.json()).currentUser,
    ).toMatchObject({
      scopes: ["workspace:read", "messages:write"],
      effectiveScopes: ["workspace:read", "messages:write"],
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
        cookie: `hype_comms_session=${ownerSessionToken}`,
        authorization: `Bearer ${created.token}`,
      },
    });
    expect(ambiguous.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(ambiguous.json()).error.code).toBe("BAD_REQUEST");

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });
    expect(listMembersResponseSchema.parse(beforeMembers.json()).members).toContainEqual({
      ...agent.user,
      kind: "human",
    });

    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/agents/${agent.user.id}`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });
    expect(disabled.statusCode).toBe(204);

    const [members, bootstrap] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/members",
        headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      }),
      app.inject({
        method: "GET",
        url: "/v1/bootstrap",
        headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": mentionClientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes are you still there",
        bodyFormat: "hype_comms_markdown_v1",
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
        headers: { cookie: `hype_comms_session=${memberSessionToken}` },
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
    const defaultAgency = await createToken(app, agent.user.id, "Default agency", [
      "agents:invite",
      "direct-conversations:write",
      "messages:write",
      "workspace:read",
    ]);
    expect(defaultAgency.agentToken.scopes).toEqual([
      "workspace:read",
      "messages:write",
      "direct-conversations:write",
      "agents:invite",
    ]);

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
        bodyFormat: "hype_comms_markdown_v1",
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
    const narrowDirect = await app.inject({
      method: "POST",
      url: "/v1/direct-conversations",
      headers: { authorization: `Bearer ${defaultAgency.token}` },
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
    expect(narrowDirect.statusCode).toBe(201);
    expect(cursor.statusCode).toBe(200);
    const createdChannelId = conversationMutationResponseSchema.parse(channel.json()).conversation
      .conversation.id;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations/${createdChannelId}/messages`,
          headers: { authorization: `Bearer ${read.token}` },
        })
      ).statusCode,
    ).toBe(200);
    const createdChannelMessageId = randomUUID();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/conversations/${createdChannelId}/messages`,
          headers: {
            authorization: `Bearer ${messages.token}`,
            "idempotency-key": createdChannelMessageId,
          },
          payload: {
            threadRootId: null,
            body: "Creator remains seated",
            bodyFormat: "hype_comms_markdown_v1",
            clientMessageId: createdChannelMessageId,
            mentionedUserIds: [],
            attachmentIds: [],
          },
        })
      ).statusCode,
    ).toBe(201);
    const creatorSync = await app.inject({
      method: "GET",
      url: "/v1/sync?after=0",
      headers: { authorization: `Bearer ${read.token}` },
    });
    expect(creatorSync.statusCode).toBe(200);
    expect(syncResponseSchema.parse(creatorSync.json()).events).toContainEqual(
      expect.objectContaining({ type: "channel.created", conversationId: createdChannelId }),
    );

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

  it("lets an agent discover and join public channels while private channels require an invite", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app, { seatPublicChannels: false });
    const observerResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { username: "channel-observer", displayName: "Channel Observer" },
    });
    expect(observerResponse.statusCode).toBe(201);
    const observer = createAgentResponseSchema.parse(observerResponse.json()).agent;
    const agency = await createToken(app, agent.user.id, "Channel agency", [
      "channels:join",
      "workspace:read",
      "messages:write",
    ]);
    const joinOnly = await createToken(app, agent.user.id, "Join without read", ["channels:join"]);
    const privateChannel = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: {
        name: "Private Plans",
        slug: "private-plans",
        topic: null,
        access: "members",
      },
    });
    expect(privateChannel.statusCode).toBe(201);
    const privateChannelId = conversationMutationResponseSchema.parse(privateChannel.json())
      .conversation.conversation.id;

    const catalog = await app.inject({
      method: "GET",
      url: "/v1/channels?limit=50",
      headers: { authorization: `Bearer ${agency.token}` },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      channels: [
        expect.objectContaining({
          conversation: expect.objectContaining({ id: generalId, access: "workspace" }),
          joined: false,
        }),
      ],
      hasMore: false,
    });
    expect(JSON.stringify(catalog.json())).not.toContain(privateChannelId);

    const beforeJoin = await app.inject({
      method: "GET",
      url: `/v1/conversations/${generalId}/messages`,
      headers: { authorization: `Bearer ${agency.token}` },
    });
    expect(beforeJoin.statusCode).toBe(404);
    const pathsBeforeJoin = communicationPathsResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/communication-paths",
          headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
        })
      ).json(),
    );
    expect(
      pathsBeforeJoin.paths.some(
        (path) => path.memberAId === agent.user.id || path.memberBId === agent.user.id,
      ),
    ).toBe(false);

    const publicMentionBeforeJoinId = randomUUID();
    const publicMentionBeforeJoin = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": publicMentionBeforeJoinId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes please join",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: publicMentionBeforeJoinId,
        mentionedUserIds: [agent.user.id],
        attachmentIds: [],
      },
    });
    expect(publicMentionBeforeJoin.statusCode).toBe(400);
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [generalId, agent.user.id],
        )
      ).rowCount,
    ).toBe(0);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/channels/${generalId}/membership`,
          headers: { authorization: `Bearer ${agency.token}` },
          payload: { unexpected: true },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/channels/${generalId}/membership`,
          headers: { authorization: `Bearer ${joinOnly.token}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [generalId, agent.user.id],
        )
      ).rowCount,
    ).toBe(0);

    const joined = await app.inject({
      method: "PUT",
      url: `/v1/channels/${generalId}/membership`,
      headers: { authorization: `Bearer ${agency.token}` },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      conversation: {
        conversation: { id: generalId },
        membershipRole: "member",
      },
    });
    const seat = await pool.query<{ joined_at: Date } & QueryResultRow>(
      `SELECT joined_at
         FROM conversation_memberships
        WHERE conversation_id = $1 AND user_id = $2`,
      [generalId, agent.user.id],
    );
    const joinedAt = seat.rows[0]?.joined_at.toISOString();
    expect(joinedAt).toBeDefined();
    const repeatedJoin = await app.inject({
      method: "PUT",
      url: `/v1/channels/${generalId}/membership`,
      headers: { authorization: `Bearer ${agency.token}` },
    });
    expect(repeatedJoin.statusCode).toBe(200);
    expect(repeatedJoin.json()).toEqual(joined.json());
    const repeatedSeat = await pool.query<{ joined_at: Date } & QueryResultRow>(
      `SELECT joined_at
         FROM conversation_memberships
        WHERE conversation_id = $1 AND user_id = $2`,
      [generalId, agent.user.id],
    );
    expect(repeatedSeat.rows[0]?.joined_at.toISOString()).toBe(joinedAt);
    const joinEventCount = await pool.query<{ event_count: number } & QueryResultRow>(
      `SELECT count(*)::integer AS event_count
         FROM sync_events AS event
        WHERE event.conversation_id = $1
          AND event.event_type = 'channel.membership_changed'
          AND event.payload->>'memberId' = $2`,
      [generalId, agent.user.id],
    );
    expect(joinEventCount.rows[0]?.event_count).toBe(1);
    const listedMembers = channelMembersResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/v1/channels/${generalId}/members`,
          headers: { authorization: `Bearer ${agency.token}` },
        })
      ).json(),
    );
    expect(listedMembers.members.find((member) => member.user.id === agent.user.id)).toMatchObject({
      joinedAt,
    });
    const joinAudience = await pool.query<{ user_id: string } & QueryResultRow>(
      `SELECT audience.user_id
         FROM sync_events AS event
         JOIN sync_event_audiences AS audience ON audience.event_id = event.id
        WHERE event.conversation_id = $1
          AND event.event_type = 'channel.membership_changed'
          AND event.payload->>'memberId' = $2
        ORDER BY audience.user_id`,
      [generalId, agent.user.id],
    );
    expect(joinAudience.rows.map((row) => row.user_id)).toEqual(
      [ownerId, memberId, agent.user.id].sort(),
    );
    expect(joinAudience.rows.map((row) => row.user_id)).not.toContain(observer.user.id);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations/${generalId}/messages`,
          headers: { authorization: `Bearer ${agency.token}` },
        })
      ).statusCode,
    ).toBe(200);

    const publicMentionAfterJoinId = randomUUID();
    const publicMentionAfterJoin = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": publicMentionAfterJoinId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes welcome",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: publicMentionAfterJoinId,
        mentionedUserIds: [agent.user.id],
        attachmentIds: [],
      },
    });
    expect(publicMentionAfterJoin.statusCode).toBe(201);
    const pathsAfterJoin = communicationPathsResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/communication-paths",
          headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
        })
      ).json(),
    );
    expect(
      pathsAfterJoin.paths.find(
        (path) =>
          [path.memberAId, path.memberBId].includes(ownerId) &&
          [path.memberAId, path.memberBId].includes(agent.user.id),
      ),
    ).toMatchObject({ sharedChannelCount: 1 });

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/channels/${privateChannelId}/membership`,
          headers: { authorization: `Bearer ${agency.token}` },
        })
      ).statusCode,
    ).toBe(404);

    const privateMentionBeforeInviteId = randomUUID();
    const privateMentionBeforeInvite = await app.inject({
      method: "POST",
      url: `/v1/conversations/${privateChannelId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": privateMentionBeforeInviteId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes private plans",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: privateMentionBeforeInviteId,
        mentionedUserIds: [agent.user.id],
        attachmentIds: [],
      },
    });
    expect(privateMentionBeforeInvite.statusCode).toBe(400);
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [privateChannelId, agent.user.id],
        )
      ).rowCount,
    ).toBe(0);
    const invited = await app.inject({
      method: "PUT",
      url: `/v1/channels/${privateChannelId}/members/${agent.user.id}`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { role: "member" },
    });
    expect(invited.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations/${privateChannelId}/messages`,
          headers: { authorization: `Bearer ${agency.token}` },
        })
      ).statusCode,
    ).toBe(200);

    const privateMentionAfterInviteId = randomUUID();
    const privateMentionAfterInvite = await app.inject({
      method: "POST",
      url: `/v1/conversations/${privateChannelId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": privateMentionAfterInviteId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes private plans",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: privateMentionAfterInviteId,
        mentionedUserIds: [agent.user.id],
        attachmentIds: [],
      },
    });
    expect(privateMentionAfterInvite.statusCode).toBe(201);
  });

  it("continues public-channel pagination when the cursor channel is archived", async () => {
    const app = await appWithWorkspace();
    const agent = await createAgent(app, { seatPublicChannels: false });
    const readOnly = await createToken(app, agent.user.id, "Workspace reader", ["workspace:read"]);
    const token = await createToken(app, agent.user.id, "Channel reader", [
      "workspace:read",
      "channels:join",
    ]);
    const headers = { cookie: `hype_comms_session=${ownerSessionToken}` };
    const alpha = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers,
      payload: { name: "Alpha", slug: "alpha", topic: null },
    });
    const zulu = await app.inject({
      method: "POST",
      url: "/v1/channels",
      headers,
      payload: { name: "Zulu", slug: "zulu", topic: null },
    });
    expect([alpha.statusCode, zulu.statusCode]).toEqual([201, 201]);
    const alphaId = conversationMutationResponseSchema.parse(alpha.json()).conversation.conversation
      .id;
    const zuluId = conversationMutationResponseSchema.parse(zulu.json()).conversation.conversation
      .id;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/channels?limit=1",
          headers: { authorization: `Bearer ${readOnly.token}` },
        })
      ).statusCode,
    ).toBe(403);
    const first = listPublicChannelsResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/channels?limit=1",
          headers: { authorization: `Bearer ${token.token}` },
        })
      ).json(),
    );
    expect(first.channels.map((entry) => entry.conversation.id)).toEqual([alphaId]);
    expect(first.nextCursor).not.toBeNull();
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/v1/channels/${alphaId}`,
          headers,
          payload: { isArchived: true },
        })
      ).statusCode,
    ).toBe(200);
    const next = listPublicChannelsResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/v1/channels?limit=50&after=${encodeURIComponent(first.nextCursor ?? "")}`,
          headers: { authorization: `Bearer ${token.token}` },
        })
      ).json(),
    );
    expect(next.channels.map((entry) => entry.conversation.id)).toEqual([generalId, zuluId]);
  });

  it("lets an agent start a private group conversation with another agent and a person", async () => {
    const app = await appWithWorkspace();
    const firstAgent = await createAgent(app);
    const secondAgentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { username: "athena", displayName: "Athena" },
    });
    expect(secondAgentResponse.statusCode).toBe(201);
    const secondAgent = createAgentResponseSchema.parse(secondAgentResponse.json()).agent;
    const first = await createToken(app, firstAgent.user.id, "Group starter", [
      "workspace:read",
      "messages:write",
      "direct-conversations:write",
      "read-cursors:write",
      "attachments:write",
    ]);
    const second = await createToken(app, secondAgent.user.id, "Group participant", [
      "workspace:read",
      "messages:write",
      "attachments:write",
    ]);
    const idempotencyKey = randomUUID();
    const request = {
      method: "POST" as const,
      url: "/v1/group-direct-conversations",
      headers: {
        authorization: `Bearer ${first.token}`,
        "idempotency-key": idempotencyKey,
        ...groupCapabilityHeader,
      },
      payload: { memberIds: [secondAgent.user.id, ownerId] },
    };

    const [created, replayed] = await Promise.all([app.inject(request), app.inject(request)]);
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(201);
    const group = conversationMutationResponseSchema.parse(created.json());
    expect(conversationMutationResponseSchema.parse(replayed.json())).toEqual(group);
    expect(group.conversation).toMatchObject({
      conversation: { kind: "group_direct_message" },
      participantIds: [firstAgent.user.id, secondAgent.user.id, ownerId].sort(),
      membershipRole: "owner",
    });
    const groupId = group.conversation.conversation.id;
    const groupCreationSequence = (
      await pool.query<{ workspace_sequence: string } & QueryResultRow>(
        `SELECT workspace_sequence::text
           FROM sync_events
          WHERE conversation_id = $1
            AND event_type = 'direct_conversation.created'`,
        [groupId],
      )
    ).rows[0]!.workspace_sequence;
    const beforeGroupCreation = (BigInt(groupCreationSequence) - 1n).toString();
    const legacySync = await workspaceRepository.syncPrincipal(
      { workspaceId, userId: firstAgent.user.id },
      beforeGroupCreation,
      100,
    );
    expect(
      legacySync.events.some(
        (event) =>
          event.conversationId === groupId ||
          (event.type === "direct_conversation.created" &&
            event.payload.conversation.id === groupId),
      ),
    ).toBe(false);
    expect(BigInt(legacySync.nextCursor)).toBeGreaterThanOrEqual(BigInt(groupCreationSequence));
    const groupCapableSync = await workspaceRepository.syncPrincipal(
      { workspaceId, userId: firstAgent.user.id, groupDirectMessages: true },
      beforeGroupCreation,
      100,
    );
    expect(
      groupCapableSync.events.find((event) => event.type === "direct_conversation.created"),
    ).toMatchObject({
      payload: { conversation: { id: groupId, kind: "group_direct_message" } },
    });

    const legacyBootstrap = await app.inject({
      method: "GET",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${first.token}` },
    });
    const legacyHistory = await app.inject({
      method: "GET",
      url: `/v1/conversations/${groupId}/messages`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    const legacyClientMessageId = randomUUID();
    const legacySend = await app.inject({
      method: "POST",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        authorization: `Bearer ${first.token}`,
        "idempotency-key": legacyClientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "This must not reach concealed recipients",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: legacyClientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(legacyBootstrap.statusCode).toBe(200);
    expect(
      workspaceBootstrapResponseSchema
        .parse(legacyBootstrap.json())
        .conversations.some((summary) => summary.conversation.id === groupId),
    ).toBe(false);
    const legacyConversationIds: string[] = [];
    let legacyAfter: string | null = null;
    for (;;) {
      const page = listConversationsResponseSchema.parse(
        (
          await app.inject({
            method: "GET",
            url:
              `/v1/conversations?limit=1` +
              (legacyAfter === null ? "" : `&after=${encodeURIComponent(legacyAfter)}`),
            headers: { authorization: `Bearer ${first.token}` },
          })
        ).json(),
      );
      expect(page.conversations).toHaveLength(1);
      expect(page.conversations[0]?.conversation.kind).not.toBe("group_direct_message");
      legacyConversationIds.push(page.conversations[0]!.conversation.id);
      if (!page.hasMore) break;
      expect(page.nextCursor).not.toBeNull();
      legacyAfter = page.nextCursor;
    }
    expect(legacyConversationIds).toContain(generalId);
    let capableAfter: string | null = null;
    let cursorBeforeGroup: string | null = null;
    for (;;) {
      const page = listConversationsResponseSchema.parse(
        (
          await app.inject({
            method: "GET",
            url:
              "/v1/conversations?limit=1" +
              (capableAfter === null ? "" : `&after=${encodeURIComponent(capableAfter)}`),
            headers: {
              authorization: `Bearer ${first.token}`,
              ...groupCapabilityHeader,
            },
          })
        ).json(),
      );
      const summary = page.conversations[0];
      if (summary?.conversation.kind === "group_direct_message") {
        expect(summary.conversation.id).toBe(groupId);
        break;
      }
      expect(summary).toBeDefined();
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();
      if (page.nextCursor === null) throw new Error("Expected another capable conversation page");
      cursorBeforeGroup = page.nextCursor;
      capableAfter = page.nextCursor;
    }
    if (cursorBeforeGroup === null) throw new Error("Expected a regular conversation before group");
    const legacyGroupOnlyTail = listConversationsResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations?limit=1&after=${encodeURIComponent(cursorBeforeGroup)}`,
          headers: { authorization: `Bearer ${first.token}` },
        })
      ).json(),
    );
    expect(legacyGroupOnlyTail).toEqual({ conversations: [], nextCursor: null, hasMore: false });
    for (const response of [legacyHistory, legacySend]) {
      expect(response.statusCode).toBe(409);
      expect(apiErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("Update Hype Comms"),
      });
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/members",
          headers: { authorization: `Bearer ${first.token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM messages
            WHERE conversation_id = $1
              AND client_message_id = $2`,
          [groupId, legacyClientMessageId],
        )
      ).rowCount,
    ).toBe(0);

    const firstClientMessageId = randomUUID();
    const firstMessage = await app.inject({
      method: "POST",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        authorization: `Bearer ${first.token}`,
        "idempotency-key": firstClientMessageId,
        ...groupCapabilityHeader,
      },
      payload: {
        threadRootId: null,
        body: "@athena launch review",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: firstClientMessageId,
        mentionedUserIds: [secondAgent.user.id],
        attachmentIds: [],
      },
    });
    expect(firstMessage.statusCode).toBe(201);
    const firstCreatedMessage = sendMessageResponseSchema.parse(firstMessage.json()).message;
    const visibleAfterGroupsClientId = randomUUID();
    const visibleAfterGroups = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": visibleAfterGroupsClientId,
      },
      payload: {
        threadRootId: null,
        body: "Visible after hidden group events",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: visibleAfterGroupsClientId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(visibleAfterGroups.statusCode).toBe(201);
    const visibleAfterGroupsId = sendMessageResponseSchema.parse(visibleAfterGroups.json()).message
      .id;
    let legacySyncCursor = beforeGroupCreation;
    let sawHiddenOnlySyncPage = false;
    let sawVisibleAfterGroups = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await workspaceRepository.syncPrincipal(
        { workspaceId, userId: firstAgent.user.id },
        legacySyncCursor,
        1,
      );
      if (page.events.length === 0) sawHiddenOnlySyncPage = true;
      if (
        page.events.some(
          (event) =>
            event.type === "message.created" && event.payload.message.id === visibleAfterGroupsId,
        )
      ) {
        sawVisibleAfterGroups = true;
        break;
      }
      expect(BigInt(page.nextCursor)).toBeGreaterThan(BigInt(legacySyncCursor));
      legacySyncCursor = page.nextCursor;
    }
    expect(sawHiddenOnlySyncPage).toBe(true);
    expect(sawVisibleAfterGroups).toBe(true);
    const legacyRead = await app.inject({
      method: "PUT",
      url: `/v1/conversations/${groupId}/read-cursor`,
      headers: { authorization: `Bearer ${first.token}` },
      payload: { lastReadMessageId: firstCreatedMessage.id },
    });
    const legacyReaction = await app.inject({
      method: "PUT",
      url: `/v1/messages/${firstCreatedMessage.id}/reactions/%F0%9F%91%8D`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    const legacyFiles = await app.inject({
      method: "GET",
      url: `/v1/conversations/${groupId}/files`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    const legacyMessage = await app.inject({
      method: "GET",
      url: `/v1/messages/${firstCreatedMessage.id}`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    const legacyThread = await app.inject({
      method: "GET",
      url: `/v1/messages/${firstCreatedMessage.id}/thread`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    const legacyAttachmentQuery = await app.inject({
      method: "POST",
      url: "/v1/attachments/query",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { messageIds: [firstCreatedMessage.id] },
    });
    const legacyReactionQuery = await app.inject({
      method: "POST",
      url: "/v1/reactions/query",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { messageIds: [firstCreatedMessage.id] },
    });
    const legacyRetract = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${firstCreatedMessage.id}`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    const rejectedUploadId = randomUUID();
    const legacyUpload = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: {
        authorization: `Bearer ${first.token}`,
        "idempotency-key": rejectedUploadId,
      },
      payload: {
        conversationId: groupId,
        fileName: "legacy.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        contentSha256: "0".repeat(64),
      },
    });
    expect(
      [
        legacyRead,
        legacyReaction,
        legacyFiles,
        legacyMessage,
        legacyThread,
        legacyAttachmentQuery,
        legacyReactionQuery,
        legacyRetract,
        legacyUpload,
      ].map((response) => response.statusCode),
    ).toEqual([409, 409, 409, 409, 409, 409, 409, 409, 409]);
    await expect(
      pool.query(`SELECT deleted_at FROM messages WHERE id = $1`, [firstCreatedMessage.id]),
    ).resolves.toMatchObject({ rows: [{ deleted_at: null }] });
    await expect(
      pool.query(`SELECT 1 FROM attachments WHERE conversation_id = $1`, [groupId]),
    ).resolves.toMatchObject({ rowCount: 0 });
    const secondHistory = await app.inject({
      method: "GET",
      url: `/v1/conversations/${groupId}/messages`,
      headers: { authorization: `Bearer ${second.token}`, ...groupCapabilityHeader },
    });
    const ownerHistory = await app.inject({
      method: "GET",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        ...groupCapabilityHeader,
      },
    });
    const observerHistory = await app.inject({
      method: "GET",
      url: `/v1/conversations/${groupId}/messages`,
      headers: { cookie: `hype_comms_session=${memberSessionToken}` },
    });
    expect(secondHistory.statusCode).toBe(200);
    expect(ownerHistory.statusCode).toBe(200);
    expect(observerHistory.statusCode).toBe(404);

    const groupEventCountBeforeRejectedMention = await pool.query<
      { event_count: number } & QueryResultRow
    >(
      `SELECT count(*)::integer AS event_count
         FROM sync_events
        WHERE conversation_id = $1`,
      [groupId],
    );
    const rejectedObserverMentionId = randomUUID();
    const rejectedObserverMention = await app.inject({
      method: "POST",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        authorization: `Bearer ${first.token}`,
        "idempotency-key": rejectedObserverMentionId,
        ...groupCapabilityHeader,
      },
      payload: {
        threadRootId: null,
        body: "@member should not be seated",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: rejectedObserverMentionId,
        mentionedUserIds: [memberId],
        attachmentIds: [],
      },
    });
    expect(rejectedObserverMention.statusCode).toBe(400);
    expect(
      (
        await pool.query(
          `SELECT 1
             FROM conversation_memberships
            WHERE conversation_id = $1 AND user_id = $2`,
          [groupId, memberId],
        )
      ).rowCount,
    ).toBe(0);
    const groupEventCountAfterRejectedMention = await pool.query<
      { event_count: number } & QueryResultRow
    >(
      `SELECT count(*)::integer AS event_count
         FROM sync_events
        WHERE conversation_id = $1`,
      [groupId],
    );
    expect(groupEventCountAfterRejectedMention.rows[0]?.event_count).toBe(
      groupEventCountBeforeRejectedMention.rows[0]?.event_count,
    );

    const replyClientMessageId = randomUUID();
    const reply = await app.inject({
      method: "POST",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        authorization: `Bearer ${second.token}`,
        "idempotency-key": replyClientMessageId,
        ...groupCapabilityHeader,
      },
      payload: {
        threadRootId: null,
        body: "Ready",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: replyClientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(reply.statusCode).toBe(201);
    const firstHistory = await app.inject({
      method: "GET",
      url: `/v1/conversations/${groupId}/messages`,
      headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
    });
    expect(firstHistory.statusCode).toBe(200);
    expect(firstHistory.json().messages).toEqual([
      expect.objectContaining({ body: "@athena launch review" }),
      expect.objectContaining({ body: "Ready" }),
    ]);
    const communicationPaths = communicationPathsResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/communication-paths",
          headers: {
            cookie: `hype_comms_session=${ownerSessionToken}`,
            ...groupCapabilityHeader,
          },
        })
      ).json(),
    );
    const directCount = (left: string, right: string): number | undefined => {
      const [memberAId, memberBId] = [left, right].sort();
      return communicationPaths.paths.find(
        (path) => path.memberAId === memberAId && path.memberBId === memberBId,
      )?.directMessageCount;
    };
    expect(directCount(firstAgent.user.id, secondAgent.user.id)).toBe(2);
    expect(directCount(firstAgent.user.id, ownerId)).toBe(1);
    expect(directCount(secondAgent.user.id, ownerId)).toBe(1);
    expect(JSON.stringify(communicationPaths)).not.toContain("@athena launch review");
    expect(JSON.stringify(communicationPaths)).not.toContain("Ready");

    const groupEventAudiences = await pool.query<
      { event_type: string; audience_ids: string[] } & QueryResultRow
    >(
      `SELECT event.event_type,
              array_agg(audience.user_id::text ORDER BY audience.user_id::text) AS audience_ids
         FROM sync_events AS event
         JOIN sync_event_audiences AS audience ON audience.event_id = event.id
        WHERE event.conversation_id = $1
          AND event.event_type IN ('direct_conversation.created', 'message.created')
        GROUP BY event.id, event.event_type
        ORDER BY event.workspace_sequence`,
      [groupId],
    );
    const expectedAudience = [firstAgent.user.id, secondAgent.user.id, ownerId].sort();
    expect(groupEventAudiences.rows.map((row) => row.event_type)).toEqual([
      "direct_conversation.created",
      "message.created",
      "message.created",
    ]);
    for (const event of groupEventAudiences.rows) {
      expect(event.audience_ids).toEqual(expectedAudience);
      expect(event.audience_ids).not.toContain(memberId);
    }

    const sendSearchMessage = async (
      conversationId: string,
      body: string,
      groupMessage: boolean,
    ): Promise<string> => {
      const clientMessageId = randomUUID();
      const response = await app.inject({
        method: "POST",
        url: `/v1/conversations/${conversationId}/messages`,
        headers: {
          ...(groupMessage
            ? { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader }
            : { cookie: `hype_comms_session=${ownerSessionToken}` }),
          "idempotency-key": clientMessageId,
        },
        payload: {
          threadRootId: null,
          body,
          bodyFormat: "hype_comms_markdown_v1",
          clientMessageId,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      });
      expect(response.statusCode).toBe(201);
      return sendMessageResponseSchema.parse(response.json()).message.id;
    };
    const searchableRegularIds: string[] = [];
    const searchableGroupIds: string[] = [];
    searchableRegularIds.push(
      await sendSearchMessage(generalId, "agencyneedle regular one", false),
    );
    searchableGroupIds.push(await sendSearchMessage(groupId, "agencyneedle group one", true));
    searchableRegularIds.push(
      await sendSearchMessage(generalId, "agencyneedle regular two", false),
    );
    searchableGroupIds.push(await sendSearchMessage(groupId, "agencyneedle group two", true));
    searchableRegularIds.push(
      await sendSearchMessage(generalId, "agencyneedle regular three", false),
    );
    const legacySearchIds: string[] = [];
    let legacySearchAfter: string | null = null;
    for (;;) {
      const response = await app.inject({
        method: "GET",
        url:
          "/v1/search?query=agencyneedle&limit=1" +
          (legacySearchAfter === null ? "" : `&after=${encodeURIComponent(legacySearchAfter)}`),
        headers: { authorization: `Bearer ${first.token}` },
      });
      expect(response.statusCode).toBe(200);
      const page = messageSearchResponseSchema.parse(response.json());
      expect(page.results).toHaveLength(1);
      legacySearchIds.push(page.results[0]!.message.id);
      if (page.nextCursor === null) break;
      legacySearchAfter = page.nextCursor;
    }
    expect(new Set(legacySearchIds)).toEqual(new Set(searchableRegularIds));
    expect(legacySearchIds).toHaveLength(searchableRegularIds.length);
    expect(legacySearchIds.some((id) => searchableGroupIds.includes(id))).toBe(false);
    const capableSearch = messageSearchResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/search?query=agencyneedle&limit=10",
          headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
        })
      ).json(),
    );
    expect(new Set(capableSearch.results.map((result) => result.message.id))).toEqual(
      new Set([...searchableRegularIds, ...searchableGroupIds]),
    );

    const retractedMessageId = await sendSearchMessage(groupId, "Temporary group message", true);
    const legacyRetractBeforeCommit = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${retractedMessageId}`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(legacyRetractBeforeCommit.statusCode).toBe(409);
    expect(
      (
        await pool.query<{ deleted_at: Date | null } & QueryResultRow>(
          `SELECT deleted_at FROM messages WHERE id = $1`,
          [retractedMessageId],
        )
      ).rows[0]?.deleted_at,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/messages/${retractedMessageId}`,
          headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
        })
      ).statusCode,
    ).toBe(200);
    for (const headers of [
      { authorization: `Bearer ${first.token}` },
      { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
    ]) {
      const [
        messageResponse,
        threadResponse,
        attachmentResponse,
        reactionResponse,
        addReactionResponse,
      ] = await Promise.all([
        app.inject({ method: "GET", url: `/v1/messages/${retractedMessageId}`, headers }),
        app.inject({
          method: "GET",
          url: `/v1/messages/${retractedMessageId}/thread`,
          headers,
        }),
        app.inject({
          method: "POST",
          url: "/v1/attachments/query",
          headers,
          payload: { messageIds: [retractedMessageId] },
        }),
        app.inject({
          method: "POST",
          url: "/v1/reactions/query",
          headers,
          payload: { messageIds: [retractedMessageId] },
        }),
        app.inject({
          method: "PUT",
          url: `/v1/messages/${retractedMessageId}/reactions/%F0%9F%91%8D`,
          headers,
        }),
      ]);
      expect(
        [
          messageResponse,
          threadResponse,
          attachmentResponse,
          reactionResponse,
          addReactionResponse,
        ].map((response) => response.statusCode),
      ).toEqual([404, 404, 404, 404, 404]);
    }

    const retractedThreadSecret = `Temporary group thread ${randomUUID()}`;
    const retractedThreadRootId = await sendSearchMessage(groupId, retractedThreadSecret, true);
    const liveReplyIdempotencyKey = randomUUID();
    const liveReply = await app.inject({
      method: "POST",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        authorization: `Bearer ${second.token}`,
        "idempotency-key": liveReplyIdempotencyKey,
        ...groupCapabilityHeader,
      },
      payload: {
        threadRootId: retractedThreadRootId,
        body: "Live group reply",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: liveReplyIdempotencyKey,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(liveReply.statusCode).toBe(201);
    const liveReplyMessage = sendMessageResponseSchema.parse(liveReply.json()).message;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/messages/${retractedThreadRootId}`,
          headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
        })
      ).statusCode,
    ).toBe(200);

    const [capableThread, legacyThreadAfterRetract, outsiderThread] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/messages/${retractedThreadRootId}/thread`,
        headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
      }),
      app.inject({
        method: "GET",
        url: `/v1/messages/${retractedThreadRootId}/thread`,
        headers: { authorization: `Bearer ${first.token}` },
      }),
      app.inject({
        method: "GET",
        url: `/v1/messages/${retractedThreadRootId}/thread`,
        headers: {
          cookie: `hype_comms_session=${memberSessionToken}`,
          ...groupCapabilityHeader,
        },
      }),
    ]);
    expect(capableThread.statusCode).toBe(200);
    expect(messageThreadResponseSchema.parse(capableThread.json())).toMatchObject({
      root: {
        id: retractedThreadRootId,
        body: "Message retracted",
        deletedAt: expect.any(String),
      },
      replies: [liveReplyMessage],
    });
    expect(capableThread.body).not.toContain(retractedThreadSecret);
    expect(legacyThreadAfterRetract.statusCode).toBe(409);
    expect(apiErrorEnvelopeSchema.parse(legacyThreadAfterRetract.json()).error.code).toBe(
      "CONFLICT",
    );
    expect(legacyThreadAfterRetract.body).not.toContain(retractedThreadSecret);
    expect(legacyThreadAfterRetract.body).not.toContain(liveReplyMessage.body);
    expect(outsiderThread.statusCode).toBe(404);

    const stagedBytes = Buffer.from("x");
    const stagedHash = createHash("sha256").update(stagedBytes).digest("hex");
    const stageIdempotencyKey = randomUUID();
    const stagedResponse = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: {
        authorization: `Bearer ${second.token}`,
        "idempotency-key": stageIdempotencyKey,
        ...groupCapabilityHeader,
      },
      payload: {
        conversationId: groupId,
        fileName: "pending.txt",
        contentType: "text/plain",
        sizeBytes: stagedBytes.byteLength,
        contentSha256: stagedHash,
      },
    });
    expect(stagedResponse.statusCode).toBe(201);
    const stagedAttachment = createFileUploadResponseSchema.parse(stagedResponse.json()).attachment;
    const legacyOwnerPendingRead = await app.inject({
      method: "GET",
      url: `/v1/files/${stagedAttachment.id}/content`,
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(legacyOwnerPendingRead.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(legacyOwnerPendingRead.json()).error.code).toBe(
      "NOT_FOUND",
    );
    for (const headers of [
      { authorization: `Bearer ${first.token}` },
      { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
    ]) {
      const [readResponse, putResponse, completeResponse] = await Promise.all([
        app.inject({ method: "GET", url: `/v1/files/${stagedAttachment.id}/content`, headers }),
        app.inject({
          method: "PUT",
          url: `/v1/files/${stagedAttachment.id}/content`,
          headers: { ...headers, "content-type": "text/plain" },
          payload: stagedBytes,
        }),
        app.inject({
          method: "POST",
          url: `/v1/files/${stagedAttachment.id}/complete`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { sizeBytes: stagedBytes.byteLength, contentSha256: stagedHash },
        }),
      ]);
      expect(
        [readResponse, putResponse, completeResponse].map((response) => response.statusCode),
      ).toEqual([404, 404, 404]);
    }
    const legacyOwnerPut = await app.inject({
      method: "PUT",
      url: `/v1/files/${stagedAttachment.id}/content`,
      headers: { authorization: `Bearer ${second.token}`, "content-type": "text/plain" },
      payload: stagedBytes,
    });
    const legacyOwnerComplete = await app.inject({
      method: "POST",
      url: `/v1/files/${stagedAttachment.id}/complete`,
      headers: {
        authorization: `Bearer ${second.token}`,
        "idempotency-key": randomUUID(),
      },
      payload: { sizeBytes: stagedBytes.byteLength, contentSha256: stagedHash },
    });
    expect([legacyOwnerPut.statusCode, legacyOwnerComplete.statusCode]).toEqual([409, 409]);
    expect(
      (
        await pool.query<{ status: string; content_received_at: Date | null } & QueryResultRow>(
          `SELECT status, content_received_at FROM attachments WHERE id = $1`,
          [stagedAttachment.id],
        )
      ).rows[0],
    ).toEqual({ status: "pending", content_received_at: null });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/files/${stagedAttachment.id}/content`,
          headers: {
            authorization: `Bearer ${second.token}`,
            "content-type": "text/plain",
            ...groupCapabilityHeader,
          },
          payload: stagedBytes,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/files/${stagedAttachment.id}/complete`,
          headers: {
            authorization: `Bearer ${second.token}`,
            "idempotency-key": randomUUID(),
            ...groupCapabilityHeader,
          },
          payload: { sizeBytes: stagedBytes.byteLength, contentSha256: stagedHash },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/files/${stagedAttachment.id}/content`,
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/files/${stagedAttachment.id}/content`,
          headers: { authorization: `Bearer ${second.token}`, ...groupCapabilityHeader },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/agents/${secondAgent.user.id}`,
          headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
        })
      ).statusCode,
    ).toBe(204);
    const bootstrapAfterDisable = await app.inject({
      method: "GET",
      url: "/v1/bootstrap",
      headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
    });
    expect(bootstrapAfterDisable.statusCode).toBe(200);
    const disabledParticipantGroup = workspaceBootstrapResponseSchema
      .parse(bootstrapAfterDisable.json())
      .conversations.find((summary) => summary.conversation.id === groupId);
    expect(disabledParticipantGroup?.participantIds).toEqual(expectedAudience);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/conversations?limit=50",
          headers: { authorization: `Bearer ${first.token}`, ...groupCapabilityHeader },
        })
      ).statusCode,
    ).toBe(200);
    const afterDisableClientMessageId = randomUUID();
    const messageAfterDisable = await app.inject({
      method: "POST",
      url: `/v1/conversations/${groupId}/messages`,
      headers: {
        authorization: `Bearer ${first.token}`,
        "idempotency-key": afterDisableClientMessageId,
        ...groupCapabilityHeader,
      },
      payload: {
        threadRootId: null,
        body: "Continuing after disable",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: afterDisableClientMessageId,
        mentionedUserIds: [],
        attachmentIds: [],
      },
    });
    expect(messageAfterDisable.statusCode).toBe(201);
    const postDisableEventAudience = await pool.query<{ user_id: string } & QueryResultRow>(
      `SELECT audience.user_id
         FROM sync_events AS event
         JOIN sync_event_audiences AS audience ON audience.event_id = event.id
        WHERE event.conversation_id = $1
          AND event.event_type = 'message.created'
          AND event.payload->'message'->>'clientMessageId' = $2
        ORDER BY audience.user_id`,
      [groupId, afterDisableClientMessageId],
    );
    expect(postDisableEventAudience.rows.map((row) => row.user_id)).toEqual(
      [firstAgent.user.id, ownerId].sort(),
    );
    expect(postDisableEventAudience.rows.map((row) => row.user_id)).not.toContain(
      secondAgent.user.id,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations/${groupId}/messages`,
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).statusCode,
    ).toBe(401);
    const replayAfterParticipantDisable = await app.inject(request);
    expect(replayAfterParticipantDisable.statusCode).toBe(201);
    expect(conversationMutationResponseSchema.parse(replayAfterParticipantDisable.json())).toEqual(
      group,
    );

    const creationEvents = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM sync_events
        WHERE conversation_id = $1
          AND event_type = 'direct_conversation.created'`,
      [groupId],
    );
    expect(creationEvents.rows[0]?.count).toBe(1);
  });

  it("lets an agent open a one-to-one conversation with another agent", async () => {
    const app = await appWithWorkspace();
    const firstAgent = await createAgent(app);
    const secondAgentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { username: "athena", displayName: "Athena" },
    });
    expect(secondAgentResponse.statusCode).toBe(201);
    const secondAgent = createAgentResponseSchema.parse(secondAgentResponse.json()).agent;
    const first = await createToken(app, firstAgent.user.id, "Direct starter", [
      "direct-conversations:write",
      "messages:write",
      "workspace:read",
    ]);
    const second = await createToken(app, secondAgent.user.id, "Direct participant", [
      "messages:write",
      "workspace:read",
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/direct-conversations",
      headers: { authorization: `Bearer ${first.token}` },
      payload: { memberId: secondAgent.user.id },
    });
    expect(created.statusCode).toBe(201);
    const direct = conversationMutationResponseSchema.parse(created.json());
    expect(direct.conversation).toMatchObject({
      conversation: { kind: "direct_message" },
      participantIds: [firstAgent.user.id, secondAgent.user.id].sort(),
    });

    const clientMessageId = randomUUID();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/conversations/${direct.conversation.conversation.id}/messages`,
          headers: {
            authorization: `Bearer ${first.token}`,
            "idempotency-key": clientMessageId,
          },
          payload: {
            threadRootId: null,
            body: "@athena status",
            bodyFormat: "hype_comms_markdown_v1",
            clientMessageId,
            mentionedUserIds: [secondAgent.user.id],
            attachmentIds: [],
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations/${direct.conversation.conversation.id}/messages`,
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/conversations/${direct.conversation.conversation.id}/messages`,
          headers: { cookie: `hype_comms_session=${memberSessionToken}` },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("rejects malformed, unauthorized, self-addressed, and unavailable group creation", async () => {
    const app = await appWithWorkspace();
    const firstAgent = await createAgent(app);
    const secondAgentResponse = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { username: "athena", displayName: "Athena" },
    });
    expect(secondAgentResponse.statusCode).toBe(201);
    const secondAgent = createAgentResponseSchema.parse(secondAgentResponse.json()).agent;
    const creator = await createToken(app, firstAgent.user.id, "Group creator", [
      "direct-conversations:write",
    ]);
    const readOnly = await createToken(app, firstAgent.user.id, "Read only", ["workspace:read"]);
    const validPayload = { memberIds: [secondAgent.user.id, ownerId] };
    const taskBotId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       VALUES ($1, NULL, 'bot', 'task-only', 'Task only')`,
      [taskBotId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [workspaceId, taskBotId],
    );
    const otherWorkspaceOwnerId = randomUUID();
    const otherWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, username, display_name)
       VALUES ($1, 'other-owner@example.test', 'other-owner', 'Other owner')`,
      [otherWorkspaceOwnerId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Other workspace', 'other-workspace', $2)`,
      [otherWorkspaceId, otherWorkspaceOwnerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [otherWorkspaceId, otherWorkspaceOwnerId],
    );

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/group-direct-conversations",
          headers: {
            authorization: `Bearer ${readOnly.token}`,
            "idempotency-key": randomUUID(),
            ...groupCapabilityHeader,
          },
          payload: validPayload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/group-direct-conversations",
          headers: { authorization: `Bearer ${creator.token}`, ...groupCapabilityHeader },
          payload: validPayload,
        })
      ).statusCode,
    ).toBe(400);

    const invalidPayloads = [
      { memberIds: [ownerId] },
      { memberIds: [ownerId, ownerId] },
      { memberIds: [ownerId, secondAgent.user.id], unexpected: true },
      { memberIds: Array.from({ length: 25 }, () => randomUUID()) },
    ];
    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/group-direct-conversations",
        headers: {
          authorization: `Bearer ${creator.token}`,
          "idempotency-key": randomUUID(),
          ...groupCapabilityHeader,
        },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const selfAddressed = await app.inject({
      method: "POST",
      url: "/v1/group-direct-conversations",
      headers: {
        authorization: `Bearer ${creator.token}`,
        "idempotency-key": randomUUID(),
        ...groupCapabilityHeader,
      },
      payload: { memberIds: [firstAgent.user.id, ownerId] },
    });
    expect(selfAddressed.statusCode).toBe(400);

    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/group-direct-conversations",
      headers: {
        authorization: `Bearer ${creator.token}`,
        "idempotency-key": randomUUID(),
        ...groupCapabilityHeader,
      },
      payload: { memberIds: [randomUUID(), ownerId] },
    });
    expect(unavailable.statusCode).toBe(404);
    for (const unavailableMemberId of [taskBotId, otherWorkspaceOwnerId]) {
      const unavailableMember = await app.inject({
        method: "POST",
        url: "/v1/group-direct-conversations",
        headers: {
          authorization: `Bearer ${creator.token}`,
          "idempotency-key": randomUUID(),
          ...groupCapabilityHeader,
        },
        payload: { memberIds: [unavailableMemberId, ownerId] },
      });
      expect(unavailableMember.statusCode).toBe(404);
    }

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/agents/${secondAgent.user.id}`,
          headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
        })
      ).statusCode,
    ).toBe(204);
    const disabledTarget = await app.inject({
      method: "POST",
      url: "/v1/group-direct-conversations",
      headers: {
        authorization: `Bearer ${creator.token}`,
        "idempotency-key": randomUUID(),
        ...groupCapabilityHeader,
      },
      payload: validPayload,
    });
    expect(disabledTarget.statusCode).toBe(404);
    expect(
      (await pool.query("SELECT 1 FROM conversations WHERE kind = 'group_direct_message'"))
        .rowCount,
    ).toBe(0);
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
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "x-hype-comms-capabilities": "announcement-channels-v1,threads-v1",
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
    await pool.query(
      `INSERT INTO conversation_memberships
         (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [conversationId, workspaceId, agent.user.id],
    );
    const bulletinClientMessageId = randomUUID();
    const bulletin = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": bulletinClientMessageId,
        "x-hype-comms-capabilities": "announcement-channels-v1,threads-v1",
      },
      payload: {
        threadRootId: null,
        body: "Owner bulletin",
        bodyFormat: "hype_comms_markdown_v1",
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
        bodyFormat: "hype_comms_markdown_v1",
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
        bodyFormat: "hype_comms_markdown_v1",
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
        bodyFormat: "hype_comms_markdown_v1",
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
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": mentionClientMessageId,
      },
      payload: {
        threadRootId: null,
        body: "@hermes please retain this context",
        bodyFormat: "hype_comms_markdown_v1",
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
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
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { email: "invitee@example.test", role: "member" },
    });
    const alias = await app.inject({
      method: "POST",
      url: "/v1/auth/invitations",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: { email: "alias@example.test", role: "member" },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });
    const invitation = listInvitationsResponseSchema
      .parse(listed.json())
      .invitations.find(({ email }) => email === "invitee@example.test");
    if (invitation === undefined) throw new Error("Invitation was not listed");
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/invitations/${invitation.id}`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });
    const memberList = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { cookie: `hype_comms_session=${memberSessionToken}` },
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
