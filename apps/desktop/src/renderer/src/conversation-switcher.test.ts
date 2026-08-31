// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationSwitcher, type SwitcherConversation } from "./conversation-switcher";

const conversations: readonly SwitcherConversation[] = [
  { id: "general", name: "# General", kind: "channel", isArchived: false },
  { id: "design", name: "# Design", kind: "channel", isArchived: false },
  {
    id: "people-planning",
    name: "# People Planning",
    kind: "channel",
    isArchived: false,
    access: "humans",
  },
  {
    id: "company-news",
    name: "# Company News",
    kind: "channel",
    isArchived: false,
    access: "workspace",
    channelMode: "announcement",
  },
  {
    id: "past-people-planning",
    name: "# Past People Planning",
    kind: "channel",
    isArchived: true,
    access: "humans",
  },
  {
    id: "old-company-news",
    name: "# Old Company News",
    kind: "channel",
    isArchived: true,
    access: "workspace",
    channelMode: "announcement",
  },
  { id: "claire", name: "Claire", kind: "direct_message", isArchived: false },
  {
    id: "group",
    name: "Claire, Woots",
    kind: "group_direct_message",
    isArchived: false,
  },
  { id: "old", name: "# Old launch", kind: "channel", isArchived: true },
];

function renderSwitcher(platform: "darwin" | "linux" | "win32" = "darwin", onSelect = vi.fn()) {
  render(
    createElement(ConversationSwitcher, {
      conversations,
      selectedConversationId: "general",
      platform,
      onSelect,
    }),
  );
  return { onSelect };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationSwitcher", () => {
  it("opens with Command+K on macOS and restores focus when dismissed", async () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /Jump to/ });
    trigger.focus();

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    expect(screen.getByRole("dialog", { name: "Jump to a conversation" })).toBeTruthy();
    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });
    await waitFor(() => expect(document.activeElement).toBe(searchbox));
    fireEvent.keyDown(searchbox, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses Control+K off macOS and ignores the macOS shortcut", () => {
    renderSwitcher("win32");

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document, { key: "K", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("filters conversations and supports arrow-key selection", () => {
    const { onSelect } = renderSwitcher(
      "darwin",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });

    fireEvent.change(searchbox, { target: { value: "#" } });
    expect(screen.queryByText("Claire")).toBeNull();
    fireEvent.keyDown(searchbox, { key: "ArrowDown" });
    fireEvent.keyDown(searchbox, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("design");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open when a selection declines navigation", async () => {
    const onSelect = vi.fn().mockResolvedValue(false);
    renderSwitcher("darwin", onSelect);
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });

    fireEvent.change(searchbox, { target: { value: "Design" } });
    fireEvent.keyDown(searchbox, { key: "Enter" });

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("design"));
    expect(screen.getByRole("dialog", { name: "Jump to a conversation" })).toBeTruthy();
    expect(document.activeElement).toBe(searchbox);
  });

  it("reports open state through onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(
      createElement(ConversationSwitcher, {
        conversations,
        selectedConversationId: "general",
        platform: "darwin",
        onSelect: vi.fn(),
        onOpenChange,
      }),
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    const trigger = screen.getByRole("button", { name: /Jump to/ });
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });
    fireEvent.keyDown(searchbox, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("labels archived results and reports an empty filter", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });

    fireEvent.change(searchbox, { target: { value: "old" } });
    expect(screen.getByText("Archived channel")).toBeTruthy();
    fireEvent.change(searchbox, { target: { value: "missing" } });
    expect(screen.getByText("No matching conversations")).toBeTruthy();
  });

  it("uses neutral direct-message iconography and a truncatable name", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Jump to a conversation" }), {
      target: { value: "Claire" },
    });

    const result = screen.getByRole("button", { name: "Claire Direct message" });
    expect(result.textContent).not.toContain("●");
    expect(result.querySelector(".direct-message-avatar")).toBeTruthy();
    const name = result.querySelector(".quick-switcher-name");
    expect(name?.textContent).toBe("Claire");
    expect(name?.getAttribute("title")).toBe("Claire");
  });

  it("identifies group conversations in search results", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Jump to a conversation" }), {
      target: { value: "Woots" },
    });

    const result = screen.getByRole("button", { name: /Claire, Woots.*Group conversation/u });
    expect(result.querySelector(".group-direct-message-avatar")).toBeTruthy();
  });

  it("identifies humans-only channels in search results", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Jump to a conversation" }), {
      target: { value: "People Planning" },
    });

    expect(
      screen.getByRole("button", { name: "Humans-only channel: # People Planning" }),
    ).toBeTruthy();
    expect(screen.getByText("Humans-only channel")).toBeTruthy();
  });

  it("announces the channel type once for announcement results", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Jump to a conversation" }), {
      target: { value: "Company News" },
    });

    expect(
      screen.getByRole("button", { name: "Announcement channel: # Company News" }),
    ).toBeTruthy();
    expect(screen.getByText("Announcement channel")).toBeTruthy();
  });

  it("keeps archived state in typed channel result names", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });

    fireEvent.change(searchbox, { target: { value: "Past People Planning" } });
    expect(
      screen.getByRole("button", {
        name: "Archived humans-only channel: # Past People Planning",
      }),
    ).toBeTruthy();

    fireEvent.change(searchbox, { target: { value: "Old Company News" } });
    expect(
      screen.getByRole("button", {
        name: "Archived announcement channel: # Old Company News",
      }),
    ).toBeTruthy();
  });
});
