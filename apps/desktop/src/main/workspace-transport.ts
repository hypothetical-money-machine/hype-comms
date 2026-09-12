import { encodeSyncPosition, type SyncPosition } from "@hype-comms/contracts";
import {
  addReactionResponseSchema,
  advanceReadCursorResponseSchema,
  agentEnrollmentResponseSchema,
  apiErrorEnvelopeSchema,
  attachmentSchema,
  channelMembershipMutationResponseSchema,
  channelMembersResponseSchema,
  communicationPathsResponseSchema,
  completeFileUploadResponseSchema,
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  conversationFilesQuerySchema,
  conversationFilesResponseSchema,
  conversationMutationResponseSchema,
  createFileUploadResponseSchema,
  humanWorkspaceBootstrapResponseSchema,
  listAgentEnrollmentsResponseSchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  listMessageAttachmentsResponseSchema,
  listMessageReactionsResponseSchema,
  messageByIdResponseSchema,
  messageHistoryResponseSchema,
  messageSearchResponseSchema,
  messageThreadRequestSchema,
  messageThreadResponseSchema,
  realtimeTicketResponseSchema,
  removeReactionResponseSchema,
  retractMessageResponseSchema,
  sendAttemptResultSchema,
  sendMessageResponseSchema,
  syncAttemptResultSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  updateProfileResponseSchema,
  type AddReactionResponse,
  type AdvanceReadCursorResponse,
  type AgentEnrollmentResponse,
  type ArchiveChannelRequest,
  type Attachment,
  type ChannelMembershipMutationResponse,
  type ChannelMembersResponse,
  type CommunicationPathsResponse,
  type ConversationFilesQuery,
  type ConversationFilesResponse,
  type ConversationMutationResponse,
  type CreateChannelOperation,
  type CreateTaskOperation,
  type DirectConversationRequest,
  type HumanWorkspaceBootstrapResponse,
  type ListAgentEnrollmentsResponse,
  type ListConversationsQuery,
  type ListConversationsResponse,
  type ListMembersResponse,
  type ListMessageAttachmentsResponse,
  type ListMessageReactionsResponse,
  type MessageByIdResponse,
  type MessageHistoryResponse,
  type MessageSearchQuery,
  type MessageSearchResponse,
  type MessageThreadRequest,
  type MessageThreadResponse,
  type MoveTaskOperation,
  type ReactionEmoji,
  type RealtimeTicketResponse,
  type RemoveReactionResponse,
  type RetractMessageResponse,
  type ReviewAgentEnrollmentRequest,
  type SendAttemptResult,
  type SendMessageOperation,
  type SyncAttemptResult,
  type TaskListQuery,
  type TaskListResponse,
  type TaskMutationResponse,
  type UpdateTaskOperation,
  type UpsertChannelMemberRequest,
  type User,
} from "@hype-comms/contracts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ChatSession } from "./chat-session";
import { requireWorkspaceProtocol, WorkspaceProtocolError } from "./workspace-protocol";
function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.round(seconds * 1000), 86400000)
    : null;
}

function appendTaskListQuery(url: URL, input: Partial<TaskListQuery>): void {
  const query = taskListQuerySchema.parse(input);
  if (query.after !== undefined) url.searchParams.set("after", query.after);
  url.searchParams.set("limit", String(query.limit));
  if (query.status !== undefined) url.searchParams.set("status", query.status);
  if (query.priority !== undefined) url.searchParams.set("priority", query.priority);
  if (query.assignee !== undefined) url.searchParams.set("assignee", query.assignee);
  if (query.dueAfter !== undefined) url.searchParams.set("dueAfter", query.dueAfter);
  if (query.dueBefore !== undefined) url.searchParams.set("dueBefore", query.dueBefore);
  if (query.updatedAfter !== undefined) url.searchParams.set("updatedAfter", query.updatedAfter);
  if (query.updatedBy !== undefined) url.searchParams.set("updatedBy", query.updatedBy);
}

