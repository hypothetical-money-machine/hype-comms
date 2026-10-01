// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MESSAGE_RETRACT_WINDOW_MS, type Message, type User } from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxItem } from "./workspace-cache";

import {
  formatMessageTime,
  MessageRow,
  participantColorIndex,
  PendingMessageRow,
  visibleTimelineMessages,
} from "./App";

describe("message time formatting", () => {
  const localAfternoon = new Date(2026, 0, 2, 17, 5).toISOString();

  it("supports an explicit 12-hour or 24-hour clock", () => {
    expect(formatMessageTime(localAfternoon, "12-hour", "en-US")).toBe("5:05 PM");
    expect(formatMessageTime(localAfternoon, "24-hour", "en-US")).toBe("17:05");
  });

  it("keeps the locale's clock when the preference follows the system", () => {
    expect(formatMessageTime(localAfternoon, "system", "en-US")).toBe("5:05 PM");
  });
});

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
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const pendingMessage: OutboxItem = {
  operation: {
    conversationId: message.conversationId,
    idempotencyKey: message.clientMessageId,
    message: {
      threadRootId: null,
      body: "Pending message",
      bodyFormat: "hype_comms_markdown_v1",
      clientMessageId: message.clientMessageId,
      mentionedUserIds: [],
      attachmentIds: [],
    },
  },
  createdAt: NOW,
  status: "pending",
  attemptCount: 0,
  nextAttemptAt: null,
  failureReason: null,
};

afterEach(cleanup);

