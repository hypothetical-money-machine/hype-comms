import { z } from "zod";
import {
  type RouteRegistrar,
  validateRequest,
  type AuthenticationPolicy,
} from "../../src/http/route-registrar.js";

const policy: AuthenticationPolicy<{ userId: string }, readonly ("read" | "write")[]> = {
  name: "typed-test-policy",
  authenticate: async () => ({ userId: "user-1" }),
};

/** Compile-only assertions: intentionally invalid declarations must keep failing typecheck. */
export function checkRouteDeclarationTypes(routes: RouteRegistrar): void {
  const definition = {
    method: "POST" as const,
    url: "/typed",
    policy,
    scopes: ["read"] as const,
    request: { body: validateRequest(z.object({ title: z.string() }).strict(), "Invalid title") },
    handler: () => undefined,
  };
  const { policy: omittedPolicy, ...withoutPolicy } = definition;
  void omittedPolicy;
  // @ts-expect-error Authentication is mandatory, including for explicitly public endpoints.
  routes.register(withoutPolicy);
  const { scopes: omittedScopes, ...withoutScopes } = definition;
  void omittedScopes;
  // @ts-expect-error Static scopes must be declared even when the policy needs no scopes.
  routes.register(withoutScopes);
  const { request: omittedSchemas, ...withoutSchemas } = definition;
  void omittedSchemas;
  // @ts-expect-error Request declarations are required.
  routes.register(withoutSchemas);
  // @ts-expect-error Scope names come from this policy, not an unrestricted string array.
  routes.register({ ...definition, scopes: ["admin"] });
  // @ts-expect-error A misspelled request part cannot be parsed from Fastify's request.
  routes.register({ ...definition, request: { boddy: definition.request.body } });
  routes.register({
    ...definition,
    handler: ({ input, request }) => {
      const title: string = input.body.title;
      void title;
      // @ts-expect-error Only declared request parts are available.
      void input.query;
      // @ts-expect-error Handlers cannot skip declared body validation.
      void request.body;
      // @ts-expect-error Handlers cannot skip declared query validation.
      void request.query;
      // @ts-expect-error Handlers cannot skip declared path validation.
      void request.params;
    },
  });
}
