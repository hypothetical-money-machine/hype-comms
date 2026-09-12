import { attachmentSchema, type Attachment, type Conversation } from "@hype-comms/contracts";
import type { QueryResultRow } from "pg";
import { iso } from "./records.js";

export interface AttachmentRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string | null;
  uploaded_by: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  content_sha256: Buffer;
  status: "pending" | "ready" | "failed";
  upload_expires_at: Date | string | null;
  content_received_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface UploadAttachmentRow extends AttachmentRow {
  upload_expired: boolean;
}

export interface ReadableAttachmentRow extends AttachmentRow {
  conversation_kind: Conversation["kind"];
}

export interface ExpiredAttachmentRow extends QueryResultRow {
  id: string;
  workspace_id: string;
}

export function mapAttachment(row: AttachmentRow): Attachment {
  return attachmentSchema.parse({
    id: row.id,
    messageId: row.message_id,
    uploadedBy: row.uploaded_by,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    downloadUrl: null,
    createdAt: iso(row.created_at),
  });
}
