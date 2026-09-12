import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ATTACHMENTS_CAPABILITY,
  DEFAULT_AGENCY_AGENT_SCOPES,
  apiErrorEnvelopeSchema,
  completeFileUploadResponseSchema,
  createAgentTokenResponseSchema,
  createFileUploadResponseSchema,
  listMessageAttachmentsResponseSchema,
  sendMessageResponseSchema,
} from "@hype-comms/contracts";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { EmailSender } from "../src/modules/identity/email.js";
import { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { hashToken } from "../src/modules/identity/tokens.js";
import { RealtimeEventHub } from "../src/modules/realtime/hub.js";
import { LocalAttachmentStore, sha256Hex } from "../src/modules/workspace/file-store.js";
import { WorkspaceRepository } from "../src/modules/workspace/repository.js";
import { SignInThrottle } from "../src/throttle.js";
import { createTestDatabase, describeWithPostgres, type TestDatabase } from "./support/database.js";

const ownerId = "a1000000-0000-4000-8000-000000000001";
const agentId = "a1000000-0000-4000-8000-000000000002";
const workspaceId = "a1000000-0000-4000-8000-000000000003";
const generalId = "a1000000-0000-4000-8000-000000000004";
const defaultTokenId = "a1000000-0000-4000-8000-000000000005";
const writeTokenId = "a1000000-0000-4000-8000-000000000006";
const outsiderId = "a1000000-0000-4000-8000-000000000007";
const outsiderTokenId = "a1000000-0000-4000-8000-000000000008";
const ownerSessionId = "a1000000-0000-4000-8000-000000000009";
const defaultAgentToken = `hype_comms_agent_${"d".repeat(43)}`;
const writeAgentToken = `hype_comms_agent_${"w".repeat(43)}`;
const outsiderAgentToken = `hype_comms_agent_${"x".repeat(43)}`;
const ownerSessionToken = "o".repeat(43);

class NoopEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {}
}

