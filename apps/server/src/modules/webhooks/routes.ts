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
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { ApiError } from "../../errors.js";
import { FixedWindowAttemptThrottle } from "../../throttle.js";
import type { BotService } from "../bots/service.js";
import { requireHumanIdentity } from "../identity/request-auth.js";
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

function channelId(value: unknown): string {
  const parsed = entityIdSchema.safeParse(
    typeof value === "object" && value !== null && "id" in value ? value.id : undefined,
  );
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel id");
  return parsed.data;
}

function webhookToken(value: unknown): string {
  const parsed = botAccessTokenSchema.safeParse(
    typeof value === "object" && value !== null && "token" in value ? value.token : undefined,
  );
  if (!parsed.success)
    throw new ApiError(401, "UNAUTHORIZED", "Webhook URL is invalid or disabled");
  return parsed.data;
}

function manageRequest(value: unknown): void {
  const parsed = manageChannelWebhookRequestSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid webhook request");
}

function secretResponse(reply: FastifyReply): FastifyReply {
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff");
}

export const channelWebhookRoutes: FastifyPluginAsync<ChannelWebhookRoutesOptions> = async (
  app,
  options,
) => {
  const throttle =
    options.throttle ??
    new FixedWindowAttemptThrottle({
      maxAttempts: WEBHOOK_POST_LIMIT,
      windowMs: WEBHOOK_POST_WINDOW_MS,
    });

  app.get("/channels/:id/webhook", async (request) => {
    const identity = await requireHumanIdentity(request, options.identityService);
    return channelWebhookResponseSchema.parse({
      webhook: await options.botService.getChannelWebhook(
        identity.currentUser.user.id,
        channelId(request.params),
      ),
    });
  });

  app.post("/channels/:id/webhook", async (request, reply) => {
    const identity = await requireHumanIdentity(request, options.identityService);
    manageRequest(request.body);
    const issued = await options.botService.enableChannelWebhook(
      identity.currentUser.user.id,
      channelId(request.params),
    );
    return secretResponse(reply).code(201).send(issuedChannelWebhookResponseSchema.parse(issued));
  });

  app.post("/channels/:id/webhook/rotate", async (request, reply) => {
    const identity = await requireHumanIdentity(request, options.identityService);
    manageRequest(request.body);
    const issued = await options.botService.rotateChannelWebhook(
      identity.currentUser.user.id,
      channelId(request.params),
    );
    return secretResponse(reply).code(201).send(issuedChannelWebhookResponseSchema.parse(issued));
  });

  app.delete("/channels/:id/webhook", async (request) => {
    const identity = await requireHumanIdentity(request, options.identityService);
    return channelWebhookResponseSchema.parse({
      webhook: await options.botService.disableChannelWebhook(
        identity.currentUser.user.id,
        channelId(request.params),
      ),
    });
  });

  app.post(
    "/webhooks/incoming/:token",
    { bodyLimit: INCOMING_WEBHOOK_BODY_LIMIT_BYTES, logLevel: "silent" },
    async (request, reply) => {
      const token = webhookToken(request.params);
      const body = incomingWebhookMessageRequestSchema.safeParse(request.body);
      if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid webhook message");
      const idempotencyKey = incomingWebhookIdempotencyKeySchema.safeParse(
        request.headers["idempotency-key"],
      );
      if (!idempotencyKey.success) {
        throw new ApiError(400, "BAD_REQUEST", "A UUID Idempotency-Key is required");
      }
      const authenticated = await options.botService.authenticateChannelWebhook(token);
      if (authenticated === null) {
        throw new ApiError(401, "UNAUTHORIZED", "Webhook URL is invalid or disabled");
      }
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
            body: body.data.body,
            bodyFormat: "hype_comms_markdown_v1",
            clientMessageId: idempotencyKey.data,
            threadRootId: null,
            mentionedUserIds: [],
            attachmentIds: [],
          },
          request.id,
        ),
      );
    },
  );
};
