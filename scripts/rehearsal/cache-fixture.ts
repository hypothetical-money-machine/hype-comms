import type { CacheScope, SendMessageOperation } from "@hype-comms/contracts";

export const scope: CacheScope = {
  userId: "31000000-0000-4000-8000-000000000001",
  workspaceId: "31000000-0000-4000-8000-000000000002",
};
export const operation: SendMessageOperation = {
  conversationId: "31000000-0000-4000-8000-000000000003",
  idempotencyKey: "31000000-0000-4000-8000-000000000004",
  message: {
    clientMessageId: "31000000-0000-4000-8000-000000000004",
    body: "Preserved across native restart 😀 🦊",
    bodyFormat: "hype_comms_markdown_v1",
    threadRootId: null,
    mentionedUserIds: [],
    attachmentIds: [],
  },
};

// Frozen schema of the last cache before the coordinated protocol upgrade.
export const legacyStores = {
  metadata: "&id",
  workspaces: "&id",
  members: "&id,updatedAt",
  conversations: "&id,kind,updatedAt",
  messages: "&id,&clientMessageId,conversationId,createdAt,conversationSequence",
  reactions: "&id,messageId,conversationId,userId,createdAt",
  tasks: "&id,conversationId,assigneeId,status,rank,updatedAt",
  outbox: "&clientMessageId,conversationId,createdAt,status,nextAttemptAt",
  events: "&id,workspaceSequence",
};
