import {
  advanceReadCursorRequestSchema,
  archiveChannelRequestSchema,
  createChannelRequestSchema,
  directConversationRequestSchema,
  entityIdSchema,
  listConversationsQuerySchema,
  messageHistoryQuerySchema,
  sendConversationMessageRequestSchema,
  syncQuerySchema,
  upsertChannelMemberRequestSchema,
} from "@hmm-chat/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import { requireAuthenticatedIdentity } from "../identity/request-auth.js";
import type { IdentityService } from "../identity/service.js";
import type { WorkspaceRepository } from "./repository.js";

interface WorkspaceRoutesOptions {
  readonly identityService: IdentityService;
  readonly repository: WorkspaceRepository;
}

function parameters(value: unknown): { readonly id: string } {
  const result = entityIdSchema.safeParse(
    typeof value === "object" && value !== null && "id" in value ? value.id : undefined,
  );
  if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid resource id");
  return { id: result.data };
}

function memberParameters(value: unknown): { readonly id: string; readonly userId: string } {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid resource ids");
  }
  const id = entityIdSchema.safeParse("id" in value ? value.id : undefined);
  const userId = entityIdSchema.safeParse("userId" in value ? value.userId : undefined);
  if (!id.success || !userId.success) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid resource ids");
  }
  return { id: id.data, userId: userId.data };
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRoutesOptions> = async (
  app,
  { identityService, repository },
) => {
  app.get("/bootstrap", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    return repository.bootstrap(identity);
  });

  app.get("/members", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    return repository.listMembers(identity);
  });

  app.get("/conversations", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid conversation query");
    return repository.listConversations(identity, query.data.after, query.data.limit);
  });

  app.post("/channels", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const result = createChannelRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel");
    return reply.code(201).send(await repository.createChannel(identity, result.data));
  });

  app.patch("/channels/:id", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id } = parameters(request.params);
    const result = archiveChannelRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel update");
    return repository.archiveChannel(identity, id);
  });

  app.get("/channels/:id/members", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id } = parameters(request.params);
    return repository.listChannelMembers(identity, id);
  });

  app.put("/channels/:id/members/:userId", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id, userId } = memberParameters(request.params);
    const body = upsertChannelMemberRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel member");
    return repository.upsertChannelMember(identity, id, userId, body.data);
  });

  app.delete("/channels/:id/members/:userId", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id, userId } = memberParameters(request.params);
    return repository.removeChannelMember(identity, id, userId);
  });

  app.post("/direct-conversations", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const result = directConversationRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid direct-conversation request");
    }
    return reply.code(201).send(await repository.createDirectConversation(identity, result.data));
  });

  app.get("/conversations/:id/messages", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id } = parameters(request.params);
    const query = messageHistoryQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid history query");
    return repository.history(identity, id, query.data.before, query.data.limit);
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id } = parameters(request.params);
    const body = sendConversationMessageRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid message");
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey !== body.data.clientMessageId) {
      throw new ApiError(400, "BAD_REQUEST", "Idempotency-Key must equal the client message ID");
    }
    return reply.code(201).send(await repository.sendMessage(identity, id, body.data));
  });

  app.put("/conversations/:id/read-cursor", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const { id } = parameters(request.params);
    const body = advanceReadCursorRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid read cursor");
    return repository.advanceReadCursor(identity, id, body.data.lastReadMessageId);
  });

  app.get("/sync", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    const query = syncQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid sync cursor");
    return repository.sync(identity, query.data.after, query.data.limit);
  });

  app.post("/realtime/tickets", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    return repository.issueRealtimeTicket(identity);
  });
};
