import {
  conversationSchema,
  messageSchema,
  readCursorSchema,
  type Conversation,
  type Message,
} from "@hype-comms/contracts";
import type { QueryResultRow } from "pg";

export interface ConversationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  kind: "channel" | "direct_message" | "group_direct_message";
  name: string | null;
  slug: string | null;
  topic: string | null;
  channel_access: "workspace" | "members" | null;
  human_only: boolean;
  channel_mode: "chat" | "announcement" | null;
  is_system: boolean;
  is_archived: boolean;
  created_by: string | null;
  dm_user_low_id: string | null;
  dm_user_high_id: string | null;
  last_task_number: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface MessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  conversation_sequence: string;
  committed_workspace_sequence: string;
  version: number;
  client_message_id: string;
  request_fingerprint: Buffer;
  author_id: string;
  thread_root_id: string | null;
  body: string;
  body_format: "hype_comms_markdown_v1";
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ReadCursorRow extends QueryResultRow {
  conversation_id: string;
  user_id: string;
  last_read_message_id: string | null;
  last_read_conversation_sequence: string;
  last_read_at: Date | string | null;
  updated_at: Date | string;
}

export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

export function mapConversation(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    topic: row.topic,
    access: row.human_only ? "humans" : row.channel_access,
    channelMode: row.kind === "channel" ? (row.channel_mode ?? "chat") : null,
    // Emitted only for built-in channels: the key is absent, never false, so payloads for ordinary
    // channels stay byte-identical for clients whose schema predates built-in channels.
    ...(row.is_system ? { isBuiltIn: true as const } : {}),
    isArchived: row.is_archived,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function mapMessage(row: MessageRow): Message {
  return messageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    conversationSequence: row.conversation_sequence,
    version: row.version,
    clientMessageId: row.client_message_id,
    authorId: row.author_id,
    threadRootId: row.thread_root_id,
    body: row.body,
    bodyFormat: row.body_format,
    editedAt: nullableIso(row.edited_at),
    deletedAt: nullableIso(row.deleted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function mapReadCursor(row: ReadCursorRow) {
  return readCursorSchema.parse({
    conversationId: row.conversation_id,
    userId: row.user_id,
    lastReadMessageId: row.last_read_message_id,
    lastReadConversationSequence: row.last_read_conversation_sequence,
    lastReadAt: nullableIso(row.last_read_at),
    updatedAt: iso(row.updated_at),
  });
}

export function participants(row: ConversationRow): string[] {
  if (row.dm_user_low_id === null || row.dm_user_high_id === null) return [];
  return row.dm_user_low_id === row.dm_user_high_id
    ? [row.dm_user_low_id]
    : [row.dm_user_low_id, row.dm_user_high_id];
}
