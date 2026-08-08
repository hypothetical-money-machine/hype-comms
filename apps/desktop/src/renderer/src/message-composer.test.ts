// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageComposer } from "./message-composer";

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
});
