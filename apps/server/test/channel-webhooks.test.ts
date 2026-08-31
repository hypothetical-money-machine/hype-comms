import { randomUUID } from "node:crypto";

import {
  apiErrorEnvelopeSchema,
  channelWebhookResponseSchema,
  issuedChannelWebhookResponseSchema,
  listMembersResponseSchema,
  sendMessageResponseSchema,
} from "@hype-comms/contracts";
import { escapeIdentifier, type Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { BotService } from "../src/modules/bots/service.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { RealtimeEventHub } from "../src/modules/realtime/hub.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { FixedWindowAttemptThrottle, SignInThrottle } from "../src/throttle.js";

const testDatabaseUrl = process.env.HYPE_COMMS_TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl === undefined ? describe.skip : describe;
const now = "2026-08-23T12:00:00.000Z";
const publicApiUrl = "http://127.0.0.1:3000";
const ownerId = "30000000-0000-4000-8000-000000000001";
const creatorId = "30000000-0000-4000-8000-000000000002";
const outsiderId = "30000000-0000-4000-8000-000000000003";
const workspaceId = "30000000-0000-4000-8000-000000000004";
const channelId = "30000000-0000-4000-8000-000000000005";
const ownerSessionId = "30000000-0000-4000-8000-000000000006";
const creatorSessionId = "30000000-0000-4000-8000-000000000007";
const outsiderSessionId = "30000000-0000-4000-8000-000000000008";
const ownerSessionToken = "o".repeat(43);
const creatorSessionToken = "c".repeat(43);
const outsiderSessionToken = "x".repeat(43);

class NoopEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

function schemaScopedUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  return url.toString();
}

function sessionCookie(token: string): { readonly cookie: string } {
  return { cookie: `hype_comms_session=${token}` };
}

function webhookPath(webhookUrl: string): string {
  return new URL(webhookUrl).pathname;
}

