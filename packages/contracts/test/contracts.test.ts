import { describe, expect, it } from "vitest";

import {
  CONVERSATION_PAGE_DEFAULT_LIMIT,
  CONVERSATION_PAGE_MAX_LIMIT,
  apiErrorEnvelopeSchema,
  conversationSummarySchema,
  conversationSchema,
  displayNameSchema,
  chatSessionStateSchema,
  listConversationsQuerySchema,
  listConversationsResponseSchema,
  messageSchema,
  messageHistoryQuerySchema,
  sendMessageOperationSchema,
  sendMessageRequestSchema,
  syncAttemptResultSchema,
  syncQuerySchema,
  systemConnectedEventSchema,
  updateStateSchema,
  updateVersionSchema,
  userSchema,
  workspaceBootstrapResponseSchema,
  workspaceSnapshotSchema,
} from "../src/index.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const NOW = "2026-07-21T12:00:00.000Z";

const CONVERSATION_SUMMARY = {
  conversation: {
    id: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    kind: "channel",
    name: "General",
    slug: "general",
    topic: null,
    isArchived: false,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  participantIds: [],
  lastMessage: null,
  unreadCount: 0,
  mentionCount: 0,
  readCursor: null,
};

const BOOTSTRAP = {
  currentUser: {
    user: {
      id: USER_ID,
      username: "morgan",
      displayName: "Morgan",
      avatarUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    email: "morgan@example.com",
    workspaceId: WORKSPACE_ID,
    role: "owner",
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "HMM",
    slug: "hmm",
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [],
  conversations: [CONVERSATION_SUMMARY],
  conversationsNextCursor: null,
  conversationsHasMore: false,
  syncCursor: "12",
  featureFlags: { channels: true, directMessages: true, mentions: true },
};

describe("entity contracts", () => {
  it("accepts representative entity payloads", () => {
    expect(
      userSchema.parse({
        id: USER_ID,
        username: "morgan",
        displayName: "Morgan",
        avatarUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ id: USER_ID });

    expect(
      conversationSchema.parse({
        id: CONVERSATION_ID,
        workspaceId: WORKSPACE_ID,
        kind: "channel",
        name: "general",
        slug: "general",
        topic: null,
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ kind: "channel" });

    expect(
      messageSchema.parse({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "42",
        version: 1,
        clientMessageId: MESSAGE_ID,
        authorId: USER_ID,
        threadRootId: null,
        body: "Hello",
        bodyFormat: "hmm_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toMatchObject({ body: "Hello" });
  });

  it("rejects unknown fields so wire-shape changes are deliberate", () => {
    expect(() =>
      userSchema.parse({
        id: USER_ID,
        username: "morgan",
        displayName: "Morgan",
        avatarUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
        role: "admin",
      }),
    ).toThrow();
  });
});

describe("transport contracts", () => {
  it("validates display names and conversation summaries", () => {
    expect(displayNameSchema.parse("  Morgan  ")).toBe("Morgan");
    expect(() => displayNameSchema.parse("Morgan\nAdmin")).toThrow();

    expect(
      conversationSummarySchema.parse({
        conversation: {
          id: CONVERSATION_ID,
          workspaceId: WORKSPACE_ID,
          kind: "channel",
          name: "General",
          slug: "general",
          topic: null,
          isArchived: false,
          createdBy: USER_ID,
          createdAt: NOW,
          updatedAt: NOW,
        },
        participantIds: [],
        lastMessage: null,
        unreadCount: 0,
        mentionCount: 0,
        readCursor: null,
      }),
    ).toMatchObject({ conversation: { slug: "general" } });
  });

  it("keeps the session state discriminated and free of credentials", () => {
    expect(chatSessionStateSchema.parse({ status: "signed-out" })).toEqual({
      status: "signed-out",
    });
    expect(
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "email",
        name: "Morgan",
        email: "MORGAN@example.com",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).toEqual({
      status: "signed-in",
      method: "email",
      name: "Morgan",
      email: "morgan@example.com",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(() =>
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "email",
        name: "Morgan",
        email: "morgan@example.com",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        token: "x",
      }),
    ).toThrow();
    expect(() => chatSessionStateSchema.parse({ status: "signed-in" })).toThrow();
  });

  it("keeps update state bounded and free of updater diagnostics", () => {
    expect(updateStateSchema.parse({ status: "downloading", percentage: 42 })).toEqual({
      status: "downloading",
      percentage: 42,
    });
    expect(updateStateSchema.parse({ status: "ready", version: "1.2.3-beta.1" })).toEqual({
      status: "ready",
      version: "1.2.3-beta.1",
    });
    expect(() => updateStateSchema.parse({ status: "downloading", percentage: 42.5 })).toThrow();
    expect(() =>
      updateStateSchema.parse({ status: "error", message: "Raw updater failure" }),
    ).toThrow();
    expect(() =>
      updateStateSchema.parse({
        status: "error",
        message: "Update failed",
        feedUrl: "https://updates.example/private",
      }),
    ).toThrow();
    expect(() => updateVersionSchema.parse("../unsigned/app.zip")).toThrow();
    expect(() => updateVersionSchema.parse("1".repeat(65))).toThrow();
  });

  it("validates the stable API error envelope", () => {
    expect(
      apiErrorEnvelopeSchema.parse({
        error: {
          code: "BAD_REQUEST",
          message: "Invalid input",
          requestId: "request-1",
          details: [{ field: "name", issue: "Required" }],
        },
      }),
    ).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("coerces bounded HTTP query parameters from URL strings", () => {
    expect(messageHistoryQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(syncQuerySchema.parse({ after: "4", limit: "100" })).toEqual({
      after: "4",
      limit: 100,
    });
    expect(() => syncQuerySchema.parse({ after: "4", limit: "101" })).toThrow();
  });

  it("validates the initial realtime handshake event", () => {
    expect(
      systemConnectedEventSchema.parse({
        version: 1,
        id: "10000000-0000-4000-8000-000000000005",
        type: "system.connected",
        occurredAt: NOW,
        workspaceId: WORKSPACE_ID,
        conversationId: null,
        workspaceSequence: "42",
        conversationSequence: null,
        entityVersion: 1,
        delivery: "at_least_once",
        payload: {
          connectionId: "10000000-0000-4000-8000-000000000006",
          userId: USER_ID,
        },
      }),
    ).toMatchObject({ type: "system.connected" });
  });

  it("rejects unsafe sequence and blank message values", () => {
    expect(() =>
      messageSchema.parse({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "0042",
        version: 1,
        clientMessageId: MESSAGE_ID,
        authorId: USER_ID,
        threadRootId: null,
        body: "   ",
        bodyFormat: "hmm_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow();
  });

  it("requires a UUID clientMessageId for idempotent sends", () => {
    expect(
      sendMessageRequestSchema.parse({
        conversationId: CONVERSATION_ID,
        threadRootId: null,
        body: "Hello",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: MESSAGE_ID,
        mentionedUserIds: [],
        attachmentIds: [],
      }),
    ).toMatchObject({ clientMessageId: MESSAGE_ID });

    expect(() =>
      sendMessageRequestSchema.parse({
        conversationId: CONVERSATION_ID,
        threadRootId: null,
        body: "Hello",
        bodyFormat: "hmm_markdown_v1",
        clientMessageId: "message-1",
        mentionedUserIds: [],
        attachmentIds: [],
      }),
    ).toThrow();

    expect(
      sendMessageOperationSchema.parse({
        conversationId: CONVERSATION_ID,
        idempotencyKey: MESSAGE_ID,
        message: {
          threadRootId: null,
          body: "Hello",
          bodyFormat: "hmm_markdown_v1",
          clientMessageId: MESSAGE_ID,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      }),
    ).toMatchObject({ conversationId: CONVERSATION_ID });

    expect(() =>
      sendMessageOperationSchema.parse({
        conversationId: CONVERSATION_ID,
        idempotencyKey: USER_ID,
        message: {
          threadRootId: null,
          body: "Hello",
          bodyFormat: "hmm_markdown_v1",
          clientMessageId: MESSAGE_ID,
          mentionedUserIds: [],
          attachmentIds: [],
        },
      }),
    ).toThrow();
  });

  it("paginates conversation listing instead of capping it above what the server can return", () => {
    expect(listConversationsQuerySchema.parse({})).toEqual({
      limit: CONVERSATION_PAGE_DEFAULT_LIMIT,
    });
    expect(listConversationsQuerySchema.parse({ after: "abc", limit: "100" })).toEqual({
      after: "abc",
      limit: CONVERSATION_PAGE_MAX_LIMIT,
    });
    expect(() =>
      listConversationsQuerySchema.parse({ limit: String(CONVERSATION_PAGE_MAX_LIMIT + 1) }),
    ).toThrow();

    expect(
      listConversationsResponseSchema.parse({
        conversations: [CONVERSATION_SUMMARY],
        nextCursor: "abc",
        hasMore: true,
      }),
    ).toMatchObject({ hasMore: true });
    // The unpaginated M2 shape must no longer validate, so no caller can silently keep it.
    expect(() =>
      listConversationsResponseSchema.parse({ conversations: [CONVERSATION_SUMMARY] }),
    ).toThrow();
    expect(
      listConversationsResponseSchema.safeParse({
        conversations: Array.from({ length: CONVERSATION_PAGE_MAX_LIMIT + 1 }, () => ({
          ...CONVERSATION_SUMMARY,
        })),
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(false);
  });

  it("requires the bootstrap conversation page cursor so the 501st conversation cannot 500", () => {
    expect(workspaceBootstrapResponseSchema.parse(BOOTSTRAP)).toMatchObject({
      conversationsHasMore: false,
      conversationsNextCursor: null,
    });
    expect(
      workspaceBootstrapResponseSchema.parse({
        ...BOOTSTRAP,
        conversationsNextCursor: "abc",
        conversationsHasMore: true,
      }),
    ).toMatchObject({ conversationsNextCursor: "abc" });

    const { conversationsNextCursor, conversationsHasMore, ...unpaginated } = BOOTSTRAP;
    expect(conversationsNextCursor).toBeNull();
    expect(conversationsHasMore).toBe(false);
    expect(() => workspaceBootstrapResponseSchema.parse(unpaginated)).toThrow();
    const overflowing = Array.from({ length: CONVERSATION_PAGE_MAX_LIMIT + 1 }, () => ({
      ...CONVERSATION_SUMMARY,
    }));
    expect(
      workspaceBootstrapResponseSchema.safeParse({ ...BOOTSTRAP, conversations: overflowing })
        .success,
    ).toBe(false);
    // The desktop aggregate is where more than one page of conversations may accumulate.
    expect(
      workspaceSnapshotSchema.safeParse({ ...unpaginated, conversations: overflowing }).success,
    ).toBe(true);
  });

  it("gives a sync attempt a permanent arm and a Retry-After so it cannot stall forever", () => {
    expect(
      syncAttemptResultSchema.parse({ status: "permanent", reason: "invalid_response" }),
    ).toEqual({ status: "permanent", reason: "invalid_response" });
    expect(syncAttemptResultSchema.parse({ status: "permanent", reason: "forbidden" })).toEqual({
      status: "permanent",
      reason: "forbidden",
    });
    expect(
      syncAttemptResultSchema.parse({
        status: "retryable",
        reason: "rate_limited",
        retryAfterMs: 1_500,
      }),
    ).toMatchObject({ retryAfterMs: 1_500 });
    // A bare retryable result is what used to swallow 403s and invalid responses.
    expect(() => syncAttemptResultSchema.parse({ status: "retryable" })).toThrow();
    expect(() =>
      syncAttemptResultSchema.parse({ status: "retryable", reason: "invalid_response" }),
    ).toThrow();
    expect(() => syncAttemptResultSchema.parse({ status: "permanent" })).toThrow();
  });

  it("reports an unreachable server as a preserved session, not a sign-out", () => {
    expect(
      chatSessionStateSchema.parse({
        status: "session-unavailable",
        reason: "server_unreachable",
        message: "Could not reach the chat server. Your session is still signed in.",
      }),
    ).toMatchObject({ status: "session-unavailable", reason: "server_unreachable" });
    expect(() =>
      chatSessionStateSchema.parse({ status: "session-unavailable", reason: "server_unreachable" }),
    ).toThrow();
    expect(() =>
      chatSessionStateSchema.parse({
        status: "session-unavailable",
        reason: "expired",
        message: "Nope",
      }),
    ).toThrow();
  });

  it("rejects non-HTTPS and credential-bearing entity URLs", () => {
    const baseUser = {
      id: USER_ID,
      username: "morgan",
      displayName: "Morgan",
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(() => userSchema.parse({ ...baseUser, avatarUrl: "javascript:alert(1)" })).toThrow();
    expect(() => userSchema.parse({ ...baseUser, avatarUrl: "file:///etc/passwd" })).toThrow();
    expect(() =>
      userSchema.parse({ ...baseUser, avatarUrl: "https://user:pass@example.com/a" }),
    ).toThrow();
    expect(
      userSchema.parse({ ...baseUser, avatarUrl: "https://cdn.example.com/avatar.png" }),
    ).toMatchObject({ avatarUrl: "https://cdn.example.com/avatar.png" });
  });
});
