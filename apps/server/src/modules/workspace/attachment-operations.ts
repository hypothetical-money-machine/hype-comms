import { z } from "zod";
import { createCursorCodec, cursorIdSchema, cursorTimestampSchema } from "./cursor-codec.js";
import { readWorkspacePosition } from "./workspace-sequence.js";
import {
  ATTACHMENT_MAX_BYTES,
  completeFileUploadResponseSchema,
  CONVERSATION_FILES_MAX_LIMIT,
  conversationFilesResponseSchema,
  createFileUploadResponseSchema,
  listMessageAttachmentsResponseSchema,
  MESSAGE_HISTORY_MAX_LIMIT,
  type Attachment,
  type CompleteFileUploadRequest,
  type CompleteFileUploadResponse,
  type ConversationFilesResponse,
  type CreateFileUploadRequest,
  type CreateFileUploadResponse,
  type ListMessageAttachmentsResponse,
} from "@hype-comms/contracts";
import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { DomainError } from "../../domain-errors.js";
import type { AuthenticatedIdentity } from "../identity/service.js";
import { attachmentsForMessages } from "./attachment-queries.js";
import {
  mapAttachment,
  type AttachmentRow,
  type ReadableAttachmentRow,
  type UploadAttachmentRow,
} from "./attachment-records.js";
import { conversationVisibilitySql, requireVisibleConversation } from "./conversation-access.js";
import {
  ATTACHMENT_UPLOAD_TTL_MS,
  isRejectedAttachment,
  sanitizeFileName,
  sha256Buffer,
  sha256Hex,
  type AttachmentStore,
} from "./file-store.js";
import { fingerprintApiRequest, runIdempotentMutation } from "./idempotency.js";
import { iso } from "./records.js";
import { runWorkspaceTransaction } from "./transaction.js";
import { requireActivePrincipal } from "./workspace-access.js";
import { type WorkspaceRepositoryHooks } from "./workspace-hooks.js";

const filesCursorCodec = createCursorCodec(
  "files",
  z.object({ createdAt: cursorTimestampSchema, id: cursorIdSchema }).strict(),
);

function encodeFilesCursor(createdAt: string, id: string): string {
  return filesCursorCodec.encode({ createdAt, id });
}
const decodeFilesCursor = filesCursorCodec.decode;

/** Owns attachment upload, completion and authorized reads. */
export class WorkspaceAttachmentOperations {
  constructor(
    private readonly pool: Pool,
    private readonly hooks: Pick<WorkspaceRepositoryHooks, "attachmentStore"> = {},
  ) {}
  async createFileUpload(
    identity: AuthenticatedIdentity,
    input: CreateFileUploadRequest,
    idempotencyKey: string,
  ): Promise<CreateFileUploadResponse> {
    const fileName = sanitizeFileName(input.fileName);
    const contentType = input.contentType.trim();
    if (isRejectedAttachment(fileName, contentType)) {
      throw new DomainError("invalid_input", "Executable files are not allowed");
    }
    if (input.sizeBytes > ATTACHMENT_MAX_BYTES) {
      throw new DomainError("invalid_input", "File exceeds the 25 MiB limit");
    }
    this.#attachmentStore();
    return runWorkspaceTransaction(this.pool, async (client) => {
      await requireVisibleConversation(client, identity, input.conversationId, true);
      await requireActivePrincipal(client, identity);
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: "/v1/files/uploads",
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 201,
          responseSchema: createFileUploadResponseSchema,
        },
        async () => {
          const inserted = await client.query<AttachmentRow>(
            `INSERT INTO attachments (
               id, workspace_id, conversation_id, uploaded_by, file_name, content_type,
               size_bytes, content_sha256, status, upload_expires_at
             )
             VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, 'pending',
               clock_timestamp() + ($9::bigint * interval '1 millisecond')
             )
             RETURNING *`,
            [
              randomUUID(),
              identity.currentUser.workspaceId,
              input.conversationId,
              identity.currentUser.user.id,
              fileName,
              contentType,
              input.sizeBytes,
              sha256Buffer(input.contentSha256),
              ATTACHMENT_UPLOAD_TTL_MS,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error("Attachment insert returned no row");
          if (row.upload_expires_at === null) {
            throw new Error("Attachment upload was created without an expiry");
          }
          return createFileUploadResponseSchema.parse({
            attachment: mapAttachment(row),
            expiresAt: iso(row.upload_expires_at),
          });
        },
      );
    });
  }

