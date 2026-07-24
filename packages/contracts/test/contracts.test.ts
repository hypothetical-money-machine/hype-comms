import { describe, expect, it } from "vitest";

import {
  apiErrorEnvelopeSchema,
  conversationSchema,
  createChatMessageRequestSchema,
  displayNameSchema,
  chatMessageEventSchema,
  chatSessionStateSchema,
  messageSchema,
  sendMessageRequestSchema,
  systemConnectedEventSchema,
  userSchema,
} from "../src/index.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";
const NOW = "2026-07-21T12:00:00.000Z";

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
  it("validates display names and welcome messages", () => {
    expect(displayNameSchema.parse("  Morgan  ")).toBe("Morgan");
    expect(() => displayNameSchema.parse("Morgan\nAdmin")).toThrow();

    // The create request carries no author: the server derives it from the session.
    expect(() =>
      createChatMessageRequestSchema.parse({
        clientMessageId: MESSAGE_ID,
        authorName: "Morgan",
        body: "Hello, welcome channel!",
      }),
    ).toThrow();

    expect(
      createChatMessageRequestSchema.parse({
        clientMessageId: MESSAGE_ID,
        body: "Hello, welcome channel!",
      }),
    ).toMatchObject({ body: "Hello, welcome channel!" });

    expect(
      chatMessageEventSchema.parse({
        version: 1,
        type: "chat.welcome_message_created",
        message: {
          id: MESSAGE_ID,
          clientMessageId: MESSAGE_ID,
          authorName: "Morgan",
          body: "Hello, welcome channel!",
          createdAt: NOW,
        },
      }),
    ).toMatchObject({ type: "chat.welcome_message_created" });
  });

  it("keeps the session state discriminated and free of credentials", () => {
    expect(chatSessionStateSchema.parse({ status: "signed-out" })).toEqual({
      status: "signed-out",
    });
    expect(
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "access-code",
        name: "Morgan",
      }),
    ).toEqual({
      status: "signed-in",
      method: "access-code",
      name: "Morgan",
    });
    expect(
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "email",
        name: "Morgan",
        email: "MORGAN@example.com",
      }),
    ).toEqual({
      status: "signed-in",
      method: "email",
      name: "Morgan",
      email: "morgan@example.com",
    });
    expect(() =>
      chatSessionStateSchema.parse({
        status: "signed-in",
        method: "access-code",
        name: "Morgan",
        accessCode: "x",
      }),
    ).toThrow();
    expect(() => chatSessionStateSchema.parse({ status: "signed-in" })).toThrow();
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
