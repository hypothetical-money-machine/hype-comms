// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnreadConversationItem } from "./unread-conversations";
import { UnreadsView } from "./unreads-view";

afterEach(cleanup);

const mention: UnreadConversationItem = {
  conversationId: "mention",
  name: "Launch Planning",
  kind: "channel",
  access: "workspace",
  channelMode: "chat",
  isArchived: false,
  unreadCount: 3,
  mentionCount: 1,
  lastMessagePreview: "@morgan can you look at the cut?",
  lastMessageAt: "2026-08-20T12:00:00.000Z",
  section: "mention",
};

const unread: UnreadConversationItem = {
  conversationId: "dm",
  name: "Dan",
  kind: "direct_message",
  access: null,
  channelMode: null,
  isArchived: false,
  unreadCount: 2,
  mentionCount: 0,
  lastMessagePreview: "Dogfood notes from standup",
  lastMessageAt: "2026-08-20T11:30:00.000Z",
  section: "unread",
};

describe("UnreadsView", () => {
  it("lists mentions and unreads and opens the selected conversation", () => {
    const onOpen = vi.fn();
    render(createElement(UnreadsView, { items: [mention, unread], active: true, onOpen }));

    expect(screen.getByRole("heading", { name: "Unreads" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mentions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unread" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Launch Planning.*@morgan can you look at the cut\?.*1 mention/u,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Dan.*2 unread messages/u }));
    expect(onOpen).toHaveBeenCalledWith("dm");
  });

  it("shows an empty state when every conversation is caught up", () => {
    render(createElement(UnreadsView, { items: [], active: true, onOpen: vi.fn() }));

    expect(screen.getByRole("heading", { name: "You're caught up" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Unread conversations" })).toBeNull();
  });

  it("stays out of the layout while another destination is open", () => {
    render(createElement(UnreadsView, { items: [unread], active: false, onOpen: vi.fn() }));

    expect(screen.getByTestId("unreads-view").hidden).toBe(true);
  });
});
