import {
  authCapabilitiesSchema,
  authKitCallbackQuerySchema,
  createDesktopAuthorizationRequestSchema,
  createDesktopAuthorizationResponseSchema,
  currentUserSchema,
  desktopAuthVariantSchema,
  desktopAuthCallbackParametersSchema,
  exchangeAuthHandoffRequestSchema,
  type DesktopAuthVariant,
} from "@hype-comms/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import { FixedWindowAttemptThrottle } from "../../throttle.js";
import { desktopCurrentUserResponse, setSessionCookie } from "./routes.js";
import type { AuthKitService } from "./authkit-service.js";
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

function validationDetails(issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => ({ field: issue.path.join("."), issue: issue.message }));
}

const AUTHORIZATION_START_LIMIT = 10;
const AUTHORIZATION_START_WINDOW_MS = 15 * 60 * 1_000;

export const authKitRoutes: FastifyPluginAsync<AuthKitRoutesOptions> = async (
  app,
  { authKitService, authKitAdmissionEnabled, identityService, cookieSecure, magicLinkAvailable },
) => {
  app.get("/auth/capabilities", async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return authCapabilitiesSchema.parse({
      authKit: authKitAdmissionEnabled && authKitService !== undefined,
      magicLink: magicLinkAvailable,
    });
  });

  if (!authKitAdmissionEnabled || authKitService === undefined) return;

  const authorizationStartThrottle = new FixedWindowAttemptThrottle({
    maxAttempts: AUTHORIZATION_START_LIMIT,
    windowMs: AUTHORIZATION_START_WINDOW_MS,
  });

  app.post("/auth/desktop-authorizations", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    const retryAfterMs = authorizationStartThrottle.recordAttempt(request.ip);
    if (retryAfterMs > 0) {
      void reply.header("retry-after", Math.ceil(retryAfterMs / 1_000).toString());
      throw new ApiError(429, "RATE_LIMITED", "Too many requests");
    }
    const result = createDesktopAuthorizationRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "Invalid authentication request",
        validationDetails(result.error.issues),
      );
    }

    const response = createDesktopAuthorizationResponseSchema.parse(
      await authKitService.beginDesktopAuthorization({
        codeChallenge: result.data.codeChallenge,
        desktopState: result.data.state,
        desktopAuthVariant: result.data.variant ?? "production",
      }),
    );
    return reply.code(201).send(response);
  });

  app.get("/auth/workos/callback", async (request, reply) => {
    void reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const result = authKitCallbackQuerySchema.safeParse(request.query);
    if (!result.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid authentication callback");
    }

    const completion = await authKitService.completeCallback(
      "code" in result.data
        ? {
            kind: "success",
            code: result.data.code,
            providerState: result.data.state,
            ipAddress: request.ip,
            ...(request.headers["user-agent"] === undefined
              ? {}
              : { userAgent: request.headers["user-agent"] }),
          }
        : {
            kind: "error",
            providerState: result.data.state,
          },
    );
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
    callbackUrl.searchParams.set("state", parameters.state);
    return reply.redirect(callbackUrl.href);
  });

  app.post("/auth/exchange", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    const result = exchangeAuthHandoffRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "Invalid authentication exchange",
        validationDetails(result.error.issues),
      );
    }

    const session = await authKitService.exchangeHandoff(
      result.data,
      request.headers["user-agent"],
    );
    const currentUser = await identityService.authenticate(session.token);
    if (currentUser === null) {
      throw new ApiError(500, "INTERNAL_ERROR", "The session could not be created");
    }
    setSessionCookie(reply, session, cookieSecure);
    return reply.code(200).send(currentUserSchema.parse(desktopCurrentUserResponse(currentUser)));
  });
};
