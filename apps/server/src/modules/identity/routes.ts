import {
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  AGENT_ENROLLMENT_REVIEW_CHANNELS_CAPABILITY,
  AGENT_ENROLLMENT_AUTHORIZATION_SCHEME,
  agentEnrollmentPolicyResponseSchema,
  agentEnrollmentNoBodyRequestSchema,
  agentEnrollmentResponseSchema,
  agentTokenSecretSchema,
  authKitLogoutUrlHeaderName,
  authKitLogoutUrlSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  createAgentTokenRequestSchema,
  createAgentTokenResponseSchema,
  createInvitationSchema,
  clientCapabilitiesHeaderSchema,
  currentPrincipalSchema,
  currentUserSchema,
  deviceSessionSchema,
  entityIdSchema,
  idempotencyKeySchema,
  invitationSchema,
  listAgentsResponseSchema,
  listAgentTokensResponseSchema,
  listAgentEnrollmentsResponseSchema,
  listInvitationsResponseSchema,
  magicLinkLandingQuerySchema,
  magicLinkRequestedSchema,
  MEMBER_PROFILES_CAPABILITY,
  requestMagicLinkSchema,
  requestAgentEnrollmentSchema,
  redeemAgentEnrollmentResponseSchema,
  reviewAgentEnrollmentRequestSchema,
  sessionTokenSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
  updateAgentEnrollmentPolicyRequestSchema,
  verifyMagicLinkSchema,
  type AgentScope,
  type CurrentUser,
  type SessionToken,
} from "@hype-comms/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { routeModule, validateRequest } from "../../http/route-registrar.js";
import { humanPolicy, publicPolicy, workspacePolicy } from "../../http/authentication-policies.js";

import { ApiError } from "../../errors.js";
import { FixedWindowAttemptThrottle } from "../../throttle.js";
import { rejectAmbiguousCredentials, type AuthenticatedRequestIdentity } from "./request-auth.js";
import type { AgentEnrollmentActor, AgentEnrollmentModule } from "./agent-enrollment.js";
import type { AuthKitService } from "./authkit-service.js";
import type { IdentityService, RedeemedSession } from "./service.js";

const COOKIE_NAME = "hype_comms_session";
const MAGIC_LINK_PAGE_HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;
const DESKTOP_CALLBACK_SCHEMES = {
  production: "hype-comms",
  development: "hype-comms-dev",
} as const;
const PROFILE_UPDATE_LIMIT = 10;
const PROFILE_UPDATE_WINDOW_MS = 15 * 60 * 1_000;

interface IdentityRoutesOptions {
  readonly service: IdentityService;
  readonly agentEnrollment?: AgentEnrollmentModule;
  readonly authKitService?: AuthKitService;
  readonly cookieSecure: boolean;
  /**
   * When false, sign-in links are issued by an administrator with the invite command. Requesting
   * one over HTTP is refused rather than accepted and silently dropped, so nobody waits on an
   * email that was never going to arrive. The refusal is identical for every address, so it
   * reveals nothing about who is a member.
   */
  readonly selfServiceMagicLink?: boolean;
  /**
   * Creating an agent persists `users.kind = 'agent'`, which the previous server release cannot
   * parse. Production enables this only after that release is no longer a rollback target.
   */
  readonly agentProvisioningEnabled?: boolean;
  /** Blocks every operation that could expose the new scope or conversation shapes to old nodes. */
  readonly defaultAgentAgencyEnabled?: boolean;
}

function enrollmentActor(identity: AuthenticatedRequestIdentity): AgentEnrollmentActor {
  return {
    userId: identity.currentUser.user.id,
    workspaceId: identity.currentUser.workspaceId,
    kind: identity.credentialType === "agent" ? "agent" : "human",
    role: identity.currentUser.role,
    agentTokenId: identity.credentialType === "agent" ? identity.agentTokenId : null,
    scopes: identity.credentialType === "agent" ? identity.authorizationScopes : [],
  };
}

function requiredEnrollmentIdempotencyKey(value: string | string[] | undefined): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Idempotency-Key is required");
  return parsed.data;
}