describeWithPostgres("default agent attachment access", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  let database: TestDatabase;
  let pool: Pool;
  let attachmentRoot: string;

  beforeAll(async () => {
    database = await createTestDatabase({ poolSize: 8 });
    pool = database.pool;
    attachmentRoot = await mkdtemp(path.join(os.tmpdir(), "agent-attachment-access-"));
  });

  beforeEach(async () => {
    await database.reset();
    await pool.query(
      `INSERT INTO users (id, email, username, display_name, kind)
       VALUES ($1, 'owner@example.test', 'owner', 'Owner', 'human'),
              ($2, NULL, 'reader-agent', 'Reader Agent', 'agent'),
              ($3, NULL, 'outsider-agent', 'Outsider Agent', 'agent')`,
      [ownerId, agentId, outsiderId],
    );
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'Attachment Access', 'attachment-access', $2)`,
      [workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'),
              ($1, $3, 'member', 'active'),
              ($1, $4, 'member', 'active')`,
      [workspaceId, ownerId, agentId, outsiderId],
    );
    await pool.query(
      `INSERT INTO conversations
         (id, workspace_id, kind, name, slug, channel_access, created_by,
          agent_membership_required)
       VALUES ($1, $2, 'channel', 'General', 'general', 'workspace', $3, true)`,
      [generalId, workspaceId, ownerId],
    );
    await pool.query(
      `INSERT INTO conversation_memberships (conversation_id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [generalId, workspaceId, agentId],
    );
    await pool.query(
      `INSERT INTO agents
         (user_id, workspace_id, created_by, legacy_public_channel_access)
       VALUES ($1, $2, $3, false), ($4, $2, $3, false)`,
      [agentId, workspaceId, ownerId, outsiderId],
    );
    await pool.query(
      `INSERT INTO agent_tokens
         (id, workspace_id, agent_user_id, token_hash, label, scopes,
          inherited_channels_join, inherited_attachments_write, created_by)
       VALUES ($1, $2, $3, $4, 'Default agency', $5, false, false, $7),
              ($6, $2, $3, $8, 'Explicit attachment writer', $9, false, false, $7)`,
      [
        defaultTokenId,
        workspaceId,
        agentId,
        hashToken(defaultAgentToken),
        [...DEFAULT_AGENCY_AGENT_SCOPES],
        writeTokenId,
        ownerId,
        hashToken(writeAgentToken),
        ["workspace:read", "messages:write", "attachments:write"],
      ],
    );
    await pool.query(
      `INSERT INTO device_sessions
         (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (
         $1, $2, $3,
         '2026-08-23T12:00:00.000Z',
         '2026-08-23T12:00:00.000Z',
         '2026-09-23T12:00:00.000Z'
       )`,
      [ownerSessionId, ownerId, hashToken(ownerSessionToken)],
    );
    await pool.query(
      `INSERT INTO agent_tokens
         (id, workspace_id, agent_user_id, token_hash, label, scopes,
          inherited_channels_join, inherited_attachments_write, created_by)
       VALUES ($1, $2, $3, $4, 'Outsider default agency', $5, false, false, $6)`,
      [
        outsiderTokenId,
        workspaceId,
        outsiderId,
        hashToken(outsiderAgentToken),
        [...DEFAULT_AGENCY_AGENT_SCOPES],
        ownerId,
      ],
    );
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  afterAll(async () => {
    await database?.dispose();
    await rm(attachmentRoot, { recursive: true, force: true });
  });

  async function appWithAttachments() {
    const identityRepository = new IdentityRepository(pool);
    const identityService = new IdentityService(
      identityRepository,
      new NoopEmailSender(),
      new SignInThrottle(),
      () => new Date("2026-08-23T12:00:00.000Z"),
      "http://127.0.0.1:3000",
    );
    const repository = new WorkspaceRepository(pool, {
      attachmentStore: new LocalAttachmentStore(attachmentRoot),
    });
    const app = await buildApp({
      cookieSecure: false,
      identity: { service: identityService, agentProvisioningEnabled: true },
      workspace: { repository, realtimeHub: new RealtimeEventHub(pool) },
    });
    apps.push(app);
    return app;
  }

  it("does not let a default-agency agent initiate an attachment upload", async () => {
    expect(DEFAULT_AGENCY_AGENT_SCOPES).not.toContain("attachments:write");
    const app = await appWithAttachments();
    const bytes = Buffer.from("read only", "utf8");
    const response = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: {
        authorization: `Bearer ${defaultAgentToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: {
        conversationId: generalId,
        fileName: "read-only.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        contentSha256: sha256Hex(bytes),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(apiErrorEnvelopeSchema.parse(response.json()).error).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lets an owner mint an explicitly scoped attachment writer through the strict API", async () => {
    const app = await appWithAttachments();
    const minted = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/tokens`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: {
        label: "Explicit writer",
        scopes: ["attachments:write", "messages:write", "workspace:read"],
      },
    });
    expect(minted.statusCode).toBe(201);
    expect(createAgentTokenResponseSchema.parse(minted.json()).agentToken.scopes).toEqual([
      "workspace:read",
      "messages:write",
      "attachments:write",
    ]);

    const unknownScope = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/tokens`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
      payload: {
        label: "Invalid writer",
        scopes: ["workspace:read", "attachments-v1"],
      },
    });
    expect(unknownScope.statusCode).toBe(400);
    expect(apiErrorEnvelopeSchema.parse(unknownScope.json()).error.code).toBe("BAD_REQUEST");
  });

  it("reserves upload bytes and completion for an explicitly write-capable agent token", async () => {
    const app = await appWithAttachments();
    const bytes = Buffer.from("legacy writer", "utf8");
    const contentSha256 = sha256Hex(bytes);
    const upload = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: {
        authorization: `Bearer ${writeAgentToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: {
        conversationId: generalId,
        fileName: "legacy.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        contentSha256,
      },
    });
    expect(upload.statusCode).toBe(201);
    const attachment = createFileUploadResponseSchema.parse(upload.json()).attachment;

    const deniedBytes = await app.inject({
      method: "PUT",
      url: `/v1/files/${attachment.id}/content`,
      headers: {
        authorization: `Bearer ${defaultAgentToken}`,
        "content-type": "text/plain",
      },
      payload: bytes,
    });
    expect(deniedBytes.statusCode).toBe(403);
    expect(apiErrorEnvelopeSchema.parse(deniedBytes.json()).error.code).toBe("FORBIDDEN");

    const acceptedBytes = await app.inject({
      method: "PUT",
      url: `/v1/files/${attachment.id}/content`,
      headers: {
        authorization: `Bearer ${writeAgentToken}`,
        "content-type": "text/plain",
      },
      payload: bytes,
    });
    expect(acceptedBytes.statusCode).toBe(204);

    const deniedCompletion = await app.inject({
      method: "POST",
      url: `/v1/files/${attachment.id}/complete`,
      headers: {
        authorization: `Bearer ${defaultAgentToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { sizeBytes: bytes.byteLength, contentSha256 },
    });
    expect(deniedCompletion.statusCode).toBe(403);
    expect(apiErrorEnvelopeSchema.parse(deniedCompletion.json()).error.code).toBe("FORBIDDEN");

    const acceptedCompletion = await app.inject({
      method: "POST",
      url: `/v1/files/${attachment.id}/complete`,
      headers: {
        authorization: `Bearer ${writeAgentToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { sizeBytes: bytes.byteLength, contentSha256 },
    });
    expect(acceptedCompletion.statusCode).toBe(200);
    expect(
      completeFileUploadResponseSchema.parse(acceptedCompletion.json()).attachment,
    ).toMatchObject({ id: attachment.id, status: "ready" });

    const writerCanReadUnattached = await app.inject({
      method: "GET",
      url: `/v1/files/${attachment.id}/content`,
      headers: { authorization: `Bearer ${writeAgentToken}` },
    });
    expect(writerCanReadUnattached.statusCode).toBe(200);
    expect(writerCanReadUnattached.rawPayload).toEqual(bytes);

    const hiddenFromReadOnlyToken = await app.inject({
      method: "GET",
      url: `/v1/files/${attachment.id}/content`,
      headers: { authorization: `Bearer ${defaultAgentToken}` },
    });
    expect(hiddenFromReadOnlyToken.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(hiddenFromReadOnlyToken.json()).error.code).toBe(
      "NOT_FOUND",
    );

    const deniedMessageId = randomUUID();
    const deniedMessage = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        authorization: `Bearer ${defaultAgentToken}`,
        "idempotency-key": deniedMessageId,
        "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
      },
      payload: {
        threadRootId: null,
        body: "Read-only token cannot claim a staged upload",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: deniedMessageId,
        mentionedUserIds: [],
        attachmentIds: [attachment.id],
      },
    });
    expect(deniedMessage.statusCode).toBe(403);
    expect(apiErrorEnvelopeSchema.parse(deniedMessage.json()).error.code).toBe("FORBIDDEN");
    const deniedArtifacts = await pool.query<{
      idempotency_count: number;
      message_count: number;
      message_id: string | null;
    }>(
      `SELECT attachment.message_id,
              (SELECT count(*)::integer
                 FROM messages
                WHERE client_message_id = $2) AS message_count,
              (SELECT count(*)::integer
                 FROM api_idempotency_records
                WHERE actor_user_id = $3 AND idempotency_key = $2::text) AS idempotency_count
         FROM attachments AS attachment
        WHERE attachment.id = $1`,
      [attachment.id, deniedMessageId, agentId],
    );
    expect(deniedArtifacts.rows[0]).toEqual({
      idempotency_count: 0,
      message_count: 0,
      message_id: null,
    });

    const writerMessageId = randomUUID();
    const writerMessage = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        authorization: `Bearer ${writeAgentToken}`,
        "idempotency-key": writerMessageId,
        "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
      },
      payload: {
        threadRootId: null,
        body: "Explicit writer claims its staged upload",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId: writerMessageId,
        mentionedUserIds: [],
        attachmentIds: [attachment.id],
      },
    });
    expect(writerMessage.statusCode).toBe(201);
    expect(sendMessageResponseSchema.parse(writerMessage.json()).attachments).toEqual([
      expect.objectContaining({ id: attachment.id }),
    ]);
  });

  it("lets a default agent read a file only while it belongs to an accessible live message", async () => {
    const app = await appWithAttachments();
    const bytes = Buffer.from("message attachment", "utf8");
    const contentSha256 = sha256Hex(bytes);
    const upload = await app.inject({
      method: "POST",
      url: "/v1/files/uploads",
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: {
        conversationId: generalId,
        fileName: "message.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        contentSha256,
      },
    });
    const attachment = createFileUploadResponseSchema.parse(upload.json()).attachment;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/files/${attachment.id}/content`,
          headers: {
            cookie: `hype_comms_session=${ownerSessionToken}`,
            "content-type": "text/plain",
          },
          payload: bytes,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/files/${attachment.id}/complete`,
          headers: {
            cookie: `hype_comms_session=${ownerSessionToken}`,
            "idempotency-key": randomUUID(),
          },
          payload: { sizeBytes: bytes.byteLength, contentSha256 },
        })
      ).statusCode,
    ).toBe(200);

    const unattached = await app.inject({
      method: "GET",
      url: `/v1/files/${attachment.id}/content`,
      headers: { authorization: `Bearer ${defaultAgentToken}` },
    });
    expect(unattached.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(unattached.json()).error.code).toBe("NOT_FOUND");

    const clientMessageId = randomUUID();
    const sentResponse = await app.inject({
      method: "POST",
      url: `/v1/conversations/${generalId}/messages`,
      headers: {
        cookie: `hype_comms_session=${ownerSessionToken}`,
        "idempotency-key": clientMessageId,
        "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY,
      },
      payload: {
        threadRootId: null,
        body: "Attached for the channel",
        bodyFormat: "hype_comms_markdown_v1",
        clientMessageId,
        mentionedUserIds: [],
        attachmentIds: [attachment.id],
      },
    });
    expect(sentResponse.statusCode).toBe(201);
    const sent = sendMessageResponseSchema.parse(sentResponse.json());
    expect(sent.attachments.map((item) => item.id)).toEqual([attachment.id]);

    const metadata = await app.inject({
      method: "POST",
      url: "/v1/attachments/query",
      headers: { authorization: `Bearer ${defaultAgentToken}` },
      payload: { messageIds: [sent.message.id] },
    });
    expect(metadata.statusCode).toBe(200);
    expect(
      listMessageAttachmentsResponseSchema
        .parse(metadata.json())
        .attachments.map((item) => item.id),
    ).toEqual([attachment.id]);

    const content = await app.inject({
      method: "GET",
      url: `/v1/files/${attachment.id}/content`,
      headers: { authorization: `Bearer ${defaultAgentToken}` },
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(bytes);
    expect(content.headers["x-content-sha256"]).toBe(contentSha256);

    const inaccessibleMetadata = await app.inject({
      method: "POST",
      url: "/v1/attachments/query",
      headers: { authorization: `Bearer ${outsiderAgentToken}` },
      payload: { messageIds: [sent.message.id] },
    });
    expect(inaccessibleMetadata.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(inaccessibleMetadata.json()).error.code).toBe("NOT_FOUND");

    const inaccessibleContent = await app.inject({
      method: "GET",
      url: `/v1/files/${attachment.id}/content`,
      headers: { authorization: `Bearer ${outsiderAgentToken}` },
    });
    expect(inaccessibleContent.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(inaccessibleContent.json()).error.code).toBe("NOT_FOUND");

    const retracted = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${sent.message.id}`,
      headers: { cookie: `hype_comms_session=${ownerSessionToken}` },
    });
    expect(retracted.statusCode).toBe(200);

    const hiddenMetadata = await app.inject({
      method: "POST",
      url: "/v1/attachments/query",
      headers: { authorization: `Bearer ${defaultAgentToken}` },
      payload: { messageIds: [sent.message.id] },
    });
    expect(hiddenMetadata.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(hiddenMetadata.json()).error.code).toBe("NOT_FOUND");

    const hiddenContent = await app.inject({
      method: "GET",
      url: `/v1/files/${attachment.id}/content`,
      headers: { authorization: `Bearer ${defaultAgentToken}` },
    });
    expect(hiddenContent.statusCode).toBe(404);
    expect(apiErrorEnvelopeSchema.parse(hiddenContent.json()).error.code).toBe("NOT_FOUND");
  });
});
