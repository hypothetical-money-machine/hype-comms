import {
  authKitLogoutUrlSchema,
  authKitProviderSessionIdSchema,
  authPkceCodeVerifierSchema,
  authProviderStateSchema,
  credentialFreeHttpsUrlSchema,
  type AuthKitLogoutUrl,
  type AuthKitProviderSessionId,
  type AuthPkceCodeVerifier,
  type AuthProviderAuthorizationCode,
  type AuthProviderState,
} from "@hmm-chat/contracts";
import {
  AuthenticationException,
  BadRequestException,
  NotFoundException,
  OauthException,
  UnauthorizedException,
  UnprocessableEntityException,
  WorkOS,
} from "@workos-inc/node";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export interface AuthKitAuthorization {
  readonly authorizationUrl: string;
  readonly state: AuthProviderState;
  /** Server-held verifier corresponding to the provider's challenge; never return it to desktop. */
  readonly codeVerifier: AuthPkceCodeVerifier;
}

/** The only WorkOS authentication data allowed beyond this adapter. */
export interface AuthKitIdentity {
  readonly provider: "workos";
  readonly subject: string;
  readonly verifiedEmail: string;
  readonly providerSessionId: string;
}

export interface AuthenticateAuthKitCodeInput {
  readonly code: AuthProviderAuthorizationCode;
  /** Recovered from the one-use server-side transaction, not supplied by the browser callback. */
  readonly codeVerifier: AuthPkceCodeVerifier;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface AuthKitIdentityProvider {
  createAuthorization(): Promise<AuthKitAuthorization>;
  authenticateCode(input: AuthenticateAuthKitCodeInput): Promise<AuthKitIdentity>;
  createLogoutUrl(providerSessionId: AuthKitProviderSessionId): AuthKitLogoutUrl;
  /** Returns the complete active-session set for one verified WorkOS subject. */
  listActiveSessionIds(providerSubject: string): Promise<ReadonlySet<AuthKitProviderSessionId>>;
}

export class AuthKitProviderUnavailableError extends Error {
  constructor() {
    super("The identity provider is unavailable");
    this.name = "AuthKitProviderUnavailableError";
  }
}

export class AuthKitIdentityRejectedError extends Error {
  constructor() {
    super("The identity could not be verified");
    this.name = "AuthKitIdentityRejectedError";
  }
}

interface WorkOSAuthorizationOptions {
  readonly provider: "authkit";
  readonly redirectUri: string;
  readonly clientId: string;
}

interface WorkOSCodeExchangeOptions {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

interface WorkOSLogoutUrlOptions {
  readonly sessionId: string;
}

interface WorkOSListSessionsOptions {
  readonly after?: string;
  readonly limit: number;
}

interface WorkOSAuthKitClient {
  getAuthorizationUrlWithPKCE(options: WorkOSAuthorizationOptions): Promise<unknown>;
  authenticateWithCode(options: WorkOSCodeExchangeOptions): Promise<unknown>;
  getLogoutUrl(options: WorkOSLogoutUrlOptions): unknown;
  /** Optional only for narrow adapter tests; the production factory always supplies it. */
  listSessions?(userId: string, options: WorkOSListSessionsOptions): Promise<unknown>;
}

export interface VerifiedWorkOSAccessToken {
  readonly subject: string;
  readonly sessionId: string;
}

type VerifyWorkOSAccessToken = (accessToken: string) => Promise<VerifiedWorkOSAccessToken>;

export const DEFAULT_WORKOS_JWT_ISSUER = "https://api.workos.com/";

const authorizationResultSchema = z
  .object({
    url: credentialFreeHttpsUrlSchema,
    state: authProviderStateSchema,
    codeVerifier: authPkceCodeVerifierSchema,
  })
  .strict();

const workOSUserIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^user_[A-Za-z0-9]+$/);

const workOSUserSchema = z
  .object({
    id: workOSUserIdSchema,
    email: z
      .email()
      .max(320)
      .transform((email) => email.toLowerCase()),
    emailVerified: z.boolean(),
  })
  .passthrough();

const activeSessionPageSchema = z
  .object({
    object: z.literal("list"),
    data: z
      .array(
        z
          .object({
            object: z.literal("session"),
            id: authKitProviderSessionIdSchema,
            userId: workOSUserIdSchema,
            status: z.literal("active"),
          })
          .passthrough(),
      )
      .max(100),
    listMetadata: z
      .object({
        after: authKitProviderSessionIdSchema.nullable().optional(),
        before: authKitProviderSessionIdSchema.nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const authenticationResultSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384),
    authenticationMethod: z.string().min(1).max(128).optional(),
    impersonator: z.unknown().optional(),
    user: workOSUserSchema,
  })
  .passthrough();

const workOSAccessTokenClaimsSchema = z
  .object({
    iss: z.string().min(1).max(2_048),
    sub: z
      .string()
      .min(1)
      .max(255)
      .regex(/^user_[A-Za-z0-9]+$/),
    sid: z
      .string()
      .min(1)
      .max(255)
      .regex(/^session_[A-Za-z0-9]+$/),
    client_id: z.string().min(1).max(255).startsWith("client_"),
    jti: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/),
    exp: z.number().int().positive(),
    iat: z.number().int().positive(),
    act: z.unknown().optional(),
  })
  .passthrough()
  .refine((claims) => claims.exp > claims.iat, {
    message: "Access token expiry must follow issuance",
    path: ["exp"],
  });

export function validateWorkOSAccessTokenClaims(
  payload: unknown,
  clientId: string,
  issuer = DEFAULT_WORKOS_JWT_ISSUER,
): VerifiedWorkOSAccessToken {
  const result = workOSAccessTokenClaimsSchema.safeParse(payload);
  if (
    !result.success ||
    result.data.iss !== issuer ||
    result.data.client_id !== clientId ||
    result.data.act !== undefined
  ) {
    // Do not attach upstream claims to the public error. They are untrusted and may contain data
    // that should not survive beyond this boundary.
    throw new joseErrors.JWTClaimValidationFailed(
      "Unexpected WorkOS access-token claims",
      {},
      "claims",
      "check_failed",
    );
  }
  return { subject: result.data.sub, sessionId: result.data.sid };
}

/** Build the verifier separately so its RS256 and claim policy can be tested with a local JWKS. */
export function createWorkOSAccessTokenVerifier(
  clientId: string,
  jwks: JWTVerifyGetKey,
  issuer = DEFAULT_WORKOS_JWT_ISSUER,
): VerifyWorkOSAccessToken {
  return async (accessToken) => {
    const verified = await jwtVerify(accessToken, jwks, {
      algorithms: ["RS256"],
      issuer,
      requiredClaims: ["iss", "sub", "sid", "client_id", "jti", "exp", "iat"],
    });
    return validateWorkOSAccessTokenClaims(verified.payload, clientId, issuer);
  };
}

function isRejectedCodeError(error: unknown): boolean {
  return (
    error instanceof OauthException ||
    error instanceof AuthenticationException ||
    error instanceof BadRequestException ||
    error instanceof UnauthorizedException ||
    error instanceof UnprocessableEntityException
  );
}

export class WorkOSAuthKitIdentityProvider implements AuthKitIdentityProvider {
  readonly #client: WorkOSAuthKitClient;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #verifyAccessToken: VerifyWorkOSAccessToken;

