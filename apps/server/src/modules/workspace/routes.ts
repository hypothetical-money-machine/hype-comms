import {
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  ANNOUNCEMENT_CHANNELS_CAPABILITY,
  ATTACHMENT_CONTENT_SHA256_HEADER,
  ATTACHMENTS_CAPABILITY,
  EPHEMERAL_ACTIVITY_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
  MEMBER_PROFILES_CAPABILITY,
  MESSAGE_RETRACT_EVENTS_CAPABILITY,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  TASK_EVENTS_CAPABILITY,
  THREADS_CAPABILITY,
  advanceReadCursorRequestSchema,
  archiveChannelRequestSchema,
  channelSlugSchema,
  clientCapabilitiesHeaderSchema,
  completeFileUploadRequestSchema,
  conversationFilesQuerySchema,
  createChannelRequestSchema,
  createFileUploadRequestSchema,
  createTaskRequestSchema,
  directConversationRequestSchema,
  entityIdSchema,
  groupDirectConversationRequestSchema,
  idempotencyKeySchema,
  joinPublicChannelRequestSchema,
  listConversationsQuerySchema,
  listMessageAttachmentsRequestSchema,
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
  AgentScope,
  ListConversationsResponse,
  User,
  WorkspaceBootstrapResponse,
} from "@hype-comms/contracts";
import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../../errors.js";
import { requireTaskIdentity } from "../bots/request-auth.js";
import type { BotService } from "../bots/service.js";
import {
  requireAgentScope,
  requireAnyAgentScope,
  requireAuthenticatedIdentity,
} from "../identity/request-auth.js";
import type { IdentityService } from "../identity/service.js";
import { GroupDirectClientUpgradeRequiredError } from "./group-direct-capability.js";
import type { WorkspaceClientCapabilities, WorkspaceRepository } from "./repository.js";

interface WorkspaceRoutesOptions {
  readonly identityService: IdentityService;
  readonly botService?: BotService;
  readonly repository: WorkspaceRepository;
  readonly defaultAgentAgencyEnabled?: boolean;
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

function workspaceClientCapabilities(
  value: string | string[] | undefined,
): WorkspaceClientCapabilities {
  const supported = capabilities(value);
  return {
    reactionEvents: supported.includes(REACTION_EVENTS_CAPABILITY),
    readStateEvents: supported.includes(READ_STATE_EVENTS_CAPABILITY),
    taskEvents: supported.includes(TASK_EVENTS_CAPABILITY),
    announcementChannels: supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
    participatedThreadNotifications: supported.includes(
      PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
    ),
    messageRetractEvents: supported.includes(MESSAGE_RETRACT_EVENTS_CAPABILITY),
    memberProfiles: supported.includes(MEMBER_PROFILES_CAPABILITY),
    ephemeralActivity: supported.includes(EPHEMERAL_ACTIVITY_CAPABILITY),
    groupDirectMessages: supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
  };
}

function projectConversationSummary(summary: ConversationSummary, supportsAnnouncements: boolean) {
  if (supportsAnnouncements) return summary;
  const conversation: Partial<ConversationSummary["conversation"]> = { ...summary.conversation };
  delete conversation.channelMode;
  return { ...summary, conversation };
}

function projectConversationSummaries(
  summaries: readonly ConversationSummary[],
  supportsAnnouncements: boolean,
  supportsGroupDirectMessages: boolean,
) {
  if (
    !supportsGroupDirectMessages &&
    summaries.some((summary) => summary.conversation.kind === "group_direct_message")
  ) {
    throw new GroupDirectClientUpgradeRequiredError();
  }
  return summaries.map((summary) => projectConversationSummary(summary, supportsAnnouncements));
}

function withoutTitle(user: User): Omit<User, "title"> {
  const { title, ...legacy } = user;
  void title;
  return legacy;
}

function projectMembers<T extends { readonly members: readonly User[] }>(
  response: T,
  capable: boolean,
) {
  if (capable) return response;
  return { ...response, members: response.members.map(withoutTitle) };
}

function projectChannelMembers<T extends { readonly members: readonly { readonly user: User }[] }>(
  response: T,
  capable: boolean,
) {
  if (capable) return response;
  return {
    ...response,
    members: response.members.map((member) => ({ ...member, user: withoutTitle(member.user) })),
  };
}

function withoutMemberEventTitle(event: unknown): unknown {
  if (typeof event !== "object" || event === null || !("type" in event)) return event;
  if (event.type !== "member.updated" || !("payload" in event)) return event;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || !("member" in payload)) return event;
  return { ...event, payload: { ...payload, member: withoutTitle(payload.member as User) } };
}