describeWithPostgres("per-channel incoming webhooks", () => {
  const schemaName = `channel_webhooks_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
  let adminPool: Pool;
  let pool: Pool;
  let identityService: IdentityService;
  let botService: BotService;
  let workspaceRepository: WorkspaceRepository;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) return;
    adminPool = createPool({ url: testDatabaseUrl, poolSize: 2 });
    await adminPool.query(`CREATE SCHEMA ${escapeIdentifier(schemaName)}`);
    pool = createPool({ url: schemaScopedUrl(testDatabaseUrl, schemaName), poolSize: 10 });
    await runMigrations(pool);
    identityService = new IdentityService(
      new IdentityRepository(pool),
      new NoopEmailSender(),
      new SignInThrottle(),
      () => new Date(now),
      publicApiUrl,
    );
    botService = new BotService(pool, () => new Date(now), publicApiUrl);
    workspaceRepository = new WorkspaceRepository(pool, { humansOnlyChannelsEnabled: true });
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE channel_webhooks, bot_channel_grants, bot_credentials, agent_tokens, agents,
               realtime_tickets, api_idempotency_records, sync_event_audiences, sync_events,
               conversation_read_cursors, message_reactions, message_mentions, attachments,
               messages, conversation_memberships, conversations, device_sessions,
               magic_link_tokens, invitations, workspace_memberships, workspaces, users
      CASCADE
    `);
    await pool.query(
      `INSERT INTO users (id, email, kind, username, display_name)
       VALUES ($1, 'owner@example.test', 'human', 'owner', 'Owner'),
              ($2, 'creator@example.test', 'human', 'creator', 'Creator'),
              ($3, 'outsider@example.test', 'human', 'outsider', 'Outsider')`,
      [ownerId, creatorId, outsiderId],
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
      [workspaceId, ownerId, creatorId, outsiderId],
    );
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by)
       VALUES ($1, $2, 'channel', 'Builds', 'builds', 'workspace', $3)`,
      [channelId, workspaceId, creatorId],
    );
    await pool.query(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $10, $10, $10::timestamptz + interval '30 days'),
              ($4, $5, $6, $10, $10, $10::timestamptz + interval '30 days'),
              ($7, $8, $9, $10, $10, $10::timestamptz + interval '30 days')`,
      [
        ownerSessionId,
        ownerId,
        hashToken(ownerSessionToken),
        creatorSessionId,
        creatorId,
        hashToken(creatorSessionToken),
        outsiderSessionId,
        outsiderId,
        hashToken(outsiderSessionToken),
        now,
      ],
    );
  });

  afterEach(async () => {
    await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  });

  afterAll(async () => {
    if (testDatabaseUrl === undefined) return;
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${escapeIdentifier(schemaName)} CASCADE`);
    await adminPool.end();
  });

  async function appWithWebhookThrottle(throttle?: FixedWindowAttemptThrottle) {
    const app = await buildApp({
      cookieSecure: false,
      identity: {
        service: identityService,
        botService,
        ...(throttle === undefined ? {} : { webhookThrottle: throttle }),
      },
      workspace: {
        repository: workspaceRepository,
        realtimeHub: new RealtimeEventHub(pool),
      },
    });
    openApps.push(app);
    return app;
  }

  async function enable(app: Awaited<ReturnType<typeof buildApp>>, token = creatorSessionToken) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/channels/${channelId}/webhook`,
      headers: sessionCookie(token),
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    return { response, issued: issuedChannelWebhookResponseSchema.parse(response.json()) };
  }

  async function post(
    app: Awaited<ReturnType<typeof buildApp>>,
    webhookUrl: string,
    body: string,
    idempotencyKey?: string,
  ) {
    return app.inject({
      method: "POST",
      url: webhookPath(webhookUrl),
      ...(idempotencyKey === undefined ? {} : { headers: { "idempotency-key": idempotencyKey } }),
      payload: { body },
    });
  }

  it("provisions a one-time hash-only bot URL and posts through canonical message sync", async () => {
    const app = await appWithWebhookThrottle();
    const { response, issued } = await enable(app);
    const token = webhookPath(issued.webhookUrl).split("/").at(-1);
    if (token === undefined) throw new Error("Issued webhook URL had no token");

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(issued.webhook).toMatchObject({
      channelId,
      enabled: true,
      bot: { kind: "bot" },
    });
    const stored = await pool.query<{
      token_hash: Buffer;
      scopes: string[];
      plaintext_present: boolean;
      grant_count: number;
    }>(
      `SELECT credential.token_hash,
              credential.scopes,
              position($2 in encode(credential.token_hash, 'hex')) > 0 AS plaintext_present,
              (
                SELECT count(*)::integer
                  FROM bot_channel_grants AS grant_record
                 WHERE grant_record.bot_user_id = webhook.bot_user_id
              ) AS grant_count
         FROM channel_webhooks AS webhook
         JOIN bot_credentials AS credential ON credential.id = webhook.current_credential_id
        WHERE webhook.conversation_id = $1`,
      [channelId, token],
    );
    expect(stored.rows[0]).toMatchObject({
      token_hash: hashToken(token),
      scopes: ["messages:write"],
      plaintext_present: false,
      grant_count: 1,
    });

    const status = await app.inject({
      method: "GET",
      url: `/v1/channels/${channelId}/webhook`,
      headers: sessionCookie(creatorSessionToken),
    });
    expect(status.statusCode).toBe(200);
    expect(channelWebhookResponseSchema.parse(status.json()).webhook).toEqual(issued.webhook);
    expect(status.body).not.toContain(token);
    expect(status.body).not.toContain("webhookUrl");

    const members = await app.inject({
      method: "GET",
      url: "/v1/members",
      headers: sessionCookie(creatorSessionToken),
    });
    expect(listMembersResponseSchema.parse(members.json()).members).toContainEqual(
      expect.objectContaining({ id: issued.webhook.bot.id, kind: "bot" }),
    );

    const clientMessageId = randomUUID();
    const first = await post(app, issued.webhookUrl, "Build 481 passed", clientMessageId);
    const retry = await post(app, issued.webhookUrl, "Build 481 passed", clientMessageId);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    const created = sendMessageResponseSchema.parse(first.json());
    expect(sendMessageResponseSchema.parse(retry.json())).toEqual(created);
    expect(created.message).toMatchObject({
      conversationId: channelId,
      clientMessageId,
      authorId: issued.webhook.bot.id,
      body: "Build 481 passed",
      threadRootId: null,
      bodyFormat: "hype_comms_markdown_v1",
    });

    const persisted = await pool.query<{
      message_count: number;
      event_count: number;
      actor_user_id: string;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM messages WHERE client_message_id = $1) AS message_count,
         (SELECT count(*)::integer FROM sync_events
           WHERE event_type = 'message.created'
             AND payload->'message'->>'clientMessageId' = $1::text) AS event_count,
         (SELECT actor_user_id FROM sync_events
           WHERE event_type = 'message.created'
             AND payload->'message'->>'clientMessageId' = $1::text) AS actor_user_id`,
      [clientMessageId],
    );
    expect(persisted.rows[0]).toEqual({
      message_count: 1,
      event_count: 1,
      actor_user_id: issued.webhook.bot.id,
    });
  });

  it("disables immediately, re-enables with a new URL, and rotates away every old URL", async () => {
    const app = await appWithWebhookThrottle();
    const first = (await enable(app)).issued;
    const disabled = await app.inject({
      method: "DELETE",
      url: `/v1/channels/${channelId}/webhook`,
      headers: sessionCookie(ownerSessionToken),
    });
    expect(disabled.statusCode).toBe(200);
    expect(channelWebhookResponseSchema.parse(disabled.json()).webhook).toMatchObject({
      enabled: false,
      bot: { id: first.webhook.bot.id },
      expiresAt: null,
    });
    expect((await post(app, first.webhookUrl, "must not land", randomUUID())).statusCode).toBe(401);
    await expect(pool.query("SELECT 1 FROM messages")).resolves.toMatchObject({ rowCount: 0 });

    const second = (await enable(app)).issued;
    expect(second.webhook.bot.id).toBe(first.webhook.bot.id);
    expect(second.webhookUrl).not.toBe(first.webhookUrl);
    expect((await post(app, first.webhookUrl, "still revoked", randomUUID())).statusCode).toBe(401);
    expect((await post(app, second.webhookUrl, "new URL works", randomUUID())).statusCode).toBe(
      201,
    );

    const rotatedResponse = await app.inject({
      method: "POST",
      url: `/v1/channels/${channelId}/webhook/rotate`,
      headers: sessionCookie(creatorSessionToken),
      payload: {},
    });
    expect(rotatedResponse.statusCode).toBe(201);
    const rotated = issuedChannelWebhookResponseSchema.parse(rotatedResponse.json());
    expect(rotated.webhookUrl).not.toBe(second.webhookUrl);
    expect(
      (await post(app, second.webhookUrl, "rotation revoked me", randomUUID())).statusCode,
    ).toBe(401);
    expect(
      (await post(app, rotated.webhookUrl, "rotated URL works", randomUUID())).statusCode,
    ).toBe(201);

    const credentials = await pool.query<{ active: number; revoked: number }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::integer AS active,
              count(*) FILTER (WHERE revoked_at IS NOT NULL)::integer AS revoked
         FROM bot_credentials
        WHERE bot_user_id = $1`,
      [first.webhook.bot.id],
    );
    expect(credentials.rows[0]).toEqual({ active: 1, revoked: 2 });
  });

  it("allows only the channel creator or a workspace owner to manage the webhook", async () => {
    const app = await appWithWebhookThrottle();
    const deniedEnable = await app.inject({
      method: "POST",
      url: `/v1/channels/${channelId}/webhook`,
      headers: sessionCookie(outsiderSessionToken),
      payload: {},
    });
    expect(deniedEnable.statusCode).toBe(403);
    expect(apiErrorEnvelopeSchema.parse(deniedEnable.json()).error.code).toBe("FORBIDDEN");

    await enable(app, ownerSessionToken);
    for (const [method, suffix, payload] of [
      ["DELETE", "", undefined],
      ["POST", "/rotate", {}],
    ] as const) {
      const denied = await app.inject({
        method,
        url: `/v1/channels/${channelId}/webhook${suffix}`,
        headers: sessionCookie(outsiderSessionToken),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(denied.statusCode).toBe(403);
      expect(apiErrorEnvelopeSchema.parse(denied.json()).error.code).toBe("FORBIDDEN");
    }
  });

  it("rejects humans-only channels before provisioning a webhook bot", async () => {
    const creator = await identityService.authenticateContext(creatorSessionToken);
    if (creator === null) throw new Error("Expected creator authentication");
    const created = await workspaceRepository.createChannel(creator, {
      name: "People",
      slug: "people",
      topic: "Humans only",
      access: "humans",
    });
    const humansOnlyChannelId = created.conversation.conversation.id;
    expect(created.conversation.conversation.access).toBe("humans");

    const app = await appWithWebhookThrottle();
    const response = await app.inject({
      method: "POST",
      url: `/v1/channels/${humansOnlyChannelId}/webhook`,
      headers: sessionCookie(creatorSessionToken),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error.code).toBe("NOT_FOUND");

    const persisted = await pool.query<{
      webhook_count: number;
      grant_count: number;
      credential_count: number;
      bot_count: number;
    }>(
      `SELECT
         (SELECT count(*)::integer
            FROM channel_webhooks
           WHERE conversation_id = $1) AS webhook_count,
         (SELECT count(*)::integer
            FROM bot_channel_grants
           WHERE conversation_id = $1) AS grant_count,
         (SELECT count(*)::integer FROM bot_credentials) AS credential_count,
         (SELECT count(*)::integer FROM users WHERE kind = 'bot') AS bot_count`,
      [humansOnlyChannelId],
    );
    expect(persisted.rows[0]).toEqual({
      webhook_count: 0,
      grant_count: 0,
      credential_count: 0,
      bot_count: 0,
    });
  });

  it("requires idempotency, rejects malformed and oversized payloads, and bounds a sender", async () => {
    const app = await appWithWebhookThrottle(
      new FixedWindowAttemptThrottle({ maxAttempts: 2, windowMs: 60_000 }),
    );
    const issued = (await enable(app)).issued;

    const missingKey = await post(app, issued.webhookUrl, "No retry identity");
    expect(missingKey.statusCode).toBe(400);
    const malformedKey = await app.inject({
      method: "POST",
      url: webhookPath(issued.webhookUrl),
      headers: { "idempotency-key": "build-481" },
      payload: { body: "Not a canonical client message id" },
    });
    expect(malformedKey.statusCode).toBe(400);
    const blankBody = await post(app, issued.webhookUrl, "   ", randomUUID());
    expect(blankBody.statusCode).toBe(400);
    const richPayload = await app.inject({
      method: "POST",
      url: webhookPath(issued.webhookUrl),
      headers: { "idempotency-key": randomUUID() },
      payload: { body: "No attachments", attachments: [] },
    });
    expect(richPayload.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      url: webhookPath(issued.webhookUrl),
      headers: { "idempotency-key": randomUUID() },
      payload: { body: "x".repeat(17_000) },
    });
    expect(oversized.statusCode).toBe(413);

    const first = await post(app, issued.webhookUrl, "one", randomUUID());
    const second = await post(app, issued.webhookUrl, "two", randomUUID());
    const limited = await post(app, issued.webhookUrl, "three", randomUUID());
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(apiErrorEnvelopeSchema.parse(limited.json()).error.code).toBe("RATE_LIMITED");
    await expect(pool.query("SELECT 1 FROM messages")).resolves.toMatchObject({ rowCount: 2 });
  });
});
