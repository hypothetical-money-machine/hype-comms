import { z } from "zod";

import { entityIdSchema, isoDateTimeSchema } from "./common.js";
import { userSchema } from "./entities.js";

const agentAccountSchema = userSchema.extend({ kind: z.literal("agent") });

export const agentScopeSchema = z.enum([
  "workspace:read",
  "messages:write",
  "conversations:write",
  "read-cursors:write",
]);
export const agentTokenScopeSchema = agentScopeSchema;

export const DEFAULT_AGENT_SCOPES = ["workspace:read", "messages:write"] as const;

export const agentScopesSchema = z
  .array(agentScopeSchema)
  .min(1)
  .max(agentScopeSchema.options.length)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: "custom", message: "Agent scopes must be unique" });
    }
  });

/** A non-expiring agent credential. The prefixed plaintext is revealed only when it is created. */
export const agentTokenSecretSchema = z
  .string()
  .regex(/^hmm_agent_[A-Za-z0-9_-]{43}$/, "Expected an HMM Chat agent token");

/**
 * The authenticated agent's own identity. Human `/auth/me` responses retain `currentUserSchema`
 * exactly; this separate arm adds the immutable capabilities carried by an agent token.
 */
export const agentCurrentPrincipalSchema = z
  .object({
    type: z.literal("agent"),
    user: agentAccountSchema,
    workspaceId: entityIdSchema,
    role: z.literal("member"),
    scopes: agentScopesSchema,
  })
  .strict();
export const currentAgentPrincipalSchema = agentCurrentPrincipalSchema;

const agentRecordShape = {
  user: agentAccountSchema,
  workspaceId: entityIdSchema,
  role: z.literal("member"),
  createdBy: entityIdSchema,
  createdAt: isoDateTimeSchema,
};

export const agentSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...agentRecordShape,
      status: z.literal("active"),
      disabledAt: z.null(),
    })
    .strict(),
  z
    .object({
      ...agentRecordShape,
      status: z.literal("disabled"),
      disabledAt: isoDateTimeSchema,
    })
    .strict(),
]);
export const agentUserSchema = agentSchema;

export const createAgentRequestSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
    displayName: userSchema.shape.displayName,
  })
  .strict();

export const createAgentResponseSchema = z.object({ agent: agentSchema }).strict();

export const listAgentsResponseSchema = z
  .object({
    // Disabled agents remain visible for audit/history, so this is deliberately larger than the
    // 25 active-membership capacity.
    agents: z.array(agentSchema).max(1_000),
  })
  .strict();

export const agentTokenSchema = z
  .object({
    id: entityIdSchema,
    agentUserId: entityIdSchema,
    label: z.string().trim().min(1).max(120),
    scopes: agentScopesSchema,
    createdBy: entityIdSchema,
    createdAt: isoDateTimeSchema,
    lastUsedAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
  })
  .strict();
export const agentTokenMetadataSchema = agentTokenSchema;

export const createAgentTokenRequestSchema = z
  .object({
    label: agentTokenSchema.shape.label,
    scopes: agentScopesSchema.default([...DEFAULT_AGENT_SCOPES]),
  })
  .strict();

export const createAgentTokenResponseSchema = z
  .object({
    token: agentTokenSecretSchema,
    agentToken: agentTokenSchema,
  })
  .strict();

export const listAgentTokensResponseSchema = z
  .object({
    tokens: z.array(agentTokenSchema).max(1_000),
  })
  .strict();

export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentTokenScope = AgentScope;
export type AgentTokenSecret = z.infer<typeof agentTokenSecretSchema>;
export type AgentCurrentPrincipal = z.infer<typeof agentCurrentPrincipalSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type AgentToken = z.infer<typeof agentTokenSchema>;
export type CreateAgentTokenRequest = z.infer<typeof createAgentTokenRequestSchema>;
export type CreateAgentTokenResponse = z.infer<typeof createAgentTokenResponseSchema>;
export type ListAgentTokensResponse = z.infer<typeof listAgentTokensResponseSchema>;
