import { describe, expect, it } from "vitest";

import {
  AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS,
  AGENT_WAKE_KEY_DOMAIN,
  agentWakeBootstrapResponseSchema,
  agentWakeSignalSchema,
  agentWakeStreamRecordSchema,
  classifyAgentWake,
  createAgentWakeSignal,
  encodeAgentWakeKeyInput,
  getAgentWakeKeyInput,
  productRealtimeEventSchema,
} from "../src/index.js";
import type { ConversationKind, ProductRealtimeEvent } from "../src/index.js";

const AGENT_USER_ID = "10000000-0000-4000-8000-000000000001";
const AUTHOR_USER_ID = "10000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000003";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000004";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000005";
const THREAD_ROOT_ID = "10000000-0000-4000-8000-000000000006";
const EVENT_ID = "10000000-0000-4000-8000-000000000007";
const CONNECTION_ID = "10000000-0000-4000-8000-000000000008";
const NOW = "2026-08-23T18:00:00.000Z";
const WAKE_ID = "a".repeat(64);

interface MessageEventOptions {
  readonly authorId?: string | null;
  readonly body?: string;
  readonly mentionedUserIds?: readonly string[];
  readonly threadRootId?: string | null;
  readonly participatedThread?: boolean;
}

function messageEvent(options: MessageEventOptions = {}): ProductRealtimeEvent {
  return productRealtimeEventSchema.parse({
    version: 1,
    id: EVENT_ID,
    type: "message.created",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    workspaceSequence: "43",
    conversationSequence: "12",
    entityVersion: 1,
    delivery: "at_least_once",
    payload: {
      message: {
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        conversationSequence: "12",
        version: 1,
        clientMessageId: MESSAGE_ID,
        authorId: options.authorId === undefined ? AUTHOR_USER_ID : options.authorId,
        threadRootId: options.threadRootId ?? null,
        body: options.body ?? "private message body that must not enter a wake",
        bodyFormat: "hype_comms_markdown_v1",
        editedAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      mentionedUserIds: options.mentionedUserIds ?? [],
      ...(options.participatedThread === true
        ? { recipientNotificationReason: "participated_thread_reply" }
        : {}),
    },
  });
}

function classify(conversationKind: ConversationKind, options: MessageEventOptions = {}) {
  return classifyAgentWake(messageEvent(options), conversationKind, AGENT_USER_ID);
}

describe("agent wake eligibility", () => {
  it("classifies an unmentioned one-to-one DM without copying its body", () => {
    const candidate = classify("direct_message", { threadRootId: THREAD_ROOT_ID });

    expect(candidate).toEqual({
      version: 1,
      type: "agent.wake",
      delivery: "at_least_once",
      eventId: EVENT_ID,
      workspaceSequence: "43",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      threadRootId: THREAD_ROOT_ID,
      occurredAt: NOW,
      reason: "direct_message",
    });
    expect(JSON.stringify(candidate)).not.toContain("private message body");
  });

  it.each(["channel", "direct_message", "group_direct_message"] as const)(
    "lets a verified mention win in a %s",
    (conversationKind) => {
      expect(classify(conversationKind, { mentionedUserIds: [AGENT_USER_ID] })).toMatchObject({
        reason: "verified_mention",
      });
    },
  );

  it.each([
    ["an unmentioned channel", "channel", {}],
    ["mention-like plaintext without a verified ID", "channel", { body: "@agent please wake" }],
    ["an unmentioned group DM", "group_direct_message", {}],
    [
      "a participated-thread reason alone",
      "channel",
      { threadRootId: THREAD_ROOT_ID, participatedThread: true },
    ],
    ["a missing author", "direct_message", { authorId: null }],
    ["a self-authored DM", "direct_message", { authorId: AGENT_USER_ID }],
    [
      "a self-authored verified mention",
      "channel",
      { authorId: AGENT_USER_ID, mentionedUserIds: [AGENT_USER_ID] },
    ],
  ] as const)("does not wake for %s", (_label, conversationKind, options) => {
    expect(classify(conversationKind, options)).toBeNull();
  });

  it("ignores every non-message product event", () => {
    const connected = productRealtimeEventSchema.parse({
      version: 1,
      id: EVENT_ID,
      type: "system.connected",
      occurredAt: NOW,
      workspaceId: WORKSPACE_ID,
      conversationId: null,
      workspaceSequence: "43",
      conversationSequence: null,
      entityVersion: 1,
      delivery: "at_least_once",
      payload: { connectionId: CONNECTION_ID, userId: AGENT_USER_ID },
    });

    expect(classifyAgentWake(connected, "direct_message", AGENT_USER_ID)).toBeNull();
  });
});

describe("agent wake wire contracts", () => {
  const candidate = classify("direct_message");

  if (candidate === null) {
    throw new Error("Test fixture must be wake eligible");
  }

  const signal = createAgentWakeSignal(candidate, WAKE_ID);

  it("bounds a strict body-free wake bootstrap to conversation IDs and kinds", () => {
    const conversations = Array.from(
      { length: AGENT_WAKE_BOOTSTRAP_MAX_CONVERSATIONS },
      (_, index) => ({
        conversationId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        kind: index % 2 === 0 ? ("channel" as const) : ("direct_message" as const),
      }),
    );
    const bootstrap = {
      agentUserId: AGENT_USER_ID,
      workspaceId: WORKSPACE_ID,
      highWaterCursor: "43",
      conversations,
    };

    expect(agentWakeBootstrapResponseSchema.parse(bootstrap)).toEqual(bootstrap);
    expect(
      agentWakeBootstrapResponseSchema.safeParse({ ...bootstrap, body: "secret" }).success,
    ).toBe(false);
    expect(
      agentWakeBootstrapResponseSchema.safeParse({
        ...bootstrap,
        conversations: [
          { ...conversations[0], lastMessage: { body: "secret" } },
          ...conversations.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(
      agentWakeBootstrapResponseSchema.safeParse({
        ...bootstrap,
        conversations: [
          ...conversations,
          {
            conversationId: "20000000-0000-4000-8000-999999999999",
            kind: "channel",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("defines stable, domain-separated wake key input without hashing in contracts", () => {
    const input = getAgentWakeKeyInput(candidate);

    expect(AGENT_WAKE_KEY_DOMAIN).toBe("hype-wake-v1");
    expect(input).toEqual({
      version: 1,
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      messageId: MESSAGE_ID,
    });
    expect(encodeAgentWakeKeyInput(input)).toBe(
      `["hype-wake-v1","${WORKSPACE_ID}","${AGENT_USER_ID}","${MESSAGE_ID}"]`,
    );
    expect(encodeAgentWakeKeyInput(input)).toBe(encodeAgentWakeKeyInput(input));
    expect(encodeAgentWakeKeyInput({ ...input, messageId: THREAD_ROOT_ID })).not.toBe(
      encodeAgentWakeKeyInput(input),
    );
  });

  it("accepts an exact body-free signal including a nullable thread root", () => {
    expect(agentWakeSignalSchema.parse(signal)).toEqual(signal);
    expect(agentWakeSignalSchema.parse({ ...signal, threadRootId: THREAD_ROOT_ID })).toMatchObject({
      threadRootId: THREAD_ROOT_ID,
    });
  });

  it.each([
    ["body", "secret body"],
    ["history", []],
    ["prompt", "perform work"],
    ["token", "provider-secret"],
  ])("rejects a signal carrying forbidden %s data", (field, value) => {
    expect(agentWakeSignalSchema.safeParse({ ...signal, [field]: value }).success).toBe(false);
  });

  it.each(["A".repeat(64), "a".repeat(63), "a".repeat(65), `wake:${"a".repeat(64)}`])(
    "rejects a malformed or non-opaque wake id",
    (wakeId) => {
      expect(agentWakeSignalSchema.safeParse({ ...signal, wakeId }).success).toBe(false);
    },
  );

  it("validates wake, checkpoint, and repair records as one strict stream", () => {
    const checkpoint = {
      version: 1,
      type: "agent.wake.checkpoint",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      cursor: "43",
    } as const;
    const repair = {
      version: 1,
      type: "agent.wake.repair_required",
      workspaceId: WORKSPACE_ID,
      agentUserId: AGENT_USER_ID,
      cursor: "43",
      reason: "cursor_expired",
    } as const;

    expect(agentWakeStreamRecordSchema.parse(signal)).toEqual(signal);
    expect(agentWakeStreamRecordSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(agentWakeStreamRecordSchema.parse(repair)).toEqual(repair);
    expect(
      agentWakeStreamRecordSchema.safeParse({ ...checkpoint, body: "not allowed" }).success,
    ).toBe(false);
    expect(
      agentWakeStreamRecordSchema.safeParse({ ...repair, reason: "retry_later" }).success,
    ).toBe(false);
  });
});