function projectSyncMemberTitles<T extends { readonly events: readonly unknown[] }>(
  response: T,
  capable: boolean,
) {
  if (capable) return response;
  return { ...response, events: response.events.map(withoutMemberEventTitle) };
}

function projectBootstrap(
  response: WorkspaceBootstrapResponse,
  supportsAnnouncements: boolean,
  supportsMemberProfiles: boolean,
  supportsGroupDirectMessages: boolean,
  effectiveAgentScopes: readonly AgentScope[] | null,
) {
  const currentUser =
    effectiveAgentScopes === null || !("type" in response.currentUser)
      ? response.currentUser
      : { ...response.currentUser, effectiveScopes: effectiveAgentScopes };
  const members = supportsMemberProfiles ? response.members : response.members.map(withoutTitle);
  const conversations = projectConversationSummaries(
    response.conversations,
    supportsAnnouncements,
    supportsGroupDirectMessages,
  );
  if (supportsAnnouncements) return { ...response, currentUser, members, conversations };
  const featureFlags: Partial<WorkspaceBootstrapResponse["featureFlags"]> = {
    ...response.featureFlags,
  };
  delete featureFlags.announcementChannels;
  return {
    ...response,
    currentUser,
    members,
    conversations,
    featureFlags,
  };
}

function projectConversationList(
  response: ListConversationsResponse,
  supportsAnnouncements: boolean,
  supportsGroupDirectMessages: boolean,
) {
  return {
    ...response,
    conversations: projectConversationSummaries(
      response.conversations,
      supportsAnnouncements,
      supportsGroupDirectMessages,
    ),
  };
}

function projectConversationMutation(
  response: ConversationMutationResponse,
  supportsAnnouncements: boolean,
) {
  if (response.conversation === undefined) return response;
  return {
    ...response,
    conversation: projectConversationSummary(response.conversation, supportsAnnouncements),
  };
}

