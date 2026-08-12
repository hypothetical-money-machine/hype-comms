import {
  ANNOUNCEMENT_CHANNELS_CAPABILITY,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  TASK_EVENTS_CAPABILITY,
  THREADS_CAPABILITY,
  advanceReadCursorRequestSchema,
  archiveChannelRequestSchema,
  channelSlugSchema,
  clientCapabilitiesHeaderSchema,
  createChannelRequestSchema,
  createTaskRequestSchema,
  directConversationRequestSchema,
  entityIdSchema,
  idempotencyKeySchema,
  listConversationsQuerySchema,
  listMessageReactionsRequestSchema,
  messageHistoryQuerySchema,
  messageSearchQuerySchema,
  moveTaskRequestSchema,
  reactionEmojiSchema,
  sendConversationMessageRequestSchema,
  syncQuerySchema,
  taskListQuerySchema,
  taskNumberSchema,
  updateTaskRequestSchema,
  upsertChannelMemberRequestSchema,
} from "@hype-comms/contracts";
import type {
  ConversationMutationResponse,
  ConversationSummary,
  ListConversationsResponse,
  WorkspaceBootstrapResponse,
} from "@hype-comms/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import { requireTaskIdentity } from "../bots/request-auth.js";
import type { BotService } from "../bots/service.js";
import { requireAgentScope, requireAuthenticatedIdentity } from "../identity/request-auth.js";
import type { IdentityService } from "../identity/service.js";
import type { WorkspaceRepository } from "./repository.js";

interface WorkspaceRoutesOptions {
  readonly identityService: IdentityService;
  readonly botService?: BotService;
  readonly repository: WorkspaceRepository;
}

function optionalIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid Idempotency-Key");
  return parsed.data;
}

function requiredIdempotencyKey(value: string | string[] | undefined): string {
  const parsed = optionalIdempotencyKey(value);
  if (parsed === undefined) throw new ApiError(400, "BAD_REQUEST", "Idempotency-Key is required");
  return parsed;
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

function channelParameters(value: unknown): { readonly slug: string } {
  const result = channelSlugSchema.safeParse(
    typeof value === "object" && value !== null && "slug" in value ? value.slug : undefined,
  );
  if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel slug");
  return { slug: result.data };
}

function channelTaskParameters(value: unknown): { readonly slug: string; readonly number: string } {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid channel task reference");
  }
  const slug = channelSlugSchema.safeParse("slug" in value ? value.slug : undefined);
  const number = taskNumberSchema.safeParse("number" in value ? value.number : undefined);
  if (!slug.success || !number.success) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid channel task reference");
  }
  return { slug: slug.data, number: number.data };
}

function reactionParameters(value: unknown): { readonly id: string; readonly emoji: string } {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid reaction");
  }
  const id = entityIdSchema.safeParse("id" in value ? value.id : undefined);
  const emoji = reactionEmojiSchema.safeParse("emoji" in value ? value.emoji : undefined);
  if (!id.success || !emoji.success) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid reaction");
  }
  return { id: id.data, emoji: emoji.data };
}

function capabilities(value: string | string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") {
    throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  }
  const parsed = clientCapabilitiesHeaderSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "BAD_REQUEST", "Invalid client capabilities");
  return parsed.data;
}

function withoutChannelMode(summary: ConversationSummary) {
  const conversation: Partial<ConversationSummary["conversation"]> = { ...summary.conversation };
  delete conversation.channelMode;
  return { ...summary, conversation };
}

function projectBootstrap(response: WorkspaceBootstrapResponse, capable: boolean) {
  if (capable) return response;
  const featureFlags: Partial<WorkspaceBootstrapResponse["featureFlags"]> = {
    ...response.featureFlags,
  };
  delete featureFlags.announcementChannels;
  return {
    ...response,
    conversations: response.conversations.map(withoutChannelMode),
    featureFlags,
  };
}

function projectConversationList(response: ListConversationsResponse, capable: boolean) {
  if (capable) return response;
  return { ...response, conversations: response.conversations.map(withoutChannelMode) };
}

