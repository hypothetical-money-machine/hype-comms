import { z } from "zod";

import { clientMessageIdSchema, entityIdSchema, isoDateTimeSchema } from "./common.js";
import { messageBodySchema, userSchema } from "./entities.js";

export const INCOMING_WEBHOOK_BODY_LIMIT_BYTES = 16 * 1024;

/** Day-one webhook input is deliberately plain text with no client-selected rendering surface. */
export const incomingWebhookMessageRequestSchema = z
  .object({
    body: messageBodySchema,
  })
  .strict();

/** The Idempotency-Key becomes the canonical client message id without translation. */
export const incomingWebhookIdempotencyKeySchema = clientMessageIdSchema;

const channelWebhookBotSchema = userSchema.extend({ kind: z.literal("bot") });

export const channelWebhookSchema = z
  .object({
    channelId: entityIdSchema,
    enabled: z.boolean(),
    bot: channelWebhookBotSchema,
    expiresAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export const channelWebhookResponseSchema = z.object({ webhook: channelWebhookSchema }).strict();

const incomingWebhookUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2_048)
  .refine(
    (value) => !/^https?:\/\/[^/?#]*@/i.test(value) && !/[?#]/.test(value),
    "Expected an HTTP webhook URL without userinfo, query, or fragment",
  );

/** Secret-bearing creation/rotation response. It must never be returned by status reads. */
export const issuedChannelWebhookResponseSchema = z
  .object({
    webhook: channelWebhookSchema.extend({ enabled: z.literal(true) }),
    webhookUrl: incomingWebhookUrlSchema,
  })
  .strict();

export const manageChannelWebhookRequestSchema = z.object({}).strict();

export type IncomingWebhookMessageRequest = z.infer<typeof incomingWebhookMessageRequestSchema>;
export type ChannelWebhook = z.infer<typeof channelWebhookSchema>;
export type ChannelWebhookResponse = z.infer<typeof channelWebhookResponseSchema>;
export type IssuedChannelWebhookResponse = z.infer<typeof issuedChannelWebhookResponseSchema>;
