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
  channelModeSchema,
  conversationMembershipRoleSchema,
  conversationSchema,
  messageSchema,
  reactionEmojiSchema,
  reactionSchema,
  readCursorSchema,
  sendMessageRequestSchema,
  userSchema,
  workspaceSchema,
} from "./entities.js";
import { currentPrincipalSchema, currentUserSchema } from "./identity.js";
import {
  realtimeEventEnvelopeSchema,
  realtimeTicketSchema,
  systemConnectedEventSchema,
} from "./realtime.js";
import { taskCreatedEventSchema, taskUpdatedEventSchema } from "./tasks.js";

export const paginationCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const REACTION_EVENTS_CAPABILITY = "reaction-events-v1";
export const READ_STATE_EVENTS_CAPABILITY = "read-state-events-v1";
export const TASK_EVENTS_CAPABILITY = "task-events-v1";
export const THREADS_CAPABILITY = "threads-v1";
export const ANNOUNCEMENT_CHANNELS_CAPABILITY = "announcement-channels-v1";
const clientCapabilitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export const clientCapabilitiesHeaderSchema = z
  .string()
  .max(512)
  .transform((value) => value.split(",").map((capability) => capability.trim()))
  .pipe(z.array(clientCapabilitySchema).max(32));

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
    currentUser: currentPrincipalSchema,
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
        // Defaults keep bootstrap responses and encrypted caches from older servers readable.
        announcementChannels: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();

/**
 * `/v1/bootstrap` for a human session. Clients that can only ever be signed-in people -- the
 * desktop app -- validate against this instead of the principal union, so an agent-shaped or
 * email-less principal is rejected at their boundary rather than parsed and carried inward.
 */
export const humanWorkspaceBootstrapResponseSchema = workspaceBootstrapResponseSchema.extend({
  currentUser: currentUserSchema,
});

/**
 * The desktop cache's aggregate view: bootstrap plus every conversation page the client has
 * already fetched. It is deliberately not a wire response, so its conversation bound is the
 * local cache limit rather than one server page. The desktop is always a human session, so the
 * principal here is deliberately narrower than the shared bootstrap response.
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
    // Discussion channels omit this on the wire so a new desktop can still talk to an older,
    // strict server. The server treats omission as chat.
    channelMode: channelModeSchema.optional(),
  })
  .strict();

export const createChannelOperationSchema = createChannelRequestSchema
  .extend({ idempotencyKey: idempotencyKeySchema })
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

export const MESSAGE_HISTORY_MAX_LIMIT = 100;
export const REACTIONS_PER_MEMBER_PER_MESSAGE_MAX = 20;
export const REACTIONS_PER_MESSAGE_MAX = 250;

export const messageHistoryQuerySchema = z
  .object({
    before: paginationCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MESSAGE_HISTORY_MAX_LIMIT).default(50),
  })
  .strict();

export const messageThreadRequestSchema = messageHistoryQuerySchema
  .extend({ messageId: entityIdSchema })
  .strict();

export const messageThreadSummarySchema = z
  .object({
    threadRootId: entityIdSchema,
    replyCount: z.number().int().positive(),
    latestReply: messageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.latestReply.threadRootId !== value.threadRootId) {
      context.addIssue({
        code: "custom",
        path: ["latestReply", "threadRootId"],
        message: "Latest reply must belong to the summarized thread",
      });
    }
  });

export const messageHistoryResponseSchema = z
  .object({
    messages: z.array(messageSchema).max(MESSAGE_HISTORY_MAX_LIMIT),
    threadSummaries: z.array(messageThreadSummarySchema).max(MESSAGE_HISTORY_MAX_LIMIT).default([]),
    threadsSupported: z.boolean().default(false),
    nextCursor: paginationCursorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const roots = new Map(value.messages.map((message) => [message.id, message]));
    const summarizedRoots = new Set<string>();
    for (const [index, summary] of value.threadSummaries.entries()) {
      const root = roots.get(summary.threadRootId);
      if (root === undefined) {
        context.addIssue({
          code: "custom",
          path: ["threadSummaries", index, "threadRootId"],
          message: "Thread summary must belong to a message in this history page",
        });
      } else if (root.threadRootId !== null) {
        context.addIssue({
          code: "custom",
          path: ["threadSummaries", index, "threadRootId"],
          message: "Thread summary must belong to a top-level message",
        });
      } else if (summary.latestReply.conversationId !== root.conversationId) {
        context.addIssue({
          code: "custom",
          path: ["threadSummaries", index, "latestReply", "conversationId"],
          message: "Latest reply must belong to the root conversation",
        });
      }
      if (summarizedRoots.has(summary.threadRootId)) {
        context.addIssue({
          code: "custom",
          path: ["threadSummaries", index, "threadRootId"],
          message: "Thread roots must be summarized at most once",
        });
      }
      summarizedRoots.add(summary.threadRootId);
    }
  });

export const messageThreadResponseSchema = z
  .object({
    root: messageSchema,
    replies: z.array(messageSchema).max(MESSAGE_HISTORY_MAX_LIMIT),
    nextCursor: paginationCursorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.root.threadRootId !== null) {
      context.addIssue({
        code: "custom",
        path: ["root", "threadRootId"],
        message: "Thread root must be a top-level message",
      });
    }
    for (const [index, reply] of value.replies.entries()) {
      if (reply.threadRootId !== value.root.id) {
        context.addIssue({
          code: "custom",
          path: ["replies", index, "threadRootId"],
          message: "Reply must belong to the requested thread",
        });
      }
      if (reply.conversationId !== value.root.conversationId) {
        context.addIssue({
          code: "custom",
          path: ["replies", index, "conversationId"],
          message: "Reply must belong to the root conversation",
        });
      }
    }
  });

/** One exact, currently authorized message used for body-free notification action hydration. */
export const messageByIdResponseSchema = z
  .object({
    message: messageSchema,
  })
  .strict();

