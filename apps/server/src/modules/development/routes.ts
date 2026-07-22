import {
  createDevelopmentWelcomeMessageRequestSchema,
  type DevelopmentWelcomeMessageEvent,
} from "@hmm-chat/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import { DevelopmentMessageConflictError, type DevelopmentWelcomeStore } from "./welcome-store.js";

interface DevelopmentChatRoutesOptions {
  allowedOrigins: ReadonlySet<string>;
  store: DevelopmentWelcomeStore;
}

export const developmentChatRoutes: FastifyPluginAsync<DevelopmentChatRoutesOptions> = async (
  app,
  { allowedOrigins, store },
) => {
  app.get("/development/welcome/messages", async () => store.history());

  app.post("/development/welcome/messages", async (request, reply) => {
    const result = createDevelopmentWelcomeMessageRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "Invalid welcome message",
        result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          issue: issue.message,
        })),
      );
    }

    try {
      const created = store.create(result.data);
      return reply.code(created.created ? 201 : 200).send(created.message);
    } catch (error) {
      if (error instanceof DevelopmentMessageConflictError) {
        throw new ApiError(409, "CONFLICT", error.message);
      }
      throw error;
    }
  });

  app.get(
    "/development/welcome/realtime",
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (origin === undefined || !allowedOrigins.has(origin)) {
          throw new ApiError(403, "FORBIDDEN", "Origin is not allowed");
        }
      },
    },
    (socket) => {
      let unsubscribe = (): void => undefined;
      unsubscribe = store.subscribe((message) => {
        const event: DevelopmentWelcomeMessageEvent = {
          version: 1,
          type: "development.welcome_message_created",
          message,
        };
        try {
          socket.send(JSON.stringify(event));
        } catch {
          unsubscribe();
        }
      });

      socket.once("close", unsubscribe);
      socket.once("error", unsubscribe);
    },
  );
};
