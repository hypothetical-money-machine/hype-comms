import { z } from "zod";

import { clientMessageIdSchema, entityIdSchema, isoDateTimeSchema } from "./common.js";
import { messageBodySchema } from "./entities.js";

export const developmentIdentityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((name) => !/[\p{Cc}\p{Cf}]/u.test(name), "Name cannot contain control characters");

export const developmentIdentitySchema = z
  .object({
    name: developmentIdentityNameSchema,
  })
  .strict();

export const developmentWelcomeMessageSchema = z
  .object({
    id: entityIdSchema,
    clientMessageId: clientMessageIdSchema,
    authorName: developmentIdentityNameSchema,
    body: messageBodySchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const createDevelopmentWelcomeMessageRequestSchema = z
  .object({
    clientMessageId: clientMessageIdSchema,
    authorName: developmentIdentityNameSchema,
    body: messageBodySchema,
  })
  .strict();

export const developmentWelcomeHistorySchema = z
  .object({
    messages: z.array(developmentWelcomeMessageSchema).max(200),
  })
  .strict();

export const developmentWelcomeMessageEventSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("development.welcome_message_created"),
    message: developmentWelcomeMessageSchema,
  })
  .strict();

export type DevelopmentIdentity = z.infer<typeof developmentIdentitySchema>;
export type DevelopmentWelcomeMessage = z.infer<typeof developmentWelcomeMessageSchema>;
export type CreateDevelopmentWelcomeMessageRequest = z.infer<
  typeof createDevelopmentWelcomeMessageRequestSchema
>;
export type DevelopmentWelcomeHistory = z.infer<typeof developmentWelcomeHistorySchema>;
export type DevelopmentWelcomeMessageEvent = z.infer<typeof developmentWelcomeMessageEventSchema>;
