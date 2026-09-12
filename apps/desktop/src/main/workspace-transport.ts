import {
  ApiClientError,
  AttachmentClient,
  HttpClient,
  retryAfterMs,
  sha256,
  WorkspaceProtocolError,
  workspaceEndpoints as endpoints,
  type ApiRequestOptions,
} from "@hype-comms/api-client";
import {
  ATTACHMENT_MAX_BYTES,
  apiErrorEnvelopeSchema,
  type SyncPosition,
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
import { open } from "node:fs/promises";
import type { ChatSession } from "./chat-session";
type RequestScopeGuard = () => void;
const alwaysCurrentRequestScope: RequestScopeGuard = () => undefined;

/** Desktop owns session invalidation, filesystem access, and UI result mapping. */
export class WorkspaceTransport {
  readonly #origin: string;
  readonly #http: HttpClient;
  readonly #attachments: AttachmentClient;
  constructor(
    apiOrigin: string,
    private readonly session: Pick<ChatSession, "fetch" | "markSignedOut">,
  ) {
    this.#origin = apiOrigin;
    this.#http = new HttpClient({
      origin: apiOrigin,
      fetch: async (url, init) => {
        const response = await session.fetch(url.href, init);
        if (response.status === 401) await session.markSignedOut();
        return response;
      },
      timeoutMs: 10_000,
    });
    this.#attachments = new AttachmentClient(this.#http);
  }
  async #request<B = never, R = unknown>(request: ApiRequestOptions<B, R>): Promise<R> {
    try {
      return await this.#http.request(request);
    } catch (error) {
      return this.#fail(error);
    }
  }
  async #fail(error: unknown): Promise<never> {
    if (error instanceof ApiClientError && error.kind === "http" && error.response !== undefined) {
      const envelope = apiErrorEnvelopeSchema.safeParse(error.body);
      throw new WorkspaceRequestError(
        envelope.success
          ? envelope.data.error.message
          : `Workspace request failed (${error.response.status})`,
        error.response.status,
        retryAfterMs(error.response),
      );
    }
    throw error;
  }
  #mutation<B, R>(request: ApiRequestOptions<B, R>, idempotencyKey: string): Promise<R> {
    return this.#request({
      ...request,
      headers: { ...request.headers, "idempotency-key": idempotencyKey },
      retry: "idempotent_once",
    });
  }
  bootstrap(): Promise<HumanWorkspaceBootstrapResponse> {
    return this.#request(endpoints.humanBootstrap());
  }
  members(): Promise<ListMembersResponse> {
    return this.#request(endpoints.members());
  }
  async updateProfile(title: string | null): Promise<User> {
    return (await this.#request(endpoints.updateProfile({ title }))).user;
  }
  communicationPaths(): Promise<CommunicationPathsResponse> {
    return this.#request(endpoints.communicationPaths());
  }
  listAgentEnrollments(): Promise<ListAgentEnrollmentsResponse> {
    return this.#request(endpoints.agentEnrollments());
  }
  reviewAgentEnrollment(
    enrollmentId: string,
    decision: ReviewAgentEnrollmentRequest["decision"],
  ): Promise<AgentEnrollmentResponse> {
    return this.#mutation(
      endpoints.reviewAgentEnrollment(enrollmentId, { decision }),
      crypto.randomUUID(),
    );
  }
  cancelAgentEnrollment(enrollmentId: string): Promise<AgentEnrollmentResponse> {
    return this.#mutation(endpoints.cancelAgentEnrollment(enrollmentId), crypto.randomUUID());
  }
  conversations(input: Partial<ListConversationsQuery> = {}): Promise<ListConversationsResponse> {
    return this.#request(endpoints.conversations(input));
  }
  createChannel(input: CreateChannelOperation): Promise<ConversationMutationResponse> {
    const { idempotencyKey, ...request } = input;
    return this.#mutation(endpoints.createChannel(request), idempotencyKey);
  }
  archiveChannel(
    conversationId: string,
    input: ArchiveChannelRequest,
  ): Promise<ConversationMutationResponse> {
    return this.#request(endpoints.archiveChannel(conversationId, input));
  }
  channelMembers(conversationId: string): Promise<ChannelMembersResponse> {
    return this.#request(endpoints.channelMembers(conversationId));
  }
  upsertChannelMember(
    conversationId: string,
    userId: string,
    input: UpsertChannelMemberRequest,
  ): Promise<ChannelMembershipMutationResponse> {
    return this.#request(endpoints.upsertChannelMember(conversationId, userId, input));
  }
  removeChannelMember(
    conversationId: string,
    userId: string,
  ): Promise<ChannelMembershipMutationResponse> {
    return this.#request(endpoints.removeChannelMember(conversationId, userId));
  }
  createDirectConversation(
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse> {
    return this.#request(endpoints.directConversation(input));
  }
  history(input: {
    readonly conversationId: string;
    readonly before?: string;
    readonly limit?: number;
  }): Promise<MessageHistoryResponse> {
    const { conversationId, ...query } = input;
    return this.#request(endpoints.history(conversationId, query));
  }
  thread(input: MessageThreadRequest): Promise<MessageThreadResponse> {
    const { messageId, ...query } = input;
    return this.#request(endpoints.thread(messageId, query));
  }
  messageById(messageId: string): Promise<MessageByIdResponse> {
    return this.#request(endpoints.message(messageId));
  }
  retractMessage(messageId: string): Promise<RetractMessageResponse> {
    return this.#request(endpoints.retractMessage(messageId));
  }
  async reactions(messageIds: readonly string[]): Promise<ListMessageReactionsResponse> {
    const parsed = await this.#request(endpoints.reactions({ messageIds: [...messageIds] }));
    const requested = new Set(messageIds);
    if (parsed.reactions.some((reaction) => !requested.has(reaction.messageId)))
      throw new ApiClientError("contract", "Reaction response included an unrequested message");
    return parsed;
  }
  addReaction(messageId: string, emoji: ReactionEmoji): Promise<AddReactionResponse> {
    return this.#request(endpoints.addReaction(messageId, emoji));
  }
  removeReaction(messageId: string, emoji: ReactionEmoji): Promise<RemoveReactionResponse> {
    return this.#request(endpoints.removeReaction(messageId, emoji));
  }
  searchMessages(input: MessageSearchQuery): Promise<MessageSearchResponse> {
    return this.#request(endpoints.search(input));
  }
  tasks(conversationId: string, input: Partial<TaskListQuery> = {}): Promise<TaskListResponse> {
    return this.#request(endpoints.tasks(conversationId, input));
  }
  myTasks(input: Partial<TaskListQuery> = {}): Promise<TaskListResponse> {
    return this.#request(endpoints.myTasks(input));
  }
  createTask(input: CreateTaskOperation): Promise<TaskMutationResponse> {
    const { conversationId, idempotencyKey, ...request } = input;
    return this.#mutation(endpoints.createTask(conversationId, request), idempotencyKey);
  }
  updateTask(input: UpdateTaskOperation): Promise<TaskMutationResponse> {
    const { taskId, idempotencyKey, ...request } = input;
    return this.#mutation(endpoints.updateTask(taskId, request), idempotencyKey);
  }
  moveTask(input: MoveTaskOperation): Promise<TaskMutationResponse> {
    const { taskId, idempotencyKey, ...request } = input;
    return this.#mutation(endpoints.moveTask(taskId, request), idempotencyKey);
  }
  async send(input: SendMessageOperation): Promise<SendAttemptResult> {
    try {
      const response = await this.#http.request({
        ...endpoints.sendMessage(input.conversationId, input.message),
        headers: { "idempotency-key": input.idempotencyKey },
      });
      return { status: "accepted", response };
    } catch (error) {
      if (error instanceof WorkspaceProtocolError) return { status: "upgrade_required" };
      if (!(error instanceof ApiClientError)) throw error;
      const response = error.response;
      if (response?.status === 401) return { status: "authentication_required" };
      if (error.kind === "network")
        return { status: "retryable", reason: "network", retryAfterMs: null };
      if (error.kind !== "http" || response === undefined)
        return { status: "retryable", reason: "invalid_response", retryAfterMs: null };
      if (response.status === 429)
        return {
          status: "retryable",
          reason: "rate_limited",
          retryAfterMs: retryAfterMs(response),
        };
      if (response.status >= 500 || [408, 425].includes(response.status))
        return { status: "retryable", reason: "server", retryAfterMs: retryAfterMs(response) };
      return {
        status: "permanent",
        reason:
          response.status === 403
            ? "forbidden"
            : response.status === 404
              ? "not_found"
              : response.status === 409
                ? "conflict"
                : "validation",
      };
    }
  }
  advanceRead(
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    return this.#request(endpoints.advanceRead(conversationId, { lastReadMessageId }));
  }
  async sync(after: SyncPosition, limit = 100): Promise<SyncAttemptResult> {
    try {
      return {
        status: "accepted",
        response: await this.#http.request(endpoints.sync(after, limit)),
      };
    } catch (error) {
      if (error instanceof WorkspaceProtocolError) return { status: "upgrade_required" };
      if (!(error instanceof ApiClientError)) throw error;
      const response = error.response;
      if (response?.status === 401) return { status: "authentication_required" };
      if (error.kind === "network")
        return { status: "retryable", reason: "network", retryAfterMs: null };
      if (error.kind !== "http" || response === undefined)
        return { status: "permanent", reason: "invalid_response" };
      if (response.status === 410) {
        const envelope = apiErrorEnvelopeSchema.safeParse(error.body);
        const mismatch =
          envelope.success &&
          envelope.data.error.details?.some(
            (detail) => detail.field === "after.epoch" && detail.issue === "epoch_mismatch",
          );
        return { status: "reset_required", reason: mismatch ? "epoch_mismatch" : "cursor_expired" };
      }
      if (response.status === 429)
        return {
          status: "retryable",
          reason: "rate_limited",
          retryAfterMs: retryAfterMs(response),
        };
      if (response.status >= 500)
        return { status: "retryable", reason: "server", retryAfterMs: retryAfterMs(response) };
      return {
        status: "permanent",
        reason:
          response.status === 403
            ? "forbidden"
            : response.status === 404
              ? "not_found"
              : "validation",
      };
    }
  }
  conversationFiles(
    conversationId: string,
    input: Partial<ConversationFilesQuery> = {},
  ): Promise<ConversationFilesResponse> {
    return this.#request(endpoints.files(conversationId, input));
  }
  attachments(messageIds: readonly string[]): Promise<ListMessageAttachmentsResponse> {
    return this.#request(endpoints.attachments({ messageIds: [...messageIds] }));
  }
  async uploadLocalFile(
    conversationId: string,
    filePath: string,
    assertCurrentScope: RequestScopeGuard = alwaysCurrentRequestScope,
  ): Promise<Attachment> {
    assertCurrentScope();
    const bytes = await readAttachment(filePath);
    assertCurrentScope();
    const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
    const contentType = contentTypeForFileName(fileName);
    const contentSha256 = await sha256(new Uint8Array(bytes));
    assertCurrentScope();
    // Bind every request, including retries, to this upload's session authorization.
    const http = new HttpClient({
      origin: this.#origin,
      timeoutMs: 10_000,
      fetch: async (url, init) => {
        assertCurrentScope();
        const response = await this.session.fetch(url.href, init);
        try {
          assertCurrentScope();
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        if (response.status === 401) await this.session.markSignedOut();
        return response;
      },
    });
    const files = new AttachmentClient(http);
    try {
      const created = await http.request({
        ...endpoints.createUpload({
          conversationId,
          fileName,
          contentType,
          sizeBytes: bytes.byteLength,
          contentSha256,
        }),
        headers: { "idempotency-key": crypto.randomUUID() },
        retry: "idempotent_once",
      });
      await files.upload({
        path: endpoints.attachmentContent(created.attachment.id),
        headers: { "content-type": contentType },
        bytes,
      });
      const completed = await http.request({
        ...endpoints.completeUpload(created.attachment.id, {
          sizeBytes: bytes.byteLength,
          contentSha256,
        }),
        headers: { "idempotency-key": crypto.randomUUID() },
        retry: "idempotent_once",
      });
      assertCurrentScope();
      return completed.attachment;
    } catch (error) {
      return this.#fail(error);
    }
  }
  async downloadFile(
    attachmentId: string,
  ): Promise<{ readonly fileName: string; readonly contentType: string; readonly bytes: Buffer }> {
    try {
      const { bytes, response } = await this.#attachments.download({
        path: endpoints.attachmentContent(attachmentId),
        maxBytes: ATTACHMENT_MAX_BYTES,
      });
      return {
        bytes: Buffer.from(bytes),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        fileName: fileNameFromDisposition(response.headers.get("content-disposition"), "download"),
      };
    } catch (error) {
      return this.#fail(error);
    }
  }
  ticket(signal?: AbortSignal): Promise<RealtimeTicketResponse> {
    return this.#request({ ...endpoints.ticket(), ...(signal === undefined ? {} : { signal }) });
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

async function readAttachment(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > ATTACHMENT_MAX_BYTES)
      throw new ApiClientError("request", "The attachment exceeded the supported size limit");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > stat.size)
      throw new ApiClientError("request", "The attachment changed while being read");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
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
