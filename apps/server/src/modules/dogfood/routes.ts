import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createDogfoodMessageRequestSchema,
  dogfoodMessageEventSchema,
  dogfoodSessionRequestSchema,
  type DogfoodSession,
} from "@hmm-chat/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { ApiError } from "../../errors.js";
import { DogfoodMessageConflictError, type DogfoodChatStore } from "./store.js";

const COOKIE_NAME = "hmm_chat_session";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

interface DogfoodRoutesOptions {
  readonly accessCode: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly store: DogfoodChatStore;
}

function equalSecrets(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signSession(session: DogfoodSession, accessCode: string): string {
  const payload = Buffer.from(
    JSON.stringify({ ...session, expiresAt: Date.now() + SESSION_LIFETIME_SECONDS * 1_000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", accessCode).update(payload).digest("base64url");
  return `${payload}.${signature}`;
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

function verifySession(request: FastifyRequest, accessCode: string): DogfoodSession {
  const token = cookieValue(request);
  if (token === undefined) throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  const expected = createHmac("sha256", accessCode).update(payload).digest("base64url");
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
    const { expiresAt: _expiresAt, ...session } = parsed;
    return dogfoodSessionRequestSchema.pick({ name: true }).parse(session);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in to continue");
  }
}

export const dogfoodRoutes: FastifyPluginAsync<DogfoodRoutesOptions> = async (
  app,
  { accessCode, allowedOrigins, store },
) => {
  app.post("/dogfood/session", async (request, reply) => {
    const result = dogfoodSessionRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid sign-in request");
    if (!equalSecrets(result.data.accessCode, accessCode)) {
      throw new ApiError(401, "UNAUTHORIZED", "Name or access code is invalid");
    }
    const token = signSession({ name: result.data.name }, accessCode);
    void reply.header(
      "set-cookie",
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_LIFETIME_SECONDS}`,
    );
    return reply.code(204).send();
  });

  app.delete("/dogfood/session", async (_request, reply) => {
    void reply.header(
      "set-cookie",
      `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    );
    return reply.code(204).send();
  });

  app.get("/dogfood/session", async (request) => verifySession(request, accessCode));
  app.get("/dogfood/welcome/messages", async (request) => {
    verifySession(request, accessCode);
    return store.history();
  });
  app.post("/dogfood/welcome/messages", async (request, reply) => {
    const session = verifySession(request, accessCode);
    const result = createDogfoodMessageRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid message");
    try {
      const created = store.create(session.name, result.data);
      return reply.code(created.created ? 201 : 200).send(created.message);
    } catch (error) {
      if (error instanceof DogfoodMessageConflictError) {
        throw new ApiError(409, "CONFLICT", error.message);
      }
      throw error;
    }
  });

  app.get(
    "/dogfood/welcome/realtime",
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin === undefined || !allowedOrigins.has(origin)) {
          throw new ApiError(403, "FORBIDDEN", "Origin is not allowed");
        }
        verifySession(request, accessCode);
      },
    },
    (socket) => {
      const unsubscribe = store.subscribe((message) => {
        try {
          socket.send(
            JSON.stringify(
              dogfoodMessageEventSchema.parse({
                version: 1,
                type: "dogfood.welcome_message_created",
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
