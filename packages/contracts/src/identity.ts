import { z } from "zod";

import { entityIdSchema, isoDateTimeSchema } from "./common.js";
import { invitationSchema, userSchema, workspaceRoleSchema } from "./entities.js";
import { agentCurrentPrincipalSchema } from "./agents.js";

const humanUserSchema = userSchema.extend({ kind: z.literal("human").default("human") });

/**
 * Email addresses are stored and compared in a single normalized form so that an invitation and a
 * later sign-in for the same person always match. Normalization is lowercasing only: the local
 * part of an address is case-sensitive per RFC 5321, but every provider we target treats
 * it case-insensitively, and matching invitations reliably matters more here.
 */
export const emailSchema = z
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());

/**
 * Opaque single-use credential delivered by email. Only its hash is ever stored, so a database
 * disclosure cannot be replayed into a session.
 */
export const magicLinkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,86}$/, "Expected a base64url magic-link token");

export const sessionTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,86}$/, "Expected a base64url session token");

export const requestMagicLinkSchema = z.object({ email: emailSchema }).strict();

export const verifyMagicLinkSchema = z.object({ token: magicLinkTokenSchema }).strict();

/**
 * A signed-in device. Sessions rotate on refresh, so `id` identifies the device lineage while the
 * token itself changes; revoking the lineage signs that device out everywhere it is stored.
 */
export const deviceSessionSchema = z
  .object({
    id: entityIdSchema,
    userId: entityIdSchema,
    createdAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    revokedAt: isoDateTimeSchema.nullable(),
    /** Free-form client description. Never trusted for authorization. */
    label: z.string().trim().max(200).nullable(),
  })
  .strict();

/**
 * The signed-in person's own view of themselves. This is the only place an email address crosses
 * the wire: `userSchema` is the shape other members see, and it deliberately has no email.
 */
export const currentUserSchema = z
  .object({
    user: humanUserSchema,
    email: emailSchema,
    workspaceId: entityIdSchema,
    role: workspaceRoleSchema,
  })
  .strict();

/** Existing human responses remain unchanged; authenticated agents use the distinct agent arm. */
export const currentPrincipalSchema = z.union([currentUserSchema, agentCurrentPrincipalSchema]);

export const createInvitationSchema = z
  .object({
    email: emailSchema,
    role: workspaceRoleSchema.exclude(["owner"]),
  })
  .strict();

export const listInvitationsResponseSchema = z
  .object({
    invitations: z.array(invitationSchema).max(1_000),
  })
  .strict();

/**
 * Sign-in never reveals whether an address is invited, registered, or unknown: every request that
 * is well formed gets the same answer.
 */
export const magicLinkRequestedSchema = z.object({ status: z.literal("accepted") }).strict();

export type Email = z.infer<typeof emailSchema>;
export type MagicLinkToken = z.infer<typeof magicLinkTokenSchema>;
export type SessionToken = z.infer<typeof sessionTokenSchema>;
export type RequestMagicLink = z.infer<typeof requestMagicLinkSchema>;
export type VerifyMagicLink = z.infer<typeof verifyMagicLinkSchema>;
export type DeviceSession = z.infer<typeof deviceSessionSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type CurrentPrincipal = z.infer<typeof currentPrincipalSchema>;
export type CreateInvitation = z.infer<typeof createInvitationSchema>;
export type ListInvitationsResponse = z.infer<typeof listInvitationsResponseSchema>;
export type MagicLinkRequested = z.infer<typeof magicLinkRequestedSchema>;
