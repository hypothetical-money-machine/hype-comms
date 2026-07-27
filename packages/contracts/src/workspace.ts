import { z } from "zod";

import {
  entityIdSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  sequenceSchema,
} from "./common.js";
import { channelSlugSchema } from "./channel-slug.js";
import {
  channelAccessSchema,
  conversationMembershipRoleSchema,
  conversationSchema,
  messageSchema,
  readCursorSchema,
  sendMessageRequestSchema,
  userSchema,
  workspaceSchema,
} from "./entities.js";
import { currentUserSchema } from "./identity.js";
import {
  realtimeEventEnvelopeSchema,
  realtimeTicketSchema,
  systemConnectedEventSchema,
} from "./realtime.js";

export const paginationCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Conversation listing is cursor-paginated so a workspace can never outgrow the wire contract.
 * Array caps below use the maximum page size, so a validated response is always representable.
 */
export const CONVERSATION_PAGE_DEFAULT_LIMIT = 50;
export const CONVERSATION_PAGE_MAX_LIMIT = 100;

export const conversationSummarySchema = z
  .object({
    conversation: conversationSchema,
    participantIds: z.array(entityIdSchema).max(25),
    // Added with channel membership management. Defaulting only this absent field keeps existing
    // encrypted cache records readable during the client upgrade.
    membershipRole: conversationMembershipRoleSchema.nullable().default(null),
    lastMessage: messageSchema.nullable(),
    unreadCount: z.number().int().nonnegative(),
    mentionCount: z.number().int().nonnegative(),
    readCursor: readCursorSchema.nullable(),
  })
  .strict();

export const workspaceBootstrapResponseSchema = z
  .object({
    currentUser: currentUserSchema,
    workspace: workspaceSchema,
    members: z.array(userSchema).max(25),
    conversations: z.array(conversationSummarySchema).max(CONVERSATION_PAGE_MAX_LIMIT),
    conversationsNextCursor: paginationCursorSchema.nullable(),
    conversationsHasMore: z.boolean(),
    syncCursor: sequenceSchema,
    featureFlags: z
      .object({
        channels: z.literal(true),
        directMessages: z.literal(true),
        mentions: z.literal(true),
      })
      .strict(),
  })
  .strict();

/**
 * The desktop cache's aggregate view: bootstrap plus every conversation page the client has
 * already fetched. It is deliberately not a wire response, so its conversation bound is the
 * local cache limit rather than one server page.
 */
export const workspaceSnapshotSchema = z
  .object({
    currentUser: currentUserSchema,
    workspace: workspaceSchema,
    members: z.array(userSchema).max(25),
    conversations: z.array(conversationSummarySchema).max(5_000),
    syncCursor: sequenceSchema,
    featureFlags: workspaceBootstrapResponseSchema.shape.featureFlags,
  })
  .strict();

export const listMembersResponseSchema = z
  .object({
    members: z.array(userSchema).max(25),
  })
  .strict();

export const listConversationsQuerySchema = z
  .object({
    after: paginationCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONVERSATION_PAGE_MAX_LIMIT)
      .default(CONVERSATION_PAGE_DEFAULT_LIMIT),
  })
  .strict();

export const listConversationsResponseSchema = z
  .object({
    conversations: z.array(conversationSummarySchema).max(CONVERSATION_PAGE_MAX_LIMIT),
    nextCursor: paginationCursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const createChannelRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: channelSlugSchema,
    topic: z.string().trim().max(250).nullable(),
    // Old clients created only workspace-visible channels and omitted this field.
    access: channelAccessSchema.default("workspace"),
  })
  .strict();

export const channelMemberSchema = z
  .object({
    user: userSchema,
    role: conversationMembershipRoleSchema,
    joinedAt: isoDateTimeSchema,
  })
  .strict();

export const channelMembersResponseSchema = z
  .object({
    conversationId: entityIdSchema,
    access: channelAccessSchema,
    members: z.array(channelMemberSchema).max(25),
    canManage: z.boolean(),
  })
  .strict();