function withoutAttachments<T extends { readonly attachments?: unknown }>(
  value: T,
  capable: boolean,
): T | Omit<T, "attachments"> {
  if (capable) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "attachments")) as Omit<
    T,
    "attachments"
  >;
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRoutesOptions> = async (app, options) => {
  const { identityService, botService, repository, defaultAgentAgencyEnabled = true } = options;
  const requireDefaultAgentAgencyEnabled = (): void => {
    if (!defaultAgentAgencyEnabled) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Default agent agency is disabled during the server rollback window",
      );
    }
  };
  app.get("/bootstrap", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return projectBootstrap(
      await repository.bootstrap(identity, supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY)),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
      supported.includes(MEMBER_PROFILES_CAPABILITY),
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      identity.credentialType === "agent" && supported.includes(AGENT_EFFECTIVE_SCOPES_CAPABILITY)
        ? identity.authorizationScopes
        : null,
    );
  });

  app.get("/members", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return projectMembers(
      await repository.listMembers(identity),
      supported.includes(MEMBER_PROFILES_CAPABILITY),
    );
  });

  app.get("/admin/communication-paths", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    if (identity.currentUser.role !== "owner") {
      throw new ApiError(403, "FORBIDDEN", "Only workspace owners can view communication paths");
    }
    // This endpoint exposes per-pair activity for conversations the owner may not be party to,
    // so every read is recorded even though it is a query.
    request.log.info(
      {
        event: "admin.communication_paths_viewed",
        actorUserId: identity.currentUser.user.id,
        workspaceId: identity.currentUser.workspaceId,
      },
      "Workspace owner viewed member communication paths",
    );
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return projectMembers(
      await repository.communicationPaths(identity),
      supported.includes(MEMBER_PROFILES_CAPABILITY),
    );
  });

  app.get("/conversations", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid conversation query");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return projectConversationList(
      await repository.listConversations(
        identity,
        query.data.after,
        query.data.limit,
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      ),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
  });

  app.get("/channels", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireDefaultAgentAgencyEnabled();
    requireAgentScope(identity, "workspace:read");
    requireAnyAgentScope(identity, ["channels:join", "conversations:write"]);
    const query = listConversationsQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel query");
    return repository.listPublicChannels(identity, query.data.after, query.data.limit);
  });

  app.post("/channels", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const result = createChannelRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const capable = supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY);
    const created = await repository.createChannel(
      identity,
      result.data,
      optionalIdempotencyKey(request.headers["idempotency-key"]),
      capable,
      request.id,
      defaultAgentAgencyEnabled,
    );
    return reply.code(201).send(projectConversationMutation(created, capable));
  });

  app.patch("/channels/:id", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "conversations:write");
    const { id } = parameters(request.params);
    const result = archiveChannelRequestSchema.safeParse(request.body);
    if (!result.success) throw new ApiError(400, "BAD_REQUEST", "Invalid channel update");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return projectConversationMutation(
      await repository.archiveChannel(identity, id),
      supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
    );
  });

  app.get("/channels/:id/members", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return projectChannelMembers(
      await repository.listChannelMembers(identity, id),
      supported.includes(MEMBER_PROFILES_CAPABILITY),
    );
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

  app.put("/channels/:id/membership", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireDefaultAgentAgencyEnabled();
    requireAnyAgentScope(identity, ["channels:join", "conversations:write"]);
    requireAgentScope(identity, "workspace:read");
    if (!joinPublicChannelRequestSchema.safeParse(request.body).success) {
      throw new ApiError(400, "BAD_REQUEST", "Channel join does not accept a request body");
    }
    const { id } = parameters(request.params);
    return repository.joinPublicChannel(identity, id);
  });

  app.post("/direct-conversations", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    // Keep broad legacy credentials working while newly enrolled agents receive only the narrow
    // permission needed to open a 1:1 conversation.
    requireAnyAgentScope(identity, ["direct-conversations:write", "conversations:write"]);
    const result = directConversationRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid direct-conversation request");
    }
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return reply
      .code(201)
      .send(
        projectConversationMutation(
          await repository.createDirectConversation(identity, result.data),
          supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        ),
      );
  });

  app.post("/group-direct-conversations", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireDefaultAgentAgencyEnabled();
    requireAnyAgentScope(identity, ["direct-conversations:write", "conversations:write"]);
    const result = groupDirectConversationRequestSchema.safeParse(request.body);
    if (!result.success) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid group direct-conversation request");
    }
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    if (!supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY)) {
      throw new GroupDirectClientUpgradeRequiredError();
    }
    return reply
      .code(201)
      .send(
        projectConversationMutation(
          await repository.createGroupDirectConversation(
            identity,
            result.data,
            requiredIdempotencyKey(request.headers["idempotency-key"]),
          ),
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
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const supportsThreads = supported.includes(THREADS_CAPABILITY);
    const supportsAttachments = supported.includes(ATTACHMENTS_CAPABILITY);
    await repository.requireGroupDirectMessagesForConversations(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    const history = await repository.history(
      identity,
      id,
      query.data.before,
      query.data.limit,
      !supportsThreads,
    );
    if (supportsThreads) return withoutAttachments(history, supportsAttachments);
    return {
      messages: history.messages,
      nextCursor: history.nextCursor,
      ...(supportsAttachments ? { attachments: history.attachments } : {}),
    };
  });

  app.get("/messages/:id/thread", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const query = messageHistoryQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid thread query");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const thread = await repository.thread(identity, id, query.data.before, query.data.limit);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return withoutAttachments(thread, supported.includes(ATTACHMENTS_CAPABILITY));
  });

  app.get("/messages/:id", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const message = await repository.messageById(identity, id);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return withoutAttachments(message, supported.includes(ATTACHMENTS_CAPABILITY));
  });

  app.delete("/messages/:id", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "messages:write");
    const { id } = parameters(request.params);
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      "retractable",
    );
    return repository.retractMessage(identity, id);
  });

  app.get("/search", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const query = messageSearchQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid search query");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    return repository.searchMessages(
      identity,
      query.data.query,
      query.data.after,
      query.data.limit,
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
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
    if (body.data.attachmentIds.length > 0) {
      requireAgentScope(identity, "attachments:write");
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey !== body.data.clientMessageId) {
      throw new ApiError(400, "BAD_REQUEST", "Idempotency-Key must equal the client message ID");
    }
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForConversations(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return reply
      .code(201)
      .send(
        withoutAttachments(
          await repository.sendMessage(
            identity,
            id,
            body.data,
            request.id,
            supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
          ),
          supported.includes(ATTACHMENTS_CAPABILITY),
        ),
      );
  });

  app.get("/conversations/:id/files", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const query = conversationFilesQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid files query");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForConversations(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return repository.listConversationFiles(identity, id, query.data.before, query.data.limit);
  });

  app.post("/attachments/query", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const body = listMessageAttachmentsRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid attachment query");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const attachments = await repository.listMessageAttachments(identity, body.data.messageIds);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      body.data.messageIds,
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return attachments;
  });

  app.post("/files/uploads", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "attachments:write");
    const body = createFileUploadRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid file upload");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForConversations(
      identity,
      [body.data.conversationId],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return reply
      .code(201)
      .send(
        await repository.createFileUpload(
          identity,
          body.data,
          requiredIdempotencyKey(request.headers["idempotency-key"]),
        ),
      );
  });

  app.post("/files/:id/complete", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "attachments:write");
    const { id } = parameters(request.params);
    const body = completeFileUploadRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid file completion");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForAttachments(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      "complete",
    );
    return repository.completeFileUpload(
      identity,
      id,
      body.data,
      requiredIdempotencyKey(request.headers["idempotency-key"]),
    );
  });

  app.get("/files/:id/content", async (request, reply) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const { id } = parameters(request.params);
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const file = await repository.readFileContent(
      identity,
      id,
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return reply
      .header("content-type", file.attachment.contentType)
      .header("content-length", file.attachment.sizeBytes.toString())
      .header(ATTACHMENT_CONTENT_SHA256_HEADER, file.contentSha256)
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.attachment.fileName)}`,
      )
      .header("x-content-type-options", "nosniff")
      .send(file.bytes);
  });

  await app.register(async (files) => {
    // This encapsulated raw-byte lane must also override Fastify's built-in text/plain and JSON
    // parsers. A wildcard alone loses to those exact parsers and turns valid text attachments
    // into strings before the handler can verify their byte length and digest.
    files.removeAllContentTypeParsers();
    files.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
      (_request, body, done) => {
        done(null, body);
      },
    );
    files.put("/files/:id/content", { bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
      const identity = await requireAuthenticatedIdentity(request, identityService);
      requireAgentScope(identity, "attachments:write");
      const { id } = parameters(request.params);
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || contentType.trim() === "") {
        throw new ApiError(400, "BAD_REQUEST", "Content-Type is required");
      }
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(400, "BAD_REQUEST", "Expected raw file bytes");
      }
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForAttachments(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        "content-write",
      );
      await repository.putFileContent(identity, id, contentType, request.body);
      return reply.code(204).send();
    });
  });

  app.post("/reactions/query", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const body = listMessageReactionsRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid reaction query");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    const reactions = await repository.listMessageReactions(identity, body.data.messageIds);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      body.data.messageIds,
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return reactions;
  });

  app.put("/messages/:id/reactions/:emoji", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "messages:write");
    const { id, emoji } = reactionParameters(request.params);
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      "active",
    );
    return repository.addReaction(identity, id, emoji);
  });

  app.delete("/messages/:id/reactions/:emoji", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "messages:write");
    const { id, emoji } = reactionParameters(request.params);
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForMessages(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      "active",
    );
    return repository.removeReaction(identity, id, emoji);
  });

  app.put("/conversations/:id/read-cursor", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "read-cursors:write");
    const { id } = parameters(request.params);
    const body = advanceReadCursorRequestSchema.safeParse(request.body);
    if (!body.success) throw new ApiError(400, "BAD_REQUEST", "Invalid read cursor");
    const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
    await repository.requireGroupDirectMessagesForConversations(
      identity,
      [id],
      supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
    );
    return repository.advanceReadCursor(identity, id, body.data.lastReadMessageId);
  });

  app.get("/sync", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    const query = syncQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApiError(400, "BAD_REQUEST", "Invalid sync cursor");
    const supported = workspaceClientCapabilities(request.headers["x-hype-comms-capabilities"]);
    return projectSyncMemberTitles(
      await repository.sync(identity, query.data.after, query.data.limit, supported),
      supported.memberProfiles === true,
    );
  });

  app.post("/realtime/tickets", async (request) => {
    const identity = await requireAuthenticatedIdentity(request, identityService);
    requireAgentScope(identity, "workspace:read");
    return repository.issueRealtimeTicket(
      identity,
      workspaceClientCapabilities(request.headers["x-hype-comms-capabilities"]),
    );
  });
};
