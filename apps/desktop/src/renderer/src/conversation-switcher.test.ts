// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationSwitcher, type SwitcherConversation } from "./conversation-switcher";

const conversations: readonly SwitcherConversation[] = [
  { id: "general", name: "# General", kind: "channel", isArchived: false },
  { id: "design", name: "# Design", kind: "channel", isArchived: false },
  { id: "claire", name: "Claire", kind: "direct_message", isArchived: false },
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
    const { onSelect } = renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    const searchbox = screen.getByRole("searchbox", { name: "Jump to a conversation" });

    fireEvent.change(searchbox, { target: { value: "#" } });
    expect(screen.queryByText("Claire")).toBeNull();
    fireEvent.keyDown(searchbox, { key: "ArrowDown" });
    fireEvent.keyDown(searchbox, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("design");
    expect(screen.queryByRole("dialog")).toBeNull();
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
});
