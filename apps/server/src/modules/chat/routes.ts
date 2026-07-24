import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createChatMessageRequestSchema,
  chatMessageEventSchema,
  chatSignInRequestSchema,
  chatIdentitySchema,
  sessionTokenSchema,
  type ChatIdentity,
} from "@hmm-chat/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import { SignInThrottle } from "../../throttle.js";
import type { IdentityService } from "../identity/service.js";
import { ChatMessageConflictError, type ChatStore } from "./store.js";

const COOKIE_NAME = "hmm_chat_session";
const IDENTITY_COOKIE_NAME = "hmm_session";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

interface ChatRoutesOptions {
  readonly accessCode: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly store: ChatStore;
  readonly cookieSecure: boolean;
  readonly throttle?: SignInThrottle;
  readonly identityService?: IdentityService;
}

function equalSecrets(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Binds the persisted server secret to the current access code so that rotating the access code
 * invalidates every outstanding session, while knowing the access code alone is never enough to
 * forge one.
 */
function deriveSigningKey(sessionKey: Buffer, accessCode: string): Buffer {
  return createHmac("sha256", sessionKey).update(accessCode).digest();
}

function signSession(session: ChatIdentity, signingKey: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({ ...session, expiresAt: Date.now() + SESSION_LIFETIME_SECONDS * 1_000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function cookieValue(request: FastifyRequest, cookieName: string): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return value.join("=");
  }
  return undefined;
}

function verifySession(request: FastifyRequest, signingKey: Buffer): ChatIdentity {
  const token = cookieValue(request, COOKIE_NAME);
  if (token === undefined) throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  const expected = createHmac("sha256", signingKey).update(payload).digest("base64url");
  if (!equalSecrets(signature, expected)) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("expiresAt" in parsed) ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now()
    ) {
      throw new Error("Expired session");
    }
    return chatIdentitySchema.parse({ name: "name" in parsed ? parsed.name : undefined });
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
}

async function resolveChatCaller(
  request: FastifyRequest,
  signingKey: Buffer,
  identityService?: IdentityService,
): Promise<ChatIdentity> {
  if (cookieValue(request, COOKIE_NAME) !== undefined) {
    return verifySession(request, signingKey);
  }

  const identityCookie = cookieValue(request, IDENTITY_COOKIE_NAME);
  if (identityService !== undefined && identityCookie !== undefined) {
    const token = sessionTokenSchema.safeParse(identityCookie);
    if (token.success) {
      const currentUser = await identityService.authenticate(token.data);
      if (currentUser !== null) {
        // A user display name may be up to 120 characters, but a chat author name may only be 80.
        // Truncating keeps a long name cosmetically wrong instead of failing every chat request
        // with a schema error the caller can do nothing about.
        return chatIdentitySchema.parse({ name: currentUser.user.displayName.slice(0, 80) });
      }
    }
  }

  throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (
  app,
  {
    accessCode,
    allowedOrigins,
    store,
    cookieSecure,
    throttle = new SignInThrottle(),
    identityService,
  },
) => {
  const signingKey = deriveSigningKey(store.sessionKey, accessCode);

  app.post("/chat/session", async (request, reply) => {
    const retryAfterMs = throttle.retryAfterMs(request.ip);
    if (retryAfterMs > 0) {
      void reply.header("retry-after", String(Math.ceil(retryAfterMs / 1_000)));
      throw new ApiError(429, "RATE_LIMITED", "Too many sign-in attempts. Try again later.");
    }

    const result = chatSignInRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid sign-in request");
    if (!equalSecrets(result.data.accessCode, accessCode)) {
      throttle.recordFailure(request.ip);
      throw new ApiError(401, "UNAUTHORIZED", "Name or access code is invalid");
    }

    throttle.recordSuccess(request.ip);
    const token = signSession({ name: result.data.name }, signingKey);
    void reply.header("set-cookie", sessionCookie(token, cookieSecure, SESSION_LIFETIME_SECONDS));
    return reply.code(204).send();
  });

  app.delete("/chat/session", async (_request, reply) => {
    void reply.header("set-cookie", sessionCookie("", cookieSecure, 0));
    return reply.code(204).send();
  });

  app.get("/chat/session", async (request) => verifySession(request, signingKey));
  app.get("/chat/welcome/messages", async (request) => {
    await resolveChatCaller(request, signingKey, identityService);
    return store.history();
  });
  app.post("/chat/welcome/messages", async (request, reply) => {
    const session = await resolveChatCaller(request, signingKey, identityService);
    const result = createChatMessageRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid message");
    try {
      const created = store.create(session.name, result.data);
      return reply.code(created.created ? 201 : 200).send(created.message);
    } catch (error) {
      if (error instanceof ChatMessageConflictError) {
        throw new ApiError(409, "CONFLICT", error.message);
      }
      throw error;
    }
  });

  app.get(
    "/chat/welcome/realtime",
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin === undefined || !allowedOrigins.has(origin)) {
          throw new ApiError(403, "FORBIDDEN", "Origin is not allowed");
        }
        await resolveChatCaller(request, signingKey, identityService);
      },
    },
    (socket) => {
      const unsubscribe = store.subscribe((message) => {
        try {
          socket.send(
            JSON.stringify(
              chatMessageEventSchema.parse({
                version: 1,
                type: "chat.welcome_message_created",
                message,
              }),
            ),
          );
        } catch {
          unsubscribe();
        }
      });
      socket.once("close", unsubscribe);
      socket.once("error", unsubscribe);
    },
  );
};