function renderMessage(overrides: {
  readonly onOpenThread?: () => void;
  readonly onRetract?: () => Promise<void>;
  readonly currentUserId?: string;
  readonly message?: Message;
  readonly replyCount?: number;
  readonly domIdPrefix?: string;
}) {
  return render(
    createElement(MessageRow, {
      message: overrides.message ?? message,
      members: [user],
      reactions: [],
      currentUserId: overrides.currentUserId ?? USER_ID,
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
  it("shows a reply count below the message while retaining the hover action rail", () => {
    const onOpenThread = vi.fn();
    renderMessage({ onOpenThread, replyCount: 3 });

    const threadAction = screen.getByRole("button", { name: "Open thread with 3 replies" });
    expect(threadAction.closest(".message-action-rail")).not.toBeNull();
    expect(threadAction.textContent).toBe("3");
    expect(
      screen.getByRole("button", {
        name: "Open thread with 3 replies for message from Morgan",
      }).textContent,
    ).toBe("3 replies");

    fireEvent.click(threadAction);
    expect(onOpenThread).toHaveBeenCalledOnce();
  });

  it("does not show a reply count for a message without replies", () => {
    const onOpenThread = vi.fn();
    const { container } = renderMessage({ onOpenThread, replyCount: 0 });

    expect(screen.queryByRole("button", { name: /0 replies/i })).toBeNull();
    const reply = screen.getByRole("button", { name: "Reply in thread" });
    expect(reply.closest(".message-action-rail")).not.toBeNull();
    expect(container.querySelector(".thread-summary")).toBeNull();

    fireEvent.click(reply);
    expect(onOpenThread).toHaveBeenCalledOnce();
  });

  it("uses singular reply text and opens the thread from the summary", () => {
    const onOpenThread = vi.fn();
    renderMessage({ onOpenThread, replyCount: 1 });

    const summary = screen.getByRole("button", {
      name: "Open thread with 1 reply for message from Morgan",
    });
    expect(summary.textContent).toBe("1 reply");

    fireEvent.click(summary);
    expect(onOpenThread).toHaveBeenCalledOnce();
  });

  it("exposes the reply count as a focusable native button", () => {
    const onOpenThread = vi.fn();
    renderMessage({ onOpenThread, replyCount: 2 });

    const summary = screen.getByRole("button", {
      name: "Open thread with 2 replies for message from Morgan",
    });
    summary.focus();
    expect(document.activeElement).toBe(summary);
    // Keyboard activation is the platform's job: a native button already activates on Enter and
    // Space. Asserting the element type is what guarantees that, whereas asserting a keydown
    // handler would only prove we reimplemented it -- and would fail once someone removed it.
    expect(summary.tagName).toBe("BUTTON");
    expect(summary.getAttribute("type")).toBe("button");
  });

  it("shows every in-thread attachment chip and opens its file", () => {
    const onOpenAttachment = vi.fn().mockResolvedValue(undefined);
    const firstAttachmentId = "10000000-0000-4000-8000-000000000010";
    const secondAttachmentId = "10000000-0000-4000-8000-000000000011";
    render(
      createElement(MessageRow, {
        message,
        members: [user],
        reactions: [],
        attachments: [
          {
            id: firstAttachmentId,
            messageId: MESSAGE_ID,
            uploadedBy: USER_ID,
            fileName: "launch-notes.pdf",
            contentType: "application/pdf",
            sizeBytes: 2048,
            status: "ready",
            downloadUrl: null,
            createdAt: NOW,
          },
          {
            id: secondAttachmentId,
            messageId: MESSAGE_ID,
            uploadedBy: USER_ID,
            fileName: "launch-diagram.png",
            contentType: "image/png",
            sizeBytes: 4096,
            status: "ready",
            downloadUrl: null,
            createdAt: NOW,
          },
        ],
        currentUserId: USER_ID,
        reactionsDisabled: false,
        onAddReaction: vi.fn().mockResolvedValue(undefined),
        onRemoveReaction: vi.fn().mockResolvedValue(undefined),
        onOpenAttachment,
        highlighted: false,
        continuation: false,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "launch-notes.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "launch-diagram.png" }));
    expect(onOpenAttachment).toHaveBeenNthCalledWith(1, firstAttachmentId);
    expect(onOpenAttachment).toHaveBeenNthCalledWith(2, secondAttachmentId);
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

describe("MessageRow participant color", () => {
  it("derives a stable palette slot from the author identifier", () => {
    const first = participantColorIndex(USER_ID);

    expect(participantColorIndex(USER_ID)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(8);
    expect(participantColorIndex("10000000-0000-4000-8000-000000000002")).not.toBe(first);
  });

  it("marks each message with its author's palette class", () => {
    const { container } = renderMessage({});

    expect(container.querySelector("article")?.classList).toContain(
      `participant-color-${String(participantColorIndex(USER_ID))}`,
    );
  });

  it("keeps the current user's color on optimistic messages", () => {
    const { container } = render(
      createElement(PendingMessageRow, {
        item: pendingMessage,
        currentUser: user,
        continuation: false,
        editing: false,
        onEdit: vi.fn(),
        onRetry: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    expect(container.querySelector("article")?.classList).toContain(
      `participant-color-${String(participantColorIndex(USER_ID))}`,
    );
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

  it("hides retracted messages so the stored body does not stay on the timeline", () => {
    expect(
      visibleTimelineMessages(
        [{ ...message, deletedAt: NOW, version: 2 }],
        message.conversationId,
        true,
      ),
    ).toEqual([]);
  });
});

describe("MessageRow retract action", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("folds retract into the hover action rail for own messages inside the window", () => {
    const onRetract = vi.fn().mockResolvedValue(undefined);
    const { container } = renderMessage({ onRetract });

    const retract = screen.getByRole("button", { name: "Retract message" });
    expect(retract.closest(".message-action-rail")).not.toBeNull();
    expect(container.textContent).toContain("Root message");

    fireEvent.click(retract);
    expect(onRetract).toHaveBeenCalledOnce();
  });

  it("does not offer retract on another author's message", () => {
    renderMessage({
      onRetract: vi.fn().mockResolvedValue(undefined),
      currentUserId: "10000000-0000-4000-8000-000000000099",
    });

    expect(screen.queryByRole("button", { name: "Retract message" })).toBeNull();
  });

  it("does not offer retract after the five-minute window", () => {
    renderMessage({
      onRetract: vi.fn().mockResolvedValue(undefined),
      message: {
        ...message,
        createdAt: new Date(Date.parse(NOW) - MESSAGE_RETRACT_WINDOW_MS - 1).toISOString(),
      },
    });

    expect(screen.queryByRole("button", { name: "Retract message" })).toBeNull();
    expect(screen.getByText("Root message")).not.toBeNull();
  });
});
