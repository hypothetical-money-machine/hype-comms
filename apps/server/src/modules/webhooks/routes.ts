import {
  INCOMING_WEBHOOK_BODY_LIMIT_BYTES,
  botAccessTokenSchema,
  channelWebhookResponseSchema,
  entityIdSchema,
  incomingWebhookIdempotencyKeySchema,
  incomingWebhookMessageRequestSchema,
  issuedChannelWebhookResponseSchema,
  manageChannelWebhookRequestSchema,
} from "@hype-comms/contracts";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { humanPolicy } from "../../http/authentication-policies.js";
import { routeModule, validateRequest } from "../../http/route-registrar.js";

import { ApiError } from "../../errors.js";
import { FixedWindowAttemptThrottle } from "../../throttle.js";
import type { BotService } from "../bots/service.js";
import type { IdentityService } from "../identity/service.js";
import type { WorkspaceRepository } from "../workspace/repository.js";

const WEBHOOK_POST_LIMIT = 60;
const WEBHOOK_POST_WINDOW_MS = 60 * 1_000;

interface ChannelWebhookRoutesOptions {
  readonly identityService: IdentityService;
  readonly botService: BotService;
  readonly repository: WorkspaceRepository;
  readonly throttle?: FixedWindowAttemptThrottle;
}

const channelParams = validateRequest(
  z.object({ id: entityIdSchema }).strict(),
  "Invalid channel id",
);
const manageBody = validateRequest(manageChannelWebhookRequestSchema, "Invalid webhook request");

function secretResponse(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff");
}

export const channelWebhookRoutes = routeModule<ChannelWebhookRoutesOptions>((routes, options) => {
  const human = humanPolicy(options.identityService);

  routes.register({
    method: "GET",
    url: "/channels/:id/webhook",
    policy: human,
    scopes: [],
    request: { params: channelParams },
    handler: async ({
      identity,
      input: {
        params: { id },
      },
    }) => {
      return channelWebhookResponseSchema.parse({
        webhook: await options.botService.getChannelWebhook(identity.currentUser.user.id, id),
      });
    },
  });

  routes.register({
    method: "POST",
    url: "/channels/:id/webhook",
    policy: human,
    scopes: [],
    request: { body: manageBody, params: channelParams },
    handler: async ({
      identity,
      reply,
      input: {
        params: { id },
      },
    }) => {
      const issued = await options.botService.enableChannelWebhook(
        identity.currentUser.user.id,
        id,
      );
      return secretResponse(reply).code(201).send(issuedChannelWebhookResponseSchema.parse(issued));
    },
  });

  routes.register({
    method: "POST",
    url: "/channels/:id/webhook/rotate",
    policy: human,
    scopes: [],
    request: { body: manageBody, params: channelParams },
    handler: async ({
      identity,
      reply,
      input: {
        params: { id },
      },
    }) => {
      const issued = await options.botService.rotateChannelWebhook(
        identity.currentUser.user.id,
        id,
      );
      return secretResponse(reply).code(201).send(issuedChannelWebhookResponseSchema.parse(issued));
    },
  });

  routes.register({
    method: "DELETE",
    url: "/channels/:id/webhook",
    policy: human,
    scopes: [],
    request: { params: channelParams },
    handler: async ({
      identity,
      input: {
        params: { id },
      },
    }) => {
      return channelWebhookResponseSchema.parse({
        webhook: await options.botService.disableChannelWebhook(identity.currentUser.user.id, id),
      });
    },
  });
});

/** External webhook jobs keep their configured URL; management uses the current product API. */
export const incomingWebhookRoutes = routeModule<ChannelWebhookRoutesOptions>((routes, options) => {
  const throttle =
    options.throttle ??
    new FixedWindowAttemptThrottle({
      maxAttempts: WEBHOOK_POST_LIMIT,
      windowMs: WEBHOOK_POST_WINDOW_MS,
    });
  routes.registerCredential({
    method: "POST",
    url: "/webhooks/incoming/:token",
    bodyLimit: INCOMING_WEBHOOK_BODY_LIMIT_BYTES,
    logLevel: "silent",
    scopes: [],
    request: {
      params: validateRequest(
        z.object({ token: botAccessTokenSchema }).strict(),
        () => new ApiError(401, "UNAUTHORIZED", "Webhook URL is invalid or disabled"),
      ),
      body: validateRequest(incomingWebhookMessageRequestSchema, "Invalid webhook message"),
      headers: validateRequest(
        z.object({ "idempotency-key": incomingWebhookIdempotencyKeySchema }),
        "A UUID Idempotency-Key is required",
      ),
    },
    policy: {
      name: "channel-webhook-token",
      authenticate: async ({ params }) => {
        const authenticated = await options.botService.authenticateChannelWebhook(params.token);
        if (authenticated === null) {
          throw new ApiError(401, "UNAUTHORIZED", "Webhook URL is invalid or disabled");
        }
        return authenticated;
      },
    },
    handler: async ({
      identity: authenticated,
      input: {
        body,
        headers: { "idempotency-key": idempotencyKey },
      },
      request,
      reply,
    }) => {
      const retryAfterMs = throttle.recordAttempt(authenticated.identity.credentialId);
      if (retryAfterMs > 0) {
        void reply.header("retry-after", Math.max(1, Math.ceil(retryAfterMs / 1_000)));
        throw new ApiError(429, "RATE_LIMITED", "Too many webhook posts");
      }
      return reply.code(201).send(
        await options.repository.sendMessage(
          authenticated.identity,
          authenticated.conversationId,
          {
            body: body.body,
            bodyFormat: "hype_comms_markdown_v1",
            clientMessageId: idempotencyKey,
            threadRootId: null,
            mentionedUserIds: [],
            attachmentIds: [],
          },
          request.id,
        ),
      );
    },
  });
});
