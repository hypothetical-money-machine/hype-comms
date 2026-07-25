import {
  advanceReadCursorResponseSchema,
  apiErrorEnvelopeSchema,
  conversationMutationResponseSchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  messageHistoryResponseSchema,
  realtimeTicketResponseSchema,
  sendAttemptResultSchema,
  sendMessageResponseSchema,
  syncAttemptResultSchema,
  workspaceBootstrapResponseSchema,
  type AdvanceReadCursorResponse,
  type ArchiveChannelRequest,
  type ConversationMutationResponse,
  type CreateChannelRequest,
  type DirectConversationRequest,
  type ListConversationsResponse,
  type ListMembersResponse,
  type MessageHistoryResponse,
  type RealtimeTicketResponse,
  type SendAttemptResult,
  type SendMessageOperation,
  type SyncAttemptResult,
  type WorkspaceBootstrapResponse,
} from "@hmm-chat/contracts";

import type { ChatSession } from "./chat-session";

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.round(seconds * 1_000), 86_400_000)
    : null;
}

export class WorkspaceTransport {
  constructor(
    private readonly apiOrigin: string,
    private readonly session: ChatSession,
  ) {}

  async #payload(response: Response): Promise<unknown> {
    if (response.ok) return response.json();
    if (response.status === 401) this.session.markSignedOut();
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

  async bootstrap(): Promise<WorkspaceBootstrapResponse> {
    const response = await this.session.fetch(this.#url("/v1/bootstrap").href, { method: "GET" });
    return workspaceBootstrapResponseSchema.parse(await this.#payload(response));
  }

  async members(): Promise<ListMembersResponse> {
    const response = await this.session.fetch(this.#url("/v1/members").href, { method: "GET" });
    return listMembersResponseSchema.parse(await this.#payload(response));
  }

  async conversations(): Promise<ListConversationsResponse> {
    const response = await this.session.fetch(this.#url("/v1/conversations").href, {
      method: "GET",
    });
    return listConversationsResponseSchema.parse(await this.#payload(response));
  }

  async createChannel(input: CreateChannelRequest): Promise<ConversationMutationResponse> {
    const response = await this.session.fetch(this.#url("/v1/channels").href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return conversationMutationResponseSchema.parse(await this.#payload(response));
  }

  async archiveChannel(
    conversationId: string,
    input: ArchiveChannelRequest,
  ): Promise<ConversationMutationResponse> {
    const response = await this.session.fetch(
      this.#url(`/v1/channels/${encodeURIComponent(conversationId)}`).href,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    return conversationMutationResponseSchema.parse(await this.#payload(response));
  }

  async createDirectConversation(
    input: DirectConversationRequest,
  ): Promise<ConversationMutationResponse> {
    const response = await this.session.fetch(this.#url("/v1/direct-conversations").href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return conversationMutationResponseSchema.parse(await this.#payload(response));
  }

  async history(input: {
    readonly conversationId: string;
    readonly before?: string;
    readonly limit?: number;
  }): Promise<MessageHistoryResponse> {
    const url = this.#url(`/v1/conversations/${encodeURIComponent(input.conversationId)}/messages`);
    if (input.before !== undefined) url.searchParams.set("before", input.before);
    url.searchParams.set("limit", String(input.limit ?? 50));
    const response = await this.session.fetch(url.href, { method: "GET" });
    return messageHistoryResponseSchema.parse(await this.#payload(response));
  }

  async send(input: SendMessageOperation): Promise<SendAttemptResult> {
    try {
      const response = await this.session.fetch(
        this.#url(`/v1/conversations/${encodeURIComponent(input.conversationId)}/messages`).href,
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
        this.session.markSignedOut();
        return { status: "authentication_required" };
      }
      if (response.status === 429) {
        return {
          status: "retryable",
          reason: "rate_limited",
          retryAfterMs: retryAfter(response),
        };
      }
      if (response.status >= 500) {
        return { status: "retryable", reason: "server", retryAfterMs: null };
      }
      const reasons = new Map<number, "validation" | "forbidden" | "not_found" | "conflict">([
        [400, "validation"],
        [403, "forbidden"],
        [404, "not_found"],
        [409, "conflict"],
      ]);
      return {
        status: "permanent",
        reason: reasons.get(response.status) ?? "validation",
      };
    } catch (error) {
      if (error instanceof TypeError) {
        return { status: "retryable", reason: "network", retryAfterMs: null };
      }
      return { status: "retryable", reason: "invalid_response", retryAfterMs: null };
    }
  }

  async advanceRead(
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<AdvanceReadCursorResponse> {
    const response = await this.session.fetch(
      this.#url(`/v1/conversations/${encodeURIComponent(conversationId)}/read-cursor`).href,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lastReadMessageId }),
      },
    );
    return advanceReadCursorResponseSchema.parse(await this.#payload(response));
  }

  async sync(after: string, limit = 100): Promise<SyncAttemptResult> {
    const url = this.#url("/v1/sync");
    url.searchParams.set("after", after);
    url.searchParams.set("limit", String(limit));
    try {
      const response = await this.session.fetch(url.href, { method: "GET" });
      if (response.ok) {
        return syncAttemptResultSchema.parse({
          status: "accepted",
          response: await response.json(),
        });
      }
      if (response.status === 401) {
        this.session.markSignedOut();
        return { status: "authentication_required" };
      }
      if (response.status === 410) {
        return { status: "reset_required", reason: "cursor_expired" };
      }
      return { status: "retryable" };
    } catch {
      return { status: "retryable" };
    }
  }

  async ticket(): Promise<RealtimeTicketResponse> {
    const response = await this.session.fetch(this.#url("/v1/realtime/tickets").href, {
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
