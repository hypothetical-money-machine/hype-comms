// @vitest-environment happy-dom

import { cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ConversationSummary, Message } from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { firstUnreadMessageId, UnreadDivider, useUnreadDividerMessageId } from "./unread-divider";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const NOW = "2026-08-05T12:00:00.000Z";

function message(id: string, sequence: string): Message {
  return {
    id,
    conversationId: CONVERSATION_ID,
    conversationSequence: sequence,
    version: 1,
    clientMessageId: id,
    authorId: USER_ID,
    threadRootId: null,
    body: `Message ${sequence}`,
    bodyFormat: "hype_comms_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function summary(unreadCount: number, lastReadSequence: string | null): ConversationSummary {
  return {
    conversation: {
      id: CONVERSATION_ID,
      workspaceId: "10000000-0000-4000-8000-000000000003",
      kind: "channel",
      name: "General",
      slug: "general",
      topic: null,
      access: "workspace",
      channelMode: "chat",
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [],
    membershipRole: null,
    lastMessage: null,
    unreadCount,
    mentionCount: 0,
    readCursor:
      lastReadSequence === null
        ? null
        : {
            conversationId: CONVERSATION_ID,
            userId: USER_ID,
            lastReadMessageId: "10000000-0000-4000-8000-000000000004",
            lastReadConversationSequence: lastReadSequence,
            lastReadAt: NOW,
            updatedAt: NOW,
          },
  };
}

const first = message("10000000-0000-4000-8000-000000000011", "1");
const second = message("10000000-0000-4000-8000-000000000012", "2");
const third = message("10000000-0000-4000-8000-000000000013", "3");

afterEach(cleanup);

describe("unread divider", () => {
  it("finds the earliest loaded message after the read watermark", () => {
    expect(firstUnreadMessageId([third, first, second], summary(2, "1"))).toBe(second.id);
    expect(firstUnreadMessageId([first, second], summary(0, "1"))).toBeNull();
    expect(firstUnreadMessageId([first, second], summary(2, null))).toBe(first.id);
  });

  it("keeps the boundary visible after the server marks the conversation read", () => {
    const { result, rerender } = renderHook(
      ({ currentSummary }: { readonly currentSummary: ConversationSummary }) =>
        useUnreadDividerMessageId(CONVERSATION_ID, [first, second, third], currentSummary),
      { initialProps: { currentSummary: summary(2, "1") } },
    );
    expect(result.current).toBe(second.id);

    rerender({ currentSummary: summary(0, "3") });
    expect(result.current).toBe(second.id);
  });

  it("starts a boundary when a background message becomes unread", () => {
    const { result, rerender } = renderHook(
      ({ currentSummary }: { readonly currentSummary: ConversationSummary }) =>
        useUnreadDividerMessageId(CONVERSATION_ID, [first, second], currentSummary),
      { initialProps: { currentSummary: summary(0, "1") } },
    );
    expect(result.current).toBeNull();

    rerender({ currentSummary: summary(1, "1") });
    expect(result.current).toBe(second.id);
  });

  it("renders an accessible timeline separator", () => {
    render(createElement(UnreadDivider, { conversationId: CONVERSATION_ID }));
    expect(screen.getByRole("separator", { name: "New messages" }).textContent).toBe(
      "New messages",
    );
  });
});