export const upsertChannelMemberRequestSchema = z
  .object({
    role: conversationMembershipRoleSchema,
  })
  .strict();

export const channelMemberTargetSchema = z
  .object({
    conversationId: entityIdSchema,
    userId: entityIdSchema,
  })
  .strict();

export const upsertChannelMemberOperationSchema = channelMemberTargetSchema
  .extend(upsertChannelMemberRequestSchema.shape)
  .strict();

export const channelMembershipMutationResponseSchema = z
  .object({
    channelMembers: channelMembersResponseSchema,
    syncCursor: sequenceSchema,
  })
  .strict();

export const archiveChannelRequestSchema = z
  .object({
    isArchived: z.literal(true),
  })
  .strict();

export const directConversationRequestSchema = z
  .object({
    memberId: entityIdSchema,
  })
  .strict();

export const conversationMutationResponseSchema = z
  .object({
    conversation: conversationSummarySchema,
    syncCursor: sequenceSchema,
  })
  .strict();

export const messageHistoryQuerySchema = z
  .object({
    before: paginationCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const messageHistoryResponseSchema = z
  .object({
    messages: z.array(messageSchema).max(100),
    nextCursor: paginationCursorSchema.nullable(),
  })
  .strict();

export const MESSAGE_SEARCH_DEFAULT_LIMIT = 25;
export const MESSAGE_SEARCH_MAX_LIMIT = 50;

export const messageSearchQuerySchema = z
  .object({
    query: z.string().trim().min(2).max(200),
    after: paginationCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MESSAGE_SEARCH_MAX_LIMIT)
      .default(MESSAGE_SEARCH_DEFAULT_LIMIT),
  })
  .strict();

export const messageSearchResultSchema = z
  .object({
    message: messageSchema,
  })
  .strict();

export const messageSearchResponseSchema = z
  .object({
    results: z.array(messageSearchResultSchema).max(MESSAGE_SEARCH_MAX_LIMIT),
    nextCursor: paginationCursorSchema.nullable(),
  })
  .strict();

export const sendConversationMessageRequestSchema = sendMessageRequestSchema.omit({
  conversationId: true,
});

export const sendMessageOperationSchema = z
  .object({
    conversationId: entityIdSchema,
    idempotencyKey: idempotencyKeySchema,
    message: sendConversationMessageRequestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.idempotencyKey !== value.message.clientMessageId) {
      context.addIssue({
        code: "custom",
        path: ["idempotencyKey"],
        message: "Idempotency-Key must equal clientMessageId",
      });
    }
  });

export const sendMessageResponseSchema = z
  .object({
    message: messageSchema,
    syncCursor: sequenceSchema,
  })
  .strict();

export const advanceReadCursorRequestSchema = z
  .object({
    lastReadMessageId: entityIdSchema,
  })
  .strict();

export const advanceReadCursorResponseSchema = z
  .object({
    readCursor: readCursorSchema,
    syncCursor: sequenceSchema,
  })
  .strict();

const workspaceEventBaseSchema = realtimeEventEnvelopeSchema.extend({
  workspaceId: entityIdSchema,
});

export const memberUpdatedEventSchema = workspaceEventBaseSchema.extend({
  type: z.literal("member.updated"),
  conversationId: z.null(),
  conversationSequence: z.null(),
  payload: z
    .object({
      member: userSchema,
    })
    .strict(),
});

export const conversationUpdatedEventSchema = workspaceEventBaseSchema.extend({
  type: z.enum(["channel.created", "channel.archived", "direct_conversation.created"]),
  conversationId: entityIdSchema,
  conversationSequence: z.null(),
  payload: z
    .object({
      conversation: conversationSchema,
      participantIds: z.array(entityIdSchema).max(25),
    })
    .strict(),
});