  constructor(options: {
    readonly client: WorkOSAuthKitClient;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly verifyAccessToken: VerifyWorkOSAccessToken;
  }) {
    this.#client = options.client;
    this.#clientId = options.clientId;
    this.#redirectUri = options.redirectUri;
    this.#verifyAccessToken = options.verifyAccessToken;
  }

  async createAuthorization(): Promise<AuthKitAuthorization> {
    let payload: unknown;
    try {
      payload = await this.#client.getAuthorizationUrlWithPKCE({
        provider: "authkit",
        redirectUri: this.#redirectUri,
        clientId: this.#clientId,
      });
    } catch {
      throw new AuthKitProviderUnavailableError();
    }

    const result = authorizationResultSchema.safeParse(payload);
    if (!result.success) throw new AuthKitProviderUnavailableError();
    return {
      authorizationUrl: result.data.url,
      state: result.data.state,
      codeVerifier: result.data.codeVerifier,
    };
  }

  async authenticateCode(input: AuthenticateAuthKitCodeInput): Promise<AuthKitIdentity> {
    let payload: unknown;
    try {
      payload = await this.#client.authenticateWithCode({
        code: input.code,
        codeVerifier: input.codeVerifier,
        clientId: this.#clientId,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
    } catch (error) {
      if (isRejectedCodeError(error)) throw new AuthKitIdentityRejectedError();
      throw new AuthKitProviderUnavailableError();
    }

    const result = authenticationResultSchema.safeParse(payload);
    if (!result.success) throw new AuthKitProviderUnavailableError();
    if (
      !result.data.user.emailVerified ||
      result.data.impersonator !== undefined ||
      result.data.authenticationMethod === "Impersonation"
    ) {
      throw new AuthKitIdentityRejectedError();
    }

    let verifiedAccessToken: VerifiedWorkOSAccessToken;
    try {
      verifiedAccessToken = await this.#verifyAccessToken(result.data.accessToken);
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) throw new AuthKitIdentityRejectedError();
      throw new AuthKitProviderUnavailableError();
    }
    if (verifiedAccessToken.subject !== result.data.user.id) {
      throw new AuthKitIdentityRejectedError();
    }

    return {
      provider: "workos",
      subject: result.data.user.id,
      verifiedEmail: result.data.user.email,
      providerSessionId: verifiedAccessToken.sessionId,
    };
  }

  createLogoutUrl(providerSessionId: AuthKitProviderSessionId): AuthKitLogoutUrl {
    const sessionId = authKitProviderSessionIdSchema.parse(providerSessionId);
    let payload: unknown;
    try {
      payload = this.#client.getLogoutUrl({ sessionId });
    } catch {
      throw new AuthKitProviderUnavailableError();
    }

    const result = authKitLogoutUrlSchema.safeParse(payload);
    if (!result.success) throw new AuthKitProviderUnavailableError();
    if (new URL(result.data).searchParams.get("session_id") !== sessionId) {
      throw new AuthKitProviderUnavailableError();
    }
    return result.data;
  }

  async listActiveSessionIds(
    providerSubjectValue: string,
  ): Promise<ReadonlySet<AuthKitProviderSessionId>> {
    const providerSubject = workOSUserIdSchema.safeParse(providerSubjectValue);
    const listSessions = this.#client.listSessions;
    if (!providerSubject.success || listSessions === undefined) {
      throw new AuthKitProviderUnavailableError();
    }

    const sessionIds = new Set<AuthKitProviderSessionId>();
    const seenCursors = new Set<string>();
    let after: AuthKitProviderSessionId | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      let payload: unknown;
      try {
        payload = await listSessions(providerSubject.data, {
          limit: 100,
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        // This subject was previously established by a signed WorkOS access token. A definitive
        // 404 now means the provider user no longer exists, so none of its sessions can be active.
        if (error instanceof NotFoundException) return new Set();
        throw new AuthKitProviderUnavailableError();
      }

      const page = activeSessionPageSchema.safeParse(payload);
      if (
        !page.success ||
        page.data.data.some((session) => session.userId !== providerSubject.data)
      ) {
        throw new AuthKitProviderUnavailableError();
      }
      for (const session of page.data.data) sessionIds.add(session.id);

      const next = page.data.listMetadata.after ?? undefined;
      if (next === undefined) return sessionIds;
      if (next === after || seenCursors.has(next)) {
        throw new AuthKitProviderUnavailableError();
      }
      seenCursors.add(next);
      after = next;
    }

    // An unexpectedly deep or cyclic response must never be mistaken for a complete active set.
    throw new AuthKitProviderUnavailableError();
  }
}

