import { z } from "zod";

import { entityIdSchema, isoDateTimeSchema } from "./common.js";
import { userSchema } from "./entities.js";

const agentAccountSchema = userSchema.extend({ kind: z.literal("agent") });

export const agentScopeSchema = z.enum([
  "workspace:read",
  "messages:write",
  "conversations:write",
  "read-cursors:write",
  "direct-conversations:write",
  "channels:join",
  "agents:invite",
  "attachments:write",
]);
export const agentTokenScopeSchema = agentScopeSchema;

export const DEFAULT_AGENT_SCOPES = ["workspace:read", "messages:write"] as const;

/**
 * The immutable day-one capability profile assigned only by the enrollment workflow. Existing
 * owner-minted credentials keep their explicit scopes and their legacy default unchanged.
 */
export const DEFAULT_AGENT_AGENCY_PROFILE = "default-agency-v1" as const;
export const AGENT_EFFECTIVE_SCOPES_CAPABILITY = "agent-effective-scopes-v1" as const;
export const AGENT_ENROLLMENT_REVIEW_CHANNELS_CAPABILITY =
  "agent-enrollment-review-channels-v1" as const;
export const DEFAULT_AGENCY_AGENT_SCOPES = [
  "workspace:read",
  "messages:write",
  "direct-conversations:write",
  "channels:join",
  "agents:invite",
] as const satisfies readonly z.infer<typeof agentScopeSchema>[];

export const AGENT_ENROLLMENT_AUTHORIZATION_SCHEME = "Enrollment" as const;

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
  .regex(/^hype_comms_agent_[A-Za-z0-9_-]{43}$/, "Expected a Hype Comms agent token");

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
    effectiveScopes: agentScopesSchema.optional(),
  })
  .strict()
  .superRefine((principal, context) => {
    if (
      principal.effectiveScopes !== undefined &&
      principal.scopes.some((scope) => !principal.effectiveScopes?.includes(scope))
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveScopes"],
        message: "Effective agent scopes must include every stored scope",
      });
    }
  });
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
    effectiveScopes: agentScopesSchema.optional(),
    createdBy: entityIdSchema,
    createdAt: isoDateTimeSchema,
    lastUsedAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((token, context) => {
    if (
      token.effectiveScopes !== undefined &&
      token.scopes.some((scope) => !token.effectiveScopes?.includes(scope))
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveScopes"],
        message: "Effective agent scopes must include every stored scope",
      });
    }
  });
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

export const agentEnrollmentPolicyModeSchema = z.enum(["required", "automatic"]);

