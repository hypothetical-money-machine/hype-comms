// @vitest-environment happy-dom

import { createElement, useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessagePane } from "./use-message-pane";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  cleanup();
  frames.clear();
  vi.restoreAllMocks();
});

function flushFrames() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of callbacks) callback(0);
  });
}

function Pane(options: Parameters<typeof useMessagePane>[0]) {
  const pane = useMessagePane(options);
  useLayoutEffect(() => {
    const list = pane.list.current;
    if (list === null) return;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 100, 200) },
    });
    for (const row of list.querySelectorAll<HTMLElement>("[data-message-id]")) {
      row.getBoundingClientRect = () => new DOMRect(0, 10, 100, 100);
      row.scrollIntoView = vi.fn();
    }
    const divider = list.querySelector("[data-divider]");
    if (divider !== null) Object.defineProperty(divider, "offsetTop", { value: 600 });
  });
  return createElement(
    "div",
    { ref: pane.list, onScroll: pane.handleScroll, "data-testid": "pane" },
    options.position.kind === "conversation" && options.position.unreadDividerMessageId !== null
      ? createElement("div", { id: `unread-${options.conversationId}`, "data-divider": true })
      : null,
    ...options.messages.map((message, index) =>
      createElement("article", {
        key: message.id,
        id: `${options.position.kind === "thread" ? "thread-message" : "message"}-${message.id}`,
        "data-message-id": message.id,
        "data-message-sequence": String(index + 1),
      }),
    ),
  );
}

function options(
  overrides: Partial<Parameters<typeof useMessagePane>[0]> = {},
): Parameters<typeof useMessagePane>[0] {
  return {
    position: { kind: "conversation", unreadDividerMessageId: null },
    conversationId: "conversation-a",
    active: true,
    isHeadless: false,
    messages: [{ id: "message-a" }],
    pendingCount: 0,
    lastReadSequence: null,
    focusedMessageId: null,
    markRead: vi.fn(),
    ...overrides,
  };
}

describe("pane scrolling and read ownership", () => {
  it("enters a conversation at its unread divider and does not follow new messages after scrolling away", () => {
    const initial = options({
      position: { kind: "conversation", unreadDividerMessageId: "message-a" },
    });
    const view = render(createElement(Pane, initial));
    const list = screen.getByTestId("pane");
    expect(list.scrollTop).toBe(500);
    list.scrollTop = 100;
    fireEvent.scroll(list);
    view.rerender(
      createElement(Pane, { ...initial, messages: [{ id: "message-a" }, { id: "message-b" }] }),
    );
    expect(list.scrollTop).toBe(100);
  });

  it("keeps the thread reading position for incoming replies and follows a newly queued reply", () => {
    const initial = options({ position: { kind: "thread", rootId: "root" } });
    const view = render(createElement(Pane, initial));
    const list = screen.getByTestId("pane");
    expect(list.scrollTop).toBe(1000);
    list.scrollTop = 100;
    fireEvent.scroll(list);
    const incoming = { ...initial, messages: [{ id: "message-a" }, { id: "message-b" }] };
    view.rerender(createElement(Pane, incoming));
    expect(list.scrollTop).toBe(100);
    view.rerender(createElement(Pane, { ...incoming, pendingCount: 1 }));
    expect(list.scrollTop).toBe(1000);
  });

  it("retires scheduled reads when the conversation changes and cancels them on disposal", () => {
    const initial = options();
    const view = render(createElement(Pane, initial));
    view.rerender(
      createElement(Pane, {
        ...initial,
        conversationId: "conversation-b",
        messages: [{ id: "message-b" }],
      }),
    );
    flushFrames();
    expect(initial.markRead).toHaveBeenCalledExactlyOnceWith("conversation-b", "message-b");
    fireEvent.scroll(screen.getByTestId("pane"));
    view.unmount();
    expect(frames.size).toBe(0);
  });

  it.each([{ active: false }, { isHeadless: true }])(
    "does not mark messages read when ineligible: %s",
    (overrides) => {
      const initial = options(overrides);
      render(createElement(Pane, initial));
      fireEvent.focus(window);
      flushFrames();
      expect(initial.markRead).not.toHaveBeenCalled();
    },
  );
});