  async putFileContent(
    identity: AuthenticatedIdentity,
    attachmentId: string,
    contentType: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const store = this.#attachmentStore();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<UploadAttachmentRow>(
        `SELECT *,
                coalesce(upload_expires_at <= clock_timestamp(), true) AS upload_expired
           FROM attachments
          WHERE id = $1
            AND workspace_id = $2
          FOR UPDATE`,
        [attachmentId, identity.currentUser.workspaceId],
      );
      const row = locked.rows[0];
      if (row === undefined || row.uploaded_by !== identity.currentUser.user.id) {
        throw new DomainError("not_found", "Upload not found");
      }
      if (row.status !== "pending") {
        throw new DomainError("conflict", "This upload can no longer receive content");
      }
      if (row.upload_expired) {
        throw new DomainError("invalid_input", "This upload has expired");
      }
      if (row.content_type !== contentType.trim()) {
        throw new DomainError("invalid_input", "Content type must match the staged upload");
      }
      if (Number(row.size_bytes) !== bytes.byteLength) {
        throw new DomainError("invalid_input", "File size must match the staged upload");
      }
      if (sha256Hex(bytes) !== row.content_sha256.toString("hex")) {
        throw new DomainError("invalid_input", "File hash must match the staged upload");
      }
      await store.write(identity.currentUser.workspaceId, attachmentId, bytes);
      await client.query(
        `UPDATE attachments
            SET content_received_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [attachmentId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeFileUpload(
    identity: AuthenticatedIdentity,
    attachmentId: string,
    input: CompleteFileUploadRequest,
    idempotencyKey: string,
  ): Promise<CompleteFileUploadResponse> {
    const store = this.#attachmentStore();
    return runWorkspaceTransaction(this.pool, async (client) => {
      return runIdempotentMutation(
        client,
        {
          actorUserId: identity.currentUser.user.id,
          workspaceId: identity.currentUser.workspaceId,
          route: `/v1/files/${attachmentId}/complete`,
          idempotencyKey,
          requestFingerprint: fingerprintApiRequest(input),
          responseStatus: 200,
          responseSchema: completeFileUploadResponseSchema,
        },
        async () => {
          const locked = await client.query<UploadAttachmentRow>(
            `SELECT *,
                    coalesce(upload_expires_at <= clock_timestamp(), true) AS upload_expired
               FROM attachments
              WHERE id = $1
                AND workspace_id = $2
              FOR UPDATE`,
            [attachmentId, identity.currentUser.workspaceId],
          );
          const row = locked.rows[0];
          if (row === undefined || row.uploaded_by !== identity.currentUser.user.id) {
            throw new DomainError("not_found", "Upload not found");
          }
          if (row.status === "ready") {
            return completeFileUploadResponseSchema.parse({ attachment: mapAttachment(row) });
          }
          if (row.status !== "pending") {
            throw new DomainError("conflict", "This upload can no longer be completed");
          }
          if (row.upload_expired) {
            throw new DomainError("invalid_input", "This upload has expired");
          }
          if (row.content_received_at === null) {
            throw new DomainError("invalid_input", "Upload the file before completing it");
          }
          if (
            Number(row.size_bytes) !== input.sizeBytes ||
            row.content_sha256.toString("hex") !== input.contentSha256
          ) {
            throw new DomainError(
              "invalid_input",
              "Completed file does not match the staged upload",
            );
          }
          const stored = await store.read(identity.currentUser.workspaceId, attachmentId);
          if (stored.byteLength !== input.sizeBytes || sha256Hex(stored) !== input.contentSha256) {
            throw new DomainError(
              "invalid_input",
              "Completed file does not match the staged upload",
            );
          }
          const updated = await client.query<AttachmentRow>(
            `UPDATE attachments
                SET status = 'ready',
                    updated_at = clock_timestamp()
              WHERE id = $1
              RETURNING *`,
            [attachmentId],
          );
          const ready = updated.rows[0];
          if (ready === undefined) throw new Error("Attachment complete returned no row");
          return completeFileUploadResponseSchema.parse({ attachment: mapAttachment(ready) });
        },
      );
    });
  }

  async listConversationFiles(
    identity: AuthenticatedIdentity,
    conversationId: string,
    before: string | undefined,
    limit: number,
  ): Promise<ConversationFilesResponse> {
    return runWorkspaceTransaction(
      this.pool,
      async (client) => {
        await requireVisibleConversation(client, identity, conversationId, false);
        const cursor = decodeFilesCursor(before);
        if (before !== undefined && cursor === null) {
          throw new DomainError("invalid_input", "Invalid files cursor");
        }
        const result = await client.query<AttachmentRow>(
          `SELECT attachment.*
           FROM attachments AS attachment
           JOIN messages AS message ON message.id = attachment.message_id
          WHERE attachment.conversation_id = $1
            AND attachment.workspace_id = $2
            AND attachment.status = 'ready'
            AND attachment.message_id IS NOT NULL
            AND message.deleted_at IS NULL
            AND (
              $3::timestamptz IS NULL
              OR attachment.created_at < $3::timestamptz
              OR (attachment.created_at = $3::timestamptz AND attachment.id < $4::uuid)
            )
          ORDER BY attachment.created_at DESC, attachment.id DESC
          LIMIT $5`,
          [
            conversationId,
            identity.currentUser.workspaceId,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            Math.min(limit, CONVERSATION_FILES_MAX_LIMIT) + 1,
          ],
        );
        const hasMore = result.rows.length > limit;
        const selected = result.rows.slice(0, limit);
        const oldest = selected.at(-1);
        return conversationFilesResponseSchema.parse({
          snapshotPosition: await readWorkspacePosition(client, identity.currentUser.workspaceId),
          files: selected.map(mapAttachment),
          nextCursor:
            hasMore && oldest !== undefined
              ? encodeFilesCursor(iso(oldest.created_at), oldest.id)
              : null,
          hasMore,
        });
      },
      { isolationLevel: "repeatable_read", readOnly: true },
    );
  }

  async listMessageAttachments(
    identity: AuthenticatedIdentity,
    messageIds: readonly string[],
  ): Promise<ListMessageAttachmentsResponse> {
    const ids = [...new Set(messageIds)];
    if (
      ids.length === 0 ||
      ids.length !== messageIds.length ||
      ids.length > MESSAGE_HISTORY_MAX_LIMIT
    ) {
      throw new DomainError("invalid_input", "Invalid attachment message IDs");
    }
    const client = await this.pool.connect();
    try {
      const visible = await client.query<
        {
          id: string;
        } & QueryResultRow
      >(
        `SELECT message.id
           FROM messages AS message
           JOIN conversations AS conversation ON conversation.id = message.conversation_id
          WHERE message.id = ANY($1::uuid[])
            AND message.workspace_id = $2
            AND conversation.workspace_id = $2
            AND message.deleted_at IS NULL
            AND ${conversationVisibilitySql("conversation", "$3")}`,
        [ids, identity.currentUser.workspaceId, identity.currentUser.user.id],
      );
      if (visible.rows.length !== ids.length) {
        throw new DomainError("not_found", "One or more messages were not found");
      }
      const attachments = await attachmentsForMessages(client, ids);
      return listMessageAttachmentsResponseSchema.parse({ attachments });
    } finally {
      client.release();
    }
  }

  async readFileContent(
    identity: AuthenticatedIdentity,
    attachmentId: string,
  ): Promise<{
    readonly attachment: Attachment;
    readonly bytes: Buffer;
    readonly contentSha256: string;
  }> {
    const store = this.#attachmentStore();
    const client = await this.pool.connect();
    try {
      const result = await client.query<ReadableAttachmentRow>(
        `SELECT attachment.*, conversation.kind AS conversation_kind
           FROM attachments AS attachment
           JOIN conversations AS conversation
             ON conversation.id = attachment.conversation_id
          WHERE attachment.id = $1
            AND attachment.workspace_id = $2
            AND conversation.workspace_id = $2
            AND attachment.status = 'ready'
            AND (
              (
                attachment.message_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM messages AS message
                   WHERE message.id = attachment.message_id
                     AND message.deleted_at IS NULL
                )
              )
              OR (
                $4::boolean
                AND attachment.message_id IS NULL
                AND attachment.uploaded_by = $3
              )
            )
            AND ${conversationVisibilitySql("conversation", "$3")}`,
        [
          attachmentId,
          identity.currentUser.workspaceId,
          identity.currentUser.user.id,
          identity.principalKind === "human" ||
            identity.authorizationScopes?.includes("attachments:write") === true,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new DomainError("not_found", "File not found");
      const bytes = await store.read(identity.currentUser.workspaceId, attachmentId);
      const contentSha256 = row.content_sha256.toString("hex");
      if (bytes.byteLength !== Number(row.size_bytes) || sha256Hex(bytes) !== contentSha256) {
        throw new DomainError("integrity_failure", "Stored file failed its integrity check");
      }
      return {
        attachment: mapAttachment(row),
        bytes,
        contentSha256,
      };
    } finally {
      client.release();
    }
  }

  #attachmentStore(): AttachmentStore {
    const store = this.hooks.attachmentStore;
    if (store === undefined) {
      throw new DomainError("invalid_input", "Attachments are not available yet");
    }
    return store;
  }
}
