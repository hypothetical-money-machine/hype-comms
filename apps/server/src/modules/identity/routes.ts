import {
  createInvitationSchema,
  currentUserSchema,
  deviceSessionSchema,
  entityIdSchema,
  invitationSchema,
  magicLinkRequestedSchema,
  requestMagicLinkSchema,
  sessionTokenSchema,
  verifyMagicLinkSchema,
  type CurrentUser,
  type SessionToken,
} from "@hmm-chat/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import type { IdentityService, RedeemedSession } from "./service.js";

const COOKIE_NAME = "hmm_session";

interface IdentityRoutesOptions {
  readonly service: IdentityService;
  readonly cookieSecure: boolean;
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

function setSessionCookie(reply: FastifyReply, session: RedeemedSession, secure: boolean): void {
  void reply.header(
    "set-cookie",
    sessionCookie(session.token, secure, { expiresAt: session.expiresAt }),
  );
}

export const identityRoutes: FastifyPluginAsync<IdentityRoutesOptions> = async (
  app,
  { service, cookieSecure },
) => {
  app.post("/auth/magic-link", async (request, reply) => {
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
    return reply.code(200).send(currentUserSchema.parse(currentUser));
  });

  app.get("/auth/me", async (request) => {
    const { currentUser } = await requireCurrentUser(request, service);
    return currentUserSchema.parse(currentUser);
  });

  app.post("/auth/session/refresh", async (request, reply) => {
    const token = requiredSessionToken(request);
    const session = await service.refreshSession(token);
    setSessionCookie(reply, session, cookieSecure);
    return reply.code(204).send();
  });

  app.delete("/auth/session", async (request, reply) => {
    const result = sessionTokenSchema.safeParse(cookieValue(request));
    if (result.success) await service.signOut(result.data);
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

  app.post("/auth/invitations", async (request, reply) => {
    const { currentUser } = await requireCurrentUser(request, service);
    const result = createInvitationSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid invitation");
    const invitation = await service.createInvitation(
      currentUser.user.id,
      result.data.email,
      result.data.role,
    );
    return reply.code(201).send(invitationSchema.parse(invitation));
  });
};
