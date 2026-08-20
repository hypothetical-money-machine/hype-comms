import type { ConversationSummary, Message } from "@hype-comms/contracts";
import { describe, expect, it } from "vitest";

import {
  lastMessagePreview,
  listUnreadConversations,
  unreadBadgeTotals,
} from "./unread-conversations";

const NOW = "2026-08-20T12:00:00.000Z";
const EARLIER = "2026-08-20T11:00:00.000Z";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000002";
const USER_ID = "30000000-0000-4000-8000-000000000001";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "30000000-0000-4000-8000-000000000020",
    conversationId: "30000000-0000-4000-8000-000000000010",
    conversationSequence: "1",
    version: 1,
    clientMessageId: "30000000-0000-4000-8000-000000000021",
    authorId: USER_ID,
    threadRootId: null,
    body: "Latest note",
    bodyFormat: "hype_comms_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function summary(
  id: string,
  name: string,
  unreadCount: number,
  mentionCount = 0,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    conversation: {
      id,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name,
      slug: name.toLocaleLowerCase().replaceAll(/\s+/gu, "-"),
      topic: null,
      access: "workspace",
      channelMode: "chat",
      isArchived: false,
      createdBy: USER_ID,
      createdAt: EARLIER,
      updatedAt: NOW,
    },
    participantIds: [],
    membershipRole: null,
    lastMessage: null,
    unreadCount,
    mentionCount,
    readCursor: null,
    ...overrides,
  };
}

describe("lastMessagePreview", () => {
  it("collapses whitespace and truncates long bodies", () => {
    expect(lastMessagePreview("  hello\n\nthere  ", null)).toBe("hello there");
    expect(lastMessagePreview("x".repeat(140), null)?.endsWith("…")).toBe(true);
  });

  it("omits deleted or empty bodies", () => {
    expect(lastMessagePreview("gone", NOW)).toBeNull();
    expect(lastMessagePreview("   ", null)).toBeNull();
  });
});

describe("listUnreadConversations", () => {
  it("uses server unread and mention counts and puts mentions first", () => {
    const items = listUnreadConversations(
      [
        summary("read", "Read", 0, 0),
        summary("later-unread", "Later unread", 2, 0, {
          lastMessage: message({
            conversationId: "later-unread",
            createdAt: NOW,
            body: "newer unread",
          }),
        }),
        summary("mention", "Mentioned", 4, 1, {
          lastMessage: message({
            conversationId: "mention",
            createdAt: EARLIER,
            body: "you were mentioned",
          }),
        }),
        summary("older-unread", "Older unread", 1, 0, {
          lastMessage: message({
            conversationId: "older-unread",
            createdAt: EARLIER,
            body: "older unread",
          }),
        }),
      ],
      (candidate) => candidate.conversation.name ?? "channel",
    );

    expect(items.map((item) => item.conversationId)).toEqual([
      "mention",
      "later-unread",
      "older-unread",
    ]);
    expect(items[0]).toMatchObject({
      section: "mention",
      mentionCount: 1,
      unreadCount: 4,
      lastMessagePreview: "you were mentioned",
    });
    expect(items[1]?.section).toBe("unread");
    expect(unreadBadgeTotals(items)).toEqual({ unreadCount: 7, mentionCount: 1 });
  });

  it("resolves direct-message names through the supplied conversationName", () => {
    const dm = summary("dm", "unused", 1, 0, {
      conversation: {
        id: "dm",
        workspaceId: WORKSPACE_ID,
        kind: "direct_message",
        name: null,
        slug: null,
        topic: null,
        access: null,
        channelMode: null,
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const items = listUnreadConversations([dm], () => "Dan");
    expect(items).toEqual([
      expect.objectContaining({
        conversationId: "dm",
        name: "Dan",
        kind: "direct_message",
        section: "unread",
      }),
    ]);
  });
});
