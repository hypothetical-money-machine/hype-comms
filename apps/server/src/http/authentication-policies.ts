import type { AgentScope, BotScope } from "@hype-comms/contracts";

import {
  requireAuthenticatedIdentity,
  requireHumanIdentity,
  requireAgentScope,
  requireAnyAgentScope,
  type AuthenticatedRequestIdentity,
} from "../modules/identity/request-auth.js";
import type { IdentityService } from "../modules/identity/service.js";
import {
  requireTaskIdentity,
  type AuthenticatedTaskIdentity,
} from "../modules/bots/request-auth.js";
import type { BotService } from "../modules/bots/service.js";
import type { AuthenticationPolicy } from "./route-registrar.js";

export type AgentScopeRequirements = readonly (
  AgentScope | { readonly any: readonly AgentScope[] }
)[];

export function workspacePolicy(
  service: IdentityService,
  available: () => void = () => undefined,
): AuthenticationPolicy<AuthenticatedRequestIdentity, AgentScopeRequirements> {
  return {
    name: "workspace-identity",
    authenticate: async (request, scopes) => {
      const identity = await requireAuthenticatedIdentity(request, service);
      available();
      for (const scope of scopes) {
        if (typeof scope === "string") requireAgentScope(identity, scope);
        else requireAnyAgentScope(identity, scope.any);
      }
      return identity;
    },
  };
}

export function humanPolicy(
  service: IdentityService,
): AuthenticationPolicy<Awaited<ReturnType<typeof requireHumanIdentity>>, readonly []> {
  return {
    name: "human-session",
    authenticate: (request) => requireHumanIdentity(request, service),
  };
}

export function taskPolicy(
  service: IdentityService,
  bots: BotService | undefined,
): AuthenticationPolicy<AuthenticatedTaskIdentity, readonly [BotScope]> {
  return {
    name: "task-human-or-bot",
    authenticate: (request, [scope]) => requireTaskIdentity(request, service, bots, scope),
  };
}

/** Public entry points must opt in explicitly; protected routes cannot omit a policy. */
export const publicPolicy: AuthenticationPolicy<undefined, readonly []> = {
  name: "public",
  authenticate: async () => undefined,
};
