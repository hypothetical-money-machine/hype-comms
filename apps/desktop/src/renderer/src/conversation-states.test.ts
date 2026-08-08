// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ArchivedConversationNotice, ConversationEmptyState } from "./conversation-states";

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
