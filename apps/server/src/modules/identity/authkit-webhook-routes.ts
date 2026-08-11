import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { ApiError } from "../../errors.js";
import {
  WORKOS_WEBHOOK_BODY_LIMIT,
  type WorkOSWebhookProcessor,
  WorkOSWebhookRejectedError,
  WorkOSWebhookUnavailableError,
} from "./authkit-webhook.js";

interface WorkOSWebhookRoutesOptions {
  readonly processor: WorkOSWebhookProcessor;
}

const webhookBodySchema = z.string().min(2).max(WORKOS_WEBHOOK_BODY_LIMIT);
const webhookSignatureSchema = z.string().min(1).max(2_048);

/** A separately scoped raw-body parser is required because signature verification covers bytes. */
export const workOSWebhookRoutes: FastifyPluginAsync<WorkOSWebhookRoutesOptions> = async (
  app,
  { processor },
) => {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: WORKOS_WEBHOOK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/auth/workos/webhook",
    { bodyLimit: WORKOS_WEBHOOK_BODY_LIMIT },
    async (request, reply) => {
      void reply.header("cache-control", "no-store");
      const payload = webhookBodySchema.safeParse(request.body);
      const signature = webhookSignatureSchema.safeParse(request.headers["workos-signature"]);
      if (!payload.success || !signature.success) {
        throw new ApiError(400, "BAD_REQUEST", "Invalid webhook request");
      }

      try {
        await processor.process({ payload: payload.data, signature: signature.data });
      } catch (error) {
        if (error instanceof WorkOSWebhookRejectedError) {
          throw new ApiError(400, "BAD_REQUEST", "Invalid webhook request");
        }
        if (error instanceof WorkOSWebhookUnavailableError) {
          request.log.error(
            { requestId: request.id },
            "WorkOS webhook processing is temporarily unavailable",
          );
          throw new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "Webhook processing is temporarily unavailable",
          );
        }
        throw error;
      }

      return reply.code(200).send();
    },
  );
};