export const listMessageReactionsRequestSchema = z
  .object({
    messageIds: z
      .array(entityIdSchema)
      .min(1)
      .max(MESSAGE_HISTORY_MAX_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length, "Message IDs must be unique"),
  })
  .strict();

export const listMessageReactionsResponseSchema = z
  .object({
    reactions: z
      .array(reactionSchema)
      .max(MESSAGE_HISTORY_MAX_LIMIT * REACTIONS_PER_MESSAGE_MAX)
      .refine(
        (reactions) => new Set(reactions.map((reaction) => reaction.id)).size === reactions.length,
        "Reaction IDs must be unique",
      )
      .refine(
        (reactions) =>
          new Set(
            reactions.map(
              (reaction) => `${reaction.messageId}:${reaction.userId}:${reaction.emoji}`,
            ),
          ).size === reactions.length,
        "Member reactions must be unique per message and emoji",
      ),
  })
  .strict();

export const messageReactionTargetSchema = z
  .object({
    messageId: entityIdSchema,
    emoji: reactionEmojiSchema,
  })
  .strict();

export const addReactionResponseSchema = z
  .object({
    reaction: reactionSchema,
    syncCursor: sequenceSchema,
  })
  .strict();

export const removeReactionResponseSchema = z
  .object({
    removed: z.boolean(),
    syncCursor: sequenceSchema,
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

/**
 * Announces THAT the workspace member directory changed -- not what it now is.
 *
 * This event is an invalidation signal, not a state delta. Consumers MUST re-read the
 * authoritative directory (`GET /v1/members`, or a fresh bootstrap) and REPLACE their member
 * list. They MUST NOT upsert `payload.member` into a cached list.
 *
 * The reason is structural, not stylistic: `userSchema` is `.strict()` and carries no status or
 * active flag, so the payload physically cannot express a removal. Treating it as an upsert makes
 * a disable re-assert the disabled member instead of dropping it. Widening `userSchema` (or this
 * payload) is not an option either -- it is `.strict()` at four separate boundaries that
 * already-installed clients parse: the bootstrap response, {@link workspaceSnapshotSchema},
 * this sync/realtime event payload, and the desktop client's encrypted cache record. Adding a
 * field breaks all four for every client already in the field.
 *
 * `payload.member` is therefore advisory only -- useful for logging and for the common
 * create/profile-edit case, never load-bearing. The server's member list (already filtered to
 * `status = 'active'` memberships) is the single source of truth.
 */
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

export const conversationUpdatedEventSchema = workspaceEventBaseSchema
  .extend({
    type: z.enum(["channel.created", "channel.archived", "direct_conversation.created"]),
    conversationId: entityIdSchema,
    conversationSequence: z.null(),
    payload: z
      .object({
        conversation: conversationSchema,
        participantIds: z.array(entityIdSchema).max(25),
      })
      .strict(),
  })
  .superRefine((event, context) => {
    const conversation = event.payload.conversation;
    if (conversation.id !== event.conversationId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "id"],
        message: "Conversation ID must match the event conversation",
      });
    }
    if (conversation.workspaceId !== event.workspaceId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "workspaceId"],
        message: "Conversation workspace must match the event workspace",
      });
    }
    if (event.type === "channel.created" && conversation.kind !== "channel") {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "kind"],
        message: "A created channel event must contain a channel",
      });
    }
    if (event.type === "channel.created" && conversation.isArchived) {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "isArchived"],
        message: "A created channel cannot already be archived",
      });
    }
    if (event.type === "channel.archived" && conversation.kind !== "channel") {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "kind"],
        message: "An archived channel event must contain a channel",
      });
    }
    if (event.type === "channel.archived" && !conversation.isArchived) {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "isArchived"],
        message: "An archived channel event must contain an archived conversation",
      });
    }
    if (
      event.type === "direct_conversation.created" &&
      conversation.kind !== "direct_message" &&
      conversation.kind !== "group_direct_message"
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "kind"],
        message: "A direct-conversation event must contain a direct conversation",
      });
    }
    if (event.type === "direct_conversation.created" && conversation.isArchived) {
      context.addIssue({
        code: "custom",
        path: ["payload", "conversation", "isArchived"],
        message: "A created direct conversation cannot already be archived",
      });
    }
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

