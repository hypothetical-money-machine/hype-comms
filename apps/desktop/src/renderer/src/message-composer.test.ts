// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
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

  it("tracks the selected conversation in its placeholder", () => {
    const { rerender, props } = renderComposer();
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(textbox.placeholder).toBe("Message # General");

    rerender(createElement(MessageComposer, { ...props, conversationName: "# Launch Planning" }));
    expect(textbox.placeholder).toBe("Message # Launch Planning");
  });

  it("disables sending when the conversation is unavailable or the draft is blank", () => {
    const { rerender, props } = renderComposer({ draft: "   " });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    rerender(createElement(MessageComposer, { ...props, disabled: true }));
    expect(screen.getByRole("textbox", { name: "Message" }).hasAttribute("disabled")).toBe(true);
  });
});
