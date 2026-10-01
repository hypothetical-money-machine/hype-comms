import { type Attachment } from "@hype-comms/contracts";
import type { PoolClient } from "pg";
import { mapAttachment, type AttachmentRow } from "./attachment-records.js";

export async function attachmentsForMessages(
  client: PoolClient,
  messageIds: readonly string[],
): Promise<Attachment[]> {
  if (messageIds.length === 0) return [];
  const result = await client.query<AttachmentRow>(
    `SELECT attachment.*
         FROM attachments AS attachment
         JOIN messages AS message ON message.id = attachment.message_id
        WHERE attachment.message_id = ANY($1::uuid[])
          AND attachment.status = 'ready'
          AND message.deleted_at IS NULL
        ORDER BY attachment.created_at, attachment.id`,
    [messageIds],
  );
  return result.rows.map(mapAttachment);
}
