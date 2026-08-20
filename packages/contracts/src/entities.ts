import { z } from "zod";

import {
  clientMessageIdSchema,
  credentialFreeHttpsUrlSchema,
  entityIdSchema,
  entityVersionSchema,
  isoDateTimeSchema,
  sequenceSchema,
} from "./common.js";
import { channelSlugSchema } from "./channel-slug.js";

const timestampsShape = {
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const userKindSchema = z.enum(["human", "bot", "agent"]);

export const userSchema = z
  .object({
    id: entityIdSchema,
    // Defaults preserve encrypted cache records written before bot principals existed.
    kind: userKindSchema.default("human"),
    username: z.string().trim().min(1).max(80),
    displayName: z.string().trim().min(1).max(120),
    avatarUrl: credentialFreeHttpsUrlSchema.nullable(),
    ...timestampsShape,
  })
  .strict();

export const workspaceSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    createdBy: entityIdSchema,
    ...timestampsShape,
  })
  .strict();

export const workspaceRoleSchema = z.enum(["owner", "member"]);
export const membershipStatusSchema = z.enum(["invited", "active", "revoked"]);

export const workspaceMembershipSchema = z
  .object({
    workspaceId: entityIdSchema,
    userId: entityIdSchema,
    role: workspaceRoleSchema,
    status: membershipStatusSchema,
    ...timestampsShape,
  })
  .strict();

export const invitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);

export const invitationSchema = z
  .object({
    id: entityIdSchema,
    workspaceId: entityIdSchema,
    email: z.email(),
    role: workspaceRoleSchema.exclude(["owner"]),
    status: invitationStatusSchema,
    invitedBy: entityIdSchema,
    expiresAt: isoDateTimeSchema,
    acceptedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const conversationKindSchema = z.enum(["channel", "direct_message", "group_direct_message"]);
export const channelAccessSchema = z.enum(["workspace", "members"]);
export const channelModeSchema = z.enum(["chat", "announcement"]);

export const conversationSchema = z
  .object({
    id: entityIdSchema,
    workspaceId: entityIdSchema,
    kind: conversationKindSchema,
    name: z.string().trim().min(1).max(100).nullable(),
    slug: channelSlugSchema.nullable(),
    topic: z.string().trim().max(250).nullable(),
    // Missing on pre-membership server responses and encrypted cache records. Null has the same
    // renderer meaning as a legacy workspace-visible channel; current servers always send the
    // explicit access mode.
    access: channelAccessSchema.nullable().default(null),
    // Missing on pre-announcement server responses and encrypted cache records. New clients
    // normalize a legacy channel to chat while keeping the field null for direct conversations.
    channelMode: channelModeSchema.nullable().optional(),
    isArchived: z.boolean(),
    createdBy: entityIdSchema.nullable(),
    ...timestampsShape,
  })
  .strict()
  .superRefine((conversation, context) => {
    if (conversation.kind === "channel" && conversation.channelMode === null) {
      context.addIssue({
        code: "custom",
        path: ["channelMode"],
        message: "Channel mode cannot be null for a channel",
      });
    }
    if (
      conversation.kind !== "channel" &&
      conversation.channelMode !== undefined &&
      conversation.channelMode !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["channelMode"],
        message: "Channel mode is only valid for channels",
      });
    }
  })
  .transform((conversation) => ({
    ...conversation,
    channelMode: conversation.kind === "channel" ? (conversation.channelMode ?? "chat") : null,
  }));

export const conversationMembershipRoleSchema = z.enum(["owner", "member"]);

export const conversationMembershipSchema = z
  .object({
    conversationId: entityIdSchema,
    userId: entityIdSchema,
    role: conversationMembershipRoleSchema,
    joinedAt: isoDateTimeSchema,
    leftAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const messageBodyFormatSchema = z.literal("hype_comms_markdown_v1");
export const messageBodySchema = z
  .string()
  .max(4_000)
  .refine((body) => body.trim().length > 0, "Message body cannot be blank")
  .refine((body) => !body.includes("\0"), "Message body cannot contain NUL bytes");

export const messageSchema = z
  .object({
    id: entityIdSchema,
    conversationId: entityIdSchema,
    conversationSequence: sequenceSchema,
    version: entityVersionSchema,
    clientMessageId: clientMessageIdSchema,
    authorId: entityIdSchema.nullable(),
    threadRootId: entityIdSchema.nullable(),
    body: messageBodySchema,
    bodyFormat: messageBodyFormatSchema,
    editedAt: isoDateTimeSchema.nullable(),
    // Reserved for a later delete-in-window retract. Shipped APIs never set this.
    deletedAt: isoDateTimeSchema.nullable(),
    ...timestampsShape,
  })
  .strict();

export const sendMessageRequestSchema = z
  .object({
    conversationId: entityIdSchema,
    threadRootId: entityIdSchema.nullable(),
    body: messageBodySchema,
    bodyFormat: messageBodyFormatSchema,
    clientMessageId: clientMessageIdSchema,
    mentionedUserIds: z.array(entityIdSchema).max(50),
    attachmentIds: z.array(entityIdSchema).max(10),
  })
  .strict();

const emojiGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiGraphemePattern =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)$/u;

/** A single standard Unicode emoji. Custom shortcode reactions are deliberately unsupported. */
export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(64)
  .transform((emoji) => emoji.normalize("NFC"))
  .refine(
    (emoji) =>
      [...emojiGraphemeSegmenter.segment(emoji)].length === 1 && emojiGraphemePattern.test(emoji),
    "Expected one Unicode emoji",
  );

export const reactionSchema = z
  .object({
    id: entityIdSchema,
    messageId: entityIdSchema,
    userId: entityIdSchema,
    emoji: reactionEmojiSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const readCursorSchema = z
  .object({
    conversationId: entityIdSchema,
    userId: entityIdSchema,
    lastReadMessageId: entityIdSchema.nullable(),
    lastReadConversationSequence: sequenceSchema,
    lastReadAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const attachmentStatusSchema = z.enum(["pending", "ready", "failed"]);

export const attachmentSchema = z
  .object({
    id: entityIdSchema,
    messageId: entityIdSchema.nullable(),
    uploadedBy: entityIdSchema,
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    status: attachmentStatusSchema,
    downloadUrl: credentialFreeHttpsUrlSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type User = z.infer<typeof userSchema>;
export type UserKind = z.infer<typeof userKindSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type ConversationKind = z.infer<typeof conversationKindSchema>;
export type ChannelAccess = z.infer<typeof channelAccessSchema>;
export type ChannelMode = z.infer<typeof channelModeSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationMembershipRole = z.infer<typeof conversationMembershipRoleSchema>;
export type ConversationMembership = z.infer<typeof conversationMembershipSchema>;
export type MessageBodyFormat = z.infer<typeof messageBodyFormatSchema>;
export type Message = z.infer<typeof messageSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type ReactionEmoji = z.infer<typeof reactionEmojiSchema>;
export type Reaction = z.infer<typeof reactionSchema>;
export type ReadCursor = z.infer<typeof readCursorSchema>;
export type AttachmentStatus = z.infer<typeof attachmentStatusSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