export const channelMembershipChangedEventSchema = workspaceEventBaseSchema.extend({
  type: z.literal("channel.membership_changed"),
  conversationId: entityIdSchema,
  conversationSequence: z.null(),
  payload: z
    .object({
      memberId: entityIdSchema,
      action: z.enum(["added", "updated", "removed"]),
    })
    .strict(),
});

export const messageCreatedEventSchema = workspaceEventBaseSchema.extend({
  type: z.literal("message.created"),
  conversationId: entityIdSchema,
  conversationSequence: sequenceSchema,
  payload: z
    .object({
      message: messageSchema,
      mentionedUserIds: z.array(entityIdSchema).max(50),
    })
    .strict(),
});

export const readCursorUpdatedEventSchema = workspaceEventBaseSchema.extend({
  type: z.literal("read_cursor.updated"),
  conversationId: entityIdSchema,
  conversationSequence: z.null(),
  payload: z
    .object({
      readCursor: readCursorSchema,
    })
    .strict(),
});

export const workspaceEventSchema = z.discriminatedUnion("type", [
  memberUpdatedEventSchema,
  conversationUpdatedEventSchema,
  channelMembershipChangedEventSchema,
  messageCreatedEventSchema,
  readCursorUpdatedEventSchema,
]);

export const syncQuerySchema = z
  .object({
    after: sequenceSchema,
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();

export const syncResponseSchema = z
  .object({
    events: z.array(workspaceEventSchema).max(100),
    nextCursor: sequenceSchema,
    highWaterCursor: sequenceSchema,
    hasMore: z.boolean(),
  })
  .strict();

export const realtimeTicketResponseSchema = z
  .object({
    ticket: realtimeTicketSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export const systemResyncRequiredEventSchema = workspaceEventBaseSchema.extend({
  type: z.literal("system.resync_required"),
  conversationId: z.null(),
  conversationSequence: z.null(),
  payload: z
    .object({
      reason: z.enum(["cursor_expired", "server_reset"]),
    })
    .strict(),
});

export const productRealtimeEventSchema = z.union([
  workspaceEventSchema,
  systemResyncRequiredEventSchema,
  systemConnectedEventSchema,
]);

export type PaginationCursor = z.infer<typeof paginationCursorSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type WorkspaceBootstrapResponse = z.infer<typeof workspaceBootstrapResponseSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type ChannelMember = z.infer<typeof channelMemberSchema>;
export type ChannelMembersResponse = z.infer<typeof channelMembersResponseSchema>;
export type UpsertChannelMemberRequest = z.infer<typeof upsertChannelMemberRequestSchema>;
export type ChannelMemberTarget = z.infer<typeof channelMemberTargetSchema>;
export type UpsertChannelMemberOperation = z.infer<typeof upsertChannelMemberOperationSchema>;
export type ChannelMembershipMutationResponse = z.infer<
  typeof channelMembershipMutationResponseSchema
>;
export type ArchiveChannelRequest = z.infer<typeof archiveChannelRequestSchema>;
export type DirectConversationRequest = z.infer<typeof directConversationRequestSchema>;
export type ConversationMutationResponse = z.infer<typeof conversationMutationResponseSchema>;
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;
export type MessageHistoryResponse = z.infer<typeof messageHistoryResponseSchema>;
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;
export type MessageSearchResult = z.infer<typeof messageSearchResultSchema>;
export type MessageSearchResponse = z.infer<typeof messageSearchResponseSchema>;
export type SendConversationMessageRequest = z.infer<typeof sendConversationMessageRequestSchema>;
export type SendMessageOperation = z.infer<typeof sendMessageOperationSchema>;
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
export type AdvanceReadCursorRequest = z.infer<typeof advanceReadCursorRequestSchema>;
export type AdvanceReadCursorResponse = z.infer<typeof advanceReadCursorResponseSchema>;
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type SyncQuery = z.infer<typeof syncQuerySchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
export type RealtimeTicketResponse = z.infer<typeof realtimeTicketResponseSchema>;
export type ProductRealtimeEvent = z.infer<typeof productRealtimeEventSchema>;
