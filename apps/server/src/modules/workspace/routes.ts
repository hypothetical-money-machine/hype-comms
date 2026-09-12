import type { WorkspaceBootstrapResponse } from "@hype-comms/contracts";
import {
  ATTACHMENT_CONTENT_SHA256_HEADER,
  advanceReadCursorRequestSchema,
  agentContextHistoryQuerySchema,
  archiveChannelRequestSchema,
  channelSlugSchema,
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
  workspaceBootstrapResponseSchema,
} from "@hype-comms/contracts";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { taskPolicy, workspacePolicy } from "../../http/authentication-policies.js";
import { routeModule, validateRequest } from "../../http/route-registrar.js";
import type { BotService } from "../bots/service.js";
import { requireAgentScope, type AuthenticatedRequestIdentity } from "../identity/request-auth.js";
import type { IdentityService } from "../identity/service.js";
import type { WorkspaceRepository } from "./repository.js";
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
function missingDirectConversationWriteScope(): ApiError {
  return new ApiError(403, "FORBIDDEN", "Agent token requires the conversations:write scope");
}
function canonicalBootstrap(
  response: WorkspaceBootstrapResponse,
  identity: AuthenticatedRequestIdentity,
): WorkspaceBootstrapResponse {
  return workspaceBootstrapResponseSchema.parse({
    ...response,
    currentUser:
      identity.credentialType === "agent"
        ? { ...response.currentUser, effectiveScopes: identity.authorizationScopes }
        : response.currentUser,
  });
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
    handler: async ({ identity }) => {
      return canonicalBootstrap(await repository.bootstrap(identity), identity);
    },
  });

  routes.register({
    method: "GET",
    url: "/members",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {},
    handler: async ({ identity }) => {
      return await repository.listMembers(identity);
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
      return await repository.communicationPaths(identity);
    },
  });

  routes.register({
    method: "GET",
    url: "/conversations",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { query: validateRequest(listConversationsQuerySchema, "Invalid conversation query") },
    handler: async ({ identity, input: { query: query } }) => {
      return await repository.listConversations(identity, query.after, query.limit);
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
      const created = await repository.createChannel(
        identity,
        result,
        optionalIdempotencyKey(request.headers["idempotency-key"]),
        request.id,
        defaultAgentAgencyEnabled,
      );
      return reply.code(201).send(created);
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
      input: {
        params: { id },
      },
    }) => {
      return await repository.archiveChannel(identity, id);
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
      input: {
        params: { id },
      },
    }) => {
      return await repository.listChannelMembers(identity, id);
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
      input: {
        params: { id, userId },
        body,
      },
    }) => {
      return await repository.upsertChannelMember(identity, id, userId, body);
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
      input: {
        params: { id, userId },
      },
    }) => {
      return await repository.removeChannelMember(identity, id, userId);
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
      input: {
        params: { id },
      },
    }) => {
      return await repository.joinPublicChannel(identity, id);
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
    handler: async ({ identity, reply, input: { body: result } }) => {
      const canCreate = canCreateDirectConversation(identity);
      const opened = canCreate
        ? await repository.createDirectConversation(identity, result)
        : await repository.findDirectConversation(identity, result);
      if (opened === null) {
        // Read-only lookup found nothing; opening it would need the write scope.
        throw missingDirectConversationWriteScope();
      }
      return reply.code(201).send(opened);
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
      return reply
        .code(201)
        .send(
          await repository.createGroupDirectConversation(
            identity,
            result,
            requiredIdempotencyKey(request.headers["idempotency-key"]),
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
      input: {
        params: { id },
        query,
      },
    }) => {
      if (query.kind === "context") {
        const contextQuery = query.value;
        return repository.contextHistory(
          identity,
          id,
          contextQuery.before,
          contextQuery.throughMessageId,
          contextQuery.limit,
        );
      }
      const history = await repository.history(identity, id, query.value.before, query.value.limit);
      return history;
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
      input: {
        params: { id },
        query,
      },
    }) => {
      const thread = await repository.thread(identity, id, query.before, query.limit);
      return thread;
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
      input: {
        params: { id },
      },
    }) => {
      const message = await repository.messageById(identity, id);
      return message;
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
      input: {
        params: { id },
      },
    }) => {
      return repository.retractMessage(identity, id);
    },
  });

  routes.register({
    method: "GET",
    url: "/search",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { query: validateRequest(messageSearchQuerySchema, "Invalid search query") },
    handler: async ({ identity, input: { query: query } }) => {
      return repository.searchMessages(identity, query.query, query.after, query.limit);
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
      return reply.code(201).send(await repository.sendMessage(identity, id, body, request.id));
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
      input: {
        params: { id },
        query,
      },
    }) => {
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
    handler: async ({ identity, input: { body: body } }) => {
      const attachments = await repository.listMessageAttachments(identity, body.messageIds);
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
      reply,
      input: {
        params: { id },
      },
    }) => {
      const file = await repository.readFileContent(identity, id);
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
        reply,
        input: {
          params: { id },
          headers: { "content-type": contentType },
          body,
        },
      }) => {
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
    handler: async ({ identity, input: { body: body } }) => {
      const reactions = await repository.listMessageReactions(identity, body.messageIds);
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
      input: {
        params: { id, emoji },
      },
    }) => {
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
      input: {
        params: { id, emoji },
      },
    }) => {
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
      input: {
        params: { id },
        body,
      },
    }) => {
      return repository.advanceReadCursor(identity, id, body.lastReadMessageId);
    },
  });

  routes.register({
    method: "GET",
    url: "/sync",
    policy: workspace,
    scopes: ["workspace:read"],
    request: { query: validateRequest(syncQuerySchema, "Invalid sync cursor") },
    handler: async ({ identity, input: { query: query } }) => {
      return await repository.sync(identity, query.after, query.limit);
    },
  });

  routes.register({
    method: "POST",
    url: "/realtime/tickets",
    policy: workspace,
    scopes: ["workspace:read"],
    request: {},
    handler: async ({ identity }) => {
      return repository.issueRealtimeTicket(identity);
    },
  });
});
