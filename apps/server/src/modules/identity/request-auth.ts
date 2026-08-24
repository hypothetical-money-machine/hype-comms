import {
  agentTokenSecretSchema,
  sessionTokenSchema,
  type AgentScope,
  type AgentTokenSecret,
  type SessionToken,
} from "@hype-comms/contracts";
import type { FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import type {
  AuthenticatedAgentIdentity,
  AuthenticatedHumanIdentity,
  IdentityService,
} from "./service.js";

const IDENTITY_COOKIE_NAME = "hype_comms_session";

function cookieValue(request: FastifyRequest, cookieName: string): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return value.join("=");
  }
  return undefined;
}

function bearerValue(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization);
  return match?.[1];
}

function carriesBearerCredential(request: FastifyRequest): boolean {
  return /^Bearer(?:[ \t]|$)/i.test(request.headers.authorization ?? "");
}

/** Reject credential confusion before a route can accidentally prefer one principal over another. */
export function rejectAmbiguousCredentials(request: FastifyRequest): void {
  if (
    cookieValue(request, IDENTITY_COOKIE_NAME) !== undefined &&
    carriesBearerCredential(request)
  ) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "Use either a session cookie or an agent bearer token, not both",
    );
  }
}

export type AuthenticatedRequestIdentity =
  | (AuthenticatedHumanIdentity & {
      readonly credentialType: "session";
      readonly token: SessionToken;
    })
  | (AuthenticatedAgentIdentity & {
      readonly credentialType: "agent";
      readonly token: AgentTokenSecret;
    });

export async function requireAuthenticatedIdentity(
  request: FastifyRequest,
  service: IdentityService,
): Promise<AuthenticatedRequestIdentity> {
  rejectAmbiguousCredentials(request);

  if (carriesBearerCredential(request)) {
    const parsed = agentTokenSecretSchema.safeParse(bearerValue(request));
    if (!parsed.success) {
      throw new ApiError(401, "UNAUTHORIZED", "Agent token is invalid or revoked");
    }
    const identity = await service.authenticateAgentContext(parsed.data);
    if (identity === null) {
      throw new ApiError(401, "UNAUTHORIZED", "Agent token is invalid or revoked");
    }
    return { ...identity, credentialType: "agent", token: parsed.data };
  }

  const parsed = sessionTokenSchema.safeParse(cookieValue(request, IDENTITY_COOKIE_NAME));
  if (!parsed.success) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  const identity = await service.authenticateContext(parsed.data);
  if (identity === null) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  return { ...identity, credentialType: "session", token: parsed.data };
}

export async function requireHumanIdentity(
  request: FastifyRequest,
  service: IdentityService,
): Promise<
  AuthenticatedHumanIdentity & {
    readonly credentialType: "session";
    readonly token: SessionToken;
  }
> {
  const identity = await requireAuthenticatedIdentity(request, service);
  if (identity.credentialType !== "session") {
    throw new ApiError(403, "FORBIDDEN", "A signed-in human session is required");
  }
  return identity;
}

export function requireAgentScope(identity: AuthenticatedRequestIdentity, scope: AgentScope): void {
  if (identity.credentialType === "agent" && !identity.authorizationScopes.includes(scope)) {
    throw new ApiError(403, "FORBIDDEN", `Agent token requires the ${scope} scope`);
  }
}

export function requireAnyAgentScope(
  identity: AuthenticatedRequestIdentity,
  scopes: readonly AgentScope[],
): void {
  if (
    identity.credentialType === "agent" &&
    !scopes.some((scope) => identity.authorizationScopes.includes(scope))
  ) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `Agent token requires one of these scopes: ${scopes.join(", ")}`,
    );
  }
}
