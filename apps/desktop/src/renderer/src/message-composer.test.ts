// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "@hype-comms/contracts";
import { createElement, createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Attachment } from "@hype-comms/contracts";

import { MessageComposer } from "./message-composer";

const pendingAttachment: Attachment = {
  id: "10000000-0000-4000-8000-000000000010",
  messageId: null,
  uploadedBy: "10000000-0000-4000-8000-000000000001",
  fileName: "launch-notes.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  status: "ready",
  downloadUrl: null,
  createdAt: "2026-08-04T12:00:00.000Z",
};

afterEach(cleanup);

function renderComposer(overrides: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  const props: Parameters<typeof MessageComposer>[0] = {
    conversationName: "# General",
    draft: "A useful update",
    disabled: false,
    error: "",
    onDraftChange: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { props, ...render(createElement(MessageComposer, props)) };
}

describe("MessageComposer", () => {
  it("uses a multiline textarea and sends with Enter", () => {
    const { props } = renderComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    expect(textbox.tagName).toBe("TEXTAREA");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it("reserves Shift+Enter for a new line", () => {
    const { props } = renderComposer({ draft: "First line\nSecond line" });
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    expect(textbox.value).toBe("First line\nSecond line");
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/for a new line/)).toBeTruthy();
  });

  it("does not submit while an input method editor is composing", () => {
    const { props } = renderComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    const event = new KeyboardEvent("keydown", { bubbles: true, key: "Enter" });
    Object.defineProperty(event, "isComposing", { value: true });

    fireEvent(textbox, event);

    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("allows only one submission while the current send is pending", async () => {
    let finishSubmission: (() => void) | undefined;
    const pendingSubmission = new Promise<void>((resolve) => {
      finishSubmission = resolve;
    });
    const onSubmit = vi.fn(() => pendingSubmission);
    renderComposer({ onSubmit });
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    textbox.focus();
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(textbox.disabled).toBe(false);
    expect(document.activeElement).toBe(textbox);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(textbox.closest("form")?.getAttribute("aria-busy")).toBe("true");

    finishSubmission?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false),
    );
    expect(document.activeElement).toBe(textbox);
  });

  it("tracks the selected conversation in its placeholder", () => {
    const { rerender, props } = renderComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(textbox.placeholder).toBe("Message # General");

    rerender(createElement(MessageComposer, { ...props, conversationName: "# Launch Planning" }));
    expect(textbox.placeholder).toBe("Message # Launch Planning");
  });

  it("leaves focus where the user put it across prop changes and remounts", () => {
    // Focus placement is the App's decision (see the conversation-change effect in App.tsx and
    // app-composer-focus.test.ts). The shared composer itself must never grab focus — not when it
    // re-enables after a snapshot refresh, not on a conversation rename, and not when a pane
    // toggle remounts it — or it steals focus from wherever the user is typing.
    const otherControl = document.createElement("button");
    document.body.append(otherControl);
    try {
      const { rerender, unmount, props } = renderComposer({ disabled: true });
      otherControl.focus();

      rerender(
        createElement(MessageComposer, {
          ...props,
          disabled: false,
          conversationName: "# Launch Planning",
        }),
      );
      expect(document.activeElement).toBe(otherControl);

      unmount();
      render(createElement(MessageComposer, props));
      expect(document.activeElement).toBe(otherControl);
    } finally {
      otherControl.remove();
    }
  });

  it("supports a focused thread-reply variant without losing shared composer behavior", () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    const { props } = renderComposer({
      conversationName: null,
      inputId: "thread-message-composer",
      inputLabel: "Reply",
      inputRef,
      placeholder: "Reply in thread",
      submitLabel: "Reply",
      variantClassName: "thread-composer",
    });
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Reply" });

    expect(textbox.id).toBe("thread-message-composer");
    expect(textbox.placeholder).toBe("Reply in thread");
    expect(textbox.closest("form")?.classList.contains("thread-composer")).toBe(true);
    expect(inputRef.current).toBe(textbox);
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });

  it("disables sending when the conversation is unavailable or the draft is blank", () => {
    const { rerender, props } = renderComposer({ draft: "   " });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    rerender(createElement(MessageComposer, { ...props, disabled: true }));
    expect(screen.getByRole("textbox", { name: "Message" }).hasAttribute("disabled")).toBe(true);
  });

  it("lets a pending attachment send without a draft", () => {
    const { props } = renderComposer({
      draft: "",
      pendingAttachments: [pendingAttachment],
      onAttach: vi.fn().mockResolvedValue(undefined),
    });
    expect(screen.getByText("launch-notes.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it("exposes an attach action that does not submit the draft", () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    const { props } = renderComposer({ draft: "A useful update", onAttach });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(onAttach).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

const NOW = "2026-08-04T12:00:00.000Z";

const morgan: User = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const alex: User = {
  id: "10000000-0000-4000-8000-000000000002",
  kind: "human",
  username: "alex",
  displayName: "Alex Rivera",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function renderLiveComposer(overrides: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  const onDraftChange = vi.fn();
  const onSubmit = overrides.onSubmit ?? vi.fn().mockResolvedValue(undefined);

  function Harness() {
    const [draft, setDraft] = useState(overrides.draft ?? "");
    return createElement(MessageComposer, {
      conversationName: "# General",
      disabled: false,
      error: "",
      members: [morgan, alex],
      currentUserId: morgan.id,
      ...overrides,
      draft,
      onDraftChange: (value) => {
        onDraftChange(value);
        setDraft(value);
      },
      onSubmit,
    });
  }

  return { onDraftChange, onSubmit, ...render(createElement(Harness)) };
}

function typeDraft(textbox: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textbox, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
}

describe("MessageComposer mentions", () => {
  it("opens a member picker on @ and filters as the user types", () => {
    renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "@");
    expect(screen.getByRole("listbox", { name: "Mention a member" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Morgan/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Alex Rivera/ })).toBeTruthy();

    typeDraft(textbox, "@al");
    expect(screen.getByRole("option", { name: /Alex Rivera/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Morgan/ })).toBeNull();
  });

  it("inserts a visible mention chip instead of leftover ordinary @name text", () => {
    const { onDraftChange, onSubmit } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "@");
    fireEvent.click(screen.getByRole("option", { name: /Alex Rivera/ }));

    expect(onDraftChange).toHaveBeenLastCalledWith("@alex ");
    expect(onSubmit).not.toHaveBeenCalled();
    const chip = document.querySelector(".mention-chip");
    expect(chip?.textContent).toBe("@alex");
    expect(chip?.getAttribute("data-mention-user-id")).toBe(alex.id);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("chooses the highlighted member with Enter or Tab and does not send", () => {
    const { onDraftChange, onSubmit } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "@");
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onDraftChange).toHaveBeenLastCalledWith("@alex ");
    expect(onSubmit).not.toHaveBeenCalled();

    typeDraft(textbox, "thanks @mo");
    fireEvent.keyDown(textbox, { key: "Tab" });
    expect(onDraftChange).toHaveBeenLastCalledWith("thanks @morgan ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("dismisses the picker with Escape and leaves the typed query", () => {
    const { onDraftChange, onSubmit } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "@al");
    fireEvent.keyDown(textbox, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onDraftChange).toHaveBeenLastCalledWith("@al");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("sends with Enter while the open picker has no matching members", () => {
    const { onSubmit } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "@nobody-matches");
    expect(screen.getByRole("listbox", { name: "Mention a member" })).toBeTruthy();

    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("reopens a dismissed picker when the composer context changes", () => {
    function ContextHarness() {
      const [draft, setDraft] = useState("");
      const [contextKey, setContextKey] = useState("conversation-1");
      return createElement(
        "div",
        null,
        createElement(
          "button",
          { type: "button", onClick: () => setContextKey("conversation-2") },
          "switch",
        ),
        createElement(MessageComposer, {
          contextKey,
          conversationName: "# General",
          disabled: false,
          error: "",
          members: [morgan, alex],
          currentUserId: morgan.id,
          draft,
          onDraftChange: (value: string) => setDraft(value),
          onSubmit: vi.fn().mockResolvedValue(undefined),
        }),
      );
    }

    render(createElement(ContextHarness));
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "@al");
    expect(screen.getByRole("listbox", { name: "Mention a member" })).toBeTruthy();
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByRole("listbox", { name: "Mention a member" })).toBeTruthy();
  });
});

describe("MessageComposer formatting", () => {
  it("renders a formatting toolbar advertising every control and its shortcut", () => {
    renderComposer();
    expect(screen.getByRole("toolbar", { name: "Text formatting" })).toBeTruthy();
    for (const name of [
      "Bold",
      "Italic",
      "Strikethrough",
      "Inline code",
      "Link",
      "Bulleted list",
      "Numbered list",
      "Quote",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Bold" }).title).toBe("Bold (Ctrl+B)");
  });

  it("advertises Cmd shortcuts on macOS", () => {
    renderComposer({ platform: "darwin" });
    expect(screen.getByRole("button", { name: "Link" }).title).toBe("Link (Cmd+Shift+K)");
  });

  it("disables the toolbar with the composer", () => {
    renderComposer({ disabled: true });
    expect(screen.getByRole("button", { name: "Bold" }).hasAttribute("disabled")).toBe(true);
  });

  it("wraps the selection from a toolbar click and keeps it selected for re-toggling", () => {
    const { onDraftChange, onSubmit } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "make it pop");
    textbox.setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));

    expect(onDraftChange).toHaveBeenLastCalledWith("**make** it pop");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textbox.selectionStart).toBe(2);
    expect(textbox.selectionEnd).toBe(6);

    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(onDraftChange).toHaveBeenLastCalledWith("make it pop");
  });

  it("applies bold from the keyboard without sending", () => {
    const { onDraftChange, onSubmit } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "ship it");
    textbox.setSelectionRange(0, 4);
    fireEvent.keyDown(textbox, { key: "b", ctrlKey: true });

    expect(onDraftChange).toHaveBeenLastCalledWith("**ship** it");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("starts a bulleted list from a bare caret with Mod+Shift+8", () => {
    const { onDraftChange } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "groceries");
    fireEvent.keyDown(textbox, { key: "*", code: "Digit8", ctrlKey: true, shiftKey: true });

    expect(onDraftChange).toHaveBeenLastCalledWith("- groceries");
  });

  it("leaves plain Mod+K for the quick switcher and takes Mod+Shift+K for links", () => {
    const { onDraftChange } = renderLiveComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    typeDraft(textbox, "docs");
    fireEvent.keyDown(textbox, { key: "k", ctrlKey: true });
    expect(onDraftChange).toHaveBeenLastCalledWith("docs");

    textbox.setSelectionRange(0, 4);
    fireEvent.keyDown(textbox, { key: "K", ctrlKey: true, shiftKey: true });
    expect(onDraftChange).toHaveBeenLastCalledWith("[docs](url)");
  });
});
