// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChannelIcon,
  ConversationBadge,
  DirectMessageIcon,
  GroupDirectMessageIcon,
} from "./conversation-indicators";

afterEach(cleanup);

describe("conversation indicators", () => {
  it("includes announcement type in a channel button's accessible name", () => {
    render(
      createElement(
        "button",
        null,
        createElement(ChannelIcon, { access: "workspace", channelMode: "announcement" }),
        createElement("span", null, "Company News"),
        createElement(ConversationBadge, { unreadCount: 2, mentionCount: 0 }),
      ),
    );

    expect(
      screen.getByRole("button", {
        name: "Announcement channel: Company News 2 unread messages",
      }),
    ).toBeTruthy();
  });

  it("uses a neutral decorative avatar for direct messages", () => {
    const { container } = render(createElement(DirectMessageIcon));

    const icon = container.querySelector(".direct-message-avatar");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.querySelector("svg")).toBeTruthy();
    expect(icon?.textContent).not.toContain("●");
  });

  it("uses distinct decorative iconography for group direct messages", () => {
    const { container } = render(createElement(GroupDirectMessageIcon));

    const icon = container.querySelector(".group-direct-message-avatar");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.querySelectorAll("circle")).toHaveLength(2);
  });

  it("distinguishes mentions from ordinary unread messages", () => {
    const { rerender } = render(
      createElement(ConversationBadge, { unreadCount: 5, mentionCount: 2 }),
    );

    const mention = screen.getByLabelText("2 mentions");
    expect(mention.classList.contains("conversation-badge-mention")).toBe(true);
    expect(mention.textContent).toBe("@2");

    rerender(createElement(ConversationBadge, { unreadCount: 5, mentionCount: 0 }));
    const unread = screen.getByLabelText("5 unread messages");
    expect(unread.classList.contains("conversation-badge-unread")).toBe(true);
    expect(unread.textContent).toBe("5");
  });
});