function includesRollbackUnsafeAgentScope(scopes: readonly AgentScope[]): boolean {
  return scopes.some(
    (scope) =>
      scope === "direct-conversations:write" ||
      scope === "channels:join" ||
      scope === "agents:invite" ||
      scope === "attachments:write",
  );
}

function requiredEnrollmentCredential(request: Pick<FastifyRequest, "headers">) {
  if (cookieValue(request) !== undefined) {
    throw new ApiError(400, "BAD_REQUEST", "Enrollment redemption accepts only its credential");
  }
  const authorization = request.headers.authorization;
  const match = /^Enrollment[ \t]+([^ \t]+)$/.exec(authorization ?? "");
  const credential = agentTokenSecretSchema.safeParse(match?.[1]);
  if (!credential.success) {
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      `${AGENT_ENROLLMENT_AUTHORIZATION_SCHEME} credential is invalid`,
    );
  }
  return credential.data;
}

function sessionCookie(
  token: string,
  secure: boolean,
  options: { readonly expiresAt?: string; readonly clear?: boolean } = {},
): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
    ...(options.expiresAt === undefined
      ? []
      : [`Expires=${new Date(options.expiresAt).toUTCString()}`]),
    ...(options.clear === true ? ["Max-Age=0"] : []),
  ].join("; ");
}

function cookieValue(request: Pick<FastifyRequest, "headers">): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return undefined;
}

function requiredSessionToken(request: FastifyRequest): SessionToken {
  rejectAmbiguousCredentials(request);
  const result = sessionTokenSchema.safeParse(cookieValue(request));
  if (!result.success) throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  return result.data;
}

async function requireCurrentUser(
  request: FastifyRequest,
  service: IdentityService,
): Promise<{ readonly token: SessionToken; readonly currentUser: CurrentUser }> {
  const token = requiredSessionToken(request);
  const currentUser = await service.authenticate(token);
  if (currentUser === null) throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  return { token, currentUser };
}

/**
 * Desktop releases through v0.1.11 validate the public user object strictly and predate the
 * additive `kind` discriminator. Omit the human-only constant on identity responses; newer
 * contracts default the missing value back to `"human"`, so both generations accept this wire
 * shape while internal identity objects remain discriminated.
 */
export function supportsMemberProfiles(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string")
    throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  const parsed = clientCapabilitiesHeaderSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  return parsed.data.includes(MEMBER_PROFILES_CAPABILITY);
}

function supportsAgentEffectiveScopes(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string") {
    throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  }
  const parsed = clientCapabilitiesHeaderSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  return parsed.data.includes(AGENT_EFFECTIVE_SCOPES_CAPABILITY);
}

function supportsAgentEnrollmentReviewChannels(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string") {
    throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  }
  const parsed = clientCapabilitiesHeaderSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  return parsed.data.includes(AGENT_ENROLLMENT_REVIEW_CHANNELS_CAPABILITY);
}

function withoutTitle<T extends { readonly title?: unknown }>(user: T): Omit<T, "title"> {
  const { title, ...legacy } = user;
  void title;
  return legacy;
}

function withoutAgentTitle<T extends { readonly user: { readonly title?: unknown } }>(agent: T) {
  return { ...agent, user: withoutTitle(agent.user) };
}

export function desktopCurrentUserResponse(currentUser: CurrentUser, memberProfiles = false) {
  const parsed = currentUserSchema.parse(currentUser);
  const { kind, ...user } = parsed.user;
  void kind;
  return { ...parsed, user: memberProfiles ? user : withoutTitle(user) };
}

export function setSessionCookie(
  reply: FastifyReply,
  session: RedeemedSession,
  secure: boolean,
): void {
  void reply.header(
    "set-cookie",
    sessionCookie(session.token, secure, { expiresAt: session.expiresAt }),
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as const
      )[character as "&" | "<" | ">" | '"' | "'"],
  );
}

