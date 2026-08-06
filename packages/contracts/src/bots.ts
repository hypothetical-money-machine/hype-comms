import { z } from "zod";

/** Task capabilities carried by one revocable bot credential. */
export const botScopeSchema = z.enum(["tasks:read", "tasks:write"]);

export const botScopesSchema = z
  .array(botScopeSchema)
  .min(1)
  .max(botScopeSchema.options.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Bot scopes must be unique");

/**
 * Long-lived bot credentials are recognizable without exposing any database identifier. The
 * random suffix contains 256 bits of entropy and only its SHA-256 hash is persisted.
 */
export const botAccessTokenSchema = z
  .string()
  .regex(/^hmm_bot_[A-Za-z0-9_-]{43}$/, "Expected a Hype Comms bot access token");

export type BotScope = z.infer<typeof botScopeSchema>;
export type BotAccessToken = z.infer<typeof botAccessTokenSchema>;
