import { botAccessTokenSchema, type BotScope } from "@hmm-chat/contracts";
import type { FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import { requireAuthenticatedIdentity } from "../identity/request-auth.js";
import type { AuthenticatedIdentity, IdentityService } from "../identity/service.js";
import type { AuthenticatedBotIdentity, BotService } from "./service.js";

export type AuthenticatedTaskIdentity = AuthenticatedIdentity | AuthenticatedBotIdentity;

function bearerToken(value: string): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Task routes are the sole service-token entrypoint. Human cookies retain their existing behavior;
 * supplying an Authorization header opts into bot authentication and cannot fall back to a cookie.
 */
export async function requireTaskIdentity(
  request: FastifyRequest,
  identityService: IdentityService,
  botService: BotService | undefined,
  requiredScope: BotScope,
): Promise<AuthenticatedTaskIdentity> {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return requireAuthenticatedIdentity(request, identityService);
  }
  const parsed = botAccessTokenSchema.safeParse(bearerToken(authorization));
  if (!parsed.success || botService === undefined) {
    throw new ApiError(401, "UNAUTHORIZED", "Bot credential is invalid or expired");
  }
  const identity = await botService.authenticate(parsed.data);
  if (identity === null) {
    throw new ApiError(401, "UNAUTHORIZED", "Bot credential is invalid or expired");
  }
  if (!identity.scopes.includes(requiredScope)) {
    throw new ApiError(403, "FORBIDDEN", `Bot credential requires ${requiredScope}`);
  }
  return identity;
}