function magicLinkPage(token: string): string {
  const productionTarget = new URL(`${DESKTOP_CALLBACK_SCHEMES.production}://auth/callback`);
  productionTarget.searchParams.set("token", token);
  const developmentTarget = new URL(`${DESKTOP_CALLBACK_SCHEMES.development}://auth/callback`);
  developmentTarget.searchParams.set("token", token);
  const escapedProductionTarget = escapeHtml(productionTarget.toString());
  const escapedDevelopmentTarget = escapeHtml(developmentTarget.toString());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Hype Comms</title>
</head>
<body>
  <main>
    <h1>Open Hype Comms</h1>
    <p>Choose the app where you want to finish signing in.</p>
    <ul>
      <li><a href="${escapedProductionTarget}">Open Hype Comms</a></li>
      <li><a href="${escapedDevelopmentTarget}">Open Hype Comms DEV</a></li>
    </ul>
    <p>Use Hype Comms DEV only when you are testing a preview build.</p>
  </main>
</body>
</html>`;
}

function invalidMagicLinkPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Invalid sign-in link</title></head>
<body><main><p>This link is not valid.</p></main></body>
</html>`;
}

export const identityLandingRoutes = routeModule((routes) => {
  routes.register({
    method: "GET",
    url: "/auth/magic-link",
    policy: publicPolicy,
    scopes: [],
    // This public page renders a validation error as HTML instead of the API envelope.
    request: {
      query: validateRequest(
        z.unknown().transform((value) => magicLinkLandingQuerySchema.safeParse(value)),
        "Invalid sign-in link",
      ),
    },
    handler: async ({ input: { query: result }, reply }) => {
      const contentSecurityPolicy =
        "default-src 'none'; style-src 'none'; img-src 'none'; script-src 'none'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

      void reply.headers({
        ...MAGIC_LINK_PAGE_HEADERS,
        "content-security-policy": contentSecurityPolicy,
        "content-type": "text/html; charset=utf-8",
      });
      if (!result.success) {
        return reply.code(400).send(invalidMagicLinkPage());
      }

      // A magic-link request has no authenticated client identity, so only the recipient may choose
      // which installed app receives the credential. Unknown query keys are stripped by the schema.
      return reply.code(200).send(magicLinkPage(result.data.token));
    },
  });
});