export const agentEnrollmentPolicySchema = z
  .object({
    workspaceId: entityIdSchema,
    mode: agentEnrollmentPolicyModeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const updateAgentEnrollmentPolicyRequestSchema = z
  .object({ mode: agentEnrollmentPolicyModeSchema })
  .strict();

export const agentEnrollmentPolicyResponseSchema = z
  .object({ policy: agentEnrollmentPolicySchema })
  .strict();

export const agentEnrollmentStatusSchema = z.enum([
  "pending_approval",
  "ready_to_redeem",
  "active",
  "rejected",
  "cancelled",
  "expired",
]);

/** Unpadded base64url SHA-256 of the complete, child-generated final agent credential. */
export const agentEnrollmentCredentialVerifierSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "Expected a canonical SHA-256 verifier");

const requestedRestrictedChannelIdsSchema = z
  .array(entityIdSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Restricted channel IDs must be unique");

export const agentEnrollmentRestrictedChannelSchema = z
  .object({
    conversationId: entityIdSchema,
    name: z.string().trim().min(1).max(100),
  })
  .strict();

export const requestAgentEnrollmentSchema = createAgentRequestSchema
  .extend({
    label: agentTokenSchema.shape.label,
    credentialVerifier: agentEnrollmentCredentialVerifierSchema,
    restrictedChannelIds: requestedRestrictedChannelIdsSchema.default([]),
  })
  .strict();

export const agentEnrollmentSchema = z
  .object({
    id: entityIdSchema,
    workspaceId: entityIdSchema,
    profile: z.literal(DEFAULT_AGENT_AGENCY_PROFILE),
    status: agentEnrollmentStatusSchema,
    username: createAgentRequestSchema.shape.username,
    displayName: createAgentRequestSchema.shape.displayName,
    label: agentTokenSchema.shape.label,
    requestedBy: entityIdSchema,
    requestedByKind: z.enum(["human", "agent"]),
    restrictedChannelIds: requestedRestrictedChannelIdsSchema,
    restrictedChannels: z.array(agentEnrollmentRestrictedChannelSchema).max(100).optional(),
    expiresAt: isoDateTimeSchema,
    reviewedBy: entityIdSchema.nullable(),
    reviewedAt: isoDateTimeSchema.nullable(),
    activatedAgentUserId: entityIdSchema.nullable(),
    activatedAgentTokenId: entityIdSchema.nullable(),
    activatedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((enrollment, context) => {
    const activationFields = [
      enrollment.activatedAgentUserId,
      enrollment.activatedAgentTokenId,
      enrollment.activatedAt,
    ];
    const hasEveryActivationField = activationFields.every((value) => value !== null);
    const hasNoActivationField = activationFields.every((value) => value === null);
    if (
      (enrollment.status === "active" && !hasEveryActivationField) ||
      (enrollment.status !== "active" && !hasNoActivationField)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only active enrollments carry complete activation metadata",
      });
    }
    if ((enrollment.reviewedBy === null) !== (enrollment.reviewedAt === null)) {
      context.addIssue({ code: "custom", message: "Review metadata must be complete" });
    }
    if (enrollment.restrictedChannels !== undefined) {
      if (enrollment.status !== "pending_approval" && enrollment.status !== "ready_to_redeem") {
        context.addIssue({
          code: "custom",
          path: ["restrictedChannels"],
          message: "Only open enrollments carry restricted channel review details",
        });
      }
      const projectedIds = enrollment.restrictedChannels.map((channel) => channel.conversationId);
      if (
        new Set(projectedIds).size !== projectedIds.length ||
        projectedIds.length !== enrollment.restrictedChannelIds.length ||
        projectedIds.some((id) => !enrollment.restrictedChannelIds.includes(id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["restrictedChannels"],
          message: "Restricted channel review details must match the requested channel IDs",
        });
      }
    }
  });

export const agentEnrollmentResponseSchema = z
  .object({ enrollment: agentEnrollmentSchema })
  .strict();

export const listAgentEnrollmentsResponseSchema = z
  .object({ enrollments: z.array(agentEnrollmentSchema).max(1_000) })
  .strict();

export const reviewAgentEnrollmentRequestSchema = z
  .object({ decision: z.enum(["approve", "reject"]) })
  .strict();

/** Cancel and redeem are intentionally bodyless mutations. */
export const agentEnrollmentNoBodyRequestSchema = z.undefined();

export const redeemAgentEnrollmentResponseSchema = z
  .object({ enrollment: agentEnrollmentSchema, agent: agentSchema })
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
export type AgentEnrollmentPolicyMode = z.infer<typeof agentEnrollmentPolicyModeSchema>;
export type AgentEnrollmentPolicy = z.infer<typeof agentEnrollmentPolicySchema>;
export type UpdateAgentEnrollmentPolicyRequest = z.infer<
  typeof updateAgentEnrollmentPolicyRequestSchema
>;
export type AgentEnrollmentPolicyResponse = z.infer<typeof agentEnrollmentPolicyResponseSchema>;
export type AgentEnrollmentStatus = z.infer<typeof agentEnrollmentStatusSchema>;
export type AgentEnrollmentCredentialVerifier = z.infer<
  typeof agentEnrollmentCredentialVerifierSchema
>;
export type RequestAgentEnrollment = z.infer<typeof requestAgentEnrollmentSchema>;
export type AgentEnrollment = z.infer<typeof agentEnrollmentSchema>;
export type AgentEnrollmentRestrictedChannel = z.infer<
  typeof agentEnrollmentRestrictedChannelSchema
>;
export type AgentEnrollmentResponse = z.infer<typeof agentEnrollmentResponseSchema>;
export type ListAgentEnrollmentsResponse = z.infer<typeof listAgentEnrollmentsResponseSchema>;
export type ReviewAgentEnrollmentRequest = z.infer<typeof reviewAgentEnrollmentRequestSchema>;
export type RedeemAgentEnrollmentResponse = z.infer<typeof redeemAgentEnrollmentResponseSchema>;
