// @vitest-environment happy-dom

import type { ConversationSummary, Message } from "@hype-comms/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationContextMenu } from "./conversation-context-menu";

const NOW = "2026-01-01T00:00:00Z";

const mockMessage: Message = {
  id: "msg-1",
  conversationId: "conv-1",
  conversationSequence: "10",
  version: 1,
  clientMessageId: "msg-client-1",
  authorId: "user-2",
  threadRootId: null,
  body: "Hello",
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function createMockSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversation: {
      id: "conv-1",
      workspaceId: "ws-1",
      kind: "channel",
      name: "general",
      slug: "general",
      topic: null,
      access: "workspace",
      channelMode: "chat",
      isArchived: false,
      createdBy: "user-1",
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: ["user-1", "user-2"],
    membershipRole: null,
    lastMessage: mockMessage,
    unreadCount: 5,
    mentionCount: 0,
    readCursor: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationContextMenu", () => {
  it("renders Mark as read enabled when conversation has unreads, and triggers callback on click", () => {
    const onClose = vi.fn();
    const onMarkAsRead = vi.fn();
    const summary = createMockSummary({ unreadCount: 3 });

    render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        onClose,
        onMarkAsRead,
      }),
    );

    const button = screen.getByRole("menuitem", { name: "Mark as read" });
    expect(button).toBeDefined();
    expect(button.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(button);
    expect(onMarkAsRead).toHaveBeenCalledWith("conv-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("sets aria-disabled on Mark as read when conversation has zero unreads and mentions", () => {
    const onClose = vi.fn();
    const onMarkAsRead = vi.fn();
    const summary = createMockSummary({ unreadCount: 0, mentionCount: 0 });

    render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        onClose,
        onMarkAsRead,
      }),
    );

    const button = screen.getByRole("menuitem", { name: "Mark as read" });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);
    expect(onMarkAsRead).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("enables Mark as read when mentionCount > 0 even if unreadCount is 0", () => {
    const onClose = vi.fn();
    const onMarkAsRead = vi.fn();
    const summary = createMockSummary({ unreadCount: 0, mentionCount: 1 });

    render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        onClose,
        onMarkAsRead,
      }),
    );

    const button = screen.getByRole("menuitem", { name: "Mark as read" });
    expect(button.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(button);
    expect(onMarkAsRead).toHaveBeenCalledWith("conv-1");
  });

  it("dismisses on Escape", () => {
    const onClose = vi.fn();
    const onMarkAsRead = vi.fn();
    const summary = createMockSummary({ unreadCount: 2 });

    render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        onClose,
        onMarkAsRead,
      }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on pointerDown outside", () => {
    const onClose = vi.fn();
    const onMarkAsRead = vi.fn();
    const summary = createMockSummary({ unreadCount: 2 });

    render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        onClose,
        onMarkAsRead,
      }),
    );

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to triggerRef on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const triggerRef = { current: trigger };
    const summary = createMockSummary({ unreadCount: 2 });

    const { unmount } = render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        triggerRef,
        onClose: vi.fn(),
        onMarkAsRead: vi.fn(),
      }),
    );

    unmount();
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it("notifies onOpenChange", () => {
    const onOpenChange = vi.fn();
    const summary = createMockSummary({ unreadCount: 2 });

    const { unmount } = render(
      createElement(ConversationContextMenu, {
        conversation: summary,
        position: { x: 100, y: 150 },
        onClose: vi.fn(),
        onMarkAsRead: vi.fn(),
        onOpenChange,
      }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(true);
    unmount();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
