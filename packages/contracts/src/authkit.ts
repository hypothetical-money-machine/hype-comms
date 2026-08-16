import { z } from "zod";

import { credentialFreeHttpsUrlSchema, entityIdSchema } from "./common.js";

/**
 * An unpadded base64url encoding of 32 random bytes. These values are deliberately fixed-width so
 * desktop state, PKCE challenges, and handoff credentials cannot become an unbounded input surface.
 */
const base64Url32ByteValueSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected an unpadded base64url value");

export const authPkceCodeChallengeSchema = base64Url32ByteValueSchema;
export const authDesktopStateSchema = base64Url32ByteValueSchema;
export const authHandoffCodeSchema = base64Url32ByteValueSchema;

/**
 * The installed desktop identity that must receive an authentication callback. The field remains
 * optional on start requests so servers can continue accepting released production clients; an
 * absent value always means production.
 */
export const desktopAuthVariantSchema = z.enum(["production", "development"]);

/** RFC 7636 code verifier syntax and bounds. The verifier never crosses into the renderer. */
export const authPkceCodeVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an RFC 7636 code verifier");

/** WorkOS generates this opaque value and the server persists it for one callback only. */
export const authProviderStateSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an opaque OAuth state value");

export const authProviderAuthorizationCodeSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^[\x21-\x7E]+$/, "Expected a printable OAuth authorization code");

export const authProviderErrorSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an OAuth error code");

export const authProviderErrorDescriptionSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[\x20-\x7E]+$/, "Expected a printable OAuth error description");

export const authKitProviderSessionIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^session_[A-Za-z0-9]+$/, "Expected a WorkOS session ID");

/** Additive response header used by new desktop clients; older clients safely ignore it. */
export const authKitLogoutUrlHeaderName = "x-hype-comms-authkit-logout-url";

/**
 * The SDK-generated URL is deliberately pinned to WorkOS' HTTPS session-revocation endpoint and
 * its single opaque session identifier. In particular, no return URL, userinfo, fragment, API key,
 * or bearer credential is accepted from the wire.
 */
export const authKitLogoutUrlSchema = credentialFreeHttpsUrlSchema
  .max(2_048)
  .regex(
    /^https:\/\/api\.workos\.com\/user_management\/sessions\/logout\?session_id=session_[A-Za-z0-9]+$/,
    "Expected a WorkOS AuthKit logout URL",
  );

export const createDesktopAuthorizationRequestSchema = z
  .object({
    codeChallenge: authPkceCodeChallengeSchema,
    state: authDesktopStateSchema,
    variant: desktopAuthVariantSchema.optional(),
  })
  .strict();

export const createDesktopAuthorizationResponseSchema = z
  .object({
    authorizationUrl: credentialFreeHttpsUrlSchema,
  })
  .strict();

export const authKitCallbackSuccessQuerySchema = z
  .object({
    code: authProviderAuthorizationCodeSchema,
    state: authProviderStateSchema,
  })
  .strict();

export const authKitCallbackErrorQuerySchema = z
  .object({
    error: authProviderErrorSchema,
    error_description: authProviderErrorDescriptionSchema.optional(),
    state: authProviderStateSchema,
  })
  .strict();

export const authKitCallbackQuerySchema = z.union([
  authKitCallbackSuccessQuerySchema,
  authKitCallbackErrorQuerySchema,
]);

export const desktopAuthCallbackSuccessParametersSchema = z
  .object({
    code: authHandoffCodeSchema,
    state: authDesktopStateSchema,
  })
  .strict();

/** Provider details stay on the server; the desktop receives one generic terminal error. */
export const desktopAuthCallbackErrorParametersSchema = z
  .object({
    error: z.literal("authentication_failed"),
    state: authDesktopStateSchema,
  })
  .strict();

export const desktopAuthCallbackParametersSchema = z.union([
  desktopAuthCallbackSuccessParametersSchema,
  desktopAuthCallbackErrorParametersSchema,
]);

export const authDevicePlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const authAppVersionSchema = z.string().trim().min(1).max(64);

/** The handoff code is useful only with the verifier corresponding to the desktop challenge. */
export const exchangeAuthHandoffRequestSchema = z
  .object({
    code: authHandoffCodeSchema,
    codeVerifier: authPkceCodeVerifierSchema,
    installationId: entityIdSchema,
    platform: authDevicePlatformSchema,
    appVersion: authAppVersionSchema,
  })
  .strict();

/** Public discovery is non-secret and lets old and new sign-in methods coexist during rollout. */
export const authCapabilitiesSchema = z
  .object({
    authKit: z.boolean(),
    magicLink: z.boolean(),
  })
  .strict();

export type AuthPkceCodeChallenge = z.infer<typeof authPkceCodeChallengeSchema>;
export type AuthPkceCodeVerifier = z.infer<typeof authPkceCodeVerifierSchema>;
export type AuthDesktopState = z.infer<typeof authDesktopStateSchema>;
export type DesktopAuthVariant = z.infer<typeof desktopAuthVariantSchema>;
export type AuthProviderState = z.infer<typeof authProviderStateSchema>;
export type AuthProviderAuthorizationCode = z.infer<typeof authProviderAuthorizationCodeSchema>;
export type AuthProviderError = z.infer<typeof authProviderErrorSchema>;
export type AuthProviderErrorDescription = z.infer<typeof authProviderErrorDescriptionSchema>;
export type AuthKitProviderSessionId = z.infer<typeof authKitProviderSessionIdSchema>;
export type AuthKitLogoutUrl = z.infer<typeof authKitLogoutUrlSchema>;
export type AuthHandoffCode = z.infer<typeof authHandoffCodeSchema>;
export type AuthDevicePlatform = z.infer<typeof authDevicePlatformSchema>;
export type AuthAppVersion = z.infer<typeof authAppVersionSchema>;
export type CreateDesktopAuthorizationRequest = z.infer<
  typeof createDesktopAuthorizationRequestSchema
>;
export type CreateDesktopAuthorizationResponse = z.infer<
  typeof createDesktopAuthorizationResponseSchema
>;
export type AuthKitCallbackSuccessQuery = z.infer<typeof authKitCallbackSuccessQuerySchema>;
export type AuthKitCallbackErrorQuery = z.infer<typeof authKitCallbackErrorQuerySchema>;
export type AuthKitCallbackQuery = z.infer<typeof authKitCallbackQuerySchema>;
export type DesktopAuthCallbackSuccessParameters = z.infer<
  typeof desktopAuthCallbackSuccessParametersSchema
>;
export type DesktopAuthCallbackErrorParameters = z.infer<
  typeof desktopAuthCallbackErrorParametersSchema
>;
export type DesktopAuthCallbackParameters = z.infer<typeof desktopAuthCallbackParametersSchema>;
export type ExchangeAuthHandoffRequest = z.infer<typeof exchangeAuthHandoffRequestSchema>;
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;