export const messageCreatedEventSchema = workspaceEventBaseSchema
  .extend({
    type: z.literal("message.created"),
    conversationId: entityIdSchema,
    conversationSequence: sequenceSchema,
    payload: z
      .object({
        message: messageSchema,
        mentionedUserIds: z.array(entityIdSchema).max(50),
      })
      .strict(),
  })
  .superRefine((event, context) => {
    if (event.payload.message.conversationId !== event.conversationId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "message", "conversationId"],
        message: "Message conversation must match the event conversation",
      });
    }
    if (event.payload.message.conversationSequence !== event.conversationSequence) {
      context.addIssue({
        code: "custom",
        path: ["payload", "message", "conversationSequence"],
        message: "Message sequence must match the event conversation sequence",
      });
    }
    if (event.payload.message.version !== event.entityVersion) {
      context.addIssue({
        code: "custom",
        path: ["payload", "message", "version"],
        message: "Message version must match the event entity version",
      });
    }
  });

const reactionChangedEventBaseSchema = workspaceEventBaseSchema.extend({
  conversationId: entityIdSchema,
  conversationSequence: sequenceSchema,
  // Reaction payloads identify their target message, but intentionally do not duplicate that
  // message's conversation identity. Requiring the non-null conversation envelope is therefore
  // the complete consistency check available without widening the rolling wire shape.
  payload: z
    .object({
      reaction: reactionSchema,
    })
    .strict(),
});

export const reactionAddedEventSchema = reactionChangedEventBaseSchema.extend({
  type: z.literal("reaction.added"),
});

export const reactionRemovedEventSchema = reactionChangedEventBaseSchema.extend({
  type: z.literal("reaction.removed"),
});

export const readCursorUpdatedEventSchema = workspaceEventBaseSchema
  .extend({
    type: z.literal("read_cursor.updated"),
    conversationId: entityIdSchema,
    conversationSequence: z.null(),
    payload: z
      .object({
        readCursor: readCursorSchema,
        // Optional for retained events and clients predating capability negotiation. New capable
        // clients receive both fields; the refinement prevents half-populated canonical state.
        unreadCount: z.number().int().nonnegative().optional(),
        mentionCount: z.number().int().nonnegative().optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if ((value.unreadCount === undefined) !== (value.mentionCount === undefined)) {
          context.addIssue({
            code: "custom",
            message: "Unread and mention counts must be provided together",
          });
        }
      }),
  })
  .superRefine((event, context) => {
    if (event.payload.readCursor.conversationId !== event.conversationId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "readCursor", "conversationId"],
        message: "Read cursor conversation must match the event conversation",
      });
    }
  });

export const workspaceEventSchema = z.discriminatedUnion("type", [
  memberUpdatedEventSchema,
  conversationUpdatedEventSchema,
  channelMembershipChangedEventSchema,
  messageCreatedEventSchema,
  reactionAddedEventSchema,
  reactionRemovedEventSchema,
  readCursorUpdatedEventSchema,
  taskCreatedEventSchema,
  taskUpdatedEventSchema,
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
      // `client_replay_overflow` is synthesized only across the same Electron main-to-renderer
      // boundary. Servers never emit it, so this additive local recovery reason does not expose an
      // older strict desktop to a new server-emitted value during a rolling release.
      reason: z.enum(["cursor_expired", "server_reset", "client_replay_overflow"]),
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
export type HumanWorkspaceBootstrapResponse = z.infer<typeof humanWorkspaceBootstrapResponseSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type CreateChannelOperation = z.infer<typeof createChannelOperationSchema>;
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
export type MessageThreadRequest = z.infer<typeof messageThreadRequestSchema>;
export type MessageThreadSummary = z.infer<typeof messageThreadSummarySchema>;
export type MessageHistoryResponse = z.infer<typeof messageHistoryResponseSchema>;
export type MessageThreadResponse = z.infer<typeof messageThreadResponseSchema>;
export type MessageByIdResponse = z.infer<typeof messageByIdResponseSchema>;
export type ListMessageReactionsRequest = z.infer<typeof listMessageReactionsRequestSchema>;
export type ListMessageReactionsResponse = z.infer<typeof listMessageReactionsResponseSchema>;
export type MessageReactionTarget = z.infer<typeof messageReactionTargetSchema>;
export type AddReactionResponse = z.infer<typeof addReactionResponseSchema>;
export type RemoveReactionResponse = z.infer<typeof removeReactionResponseSchema>;
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
