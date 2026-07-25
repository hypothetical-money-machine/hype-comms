import {
  advanceReadCursorResponseSchema,
  apiErrorEnvelopeSchema,
  conversationMutationResponseSchema,
  CONVERSATION_PAGE_DEFAULT_LIMIT,
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
  type ListConversationsQuery,
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

/**
 * A transport-level failure worth retrying. `fetch` reports connection problems as `TypeError`,
 * while `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`, so a plain
 * request timeout must not be mistaken for a malformed response.
 */
function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * The deployed API can be briefly older than the desktop client during a rolling upgrade. Before
 * conversation pagination existed, bootstrap returned the complete conversation list without
 * page metadata. Preserve that response's meaning while still validating every other field
 * strictly; current servers always send the two metadata fields themselves.
 */
function withLegacyBootstrapPagination(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;

  const candidate = payload as Record<string, unknown>;
  return {
    ...candidate,
    conversationsNextCursor:
      candidate.conversationsNextCursor === undefined ? null : candidate.conversationsNextCursor,
    conversationsHasMore:
      candidate.conversationsHasMore === undefined ? false : candidate.conversationsHasMore,
  };
}

type SendPermanentReason = Extract<SendAttemptResult, { status: "permanent" }>["reason"];
type SyncPermanentReason = Extract<SyncAttemptResult, { status: "permanent" }>["reason"];

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
    return workspaceBootstrapResponseSchema.parse(
      withLegacyBootstrapPagination(await this.#payload(response)),
    );
  }

  async members(): Promise<ListMembersResponse> {
    const response = await this.session.fetch(this.#url("/v1/members").href, { method: "GET" });
    return listMembersResponseSchema.parse(await this.#payload(response));
  }

  async conversations(
    input: Partial<ListConversationsQuery> = {},
  ): Promise<ListConversationsResponse> {
    const url = this.#url("/v1/conversations");
    if (input.after !== undefined) url.searchParams.set("after", input.after);
    url.searchParams.set("limit", String(input.limit ?? CONVERSATION_PAGE_DEFAULT_LIMIT));
    const response = await this.session.fetch(url.href, { method: "GET" });
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
      if (response.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(response.status)) {
        return { status: "retryable", reason: "server", retryAfterMs: retryAfter(response) };
      }
      return {
        status: "permanent",
        reason: SEND_PERMANENT_REASONS.get(response.status) ?? "validation",
      };
    } catch (error) {
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

    let response: Response;
    try {
      response = await this.session.fetch(url.href, { method: "GET" });
    } catch (error) {
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
      this.session.markSignedOut();
      return { status: "authentication_required" };
    }
    if (response.status === 410) {
      return { status: "reset_required", reason: "cursor_expired" };
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
