import {
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
  invitationSchema,
  listAgentsResponseSchema,
  listAgentTokensResponseSchema,
  listInvitationsResponseSchema,
  magicLinkLandingQuerySchema,
  magicLinkRequestedSchema,
  MEMBER_PROFILES_CAPABILITY,
  requestMagicLinkSchema,
  sessionTokenSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
  verifyMagicLinkSchema,
  type CurrentUser,
  type SessionToken,
} from "@hype-comms/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import { FixedWindowAttemptThrottle } from "../../throttle.js";
import {
  rejectAmbiguousCredentials,
  requireAuthenticatedIdentity,
  requireHumanIdentity,
} from "./request-auth.js";
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

function cookieValue(request: FastifyRequest): string | undefined {
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

export const identityLandingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/auth/magic-link", async (request, reply) => {
    const result = magicLinkLandingQuerySchema.safeParse(request.query);
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
  });
};

export const identityRoutes: FastifyPluginAsync<IdentityRoutesOptions> = async (
  app,
  {
    service,
    authKitService,
    cookieSecure,
    selfServiceMagicLink = true,
    agentProvisioningEnabled = true,
  },
) => {
  const profileUpdateThrottle = new FixedWindowAttemptThrottle({
    maxAttempts: PROFILE_UPDATE_LIMIT,
    windowMs: PROFILE_UPDATE_WINDOW_MS,
  });

  app.post("/auth/magic-link", async (request, reply) => {
    if (!selfServiceMagicLink) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Sign-in links are issued by an administrator",
      );
    }
    const result = requestMagicLinkSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid magic-link request");
    const response = await service.requestMagicLink(result.data.email, request.ip, request.log);
    return reply.code(202).send(magicLinkRequestedSchema.parse(response));
  });

  app.post("/auth/session", async (request, reply) => {
    const result = verifyMagicLinkSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid magic-link token");
    const userAgent = request.headers["user-agent"];
    const label = userAgent === undefined ? null : userAgent.slice(0, 200);
    const session = await service.redeemMagicLink(result.data.token, label);
    const currentUser = await service.authenticate(session.token);
    if (currentUser === null) {
      throw new ApiError(500, "INTERNAL_ERROR", "The session could not be created");
    }
    setSessionCookie(reply, session, cookieSecure);
    return reply
      .code(200)
      .send(
        desktopCurrentUserResponse(
          currentUser,
          supportsMemberProfiles(request.headers["x-hype-comms-capabilities"]),
        ),
      );
  });

  app.get("/auth/me", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, service);
    const memberProfiles = supportsMemberProfiles(request.headers["x-hype-comms-capabilities"]);
    return identity.credentialType === "session"
      ? desktopCurrentUserResponse(identity.currentUser, memberProfiles)
      : (() => {
          const principal = currentPrincipalSchema.parse(identity.currentUser);
          return memberProfiles ? principal : { ...principal, user: withoutTitle(principal.user) };
        })();
  });

  app.patch("/profile", async (request, reply) => {
    const { currentUser } = await requireCurrentUser(request, service);
    const retryAfterMs = profileUpdateThrottle.recordAttempt(currentUser.user.id);
    if (retryAfterMs > 0) {
      void reply.header("retry-after", Math.ceil(retryAfterMs / 1_000).toString());
      throw new ApiError(429, "RATE_LIMITED", "Too many requests");
    }
    const body = updateProfileRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid profile update");
    const response = updateProfileResponseSchema.parse({
      user: await service.updateProfileTitle(currentUser.user.id, body.data.title),
    });
    return supportsMemberProfiles(request.headers["x-hype-comms-capabilities"])
      ? response
      : { ...response, user: withoutTitle(response.user) };
  });

  app.post("/auth/session/refresh", async (request, reply) => {
    const token = requiredSessionToken(request);
    const session = await service.refreshSession(token, request.log);
    setSessionCookie(reply, session, cookieSecure);
    return reply.code(204).send();
  });

  app.delete("/auth/session", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    rejectAmbiguousCredentials(request);
    const result = sessionTokenSchema.safeParse(cookieValue(request));
    const providerSessionId = result.success ? await service.signOut(result.data) : null;
    if (providerSessionId !== null && authKitService !== undefined) {
      const logoutUrl = authKitLogoutUrlSchema.safeParse(
        authKitService.createLogoutUrl(providerSessionId),
      );
      if (logoutUrl.success) void reply.header(authKitLogoutUrlHeaderName, logoutUrl.data);
    }
    void reply.header("set-cookie", sessionCookie("", cookieSecure, { clear: true }));
    return reply.code(204).send();
  });

  app.get("/auth/devices", async (request) => {
    const { currentUser } = await requireCurrentUser(request, service);
    return deviceSessionSchema.array().parse(await service.listDevices(currentUser.user.id));
  });

  app.delete("/auth/devices/:id", async (request, reply) => {
    const { currentUser } = await requireCurrentUser(request, service);
    const parameters = entityIdSchema.safeParse(
      typeof request.params === "object" && request.params !== null && "id" in request.params
        ? request.params.id
        : undefined,
    );
    if (!parameters.success) throw new ApiError(400, "BAD_REQUEST", "Invalid device session id");
    if (!(await service.revokeDevice(currentUser.user.id, parameters.data))) {
      throw new ApiError(404, "NOT_FOUND", "Device session not found");
    }
    return reply.code(204).send();
  });

  /** Shared by the legacy `/auth/invitations` path and the current `/invitations` one. */
  const createInvitation = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const identity = await requireHumanIdentity(request, service);
    const result = createInvitationSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid invitation");
    const invitation = await service.createInvitation(
      identity.currentUser.user.id,
      result.data.email,
      result.data.role,
    );
    return reply.code(201).send(invitationSchema.parse(invitation));
  };

  app.post("/auth/invitations", createInvitation);

  app.get("/invitations", async (request) => {
    const identity = await requireHumanIdentity(request, service);
    return listInvitationsResponseSchema.parse({
      invitations: await service.listInvitations(identity.currentUser.user.id),
    });
  });

  app.post("/invitations", createInvitation);

  app.delete("/invitations/:id", async (request, reply) => {
    const identity = await requireHumanIdentity(request, service);
    const invitationId = entityIdSchema.safeParse(
      typeof request.params === "object" && request.params !== null && "id" in request.params
        ? request.params.id
        : undefined,
    );
    if (!invitationId.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid invitation id");
    }
    if (!(await service.revokeInvitation(identity.currentUser.user.id, invitationId.data))) {
      throw new ApiError(404, "NOT_FOUND", "Pending invitation not found");
    }
    return reply.code(204).send();
  });

  app.get("/agents", async (request) => {
    const identity = await requireHumanIdentity(request, service);
    const response = listAgentsResponseSchema.parse({
      agents: await service.listAgents(identity.currentUser.user.id),
    });
    return supportsMemberProfiles(request.headers["x-hype-comms-capabilities"])
      ? response
      : { ...response, agents: response.agents.map(withoutAgentTitle) };
  });

  app.post("/agents", async (request, reply) => {
    const identity = await requireHumanIdentity(request, service);
    if (!agentProvisioningEnabled) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Agent provisioning is disabled during the server rollback window",
      );
    }
    const input = createAgentRequestSchema.safeParse(request.body);
    if (!input.success) throw new ApiError(400, "BAD_REQUEST", "Invalid agent");
    const agent = await service.createAgent(identity.currentUser.user.id, input.data);
    const response = createAgentResponseSchema.parse({ agent });
    return reply
      .code(201)
      .send(
        supportsMemberProfiles(request.headers["x-hype-comms-capabilities"])
          ? response
          : { ...response, agent: withoutAgentTitle(response.agent) },
      );
  });

  app.delete("/agents/:id", async (request, reply) => {
    const identity = await requireHumanIdentity(request, service);
    const agentId = entityIdSchema.safeParse(
      typeof request.params === "object" && request.params !== null && "id" in request.params
        ? request.params.id
        : undefined,
    );
    if (!agentId.success) throw new ApiError(400, "BAD_REQUEST", "Invalid agent id");
    if (!(await service.disableAgent(identity.currentUser.user.id, agentId.data))) {
      throw new ApiError(404, "NOT_FOUND", "Agent not found");
    }
    return reply.code(204).send();
  });

  app.get("/agents/:id/tokens", async (request) => {
    const identity = await requireHumanIdentity(request, service);
    const agentId = entityIdSchema.safeParse(
      typeof request.params === "object" && request.params !== null && "id" in request.params
        ? request.params.id
        : undefined,
    );
    if (!agentId.success) throw new ApiError(400, "BAD_REQUEST", "Invalid agent id");
    return listAgentTokensResponseSchema.parse({
      tokens: await service.listAgentTokens(identity.currentUser.user.id, agentId.data),
    });
  });

  app.post("/agents/:id/tokens", async (request, reply) => {
    const identity = await requireHumanIdentity(request, service);
    const agentId = entityIdSchema.safeParse(
      typeof request.params === "object" && request.params !== null && "id" in request.params
        ? request.params.id
        : undefined,
    );
    if (!agentId.success) throw new ApiError(400, "BAD_REQUEST", "Invalid agent id");
    const input = createAgentTokenRequestSchema.safeParse(request.body);
    if (!input.success) throw new ApiError(400, "BAD_REQUEST", "Invalid agent token");
    return reply
      .code(201)
      .send(
        createAgentTokenResponseSchema.parse(
          await service.createAgentToken(identity.currentUser.user.id, agentId.data, input.data),
        ),
      );
  });

  app.delete("/agents/:agentId/tokens/:tokenId", async (request, reply) => {
    const identity = await requireHumanIdentity(request, service);
    const params =
      typeof request.params === "object" && request.params !== null ? request.params : {};
    const agentId = entityIdSchema.safeParse("agentId" in params ? params.agentId : undefined);
    const tokenId = entityIdSchema.safeParse("tokenId" in params ? params.tokenId : undefined);
    if (!agentId.success || !tokenId.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid agent token id");
    }
    if (
      !(await service.revokeAgentToken(identity.currentUser.user.id, agentId.data, tokenId.data))
    ) {
      throw new ApiError(404, "NOT_FOUND", "Agent token not found");
    }
    return reply.code(204).send();
  });
};