function projectConversationMutation(response: ConversationMutationResponse, capable: boolean) {
  if (capable || response.conversation === undefined) return response;
  return { ...response, conversation: withoutChannelMode(response.conversation) };
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRoutesOptions> = async (app, options) => {
  const { identityService, botService, repository } = options;
  app.get("/bootstrap", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return projectBootstrap(
      await repository.bootstrap(identity),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
    );
  });

  app.get("/members", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    return repository.listMembers(identity);
  });

  app.get("/conversations", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid conversation query");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return projectConversationList(
      await repository.listConversations(identity, query.data.after, query.data.limit),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
    );
  });

  app.post("/channels", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const result = createChannelRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    const capable = supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY);
    const created = await repository.createChannel(
      identity,
      result.data,
      optionalIdempotencyKey(request.headers["idempotency-key"]),
      capable,
      request.id,
    );
    return reply.code(201).send(projectConversationMutation(created, capable));
  });

  app.patch("/channels/:id", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const { id } = parameters(request.params);
    const result = archiveChannelRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel update");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return projectConversationMutation(
      await repository.archiveChannel(identity, id),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
    );
  });

  app.get("/channels/:id/members", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    return repository.listChannelMembers(identity, id);
  });

  app.put("/channels/:id/members/:userId", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const { id, userId } = memberParameters(request.params);
    const body = upsertChannelMemberRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel member");
    return repository.upsertChannelMember(identity, id, userId, body.data);
  });

  app.delete("/channels/:id/members/:userId", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const { id, userId } = memberParameters(request.params);
    return repository.removeChannelMember(identity, id, userId);
  });

  app.post("/direct-conversations", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const result = directConversationRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid direct-conversation request");
    }
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return reply
      .code(201)
      .send(
        projectConversationMutation(
          await repository.createDirectConversation(identity, result.data),
          supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        ),
      );
  });

  app.get("/conversations/:id/messages", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const query = messageHistoryQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid history query");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    const supportsThreads = supported.includes(THREADS_CAPABILITY);
    const history = await repository.history(
      identity,
      id,
      query.data.before,
      query.data.limit,
      !supportsThreads,
    );
    if (supportsThreads) return history;
    return { messages: history.messages, nextCursor: history.nextCursor };
  });

  app.get("/messages/:id/thread", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const query = messageHistoryQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid thread query");
    return repository.thread(identity, id, query.data.before, query.data.limit);
  });

  app.get("/messages/:id", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    return repository.messageById(identity, id);
  });

  app.get("/search", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const query = messageSearchQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid search query");
    return repository.searchMessages(
      identity,
      query.data.query,
      query.data.after,
      query.data.limit,
    );
  });

  app.get("/conversations/:id/tasks", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:read");
    const { id } = parameters(request.params);
    const query = taskListQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task query");
    const { after, limit, ...filters } = query.data;
    return repository.listConversationTasks(identity, id, after, limit, filters);
  });

  app.get("/channels/:slug/tasks", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:read");
    const { slug } = channelParameters(request.params);
    const query = taskListQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task query");
    const { after, limit, ...filters } = query.data;
    return repository.listChannelTasks(identity, slug, after, limit, filters);
  });

  app.get("/channels/:slug/tasks/:number", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:read");
    const { slug, number } = channelTaskParameters(request.params);
    return repository.getChannelTaskByNumber(identity, slug, number);
  });

  app.get("/tasks/mine", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:read");
    const query = taskListQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task query");
    const { after, limit, ...filters } = query.data;
    return repository.listMyTasks(identity, after, limit, filters);
  });

  app.get("/tasks/:id", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:read");
    const { id } = parameters(request.params);
    return repository.getTask(identity, id);
  });

  app.post("/conversations/:id/tasks", async (request, reply) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:write");
    const { id } = parameters(request.params);
    const body = createTaskRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task");
    return reply
      .code(201)
      .send(
        await repository.createTask(
          identity,
          id,
          body.data,
          requiredIdempotencyKey(request.headers["idempotency-key"]),
        ),
      );
  });

  app.post("/channels/:slug/tasks", async (request, reply) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:write");
    const { slug } = channelParameters(request.params);
    const body = createTaskRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task");
    return reply
      .code(201)
      .send(
        await repository.createChannelTask(
          identity,
          slug,
          body.data,
          requiredIdempotencyKey(request.headers["idempotency-key"]),
        ),
      );
  });

  app.patch("/tasks/:id", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:write");
    const { id } = parameters(request.params);
    const body = updateTaskRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task update");
    return repository.updateTask(
      identity,
      id,
      body.data,
      requiredIdempotencyKey(request.headers["idempotency-key"]),
    );
  });

  app.post("/tasks/:id/move", async (request) => {
    const identity = await requireTaskIdentity(request, identityService, botService, "tasks:write");
    const { id } = parameters(request.params);
    const body = moveTaskRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid task move");
    return repository.moveTask(
      identity,
      id,
      body.data,
      requiredIdempotencyKey(request.headers["idempotency-key"]),
    );
  });

  app.post("/conversations/:id/messages", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "messages:write");
    const { id } = parameters(request.params);
    const body = sendConversationMessageRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid message");
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey !== body.data.clientMessageId) {
      throw new ApiError(400, "BAD_REQUEST", "Idempotency-Key must equal the client message ID");
    }
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return reply
      .code(201)
      .send(
        await repository.sendMessage(
          identity,
          id,
          body.data,
          request.id,
          supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        ),
      );
  });

  app.post("/reactions/query", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const body = listMessageReactionsRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid reaction query");
    return repository.listMessageReactions(identity, body.data.messageIds);
  });

  app.put("/messages/:id/reactions/:emoji", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "messages:write");
    const { id, emoji } = reactionParameters(request.params);
    return repository.addReaction(identity, id, emoji);
  });

  app.delete("/messages/:id/reactions/:emoji", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "messages:write");
    const { id, emoji } = reactionParameters(request.params);
    return repository.removeReaction(identity, id, emoji);
  });

  app.put("/conversations/:id/read-cursor", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "read-cursors:write");
    const { id } = parameters(request.params);
    const body = advanceReadCursorRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid read cursor");
    return repository.advanceReadCursor(identity, id, body.data.lastReadMessageId);
  });

  app.get("/sync", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const query = syncQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid sync cursor");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return repository.sync(
      identity,
      query.data.after,
      query.data.limit,
      supported.includes(REACTION_EVENTS_CAPABILITY),
      supported.includes(READ_STATE_EVENTS_CAPABILITY),
      supported.includes(TASK_EVENTS_CAPABILITY),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
      supported.includes(PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY),
    );
  });

  app.post("/realtime/tickets", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const supported = capabilities(request.headers["x-hmm-chat-capabilities"]);
    return repository.issueRealtimeTicket(
      identity,
      supported.includes(REACTION_EVENTS_CAPABILITY),
      supported.includes(READ_STATE_EVENTS_CAPABILITY),
      supported.includes(TASK_EVENTS_CAPABILITY),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
      supported.includes(PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY),
    );
  });
};
