// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ArchivedConversationNotice, ConversationEmptyState } from "./conversation-states";
import { AnnouncementPostingNotice } from "./conversation-states";

afterEach(cleanup);

describe("ConversationEmptyState", () => {
  it("welcomes members to an empty channel by name", () => {
    render(
      createElement(ConversationEmptyState, {
        conversationName: "# Launch Planning",
        kind: "channel",
        personal: false,
        archived: false,
      }),
    );

    expect(screen.getByRole("heading").textContent).toBe("Welcome to # Launch Planning");
    expect(screen.getByText("This is the beginning of # Launch Planning.")).toBeTruthy();
  });

  it("explains the special purpose of a self direct message", () => {
    render(
      createElement(ConversationEmptyState, {
        conversationName: "Claire",
        kind: "direct_message",
        personal: true,
        archived: false,
      }),
    );

    expect(screen.getByRole("heading").textContent).toBe("Your personal space");
    expect(screen.getByText(/notes, links, and reminders/)).toBeTruthy();
  });

  it("uses read-only copy for an empty archived channel", () => {
    render(
      createElement(ConversationEmptyState, {
        conversationName: "# History",
        kind: "channel",
        personal: false,
        archived: true,
      }),
    );

    expect(screen.getByRole("heading").textContent).toBe("No messages in # History");
    expect(screen.getByText("This archived channel is read-only.")).toBeTruthy();
  });

  it("explains announcement participation without suggesting a root post", () => {
    render(
      createElement(ConversationEmptyState, {
        conversationName: "📣 Company News",
        kind: "channel",
        channelMode: "announcement",
        personal: false,
        archived: false,
      }),
    );
    expect(screen.getByText(/members can reply in threads and react/i)).toBeTruthy();
  });
});

describe("AnnouncementPostingNotice", () => {
  it("keeps member participation available through threads and reactions", () => {
    render(createElement(AnnouncementPostingNotice));
    expect(
      screen.getByRole("note", { name: "Announcement posting restricted" }).textContent,
    ).toContain("reply to a bulletin in its thread or add a reaction");
  });
});

describe("ArchivedConversationNotice", () => {
  it("distinguishes channel and thread read-only states", () => {
    const { rerender } = render(createElement(ArchivedConversationNotice));
    expect(screen.getByRole("note", { name: "Archived channel" })).toBeTruthy();

    rerender(createElement(ArchivedConversationNotice, { thread: true }));
    expect(screen.getByRole("note", { name: "Archived thread" }).textContent).toContain(
      "Replies are unavailable",
    );
  });
});