export const identityRoutes = routeModule<IdentityRoutesOptions>(
  (
    routes,
    {
      service,
      agentEnrollment,
      authKitService,
      cookieSecure,
      selfServiceMagicLink = true,
      agentProvisioningEnabled = true,
      defaultAgentAgencyEnabled = true,
    },
  ) => {
    const human = humanPolicy(service);
    const workspace = workspacePolicy(service);
    const currentUserPolicy = {
      name: "current-human-session",
      authenticate: (request: FastifyRequest) => requireCurrentUser(request, service),
    };
    const profileUpdateThrottle = new FixedWindowAttemptThrottle({
      maxAttempts: PROFILE_UPDATE_LIMIT,
      windowMs: PROFILE_UPDATE_WINDOW_MS,
    });

    const requireEnrollmentModule = (): AgentEnrollmentModule => {
      if (agentEnrollment === undefined) {
        throw new ApiError(503, "SERVICE_UNAVAILABLE", "Agent enrollment is unavailable");
      }
      return agentEnrollment;
    };

    const requireEnrollmentIssuanceEnabled = (): void => {
      if (!agentProvisioningEnabled || !defaultAgentAgencyEnabled) {
        throw new ApiError(
          503,
          "SERVICE_UNAVAILABLE",
          "Agent provisioning is disabled during the server rollback window",
        );
      }
    };

    routes.register({
      method: "POST",
      url: "/auth/magic-link",
      policy: publicPolicy,
      scopes: [],
      request: { body: validateRequest(requestMagicLinkSchema, "Invalid magic-link request") },
      beforeValidation: () => {
        if (!selfServiceMagicLink) {
          throw new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "Sign-in links are issued by an administrator",
          );
        }
      },
      handler: async ({ request, reply, input: { body: result } }) => {
        const response = await service.requestMagicLink(result.email, request.ip, request.log);
        return reply.code(202).send(magicLinkRequestedSchema.parse(response));
      },
    });

    routes.registerCredential({
      method: "POST",
      url: "/auth/session",
      scopes: [],
      request: { body: validateRequest(verifyMagicLinkSchema, "Invalid magic-link token") },
      policy: {
        name: "single-use-magic-link",
        authenticate: async ({ body: result }, request) => {
          const userAgent = request.headers["user-agent"];
          const label = userAgent === undefined ? null : userAgent.slice(0, 200);
          const session = await service.redeemMagicLink(result.token, label);
          const currentUser = await service.authenticate(session.token);
          if (currentUser === null) {
            throw new ApiError(500, "INTERNAL_ERROR", "The session could not be created");
          }
          return { session, currentUser };
        },
      },
      handler: async ({ identity: { session, currentUser }, request, reply }) => {
        setSessionCookie(reply, session, cookieSecure);
        return reply
          .code(200)
          .send(
            desktopCurrentUserResponse(
              currentUser,
              supportsMemberProfiles(request.headers["x-hype-comms-capabilities"]),
            ),
          );
      },
    });

    routes.register({
      method: "GET",
      url: "/auth/me",
      policy: workspace,
      scopes: [],
      request: {},
      handler: async ({ identity, request }) => {
        const memberProfiles = supportsMemberProfiles(request.headers["x-hype-comms-capabilities"]);
        return identity.credentialType === "session"
          ? desktopCurrentUserResponse(identity.currentUser, memberProfiles)
          : (() => {
              const principal = currentPrincipalSchema.parse({
                ...identity.currentUser,
                ...(supportsAgentEffectiveScopes(request.headers["x-hype-comms-capabilities"])
                  ? { effectiveScopes: identity.authorizationScopes }
                  : {}),
              });
              return memberProfiles
                ? principal
                : { ...principal, user: withoutTitle(principal.user) };
            })();
      },
    });

    routes.register({
      method: "PATCH",
      url: "/profile",
      policy: currentUserPolicy,
      scopes: [],
      request: { body: validateRequest(updateProfileRequestSchema, "Invalid profile update") },
      beforeValidation: ({ identity: { currentUser }, reply }) => {
        const retryAfterMs = profileUpdateThrottle.recordAttempt(currentUser.user.id);
        if (retryAfterMs > 0) {
          void reply.header("retry-after", Math.ceil(retryAfterMs / 1_000).toString());
          throw new ApiError(429, "RATE_LIMITED", "Too many requests");
        }
      },
      handler: async ({ identity: { currentUser }, request, input: { body } }) => {
        const response = updateProfileResponseSchema.parse({
          user: await service.updateProfileTitle(currentUser.user.id, body.title),
        });
        return supportsMemberProfiles(request.headers["x-hype-comms-capabilities"])
          ? response
          : { ...response, user: withoutTitle(response.user) };
      },
    });

    routes.register({
      method: "POST",
      url: "/auth/session/refresh",
      policy: {
        name: "session-refresh",
        authenticate: async (request) => {
          const token = requiredSessionToken(request);
          const session = await service.refreshSession(token, request.log);
          return session;
        },
      },
      scopes: [],
      request: {},
      handler: async ({ identity: session, reply }) => {
        setSessionCookie(reply, session, cookieSecure);
        return reply.code(204).send();
      },
    });

    routes.register({
      method: "DELETE",
      url: "/auth/session",
      policy: {
        name: "idempotent-session-signout",
        authenticate: async (request) => {
          rejectAmbiguousCredentials(request);
          const result = sessionTokenSchema.safeParse(cookieValue(request));
          const providerSessionId = result.success ? await service.signOut(result.data) : null;
          return providerSessionId;
        },
      },
      scopes: [],
      request: {},
      beforeAuthentication: ({ reply }) => {
        void reply.header("cache-control", "no-store");
      },
      handler: async ({ identity: providerSessionId, reply }) => {
        if (providerSessionId !== null && authKitService !== undefined) {
          const logoutUrl = authKitLogoutUrlSchema.safeParse(
            authKitService.createLogoutUrl(providerSessionId),
          );
          if (logoutUrl.success) void reply.header(authKitLogoutUrlHeaderName, logoutUrl.data);
        }
        void reply.header("set-cookie", sessionCookie("", cookieSecure, { clear: true }));
        return reply.code(204).send();
      },
    });

    routes.register({
      method: "GET",
      url: "/auth/devices",
      policy: currentUserPolicy,
      scopes: [],
      request: {},
      handler: async ({ identity: { currentUser } }) => {
        return deviceSessionSchema.array().parse(await service.listDevices(currentUser.user.id));
      },
    });

    routes.register({
      method: "DELETE",
      url: "/auth/devices/:id",
      policy: currentUserPolicy,
      scopes: [],
      request: {
        params: validateRequest(
          z.object({ id: entityIdSchema }).strict(),
          "Invalid device session id",
        ),
      },
      handler: async ({
        identity: { currentUser },
        reply,
        input: {
          params: { id: parameters },
        },
      }) => {
        if (!(await service.revokeDevice(currentUser.user.id, parameters))) {
          throw new ApiError(404, "NOT_FOUND", "Device session not found");
        }
        return reply.code(204).send();
      },
    });

    for (const url of ["/auth/invitations", "/invitations"]) {
      routes.register({
        method: "POST",
        url,
        policy: human,
        scopes: [],
        request: { body: validateRequest(createInvitationSchema, "Invalid invitation") },
        handler: async ({ identity, input: { body }, reply }) => {
          const invitation = await service.createInvitation(
            identity.currentUser.user.id,
            body.email,
            body.role,
          );
          return reply.code(201).send(invitationSchema.parse(invitation));
        },
      });
    }

    routes.register({
      method: "GET",
      url: "/invitations",
      policy: human,
      scopes: [],
      request: {},
      handler: async ({ identity }) => {
        return listInvitationsResponseSchema.parse({
          invitations: await service.listInvitations(identity.currentUser.user.id),
        });
      },
    });

    routes.register({
      method: "DELETE",
      url: "/invitations/:id",
      policy: human,
      scopes: [],
      request: {
        params: validateRequest(z.object({ id: entityIdSchema }).strict(), "Invalid invitation id"),
      },
      handler: async ({
        identity,
        reply,
        input: {
          params: { id: invitationId },
        },
      }) => {
        if (!(await service.revokeInvitation(identity.currentUser.user.id, invitationId))) {
          throw new ApiError(404, "NOT_FOUND", "Pending invitation not found");
        }
        return reply.code(204).send();
      },
    });

    routes.register({
      method: "GET",
      url: "/agent-enrollment-policy",
      policy: human,
      scopes: [],
      request: {},
      handler: async ({ identity }) => {
        return agentEnrollmentPolicyResponseSchema.parse({
          policy: await requireEnrollmentModule().getPolicy(enrollmentActor(identity)),
        });
      },
    });

    routes.register({
      method: "PATCH",
      url: "/agent-enrollment-policy",
      policy: human,
      scopes: [],
      request: {
        body: validateRequest(
          updateAgentEnrollmentPolicyRequestSchema,
          "Invalid agent enrollment policy",
        ),
      },
      beforeValidation: () => {
        requireEnrollmentIssuanceEnabled();
      },
      handler: async ({ identity, input: { body: input } }) => {
        return agentEnrollmentPolicyResponseSchema.parse({
          policy: await requireEnrollmentModule().setPolicy(enrollmentActor(identity), input.mode),
        });
      },
    });

    routes.register({
      method: "POST",
      url: "/agent-enrollments",
      policy: workspace,
      scopes: ["agents:invite"],
      request: { body: validateRequest(requestAgentEnrollmentSchema, "Invalid agent enrollment") },
      beforeValidation: () => {
        requireEnrollmentIssuanceEnabled();
      },
      handler: async ({ identity, request, reply, input: { body: input } }) => {
        const enrollment = await requireEnrollmentModule().request(
          enrollmentActor(identity),
          input,
          requiredEnrollmentIdempotencyKey(request.headers["idempotency-key"]),
        );
        return reply.code(201).send(agentEnrollmentResponseSchema.parse({ enrollment }));
      },
    });

    routes.register({
      method: "GET",
      url: "/agent-enrollments",
      policy: workspace,
      scopes: ["agents:invite"],
      request: {},
      beforeAuthentication: ({ reply }) => {
        void reply.header("cache-control", "no-store");
      },
      handler: async ({ identity, request }) => {
        return listAgentEnrollmentsResponseSchema.parse({
          enrollments: await requireEnrollmentModule().list(
            enrollmentActor(identity),
            supportsAgentEnrollmentReviewChannels(request.headers["x-hype-comms-capabilities"]),
          ),
        });
      },
    });

    routes.register({
      method: "GET",
      url: "/agent-enrollments/:id",
      policy: workspace,
      scopes: ["agents:invite"],
      request: {
        params: validateRequest(
          z.object({ id: entityIdSchema }).strict(),
          "Invalid agent enrollment id",
        ),
      },
      handler: async ({
        identity,
        input: {
          params: { id },
        },
      }) => {
        return agentEnrollmentResponseSchema.parse({
          enrollment: await requireEnrollmentModule().get(enrollmentActor(identity), id),
        });
      },
    });

    routes.register({
      method: "POST",
      url: "/agent-enrollments/:id/review",
      policy: human,
      scopes: [],
      request: {
        params: validateRequest(
          z.object({ id: entityIdSchema }).strict(),
          "Invalid agent enrollment id",
        ),
        body: validateRequest(reviewAgentEnrollmentRequestSchema, "Invalid enrollment review"),
      },
      beforeValidation: () => {
        requireEnrollmentIssuanceEnabled();
      },
      handler: async ({
        identity,
        input: {
          params: { id },
          body: input,
        },
      }) => {
        return agentEnrollmentResponseSchema.parse({
          enrollment: await requireEnrollmentModule().review(
            enrollmentActor(identity),
            id,
            input.decision,
          ),
        });
      },
    });

    routes.register({
      method: "POST",
      url: "/agent-enrollments/:id/cancel",
      policy: workspace,
      scopes: ["agents:invite"],
      request: {
        body: validateRequest(
          agentEnrollmentNoBodyRequestSchema,
          "Enrollment cancellation does not accept a body",
        ),
        params: validateRequest(
          z.object({ id: entityIdSchema }).strict(),
          "Invalid agent enrollment id",
        ),
      },
      handler: async ({
        identity,
        input: {
          params: { id },
        },
      }) => {
        return agentEnrollmentResponseSchema.parse({
          enrollment: await requireEnrollmentModule().cancel(enrollmentActor(identity), id),
        });
      },
    });

    routes.registerCredential({
      method: "POST",
      url: "/agent-enrollments/:id/redeem",
      scopes: [],
      request: {
        params: validateRequest(
          z.object({ id: entityIdSchema }).strict(),
          "Invalid agent enrollment id",
        ),
        headers: validateRequest(
          z
            .object({ authorization: z.string().optional(), cookie: z.string().optional() })
            .transform((headers) => requiredEnrollmentCredential({ headers })),
          "Invalid enrollment credential",
        ),
        body: validateRequest(
          agentEnrollmentNoBodyRequestSchema,
          "Enrollment redemption does not accept a body",
        ),
      },
      policy: {
        name: "enrollment-redemption-credential",
        authenticate: async ({ params, headers: credential }) => {
          const enrollmentModule = requireEnrollmentModule();
          await enrollmentModule.authenticateRedemptionCredential(params.id, credential);
          requireEnrollmentIssuanceEnabled();
          return { credential, enrollmentModule };
        },
      },
      handler: async ({
        identity: { credential, enrollmentModule },
        input: {
          params: { id },
        },
        reply,
      }) => {
        void reply.header("cache-control", "no-store");
        return redeemAgentEnrollmentResponseSchema.parse(
          await enrollmentModule.redeem(id, credential),
        );
      },
    });

    routes.register({
      method: "GET",
      url: "/agents",
      policy: human,
      scopes: [],
      request: {},
      handler: async ({ identity, request }) => {
        const response = listAgentsResponseSchema.parse({
          agents: await service.listAgents(identity.currentUser.user.id),
        });
        return supportsMemberProfiles(request.headers["x-hype-comms-capabilities"])
          ? response
          : { ...response, agents: response.agents.map(withoutAgentTitle) };
      },
    });

    routes.register({
      method: "POST",
      url: "/agents",
      policy: human,
      scopes: [],
      request: { body: validateRequest(createAgentRequestSchema, "Invalid agent") },
      beforeValidation: () => {
        if (!agentProvisioningEnabled || !defaultAgentAgencyEnabled) {
          throw new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "Agent provisioning is disabled during the server rollback window",
          );
        }
      },
      handler: async ({ identity, request, reply, input: { body: input } }) => {
        const agent = await service.createAgent(identity.currentUser.user.id, input);
        const response = createAgentResponseSchema.parse({ agent });
        return reply
          .code(201)
          .send(
            supportsMemberProfiles(request.headers["x-hype-comms-capabilities"])
              ? response
              : { ...response, agent: withoutAgentTitle(response.agent) },
          );
      },
    });

    routes.register({
      method: "DELETE",
      url: "/agents/:id",
      policy: human,
      scopes: [],
      request: {
        params: validateRequest(z.object({ id: entityIdSchema }).strict(), "Invalid agent id"),
      },
      handler: async ({
        identity,
        reply,
        input: {
          params: { id: agentId },
        },
      }) => {
        if (!(await service.disableAgent(identity.currentUser.user.id, agentId))) {
          throw new ApiError(404, "NOT_FOUND", "Agent not found");
        }
        return reply.code(204).send();
      },
    });

    routes.register({
      method: "GET",
      url: "/agents/:id/tokens",
      policy: human,
      scopes: [],
      request: {
        params: validateRequest(z.object({ id: entityIdSchema }).strict(), "Invalid agent id"),
      },
      handler: async ({
        identity,
        request,
        input: {
          params: { id: agentId },
        },
      }) => {
        return listAgentTokensResponseSchema.parse({
          tokens: await service.listAgentTokens(
            identity.currentUser.user.id,
            agentId,
            supportsAgentEffectiveScopes(request.headers["x-hype-comms-capabilities"]),
          ),
        });
      },
    });

    routes.register({
      method: "POST",
      url: "/agents/:id/tokens",
      policy: human,
      scopes: [],
      request: {
        params: validateRequest(z.object({ id: entityIdSchema }).strict(), "Invalid agent id"),
        body: validateRequest(createAgentTokenRequestSchema, "Invalid agent token"),
      },
      handler: async ({
        identity,
        request,
        reply,
        input: {
          params: { id: agentId },
          body: input,
        },
      }) => {
        if (!defaultAgentAgencyEnabled) {
          throw new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "Agent token creation is disabled during the server rollback window",
          );
        }
        if (!agentProvisioningEnabled && includesRollbackUnsafeAgentScope(input.scopes)) {
          requireEnrollmentIssuanceEnabled();
        }
        return reply
          .code(201)
          .send(
            createAgentTokenResponseSchema.parse(
              await service.createAgentToken(
                identity.currentUser.user.id,
                agentId,
                input,
                supportsAgentEffectiveScopes(request.headers["x-hype-comms-capabilities"]),
              ),
            ),
          );
      },
    });

    routes.register({
      method: "DELETE",
      url: "/agents/:agentId/tokens/:tokenId",
      policy: human,
      scopes: [],
      request: {
        params: validateRequest(
          z.object({ agentId: entityIdSchema, tokenId: entityIdSchema }).strict(),
          "Invalid agent token id",
        ),
      },
      handler: async ({
        identity,
        reply,
        input: {
          params: { agentId, tokenId },
        },
      }) => {
        if (!(await service.revokeAgentToken(identity.currentUser.user.id, agentId, tokenId))) {
          throw new ApiError(404, "NOT_FOUND", "Agent token not found");
        }
        return reply.code(204).send();
      },
    });
  },
);
