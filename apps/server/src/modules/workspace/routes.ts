import {
  AGENT_CONTEXT_PACK_CAPABILITY,
  AGENT_EFFECTIVE_SCOPES_CAPABILITY,
  ANNOUNCEMENT_CHANNELS_CAPABILITY,
  ATTACHMENT_CONTENT_SHA256_HEADER,
  ATTACHMENTS_CAPABILITY,
  EPHEMERAL_ACTIVITY_CAPABILITY,
  GROUP_DIRECT_MESSAGES_CAPABILITY,
  HUMANS_ONLY_CHANNELS_CAPABILITY,
  SYSTEM_CHANNELS_CAPABILITY,
  MEMBER_PROFILES_CAPABILITY,
  MESSAGE_RETRACT_EVENTS_CAPABILITY,
  PARTICIPATED_THREAD_NOTIFICATIONS_CAPABILITY,
  REACTION_EVENTS_CAPABILITY,
  READ_STATE_EVENTS_CAPABILITY,
  TASK_EVENTS_CAPABILITY,
  THREADS_CAPABILITY,
  advanceReadCursorRequestSchema,
  agentContextHistoryQuerySchema,
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
  AgentScope,
  ChannelMembersResponse,
  ChannelMembershipMutationResponse,
  ConversationMutationResponse,
  ConversationSummary,
  ListConversationsResponse,
  User,
  WorkspaceBootstrapResponse,
} from "@hype-comms/contracts";
import { z } from "zod";
import { routeModule, validateRequest } from "../../http/route-registrar.js";
import { taskPolicy, workspacePolicy } from "../../http/authentication-policies.js";

import { ApiError } from "../../errors.js";
import type { BotService } from "../bots/service.js";
import { requireAgentScope, type AuthenticatedRequestIdentity } from "../identity/request-auth.js";
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

const resourceParams = validateRequest(
  z.object({ id: entityIdSchema }).strict(),
  "Invalid resource id",
);
const memberParams = validateRequest(
  z.object({ id: entityIdSchema, userId: entityIdSchema }).strict(),
  "Invalid resource ids",
);
const channelParams = validateRequest(
  z.object({ slug: channelSlugSchema }).strict(),
  "Invalid channel slug",
);
const channelTaskParams = validateRequest(
  z.object({ slug: channelSlugSchema, number: taskNumberSchema }).strict(),
  "Invalid channel task reference",
);
const reactionParams = validateRequest(
  z.object({ id: entityIdSchema, emoji: reactionEmojiSchema }).strict(),
  "Invalid reaction",
);

const historyQuery = validateRequest(
  z.union([
    agentContextHistoryQuerySchema.transform((value) => ({ kind: "context" as const, value })),
    messageHistoryQuerySchema.transform((value) => ({ kind: "history" as const, value })),
  ]),
  (value) =>
    typeof value === "object" && value !== null && Object.hasOwn(value, "contextPack")
      ? "Invalid context history query"
      : "Invalid history query",
);

function canCreateDirectConversation(identity: AuthenticatedRequestIdentity): boolean {
  return (
    identity.credentialType === "session" ||
    identity.currentUser.scopes.includes("direct-conversations:write") ||
    identity.currentUser.scopes.includes("conversations:write")
  );
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
    humansOnlyChannels: supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
    systemChannels: supported.includes(SYSTEM_CHANNELS_CAPABILITY),
  };
}

function missingDirectConversationWriteScope(): ApiError {
  return new ApiError(403, "FORBIDDEN", "Agent token requires the conversations:write scope");
}

function projectConversationSummary(
  summary: ConversationSummary,
  supportsAnnouncements: boolean,
  supportsHumansOnlyChannels: boolean,
) {
  const conversation: Partial<ConversationSummary["conversation"]> = { ...summary.conversation };
  if (!supportsAnnouncements) delete conversation.channelMode;
  if (!supportsHumansOnlyChannels && conversation.access === "humans") {
    conversation.access = "members";
  }
  return { ...summary, conversation };
}

