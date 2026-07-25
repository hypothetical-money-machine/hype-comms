import { z } from "zod";

import { entityIdSchema } from "./common.js";
import { userSchema } from "./entities.js";
import { emailSchema } from "./identity.js";

export const chatSessionStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("signed-out"),
      message: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("signed-in"),
      method: z.literal("email"),
      name: userSchema.shape.displayName,
      email: emailSchema,
      userId: userSchema.shape.id,
      workspaceId: entityIdSchema,
    })
    .strict(),
  /**
   * The stored credential could not be checked because the service was unreachable or failing.
   * The device session is deliberately preserved, so this is never a sign-out.
   */
  z
    .object({
      status: z.literal("session-unavailable"),
      reason: z.enum(["server_unreachable", "server_error"]),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

export const magicLinkDeliveryStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("email-sent") }).strict(),
  z
    .object({
      status: z.literal("administrator-delivery"),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

export type ChatSessionState = z.infer<typeof chatSessionStateSchema>;
export type MagicLinkDeliveryState = z.infer<typeof magicLinkDeliveryStateSchema>;
