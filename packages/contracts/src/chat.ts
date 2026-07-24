import { z } from "zod";

import {
  clientMessageIdSchema,
  displayNameSchema,
  entityIdSchema,
  isoDateTimeSchema,
} from "./common.js";
import { messageBodySchema } from "./entities.js";

export const chatSignInRequestSchema = z
  .object({
    name: displayNameSchema,
    accessCode: z.string().min(1).max(256),
  })
  .strict();

export const chatIdentitySchema = z
  .object({
    name: displayNameSchema,
  })
  .strict();

/**
 * Session state as reported to the renderer over IPC. The access code and the session cookie stay
 * in the main process; the renderer only ever learns whether a session exists and under what name.
 */
export const chatSessionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-out") }).strict(),
  z.object({ status: z.literal("signed-in"), name: displayNameSchema }).strict(),
]);

export const createChatMessageRequestSchema = z
  .object({
    clientMessageId: clientMessageIdSchema,
    body: messageBodySchema,
  })
  .strict();

export const chatMessageSchema = z
  .object({
    id: entityIdSchema,
    clientMessageId: clientMessageIdSchema,
    authorName: displayNameSchema,
    body: messageBodySchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const chatHistorySchema = z
  .object({
    messages: z.array(chatMessageSchema).max(200),
  })
  .strict();

export const chatMessageEventSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("chat.welcome_message_created"),
    message: chatMessageSchema,
  })
  .strict();

export type ChatIdentity = z.infer<typeof chatIdentitySchema>;
export type ChatSignInRequest = z.infer<typeof chatSignInRequestSchema>;
export type ChatSessionState = z.infer<typeof chatSessionStateSchema>;
export type CreateChatMessageRequest = z.infer<typeof createChatMessageRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatHistory = z.infer<typeof chatHistorySchema>;
export type ChatMessageEvent = z.infer<typeof chatMessageEventSchema>;
