import { routeModule, validateRequest } from "../../http/route-registrar.js";
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
export const workOSWebhookRoutes = routeModule<WorkOSWebhookRoutesOptions>(
  async (routes, { processor }) => {
    await routes.rawJsonText(WORKOS_WEBHOOK_BODY_LIMIT, (webhooks) => {
      webhooks.registerCredential({
        method: "POST",
        url: "/auth/workos/webhook",
        bodyLimit: WORKOS_WEBHOOK_BODY_LIMIT,
        scopes: [],
        beforeAuthentication: ({ reply }) => {
          void reply.header("cache-control", "no-store");
        },
        request: {
          body: validateRequest(webhookBodySchema, "Invalid webhook request"),
          headers: validateRequest(
            z.object({ "workos-signature": webhookSignatureSchema }),
            "Invalid webhook request",
          ),
        },
        policy: {
          name: "signed-workos-event",
          // The processor verifies the signature before applying the event. Keep that operation atomic.
          authenticate: async (
            { body: payload, headers: { "workos-signature": signature } },
            request,
          ) => {
            try {
              await processor.process({ payload, signature });
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
          },
        },
        handler: ({ reply }) => reply.code(200).send(),
      });
    });
  },
);
