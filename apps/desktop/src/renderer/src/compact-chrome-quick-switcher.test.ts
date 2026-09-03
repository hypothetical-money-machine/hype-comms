// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationSwitcher, type SwitcherConversation } from "./conversation-switcher";
import { MessageComposer } from "./message-composer";
import { useCompactChrome } from "./use-compact-chrome";

const conversations: readonly SwitcherConversation[] = [
  { id: "general", name: "# General", kind: "channel", isArchived: false },
  { id: "launch", name: "# Launch Planning", kind: "channel", isArchived: false },
];

/**
 * The App wiring this regression is about, cut down to the three parts that interact: the compact
 * chrome hover/focus tracking, the quick switcher rendered inside the chrome, and the App-level
 * effect that focuses the composer when the selected conversation changes (see App.tsx). A pick
 * unmounts the switcher's focused portal input with no focusout while that effect immediately
 * parks focus on the composer textarea, so the chrome's destroyed-focus self-heal never applies.
 */
function CompactWorkspace() {
  const chrome = useCompactChrome(true);
  const [selectedConversationId, setSelectedConversationId] = useState("general");
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const lastFocusKey = useRef(selectedConversationId);

  useEffect(() => {
    const previousKey = lastFocusKey.current;
    lastFocusKey.current = selectedConversationId;
    if (selectedConversationId !== previousKey) composerInput.current?.focus();
  }, [selectedConversationId]);

  return createElement(
    "div",
    null,
    createElement("button", {
      type: "button",
      "aria-label": "Show navigation",
      ...chrome.hotzoneProps,
    }),
    createElement(
      "aside",
      { "aria-label": "Workspace navigation", ...chrome.chromeProps },
      createElement(ConversationSwitcher, {
        conversations,
        selectedConversationId,
        platform: "darwin",
        onSelect: (conversationId: string) => {
          setSelectedConversationId(conversationId);
          chrome.collapse();
        },
        onOpenChange: chrome.onPopoverOpenChange,
      }),
    ),
    createElement(MessageComposer, {
      conversationName: "# General",
      draft: "",
      disabled: false,
      error: "",
      inputRef: composerInput,
      platform: "darwin",
      onDraftChange: () => undefined,
      onSubmit: () => Promise.resolve(),
    }),
  );
}

describe("compact chrome after a quick-switcher pick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.chromeRevealed;
    vi.useRealTimers();
  });

  it("still auto-hides once the composer has taken focus from the unmounted switcher", () => {
    render(createElement(CompactWorkspace));
    const hotzone = screen.getByRole("button", { name: "Show navigation" });

    // Opening the switcher focuses its portal input, which reveals the chrome and records
    // focus as being inside it.
    fireEvent.click(screen.getByRole("button", { name: /Jump to/ }));
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(true);

    // Picking a conversation unmounts that focused input without a focusout, and the App effect
    // immediately parks focus on the composer textarea.
    fireEvent.click(screen.getByRole("button", { name: /Launch Planning/ }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));

    // The user brings the navigation back with the hotzone and moves the pointer away again.
    fireEvent.mouseOver(hotzone);
    fireEvent.mouseEnter(hotzone);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(true);
    fireEvent.mouseOut(hotzone);
    fireEvent.mouseLeave(hotzone);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
  });
});