/**
 * A transport-level failure worth retrying. `fetch` reports connection problems as `TypeError`,
 * while `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`, so a plain
 * request timeout must not be mistaken for a malformed response.
 */
function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
type SendPermanentReason = Extract<
  SendAttemptResult,
  {
    status: "permanent";
  }
>["reason"];
type SyncPermanentReason = Extract<
  SyncAttemptResult,
  {
    status: "permanent";
  }
>["reason"];
/** Statuses whose meaning is fixed: retrying the identical request cannot change the outcome. */
const SEND_PERMANENT_REASONS = new Map<number, SendPermanentReason>([
  [400, "validation"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
]);

const SYNC_PERMANENT_REASONS = new Map<number, SyncPermanentReason>([
  [400, "validation"],
  [403, "forbidden"],
  [404, "not_found"],
]);

/** 4xx statuses that describe a transient condition rather than a rejected request. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425]);

type RequestScopeGuard = () => void;

const alwaysCurrentRequestScope: RequestScopeGuard = () => undefined;

export class WorkspaceTransport {
  constructor(
    private readonly apiOrigin: string,
    private readonly session: Pick<ChatSession, "fetch" | "markSignedOut">,
  ) {}
  async #fetch(url: string, init: RequestInit): Promise<Response> {
    return requireWorkspaceProtocol(await this.session.fetch(url, init));
  }
  async #payload(response: Response): Promise<unknown> {
    if (response.ok) return response.json();
    if (response.status === 401) await this.session.markSignedOut();
    let message = `Workspace request failed (${response.status})`;
    try {
      const parsed = apiErrorEnvelopeSchema.safeParse(await response.json());
      if (parsed.success) message = parsed.data.error.message;
    } catch {
      // Keep the status-derived message.
    }
    throw new WorkspaceRequestError(message, response.status, retryAfter(response));
  }

  #url(pathname: string): URL {
    return new URL(pathname, this.apiOrigin);
  }

  /** Fetch, abandoning the request if the calling scope is replaced on either side of the await. */
  async #fetchInScope(
    url: string,
    init: RequestInit,
    assertCurrentScope: RequestScopeGuard,
  ): Promise<Response> {
    assertCurrentScope();
    const response = await this.#fetch(url, init);
    try {
      assertCurrentScope();
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  }

  async #fetchIdempotentMutation(
    url: string,
    init: RequestInit,
    assertCurrentScope: RequestScopeGuard = alwaysCurrentRequestScope,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetchInScope(url, init, assertCurrentScope);
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      return this.#fetchInScope(url, init, assertCurrentScope);
    }
    if (response.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(response.status)) {
      return this.#fetchInScope(url, init, assertCurrentScope);
    }
    return response;
  }

  async bootstrap(): Promise<HumanWorkspaceBootstrapResponse> {
    const response = await this.#fetch(this.#url("/v2/bootstrap").href, {
      method: "GET",
    });
    return humanWorkspaceBootstrapResponseSchema.parse(await this.#payload(response));
  }

  async members(): Promise<ListMembersResponse> {
    const response = await this.#fetch(this.#url("/v2/members").href, {
      method: "GET",
    });
    return listMembersResponseSchema.parse(await this.#payload(response));
  }

  async updateProfile(title: string | null): Promise<User> {
    const response = await this.#fetch(this.#url("/v2/profile").href, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ title }),
    });
    return updateProfileResponseSchema.parse(await this.#payload(response)).user;
  }

  async communicationPaths(): Promise<CommunicationPathsResponse> {
    const response = await this.#fetch(this.#url("/v2/admin/communication-paths").href, {
      method: "GET",
    });
    return communicationPathsResponseSchema.parse(await this.#payload(response));
  }

  async listAgentEnrollments(): Promise<ListAgentEnrollmentsResponse> {
    const response = await this.#fetch(this.#url("/v2/agent-enrollments").href, {
      method: "GET",
    });
    return listAgentEnrollmentsResponseSchema.parse(await this.#payload(response));
  }

  async reviewAgentEnrollment(
    enrollmentId: string,
    decision: ReviewAgentEnrollmentRequest["decision"],
  ): Promise<AgentEnrollmentResponse> {
    const response = await this.#fetchIdempotentMutation(
      this.#url(`/v2/agent-enrollments/${encodeURIComponent(enrollmentId)}/review`).href,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ decision }),
      },
    );
    return agentEnrollmentResponseSchema.parse(await this.#payload(response));
  }

  async cancelAgentEnrollment(enrollmentId: string): Promise<AgentEnrollmentResponse> {
    const response = await this.#fetchIdempotentMutation(
      this.#url(`/v2/agent-enrollments/${encodeURIComponent(enrollmentId)}/cancel`).href,
      {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      },
    );
    return agentEnrollmentResponseSchema.parse(await this.#payload(response));
  }

  async conversations(
    input: Partial<ListConversationsQuery> = {},
  ): Promise<ListConversationsResponse> {
    const url = this.#url("/v2/conversations");
    if (input.after !== undefined) url.searchParams.set("after", input.after);
    url.searchParams.set("limit", String(input.limit ?? CONVERSATION_PAGE_DEFAULT_LIMIT));
    const response = await this.#fetch(url.href, {
      method: "GET",
    });
    return listConversationsResponseSchema.parse(await this.#payload(response));
  }

  async createChannel(input: CreateChannelOperation): Promise<ConversationMutationResponse> {
    const { idempotencyKey, ...request } = input;
    const { channelMode, ...legacyRequest } = request;
    const body = channelMode === "announcement" ? request : legacyRequest;
    const response = await this.#fetchIdempotentMutation(this.#url("/v2/channels").href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    return conversationMutationResponseSchema.parse(await this.#payload(response));
  }

  async archiveChannel(
    conversationId: string,
    input: ArchiveChannelRequest,
  ): Promise<ConversationMutationResponse> {
    const response = await this.#fetch(
      this.#url(`/v2/channels/${encodeURIComponent(conversationId)}`).href,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    return conversationMutationResponseSchema.parse(await this.#payload(response));
  }

  async channelMembers(conversationId: string): Promise<ChannelMembersResponse> {
    const response = await this.#fetch(
      this.#url(`/v2/channels/${encodeURIComponent(conversationId)}/members`).href,
      {
        method: "GET",
      },
    );
    return channelMembersResponseSchema.parse(await this.#payload(response));
  }

  async upsertChannelMember(
    conversationId: string,
    userId: string,
    input: UpsertChannelMemberRequest,
  ): Promise<ChannelMembershipMutationResponse> {
    const response = await this.#fetch(
      this.#url(
        `/v2/channels/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      ).href,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    return channelMembershipMutationResponseSchema.parse(await this.#payload(response));
  }

  async removeChannelMember(
    conversationId: string,
    userId: string,
  ): Promise<ChannelMembershipMutationResponse> {
    const response = await this.#fetch(
      this.#url(
        `/v2/channels/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      ).href,
      { method: "DELETE" },
    );
    return channelMembershipMutationResponseSchema.parse(await this.#payload(response));
  }

  async createDirectConversation(
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse> {
    const response = await this.#fetch(this.#url("/v2/direct-conversations").href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    return conversationMutationResponseSchema.parse(await this.#payload(response));
  }

  async history(input: {
    readonly conversationId: string;
    readonly before?: string;
    readonly limit?: number;
  }): Promise<MessageHistoryResponse> {
    const url = this.#url(`/v2/conversations/${encodeURIComponent(input.conversationId)}/messages`);
    if (input.before !== undefined) url.searchParams.set("before", input.before);
    url.searchParams.set("limit", String(input.limit ?? 50));
    const response = await this.#fetch(url.href, {
      method: "GET",
    });
    return messageHistoryResponseSchema.parse(await this.#payload(response));
  }

  async thread(input: MessageThreadRequest): Promise<MessageThreadResponse> {
    const request = messageThreadRequestSchema.parse(input);
    const url = this.#url(`/v2/messages/${encodeURIComponent(request.messageId)}/thread`);
    if (request.before !== undefined) url.searchParams.set("before", request.before);
    url.searchParams.set("limit", String(request.limit));
    const response = await this.#fetch(url.href, { method: "GET" });
    return messageThreadResponseSchema.parse(await this.#payload(response));
  }

  async messageById(messageId: string): Promise<MessageByIdResponse> {
    const response = await this.#fetch(
      this.#url(`/v2/messages/${encodeURIComponent(messageId)}`).href,
      { method: "GET" },
    );
    return messageByIdResponseSchema.parse(await this.#payload(response));
  }

  async retractMessage(messageId: string): Promise<RetractMessageResponse> {
    const response = await this.#fetch(
      this.#url(`/v2/messages/${encodeURIComponent(messageId)}`).href,
      { method: "DELETE" },
    );
    return retractMessageResponseSchema.parse(await this.#payload(response));
  }

  async reactions(messageIds: readonly string[]): Promise<ListMessageReactionsResponse> {
    const response = await this.#fetch(this.#url("/v2/reactions/query").href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIds }),
    });
    const parsed = listMessageReactionsResponseSchema.parse(await this.#payload(response));
    const requested = new Set(messageIds);
    if (parsed.reactions.some((reaction) => !requested.has(reaction.messageId))) {
      throw new Error("Reaction response included an unrequested message");
    }
    return parsed;
  }

  async addReaction(messageId: string, emoji: ReactionEmoji): Promise<AddReactionResponse> {
    const response = await this.#fetch(
      this.#url(
        `/v2/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      ).href,
      { method: "PUT" },
    );
    return addReactionResponseSchema.parse(await this.#payload(response));
  }

  async removeReaction(messageId: string, emoji: ReactionEmoji): Promise<RemoveReactionResponse> {
    const response = await this.#fetch(
      this.#url(
        `/v2/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      ).href,
      { method: "DELETE" },
    );
    return removeReactionResponseSchema.parse(await this.#payload(response));
  }

  async searchMessages(input: MessageSearchQuery): Promise<MessageSearchResponse> {
    const url = this.#url("/v2/search");
    url.searchParams.set("query", input.query);
    if (input.after !== undefined) url.searchParams.set("after", input.after);
    url.searchParams.set("limit", String(input.limit));
    const response = await this.#fetch(url.href, { method: "GET" });
    return messageSearchResponseSchema.parse(await this.#payload(response));
  }

  async tasks(
    conversationId: string,
    input: Partial<TaskListQuery> = {},
  ): Promise<TaskListResponse> {
    const url = this.#url(`/v2/conversations/${encodeURIComponent(conversationId)}/tasks`);
    appendTaskListQuery(url, input);
    const response = await this.#fetch(url.href, { method: "GET" });
    return taskListResponseSchema.parse(await this.#payload(response));
  }

  async myTasks(input: Partial<TaskListQuery> = {}): Promise<TaskListResponse> {
    const url = this.#url("/v2/tasks/mine");
    appendTaskListQuery(url, input);
    const response = await this.#fetch(url.href, { method: "GET" });
    return taskListResponseSchema.parse(await this.#payload(response));
  }

  async createTask(input: CreateTaskOperation): Promise<TaskMutationResponse> {
    const { conversationId, idempotencyKey, ...request } = input;
    const response = await this.#fetchIdempotentMutation(
      this.#url(`/v2/conversations/${encodeURIComponent(conversationId)}/tasks`).href,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(request),
      },
    );
    return taskMutationResponseSchema.parse(await this.#payload(response));
  }

  async updateTask(input: UpdateTaskOperation): Promise<TaskMutationResponse> {
    const { taskId, idempotencyKey, ...request } = input;
    const response = await this.#fetchIdempotentMutation(
      this.#url(`/v2/tasks/${encodeURIComponent(taskId)}`).href,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(request),
      },
    );
    return taskMutationResponseSchema.parse(await this.#payload(response));
  }

  async moveTask(input: MoveTaskOperation): Promise<TaskMutationResponse> {
    const { taskId, idempotencyKey, ...request } = input;
    const response = await this.#fetchIdempotentMutation(
      this.#url(`/v2/tasks/${encodeURIComponent(taskId)}/move`).href,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(request),
      },
    );
    return taskMutationResponseSchema.parse(await this.#payload(response));
  }

  async send(input: SendMessageOperation): Promise<SendAttemptResult> {
    try {
      const response = await this.#fetch(
        this.#url(`/v2/conversations/${encodeURIComponent(input.conversationId)}/messages`).href,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey,
          },
          body: JSON.stringify(input.message),
        },
      );
      if (response.ok) {
        return sendAttemptResultSchema.parse({
          status: "accepted",
          response: sendMessageResponseSchema.parse(await response.json()),
        });
      }
      if (response.status === 401) {
        await this.session.markSignedOut();
        return { status: "authentication_required" };
      }
      if (response.status === 429) {
        return {
          status: "retryable",
          reason: "rate_limited",
          retryAfterMs: retryAfter(response),
        };
      }
      if (response.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(response.status)) {
        return { status: "retryable", reason: "server", retryAfterMs: retryAfter(response) };
      }
      return {
        status: "permanent",
        reason: SEND_PERMANENT_REASONS.get(response.status) ?? "validation",
      };
    } catch (error) {
      if (error instanceof WorkspaceProtocolError) return { status: "upgrade_required" };
      if (isNetworkFailure(error)) {
        return { status: "retryable", reason: "network", retryAfterMs: null };
      }
      return { status: "retryable", reason: "invalid_response", retryAfterMs: null };
    }
  }

  async advanceRead(
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    const response = await this.#fetch(
      this.#url(`/v2/conversations/${encodeURIComponent(conversationId)}/read-cursor`).href,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lastReadMessageId }),
      },
    );
    return advanceReadCursorResponseSchema.parse(await this.#payload(response));
  }

  async sync(after: SyncPosition, limit = 100): Promise<SyncAttemptResult> {
    const url = this.#url("/v2/sync");
    url.searchParams.set("after", encodeSyncPosition(after));
    url.searchParams.set("limit", String(limit));

    let response: Response;
    try {
      response = await this.#fetch(url.href, {
        method: "GET",
      });
    } catch (error) {
      if (error instanceof WorkspaceProtocolError) return { status: "upgrade_required" };
      // Only a transport failure is worth retrying; anything else would retry forever.
      return isNetworkFailure(error)
        ? { status: "retryable", reason: "network", retryAfterMs: null }
        : { status: "permanent", reason: "invalid_response" };
    }

    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: "permanent", reason: "invalid_response" };
      }
      // A response the client cannot parse never becomes retryable: the renderer must surface it.
      const accepted = syncAttemptResultSchema.safeParse({ status: "accepted", response: body });
      if (!accepted.success) return { status: "permanent", reason: "invalid_response" };
      return accepted.data;
    }
    if (response.status === 401) {
      await this.session.markSignedOut();
      return { status: "authentication_required" };
    }
    if (response.status === 410) {
      const envelope = apiErrorEnvelopeSchema.safeParse(await response.json().catch(() => null));
      const epochMismatch =
        envelope.success &&
        envelope.data.error.details?.some(
          (detail) => detail.field === "after.epoch" && detail.issue === "epoch_mismatch",
        );
      return {
        status: "reset_required",
        reason: epochMismatch ? "epoch_mismatch" : "cursor_expired",
      };
    }
    if (response.status === 429) {
      return { status: "retryable", reason: "rate_limited", retryAfterMs: retryAfter(response) };
    }
    if (response.status >= 500) {
      return { status: "retryable", reason: "server", retryAfterMs: retryAfter(response) };
    }
    // Every remaining status is a rejected request, not a hiccup: retrying it changes nothing.
    return {
      status: "permanent",
      reason: SYNC_PERMANENT_REASONS.get(response.status) ?? "validation",
    };
  }

  async conversationFiles(
    conversationId: string,
    input: Partial<ConversationFilesQuery> = {},
  ): Promise<ConversationFilesResponse> {
    const query = conversationFilesQuerySchema.parse(input);
    const url = this.#url(`/v2/conversations/${encodeURIComponent(conversationId)}/files`);
    if (query.before !== undefined) url.searchParams.set("before", query.before);
    url.searchParams.set("limit", String(query.limit));
    const response = await this.#fetch(url.href, {
      method: "GET",
    });
    return conversationFilesResponseSchema.parse(await this.#payload(response));
  }

  async attachments(messageIds: readonly string[]): Promise<ListMessageAttachmentsResponse> {
    const response = await this.#fetch(this.#url("/v2/attachments/query").href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ messageIds }),
    });
    return listMessageAttachmentsResponseSchema.parse(await this.#payload(response));
  }

  async uploadLocalFile(
    conversationId: string,
    filePath: string,
    assertCurrentScope: RequestScopeGuard = alwaysCurrentRequestScope,
  ): Promise<Attachment> {
    assertCurrentScope();
    const bytes = await readFile(filePath);
    assertCurrentScope();
    const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
    const contentType = contentTypeForFileName(fileName);
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const created = createFileUploadResponseSchema.parse(
      await this.#payload(
        await this.#fetchIdempotentMutation(
          this.#url("/v2/files/uploads").href,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              conversationId,
              fileName,
              contentType,
              sizeBytes: bytes.byteLength,
              contentSha256,
            }),
          },
          assertCurrentScope,
        ),
      ),
    );
    const uploaded = await this.#fetchInScope(
      this.#url(`/v2/files/${encodeURIComponent(created.attachment.id)}/content`).href,
      {
        method: "PUT",
        headers: { "content-type": contentType },
        body: bytes,
      },
      assertCurrentScope,
    );
    if (!uploaded.ok) {
      throw new WorkspaceRequestError(
        `Workspace request failed (${uploaded.status})`,
        uploaded.status,
        retryAfter(uploaded),
      );
    }
    const completed = completeFileUploadResponseSchema.parse(
      await this.#payload(
        await this.#fetchIdempotentMutation(
          this.#url(`/v2/files/${encodeURIComponent(created.attachment.id)}/complete`).href,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              sizeBytes: bytes.byteLength,
              contentSha256,
            }),
          },
          assertCurrentScope,
        ),
      ),
    );
    assertCurrentScope();
    return attachmentSchema.parse(completed.attachment);
  }

  async downloadFile(attachmentId: string): Promise<{
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Buffer;
  }> {
    const response = await this.#fetch(
      this.#url(`/v2/files/${encodeURIComponent(attachmentId)}/content`).href,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new WorkspaceRequestError(
        `Workspace request failed (${response.status})`,
        response.status,
        retryAfter(response),
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const fileName = fileNameFromDisposition(
      response.headers.get("content-disposition"),
      "download",
    );
    return { fileName, contentType, bytes };
  }

  async ticket(): Promise<RealtimeTicketResponse> {
    const response = await this.#fetch(this.#url("/v2/realtime/tickets").href, {
      method: "POST",
    });
    return realtimeTicketResponseSchema.parse(await this.#payload(response));
  }
}

export class WorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "WorkspaceRequestError";
  }
}

function contentTypeForFileName(fileName: string): string {
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined;
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
    case "md":
    case "log":
      return "text/plain";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) {
    return fallback;
  }
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1] !== undefined) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // Fall through to the quoted filename or the caller-supplied fallback.
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  return quoted?.[1] ?? fallback;
}
