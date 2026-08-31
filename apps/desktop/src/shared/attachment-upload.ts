import {
  ATTACHMENTS_PER_MESSAGE_MAX,
  entityIdSchema,
  uniqueAttachmentsSchema,
} from "@hype-comms/contracts";
import { z } from "zod";

const attachmentBatchSchema = uniqueAttachmentsSchema(ATTACHMENTS_PER_MESSAGE_MAX, 1);

const attachmentUploadFailureMessageSchema = z.string().trim().min(1).max(500);

export const ATTACHMENT_UPLOAD_SCOPE_CHANGED_MESSAGE =
  "Your account changed while files were being attached. Choose the files again.";

/** Raised when a native picker result outlives the account that opened it. */
export class AttachmentUploadScopeChangedError extends Error {
  constructor() {
    super(ATTACHMENT_UPLOAD_SCOPE_CHANGED_MESSAGE);
    this.name = "AttachmentUploadScopeChangedError";
  }
}

/** Abandon an in-flight upload whose account or transport was replaced while it ran. */
export function assertCurrentUploadScope(isCurrentScope: () => boolean): void {
  if (!isCurrentScope()) throw new AttachmentUploadScopeChangedError();
}

export const attachmentUploadRequestSchema = z
  .object({
    conversationId: entityIdSchema,
    maxFiles: z.number().int().min(1).max(ATTACHMENTS_PER_MESSAGE_MAX),
  })
  .strict();

/** A bounded, curated result for the native file-picker IPC boundary. */
export const attachmentUploadResultSchema = z.union([
  z.object({ status: z.literal("cancelled") }).strict(),
  z
    .object({
      status: z.literal("completed"),
      attachments: attachmentBatchSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("partial"),
      reason: z.literal("upload_failed"),
      attachments: attachmentBatchSchema,
      message: attachmentUploadFailureMessageSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.literal("selection_limit"),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.literal("upload_failed"),
      message: attachmentUploadFailureMessageSchema,
    })
    .strict(),
]);

export type AttachmentUploadRequest = z.infer<typeof attachmentUploadRequestSchema>;
export type AttachmentUploadResult = z.infer<typeof attachmentUploadResultSchema>;
