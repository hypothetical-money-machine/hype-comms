import {
  authCapabilitiesSchema,
  authKitCallbackQuerySchema,
  createDesktopAuthorizationRequestSchema,
  createDesktopAuthorizationResponseSchema,
  desktopAuthCallbackParametersSchema,
  desktopAuthVariantSchema,
  exchangeAuthHandoffRequestSchema,
  type DesktopAuthVariant,
} from "@hype-comms/contracts";
import { ApiError } from "../../errors.js";
import { publicPolicy } from "../../http/authentication-policies.js";
import { routeModule, validateRequest } from "../../http/route-registrar.js";
import { FixedWindowAttemptThrottle } from "../../throttle.js";
import type { AuthKitService } from "./authkit-service.js";
import { desktopCurrentUserResponse, setSessionCookie } from "./routes.js";
import type { IdentityService } from "./service.js";

const DESKTOP_CALLBACK_SCHEMES = {
  production: "hype-comms",
  development: "hype-comms-dev",
} as const satisfies Record<DesktopAuthVariant, string>;

interface AuthKitRoutesOptions {
  readonly authKitService?: AuthKitService;
  readonly authKitAdmissionEnabled: boolean;
  readonly identityService: IdentityService;
  readonly cookieSecure: boolean;
  readonly magicLinkAvailable: boolean;
}
function validationDetails(
  issues: readonly {
    path: PropertyKey[];
    message: string;
  }[],
) {
  return issues.map((issue) => ({ field: issue.path.join("."), issue: issue.message }));
}

const AUTHORIZATION_START_LIMIT = 10;
const AUTHORIZATION_START_WINDOW_MS = 15 * 60 * 1000;
export const authKitRoutes = routeModule<AuthKitRoutesOptions>(
  (
    routes,
    { authKitService, authKitAdmissionEnabled, identityService, cookieSecure, magicLinkAvailable },
  ) => {
    routes.register({
      method: "GET",
      url: "/auth/capabilities",
      policy: publicPolicy,
      scopes: [],
      request: {},
      handler: async ({ reply }) => {
        void reply.header("cache-control", "no-store");
        return authCapabilitiesSchema.parse({
          authKit: authKitAdmissionEnabled && authKitService !== undefined,
          magicLink: magicLinkAvailable,
        });
      },
    });

    if (!authKitAdmissionEnabled || authKitService === undefined) return;

    const authorizationStartThrottle = new FixedWindowAttemptThrottle({
      maxAttempts: AUTHORIZATION_START_LIMIT,
      windowMs: AUTHORIZATION_START_WINDOW_MS,
    });

    routes.register({
      method: "POST",
      url: "/auth/desktop-authorizations",
      policy: publicPolicy,
      scopes: [],
      beforeValidation: ({ request, reply }) => {
        void reply.header("cache-control", "no-store");
        const retryAfterMs = authorizationStartThrottle.recordAttempt(request.ip);
        if (retryAfterMs > 0) {
          void reply.header("retry-after", Math.ceil(retryAfterMs / 1000).toString());
          throw new ApiError(429, "RATE_LIMITED", "Too many requests");
        }
      },
      request: {
        body: validateRequest(
          createDesktopAuthorizationRequestSchema,
          (_value, error) =>
            new ApiError(
              400,
              "BAD_REQUEST",
              "Invalid authentication request",
              validationDetails(error.issues),
            ),
        ),
      },
      handler: async ({ input: { body }, reply }) => {
        const response = createDesktopAuthorizationResponseSchema.parse(
          await authKitService.beginDesktopAuthorization({
            codeChallenge: body.codeChallenge,
            desktopState: body.state,
            desktopAuthVariant: body.variant ?? "production",
          }),
        );
        return reply.code(201).send(response);
      },
    });

    routes.registerCredential({
      method: "POST",
      url: "/auth/exchange",
      scopes: [],
      beforeAuthentication: ({ reply }) => {
        void reply.header("cache-control", "no-store");
      },
      request: {
        body: validateRequest(
          exchangeAuthHandoffRequestSchema,
          (_value, error) =>
            new ApiError(
              400,
              "BAD_REQUEST",
              "Invalid authentication exchange",
              validationDetails(error.issues),
            ),
        ),
      },
      policy: {
        name: "authkit-handoff",
        authenticate: async ({ body }, request) => {
          const session = await authKitService.exchangeHandoff(body, request.headers["user-agent"]);
          const currentUser = await identityService.authenticate(session.token);
          if (currentUser === null) {
            throw new ApiError(500, "INTERNAL_ERROR", "The session could not be created");
          }
          return { session, currentUser };
        },
      },
      handler: async ({ identity: { session, currentUser }, reply }) => {
        setSessionCookie(reply, session, cookieSecure);
        return reply.code(200).send(desktopCurrentUserResponse(currentUser));
      },
    });
  },
);
/** Provider-configured callback address stays stable across workspace protocol upgrades. */
export const authKitCallbackRoutes = routeModule<
  Pick<AuthKitRoutesOptions, "authKitService" | "authKitAdmissionEnabled">
>((routes, { authKitService, authKitAdmissionEnabled }) => {
  if (!authKitAdmissionEnabled || authKitService === undefined) return;
  routes.registerCredential({
    method: "GET",
    url: "/auth/workos/callback",
    scopes: [],
    beforeAuthentication: ({ reply }) => {
      void reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    },
    request: {
      query: validateRequest(authKitCallbackQuerySchema, "Invalid authentication callback"),
    },
    policy: {
      name: "workos-callback-state",
      authenticate: async ({ query }, request) => {
        const completion = await authKitService.completeCallback(
          "code" in query
            ? {
                kind: "success",
                code: query.code,
                providerState: query.state,
                ipAddress: request.ip,
                ...(request.headers["user-agent"] === undefined
                  ? {}
                  : { userAgent: request.headers["user-agent"] }),
              }
            : {
                kind: "error",
                providerState: query.state,
              },
        );
        return completion;
      },
    },
    handler: async ({ identity: completion, request, reply }) => {
      if (completion.kind === "error" && completion.failureCategory !== undefined) {
        request.log.warn(
          { authKitFailureCategory: completion.failureCategory },
          "AuthKit callback failed",
        );
      }
      if (completion.kind === "error" && !("desktopState" in completion)) {
        const callbackUrl = new URL(`${DESKTOP_CALLBACK_SCHEMES.production}://auth/callback`);
        callbackUrl.searchParams.set("error", "authentication_failed");
        return reply.redirect(callbackUrl.href);
      }
      const parameters = desktopAuthCallbackParametersSchema.parse(
        completion.kind === "success"
          ? { code: completion.handoffCode, state: completion.desktopState }
          : { error: "authentication_failed", state: completion.desktopState },
      );
      const callbackVariant = desktopAuthVariantSchema.parse(completion.desktopAuthVariant);
      const callbackUrl = new URL(`${DESKTOP_CALLBACK_SCHEMES[callbackVariant]}://auth/callback`);
      if ("code" in parameters) {
        callbackUrl.searchParams.set("code", parameters.code);
      } else {
        callbackUrl.searchParams.set("error", parameters.error);
      }
      if (parameters.state !== undefined) {
        callbackUrl.searchParams.set("state", parameters.state);
      }
      return reply.redirect(callbackUrl.href);
    },
  });
});
