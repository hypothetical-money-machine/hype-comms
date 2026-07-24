import { z } from "zod";

import {
  clientMessageIdSchema,
  displayNameSchema,
  entityIdSchema,
  isoDateTimeSchema,
} from "./common.js";
import { messageBodySchema } from "./entities.js";

export const dogfoodSessionRequestSchema = z
  .object({
    name: displayNameSchema,
    accessCode: z.string().min(1).max(256),
  })
  .strict();

export const dogfoodSessionSchema = z
  .object({
    name: displayNameSchema,
  })
  .strict();

/**
 * Session state as reported to the renderer over IPC. The access code and the session cookie stay
 * in the main process; the renderer only ever learns whether a session exists and under what name.
 */
export const dogfoodSessionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-out") }).strict(),
  z.object({ status: z.literal("signed-in"), name: displayNameSchema }).strict(),
]);

export const createDogfoodMessageRequestSchema = z
  .object({
    clientMessageId: clientMessageIdSchema,
    body: messageBodySchema,
  })
  .strict();

export const dogfoodMessageSchema = z
  .object({
    id: entityIdSchema,
    clientMessageId: clientMessageIdSchema,
    authorName: displayNameSchema,
    body: messageBodySchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const dogfoodHistorySchema = z
  .object({
    messages: z.array(dogfoodMessageSchema).max(200),
  })
  .strict();

export const dogfoodMessageEventSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("dogfood.welcome_message_created"),
    message: dogfoodMessageSchema,
  })
  .strict();

export type DogfoodSession = z.infer<typeof dogfoodSessionSchema>;
export type DogfoodSessionRequest = z.infer<typeof dogfoodSessionRequestSchema>;
export type DogfoodSessionState = z.infer<typeof dogfoodSessionStateSchema>;
export type CreateDogfoodMessageRequest = z.infer<typeof createDogfoodMessageRequestSchema>;
export type DogfoodMessage = z.infer<typeof dogfoodMessageSchema>;
export type DogfoodHistory = z.infer<typeof dogfoodHistorySchema>;
export type DogfoodMessageEvent = z.infer<typeof dogfoodMessageEventSchema>;