export interface WorkOSAuthKitIdentityProviderConfig {
  readonly apiKey: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly jwtIssuer: string;
  /**
   * Optional SDK transport overrides for a local WorkOS Emulate instance. Production never sets
   * these; tests and local emulator wiring use them to keep the official client pointed at
   * `http://localhost:<port>` instead of `https://api.workos.com`.
   */
  readonly apiHostname?: string;
  readonly port?: number;
  readonly https?: boolean;
}

export function createWorkOSAuthKitIdentityProvider(
  config: WorkOSAuthKitIdentityProviderConfig,
): WorkOSAuthKitIdentityProvider {
  const workos = new WorkOS(config.apiKey, {
    clientId: config.clientId,
    ...(config.apiHostname === undefined ? {} : { apiHostname: config.apiHostname }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.https === undefined ? {} : { https: config.https }),
  });
  const jwks = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(config.clientId)));
  return new WorkOSAuthKitIdentityProvider({
    client: {
      getAuthorizationUrlWithPKCE: (options) =>
        workos.userManagement.getAuthorizationUrlWithPKCE(options),
      authenticateWithCode: (options) => workos.userManagement.authenticateWithCode(options),
      getLogoutUrl: (options) => workos.userManagement.getLogoutUrl(options),
      listSessions: (userId, options) => workos.userManagement.listSessions(userId, options),
    },
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    verifyAccessToken: createWorkOSAccessTokenVerifier(config.clientId, jwks, config.jwtIssuer),
  });
}
