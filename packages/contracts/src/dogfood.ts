import { z } from "zod";

import { clientMessageIdSchema, entityIdSchema, isoDateTimeSchema } from "./common.js";
import { developmentIdentityNameSchema } from "./development.js";
import { messageBodySchema } from "./entities.js";

export const dogfoodSessionRequestSchema = z
  .object({
    name: developmentIdentityNameSchema,
    accessCode: z.string().min(1).max(256),
  })
  .strict();

export const dogfoodSessionSchema = z
  .object({
    name: developmentIdentityNameSchema,
  })
  .strict();

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
    authorName: developmentIdentityNameSchema,
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
export type CreateDogfoodMessageRequest = z.infer<typeof createDogfoodMessageRequestSchema>;
export type DogfoodMessage = z.infer<typeof dogfoodMessageSchema>;
export type DogfoodHistory = z.infer<typeof dogfoodHistorySchema>;
export type DogfoodMessageEvent = z.infer<typeof dogfoodMessageEventSchema>;
