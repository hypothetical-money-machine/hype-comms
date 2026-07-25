import { sessionTokenSchema, type SessionToken } from "@hmm-chat/contracts";
import type { FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import type { AuthenticatedIdentity, IdentityService } from "./service.js";

const IDENTITY_COOKIE_NAME = "hmm_session";

function cookieValue(request: FastifyRequest, cookieName: string): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return value.join("=");
  }
  return undefined;
}

export async function requireAuthenticatedIdentity(
  request: FastifyRequest,
  service: IdentityService,
): Promise<AuthenticatedIdentity & { readonly token: SessionToken }> {
  const parsed = sessionTokenSchema.safeParse(cookieValue(request, IDENTITY_COOKIE_NAME));
  if (!parsed.success) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  const identity = await service.authenticateContext(parsed.data);
  if (identity === null) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  return { ...identity, token: parsed.data };
}