function projectConversationSummaries(
  summaries: readonly ConversationSummary[],
  supportsAnnouncements: boolean,
  supportsGroupDirectMessages: boolean,
  supportsHumansOnlyChannels: boolean,
) {
  if (
    !supportsGroupDirectMessages &&
    summaries.some((summary) => summary.conversation.kind === "group_direct_message")
  ) {
    throw new GroupDirectClientUpgradeRequiredError();
  }
  return summaries.map((summary) =>
    projectConversationSummary(summary, supportsAnnouncements, supportsHumansOnlyChannels),
  );
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

function projectChannelMembers(
  response: ChannelMembersResponse,
  supportsMemberProfiles: boolean,
  supportsHumansOnlyChannels: boolean,
) {
  return {
    ...response,
    access:
      !supportsHumansOnlyChannels && response.access === "humans" ? "members" : response.access,
    members: supportsMemberProfiles
      ? response.members
      : response.members.map((member) => ({ ...member, user: withoutTitle(member.user) })),
  };
}

function projectChannelMembershipMutation(
  response: ChannelMembershipMutationResponse,
  supportsMemberProfiles: boolean,
  supportsHumansOnlyChannels: boolean,
) {
  return {
    ...response,
    channelMembers: projectChannelMembers(
      response.channelMembers,
      supportsMemberProfiles,
      supportsHumansOnlyChannels,
    ),
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
  supportsHumansOnlyChannels: boolean,
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
    supportsHumansOnlyChannels,
  );
  const featureFlags: Partial<WorkspaceBootstrapResponse["featureFlags"]> = {
    ...response.featureFlags,
  };
  if (!supportsAnnouncements) delete featureFlags.announcementChannels;
  if (!supportsHumansOnlyChannels) delete featureFlags.humansOnlyChannels;
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
  supportsHumansOnlyChannels: boolean,
) {
  return {
    ...response,
    conversations: projectConversationSummaries(
      response.conversations,
      supportsAnnouncements,
      supportsGroupDirectMessages,
      supportsHumansOnlyChannels,
    ),
  };
}

function projectConversationMutation(
  response: ConversationMutationResponse,
  supportsAnnouncements: boolean,
  supportsHumansOnlyChannels: boolean,
) {
  if (response.conversation === undefined) return response;
  return {
    ...response,
    conversation: projectConversationSummary(
      response.conversation,
      supportsAnnouncements,
      supportsHumansOnlyChannels,
    ),
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

export const workspaceRoutes = routeModule<WorkspaceRoutesOptions>(async (routes, options) => {
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
  const workspace = workspacePolicy(identityService);
  const agency = workspacePolicy(identityService, requireDefaultAgentAgencyEnabled);
  const tasks = taskPolicy(identityService, botService);
  routes.register({
    method: "GET",
    url: "/bootstrap",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {},
    handler: async ({ identity, request }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectBootstrap(
        await repository.bootstrap(
          identity,
          supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
          supported.includes(SYSTEM_CHANNELS_CAPABILITY),
        ),
        supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        supported.includes(MEMBER_PROFILES_CAPABILITY),
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
        identity.credentialType === "agent" && supported.includes(AGENT_EFFECTIVE_SCOPES_CAPABILITY)
          ? identity.authorizationScopes
          : null,
      );
    },
  });

  routes.register({
    method: "GET",
    url: "/members",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {},
    handler: async ({ identity, request }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectMembers(
        await repository.listMembers(identity),
        supported.includes(MEMBER_PROFILES_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "GET",
    url: "/admin/communication-paths",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {},
    handler: async ({ identity, request }) => {
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
    },
  });

  routes.register({
    method: "GET",
    url: "/conversations",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { query: validateRequest(listConversationsQuerySchema, "Invalid conversation query") },
    handler: async ({ identity, request, input: { query: query } }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectConversationList(
        await repository.listConversations(
          identity,
          query.after,
          query.limit,
          supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
          supported.includes(SYSTEM_CHANNELS_CAPABILITY),
        ),
        supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "GET",
    url: "/channels",
    policy: agency,
    scopes: ["workspace:read", { any: ["channels:join", "conversations:write"] }],
    request: { query: validateRequest(listConversationsQuerySchema, "Invalid channel query") },
    handler: async ({ identity, input: { query: query } }) => {
      return repository.listPublicChannels(identity, query.after, query.limit);
    },
  });

  routes.register({
    method: "POST",
    url: "/channels",
    policy: workspace,
    scopes: ["conversations:write"],
    request: { body: validateRequest(createChannelRequestSchema, "Invalid channel") },
    handler: async ({ identity, request, reply, input: { body: result } }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      const supportsAnnouncements = supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY);
      const supportsHumansOnlyChannels = supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY);
      if (result.access === "humans" && !supportsHumansOnlyChannels) {
        throw new ApiError(400, "BAD_REQUEST", "Client does not support humans-only channels");
      }
      const created = await repository.createChannel(
        identity,
        result,
        optionalIdempotencyKey(request.headers["idempotency-key"]),
        supportsAnnouncements,
        request.id,
        defaultAgentAgencyEnabled,
      );
      return reply
        .code(201)
        .send(
          projectConversationMutation(created, supportsAnnouncements, supportsHumansOnlyChannels),
        );
    },
  });

  routes.register({
    method: "PATCH",
    url: "/channels/:id",
    policy: workspace,
    scopes: ["conversations:write"],
    request: {
      params: resourceParams,
      body: validateRequest(archiveChannelRequestSchema, "Invalid channel update"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectConversationMutation(
        await repository.archiveChannel(identity, id),
        supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "GET",
    url: "/channels/:id/members",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { params: resourceParams },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectChannelMembers(
        await repository.listChannelMembers(identity, id),
        supported.includes(MEMBER_PROFILES_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "PUT",
    url: "/channels/:id/members/:userId",
    policy: workspace,
    scopes: ["conversations:write"],
    request: {
      params: memberParams,
      body: validateRequest(upsertChannelMemberRequestSchema, "Invalid channel member"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id, userId },
        body,
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectChannelMembershipMutation(
        await repository.upsertChannelMember(identity, id, userId, body),
        supported.includes(MEMBER_PROFILES_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "DELETE",
    url: "/channels/:id/members/:userId",
    policy: workspace,
    scopes: ["conversations:write"],
    request: { params: memberParams },
    handler: async ({
      identity,
      request,
      input: {
        params: { id, userId },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectChannelMembershipMutation(
        await repository.removeChannelMember(identity, id, userId),
        supported.includes(MEMBER_PROFILES_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "PUT",
    url: "/channels/:id/membership",
    policy: agency,
    scopes: [{ any: ["channels:join", "conversations:write"] }, "workspace:read"],
    request: {
      body: validateRequest(
        joinPublicChannelRequestSchema,
        "Channel join does not accept a request body",
      ),
      params: resourceParams,
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return projectConversationMutation(
        await repository.joinPublicChannel(identity, id),
        supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
        supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "POST",
    url: "/direct-conversations",
    policy: workspace,
    scopes: [],
    request: {
      body: validateRequest(directConversationRequestSchema, "Invalid direct-conversation request"),
    },
    beforeValidation: ({ identity }) => {
      // Keep broad legacy credentials working while newly enrolled agents receive only the narrow
      // permission needed to open a 1:1 conversation. A read-only agent token may still look one up,
      // so `workspace:read` alone reaches the read path below.
      const canCreate = canCreateDirectConversation(identity);
      if (
        identity.credentialType === "agent" &&
        !canCreate &&
        !identity.currentUser.scopes.includes("workspace:read")
      ) {
        throw missingDirectConversationWriteScope();
      }
    },
    handler: async ({ identity, request, reply, input: { body: result } }) => {
      const canCreate = canCreateDirectConversation(identity);
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      const opened = canCreate
        ? await repository.createDirectConversation(identity, result)
        : await repository.findDirectConversation(identity, result);
      if (opened === null) {
        // Read-only lookup found nothing; opening it would need the write scope.
        throw missingDirectConversationWriteScope();
      }
      return reply
        .code(201)
        .send(
          projectConversationMutation(
            opened,
            supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
            supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
          ),
        );
    },
  });

  routes.register({
    method: "POST",
    url: "/group-direct-conversations",
    policy: agency,
    scopes: [{ any: ["direct-conversations:write", "conversations:write"] }],
    request: {
      body: validateRequest(
        groupDirectConversationRequestSchema,
        "Invalid group direct-conversation request",
      ),
    },
    handler: async ({ identity, request, reply, input: { body: result } }) => {
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
              result,
              requiredIdempotencyKey(request.headers["idempotency-key"]),
            ),
            supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
            supported.includes(HUMANS_ONLY_CHANNELS_CAPABILITY),
          ),
        );
    },
  });

  routes.register({
    method: "GET",
    url: "/conversations/:id/messages",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { params: resourceParams, query: historyQuery },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        query,
      },
    }) => {
      if (query.kind === "context") {
        const contextQuery = query.value;
        const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
        if (!supported.includes(AGENT_CONTEXT_PACK_CAPABILITY)) {
          throw new ApiError(400, "BAD_REQUEST", "Context pack capability is required");
        }
        return repository.contextHistory(
          identity,
          id,
          contextQuery.before,
          contextQuery.throughMessageId,
          contextQuery.limit,
        );
      }
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
        query.value.before,
        query.value.limit,
        !supportsThreads,
      );
      if (supportsThreads) return withoutAttachments(history, supportsAttachments);
      return {
        messages: history.messages,
        nextCursor: history.nextCursor,
        ...(supportsAttachments ? { attachments: history.attachments } : {}),
      };
    },
  });

  routes.register({
    method: "GET",
    url: "/messages/:id/thread",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {
      params: resourceParams,
      query: validateRequest(messageHistoryQuerySchema, "Invalid thread query"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        query,
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      const thread = await repository.thread(identity, id, query.before, query.limit);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return withoutAttachments(thread, supported.includes(ATTACHMENTS_CAPABILITY));
    },
  });

  routes.register({
    method: "GET",
    url: "/messages/:id",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { params: resourceParams },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      const message = await repository.messageById(identity, id);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return withoutAttachments(message, supported.includes(ATTACHMENTS_CAPABILITY));
    },
  });

  routes.register({
    method: "DELETE",
    url: "/messages/:id",
    policy: workspace,
    scopes: ["messages:write"],
    request: { params: resourceParams },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        "retractable",
      );
      return repository.retractMessage(identity, id);
    },
  });

  routes.register({
    method: "GET",
    url: "/search",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { query: validateRequest(messageSearchQuerySchema, "Invalid search query") },
    handler: async ({ identity, request, input: { query: query } }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      return repository.searchMessages(
        identity,
        query.query,
        query.after,
        query.limit,
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        supported.includes(SYSTEM_CHANNELS_CAPABILITY),
      );
    },
  });

  routes.register({
    method: "GET",
    url: "/conversations/:id/tasks",
    policy: tasks,
    scopes: ["tasks:read"],
    request: {
      params: resourceParams,
      query: validateRequest(taskListQuerySchema, "Invalid task query"),
    },
    handler: async ({
      identity,
      input: {
        params: { id },
        query,
      },
    }) => {
      const { after, limit, ...filters } = query;
      return repository.listConversationTasks(identity, id, after, limit, filters);
    },
  });

  routes.register({
    method: "GET",
    url: "/channels/:slug/tasks",
    policy: tasks,
    scopes: ["tasks:read"],
    request: {
      params: channelParams,
      query: validateRequest(taskListQuerySchema, "Invalid task query"),
    },
    handler: async ({
      identity,
      input: {
        params: { slug },
        query,
      },
    }) => {
      const { after, limit, ...filters } = query;
      return repository.listChannelTasks(identity, slug, after, limit, filters);
    },
  });

  routes.register({
    method: "GET",
    url: "/channels/:slug/tasks/:number",
    policy: tasks,
    scopes: ["tasks:read"],
    request: { params: channelTaskParams },
    handler: async ({
      identity,
      input: {
        params: { slug, number },
      },
    }) => {
      return repository.getChannelTaskByNumber(identity, slug, number);
    },
  });

  routes.register({
    method: "GET",
    url: "/tasks/mine",
    policy: tasks,
    scopes: ["tasks:read"],
    request: { query: validateRequest(taskListQuerySchema, "Invalid task query") },
    handler: async ({ identity, input: { query: query } }) => {
      const { after, limit, ...filters } = query;
      return repository.listMyTasks(identity, after, limit, filters);
    },
  });

  routes.register({
    method: "GET",
    url: "/tasks/:id",
    policy: tasks,
    scopes: ["tasks:read"],
    request: { params: resourceParams },
    handler: async ({
      identity,
      input: {
        params: { id },
      },
    }) => {
      return repository.getTask(identity, id);
    },
  });

  routes.register({
    method: "POST",
    url: "/conversations/:id/tasks",
    policy: tasks,
    scopes: ["tasks:write"],
    request: {
      params: resourceParams,
      body: validateRequest(createTaskRequestSchema, "Invalid task"),
    },
    handler: async ({
      identity,
      request,
      reply,
      input: {
        params: { id },
        body,
      },
    }) => {
      return reply
        .code(201)
        .send(
          await repository.createTask(
            identity,
            id,
            body,
            requiredIdempotencyKey(request.headers["idempotency-key"]),
          ),
        );
    },
  });

  routes.register({
    method: "POST",
    url: "/channels/:slug/tasks",
    policy: tasks,
    scopes: ["tasks:write"],
    request: {
      params: channelParams,
      body: validateRequest(createTaskRequestSchema, "Invalid task"),
    },
    handler: async ({
      identity,
      request,
      reply,
      input: {
        params: { slug },
        body,
      },
    }) => {
      return reply
        .code(201)
        .send(
          await repository.createChannelTask(
            identity,
            slug,
            body,
            requiredIdempotencyKey(request.headers["idempotency-key"]),
          ),
        );
    },
  });

  routes.register({
    method: "PATCH",
    url: "/tasks/:id",
    policy: tasks,
    scopes: ["tasks:write"],
    request: {
      params: resourceParams,
      body: validateRequest(updateTaskRequestSchema, "Invalid task update"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        body,
      },
    }) => {
      return repository.updateTask(
        identity,
        id,
        body,
        requiredIdempotencyKey(request.headers["idempotency-key"]),
      );
    },
  });

  routes.register({
    method: "POST",
    url: "/tasks/:id/move",
    policy: tasks,
    scopes: ["tasks:write"],
    request: {
      params: resourceParams,
      body: validateRequest(moveTaskRequestSchema, "Invalid task move"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        body,
      },
    }) => {
      return repository.moveTask(
        identity,
        id,
        body,
        requiredIdempotencyKey(request.headers["idempotency-key"]),
      );
    },
  });

  routes.register({
    method: "POST",
    url: "/conversations/:id/messages",
    policy: workspace,
    scopes: ["messages:write"],
    request: {
      params: resourceParams,
      body: validateRequest(sendConversationMessageRequestSchema, "Invalid message"),
    },
    handler: async ({
      identity,
      request,
      reply,
      input: {
        params: { id },
        body,
      },
    }) => {
      if (body.attachmentIds.length > 0) {
        requireAgentScope(identity, "attachments:write");
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey !== body.clientMessageId) {
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
              body,
              request.id,
              supported.includes(ANNOUNCEMENT_CHANNELS_CAPABILITY),
            ),
            supported.includes(ATTACHMENTS_CAPABILITY),
          ),
        );
    },
  });

  routes.register({
    method: "GET",
    url: "/conversations/:id/files",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {
      params: resourceParams,
      query: validateRequest(conversationFilesQuerySchema, "Invalid files query"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        query,
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForConversations(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return repository.listConversationFiles(identity, id, query.before, query.limit);
    },
  });

  routes.register({
    method: "POST",
    url: "/attachments/query",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {
      body: validateRequest(listMessageAttachmentsRequestSchema, "Invalid attachment query"),
    },
    handler: async ({ identity, request, input: { body: body } }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      const attachments = await repository.listMessageAttachments(identity, body.messageIds);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        body.messageIds,
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return attachments;
    },
  });

  routes.register({
    method: "POST",
    url: "/files/uploads",
    policy: workspace,
    scopes: ["attachments:write"],
    request: { body: validateRequest(createFileUploadRequestSchema, "Invalid file upload") },
    handler: async ({ identity, request, reply, input: { body: body } }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForConversations(
        identity,
        [body.conversationId],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return reply
        .code(201)
        .send(
          await repository.createFileUpload(
            identity,
            body,
            requiredIdempotencyKey(request.headers["idempotency-key"]),
          ),
        );
    },
  });

  routes.register({
    method: "POST",
    url: "/files/:id/complete",
    policy: workspace,
    scopes: ["attachments:write"],
    request: {
      params: resourceParams,
      body: validateRequest(completeFileUploadRequestSchema, "Invalid file completion"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        body,
      },
    }) => {
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
        body,
        requiredIdempotencyKey(request.headers["idempotency-key"]),
      );
    },
  });

  routes.register({
    method: "GET",
    url: "/files/:id/content",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { params: resourceParams },
    handler: async ({
      identity,
      request,
      reply,
      input: {
        params: { id },
      },
    }) => {
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
    },
  });

  await routes.rawBytes(25 * 1024 * 1024, (files) => {
    files.register({
      method: "PUT",
      url: "/files/:id/content",
      policy: workspace,
      scopes: ["attachments:write"],
      request: {
        params: resourceParams,
        headers: validateRequest(
          z.object({ "content-type": z.string().refine((value) => value.trim() !== "") }),
          "Content-Type is required",
        ),
        body: validateRequest(z.instanceof(Buffer), "Expected raw file bytes"),
      },
      bodyLimit: 25 * 1024 * 1024,
      handler: async ({
        identity,
        request,
        reply,
        input: {
          params: { id },
          headers: { "content-type": contentType },
          body,
        },
      }) => {
        const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
        await repository.requireGroupDirectMessagesForAttachments(
          identity,
          [id],
          supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
          "content-write",
        );
        await repository.putFileContent(identity, id, contentType, body);
        return reply.code(204).send();
      },
    });
  });

  routes.register({
    method: "POST",
    url: "/reactions/query",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { body: validateRequest(listMessageReactionsRequestSchema, "Invalid reaction query") },
    handler: async ({ identity, request, input: { body: body } }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      const reactions = await repository.listMessageReactions(identity, body.messageIds);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        body.messageIds,
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return reactions;
    },
  });

  routes.register({
    method: "PUT",
    url: "/messages/:id/reactions/:emoji",
    policy: workspace,
    scopes: ["messages:write"],
    request: { params: reactionParams },
    handler: async ({
      identity,
      request,
      input: {
        params: { id, emoji },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        "active",
      );
      return repository.addReaction(identity, id, emoji);
    },
  });

  routes.register({
    method: "DELETE",
    url: "/messages/:id/reactions/:emoji",
    policy: workspace,
    scopes: ["messages:write"],
    request: { params: reactionParams },
    handler: async ({
      identity,
      request,
      input: {
        params: { id, emoji },
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForMessages(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
        "active",
      );
      return repository.removeReaction(identity, id, emoji);
    },
  });

  routes.register({
    method: "PUT",
    url: "/conversations/:id/read-cursor",
    policy: workspace,
    scopes: ["read-cursors:write"],
    request: {
      params: resourceParams,
      body: validateRequest(advanceReadCursorRequestSchema, "Invalid read cursor"),
    },
    handler: async ({
      identity,
      request,
      input: {
        params: { id },
        body,
      },
    }) => {
      const supported = capabilities(request.headers["x-hype-comms-capabilities"]);
      await repository.requireGroupDirectMessagesForConversations(
        identity,
        [id],
        supported.includes(GROUP_DIRECT_MESSAGES_CAPABILITY),
      );
      return repository.advanceReadCursor(identity, id, body.lastReadMessageId);
    },
  });

  routes.register({
    method: "GET",
    url: "/sync",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { query: validateRequest(syncQuerySchema, "Invalid sync cursor") },
    handler: async ({ identity, request, input: { query: query } }) => {
      const supported = workspaceClientCapabilities(request.headers["x-hype-comms-capabilities"]);
      return projectSyncMemberTitles(
        await repository.sync(identity, query.after, query.limit, supported),
        supported.memberProfiles === true,
      );
    },
  });

  routes.register({
    method: "POST",
    url: "/realtime/tickets",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {},
    handler: async ({ identity, request }) => {
      return repository.issueRealtimeTicket(
        identity,
        workspaceClientCapabilities(request.headers["x-hype-comms-capabilities"]),
      );
    },
  });
});
