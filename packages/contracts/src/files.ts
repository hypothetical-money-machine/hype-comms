import { z } from "zod";

import { entityIdSchema, isoDateTimeSchema } from "./common.js";
import { attachmentSchema } from "./entities.js";

const filesPaginationCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ATTACHMENTS_CAPABILITY = "attachments-v1";
export const ATTACHMENT_CONTENT_SHA256_HEADER = "x-content-sha256";
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE_MAX = 10;
export const CONVERSATION_FILES_DEFAULT_LIMIT = 50;
export const CONVERSATION_FILES_MAX_LIMIT = 100;

export const contentSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest");

export const attachmentFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes("\0") && !/[\p{Cc}\p{Cf}]/u.test(name), "Invalid file name")
  .refine((name) => !/[\\/]/.test(name), "File name cannot contain a path");

export const attachmentContentTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;\s*[A-Za-z0-9-]+=[A-Za-z0-9!#$&^_.+-]+)*$/,
    "Expected a MIME type",
  );

export const createFileUploadRequestSchema = z
  .object({
    conversationId: entityIdSchema,
    fileName: attachmentFileNameSchema,
    contentType: attachmentContentTypeSchema,
    sizeBytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
    contentSha256: contentSha256Schema,
  })
  .strict();

export const createFileUploadResponseSchema = z
  .object({
    attachment: attachmentSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export const completeFileUploadRequestSchema = z
  .object({
    sizeBytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
    contentSha256: contentSha256Schema,
  })
  .strict();

export const completeFileUploadResponseSchema = z
  .object({
    attachment: attachmentSchema,
  })
  .strict();

export const conversationFilesQuerySchema = z
  .object({
    before: filesPaginationCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONVERSATION_FILES_MAX_LIMIT)
      .default(CONVERSATION_FILES_DEFAULT_LIMIT),
  })
  .strict();

export const conversationFilesResponseSchema = z
  .object({
    files: z.array(attachmentSchema).max(CONVERSATION_FILES_MAX_LIMIT),
    nextCursor: filesPaginationCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const listMessageAttachmentsRequestSchema = z
  .object({
    messageIds: z
      .array(entityIdSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Message IDs must be unique"),
  })
  .strict();

/** An attachment list bounded by `min`/`max`, rejecting a repeated attachment ID. */
export function uniqueAttachmentsSchema(max: number, min = 0) {
  return z
    .array(attachmentSchema)
    .min(min)
    .max(max)
    .refine(
      (attachments) =>
        new Set(attachments.map((attachment) => attachment.id)).size === attachments.length,
      "Attachment IDs must be unique",
    );
}

export const listMessageAttachmentsResponseSchema = z
  .object({
    attachments: uniqueAttachmentsSchema(100 * ATTACHMENTS_PER_MESSAGE_MAX),
  })
  .strict();

export const openAttachmentRequestSchema = z
  .object({
    attachmentId: entityIdSchema,
  })
  .strict();

export const openAttachmentResponseSchema = z
  .object({
    opened: z.boolean(),
  })
  .strict();

export type CreateFileUploadRequest = z.infer<typeof createFileUploadRequestSchema>;
export type CreateFileUploadResponse = z.infer<typeof createFileUploadResponseSchema>;
export type CompleteFileUploadRequest = z.infer<typeof completeFileUploadRequestSchema>;
export type CompleteFileUploadResponse = z.infer<typeof completeFileUploadResponseSchema>;
export type ConversationFilesQuery = z.infer<typeof conversationFilesQuerySchema>;
export type ConversationFilesResponse = z.infer<typeof conversationFilesResponseSchema>;
export type ListMessageAttachmentsRequest = z.infer<typeof listMessageAttachmentsRequestSchema>;
export type ListMessageAttachmentsResponse = z.infer<typeof listMessageAttachmentsResponseSchema>;
export type OpenAttachmentRequest = z.infer<typeof openAttachmentRequestSchema>;
export type OpenAttachmentResponse = z.infer<typeof openAttachmentResponseSchema>;
