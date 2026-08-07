// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Message, User } from "@hmm-chat/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageRow, visibleTimelineMessages } from "./App";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000002";
const NOW = "2026-08-04T12:00:00.000Z";

const user: User = {
  id: USER_ID,
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const message: Message = {
  id: MESSAGE_ID,
  conversationId: "10000000-0000-4000-8000-000000000003",
  conversationSequence: "1",
  version: 1,
  clientMessageId: "10000000-0000-4000-8000-000000000004",
  authorId: USER_ID,
  threadRootId: null,
  body: "Root message",
  bodyFormat: "hmm_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

afterEach(cleanup);

function renderMessage(overrides: {
  readonly onOpenThread?: () => void;
  readonly replyCount?: number;
  readonly domIdPrefix?: string;
}) {
  return render(
    createElement(MessageRow, {
      message,
      members: [user],
      reactions: [],
      currentUserId: USER_ID,
      reactionsDisabled: false,
      onAddReaction: vi.fn().mockResolvedValue(undefined),
      onRemoveReaction: vi.fn().mockResolvedValue(undefined),
      highlighted: false,
      continuation: false,
      ...overrides,
    }),
  );
}

describe("MessageRow thread action", () => {
  it("opens a summarized thread from its reply-count action", () => {
    const onOpenThread = vi.fn();
    renderMessage({ onOpenThread, replyCount: 3 });

    fireEvent.click(screen.getByRole("button", { name: "3 replies" }));

    expect(onOpenThread).toHaveBeenCalledOnce();
  });

  it("does not expose a nested reply action when the caller omits it", () => {
    renderMessage({});

    expect(screen.queryByRole("button", { name: /repl(?:y|ies)/i })).toBeNull();
  });

  it("keeps visibility metadata when rendered in the thread pane", () => {
    const { container } = renderMessage({ domIdPrefix: "thread-message" });
    const row = container.querySelector("article");

    expect(row?.id).toBe(`thread-message-${MESSAGE_ID}`);
    expect(row?.dataset.messageId).toBe(MESSAGE_ID);
    expect(row?.dataset.messageSequence).toBe("1");
  });
});

describe("visibleTimelineMessages", () => {
  const reply: Message = {
    ...message,
    id: "10000000-0000-4000-8000-000000000005",
    conversationSequence: "2",
    threadRootId: message.id,
  };

  it("keeps replies inline for a previous server and projects roots for a thread-capable server", () => {
    expect(visibleTimelineMessages([message, reply], message.conversationId, false)).toEqual([
      message,
      reply,
    ]);
    expect(visibleTimelineMessages([message, reply], message.conversationId, true)).toEqual([
      message,
    ]);
  });
});
