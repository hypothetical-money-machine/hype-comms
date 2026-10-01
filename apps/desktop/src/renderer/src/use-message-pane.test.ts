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

type PaneOptions = Parameters<typeof useMessagePane>[0] & {
  readonly rowTops?: Readonly<Record<string, number>>;
  readonly scrollHeight?: number;
  readonly onHistoryLoad?: () => void;
};

function Pane(options: PaneOptions) {
  const pane = useMessagePane(options);
  useLayoutEffect(() => {
    const list = pane.list.current;
    if (list === null) return;
    Object.defineProperties(list, {
      scrollHeight: {
        configurable: true,
        get: () => Number(list.dataset.scrollHeight ?? "1000"),
      },
      clientHeight: { configurable: true, value: 200 },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 100, 200) },
    });
    for (const row of list.querySelectorAll<HTMLElement>("[data-message-id]")) {
      row.getBoundingClientRect = () =>
        new DOMRect(
          0,
          row.dataset.contentTop === undefined
            ? 10
            : Number(row.dataset.contentTop) - list.scrollTop,
          100,
          100,
        );
      if (!vi.isMockFunction(row.scrollIntoView)) row.scrollIntoView = vi.fn();
    }
    const divider = list.querySelector("[data-divider]");
    if (divider !== null) Object.defineProperty(divider, "offsetTop", { value: 600 });
  });
  return createElement(
    "div",
    {
      ref: pane.list,
      onScroll: pane.handleScroll,
      onWheelCapture: pane.cancelHistoryAnchor,
      onTouchMoveCapture: pane.cancelHistoryAnchor,
      onPointerDownCapture: pane.cancelHistoryAnchor,
      onKeyDownCapture: pane.cancelHistoryAnchor,
      "data-testid": "pane",
      "data-scroll-height": options.scrollHeight ?? 1000,
    },
    createElement(
      "button",
      {
        type: "button",
        onClick: () => pane.beginHistoryLoad(options.onHistoryLoad ?? (() => undefined)),
      },
      "Load older",
    ),
    options.position.kind === "conversation" && options.position.unreadDividerMessageId !== null
      ? createElement("div", { id: `unread-${options.conversationId}`, "data-divider": true })
      : null,
    ...options.messages.map((message, index) =>
      createElement("article", {
        key: message.id,
        id: `${options.position.kind === "thread" ? "thread-message" : "message"}-${message.id}`,
        "data-message-id": message.id,
        "data-message-sequence": String(index + 1),
        "data-content-top": options.rowTops?.[message.id],
      }),
    ),
  );
}

function options(overrides: Partial<PaneOptions> = {}): PaneOptions {
  return {
    position: { kind: "conversation", unreadDividerMessageId: null },
    conversationId: "conversation-a",
    active: true,
    isHeadless: false,
    messages: [{ id: "message-a" }],
    pendingCount: 0,
    lastReadSequence: null,
    focusedMessageId: null,
    focusedMessageRequest: 0,
    historyLoading: false,
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

  it("keeps a queued read across callback changes and uses the current callback", () => {
    const initial = options();
    const view = render(createElement(Pane, initial));
    flushFrames();
    vi.mocked(initial.markRead).mockClear();
    fireEvent.scroll(screen.getByTestId("pane"));
    const currentMarkRead = vi.fn();
    view.rerender(createElement(Pane, { ...initial, markRead: currentMarkRead }));
    flushFrames();
    expect(initial.markRead).not.toHaveBeenCalled();
    expect(currentMarkRead).toHaveBeenCalledExactlyOnceWith("conversation-a", "message-a");
  });

  it("does not recenter the selected message when its read cursor advances", () => {
    const initial = options({ focusedMessageId: "message-a" });
    const view = render(createElement(Pane, initial));
    const message = document.getElementById("message-message-a")!;
    expect(message.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    vi.mocked(message.scrollIntoView).mockClear();
    view.rerender(createElement(Pane, { ...initial, lastReadSequence: "1" }));
    expect(message.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the visible row anchored until older history finishes", () => {
    const load = vi.fn();
    const initial = options({ rowTops: { "message-a": 120 }, onHistoryLoad: load });
    const view = render(createElement(Pane, initial));
    const list = screen.getByTestId("pane");
    list.scrollTop = 100;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(createElement(Pane, { ...initial, historyLoading: true }));

    const firstPage = {
      ...initial,
      historyLoading: true,
      messages: [{ id: "older-a" }, { id: "message-a" }],
      rowTops: { "older-a": 120, "message-a": 320 },
      scrollHeight: 1200,
    };
    view.rerender(createElement(Pane, firstPage));
    expect(list.scrollTop).toBe(300);
    expect(document.getElementById("message-message-a")?.getBoundingClientRect().top).toBe(20);

    const finished = {
      ...firstPage,
      historyLoading: false,
      messages: [{ id: "older-b" }, { id: "older-a" }, { id: "message-a" }],
      rowTops: { "older-b": 120, "older-a": 320, "message-a": 520 },
      scrollHeight: 1400,
    };
    view.rerender(createElement(Pane, finished));
    expect(list.scrollTop).toBe(500);
    view.rerender(
      createElement(Pane, {
        ...finished,
        messages: [{ id: "older-c" }, ...finished.messages],
        rowTops: { "older-c": 120, "older-b": 320, "older-a": 520, "message-a": 720 },
        scrollHeight: 1600,
      }),
    );
    expect(list.scrollTop).toBe(500);
  });

  it("keeps the browser's prepend adjustment without applying it twice", () => {
    const initial = options({ rowTops: { "message-a": 120 } });
    const view = render(createElement(Pane, initial));
    const list = screen.getByTestId("pane");
    list.scrollTop = 100;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    view.rerender(createElement(Pane, { ...initial, historyLoading: true }));
    list.scrollTop = 300;
    view.rerender(
      createElement(Pane, {
        ...initial,
        messages: [{ id: "older-a" }, { id: "message-a" }],
        rowTops: { "older-a": 120, "message-a": 320 },
        scrollHeight: 1200,
      }),
    );
    expect(list.scrollTop).toBe(300);
  });

  it.each(["scroll event", "undispatched scroll"] as const)(
    "cancels a pending history anchor after a user %s",
    (movement) => {
      const initial = options({ rowTops: { "message-a": 120 } });
      const view = render(createElement(Pane, initial));
      const list = screen.getByTestId("pane");
      list.scrollTop = 100;
      fireEvent.scroll(list);
      fireEvent.click(screen.getByRole("button", { name: "Load older" }));
      view.rerender(createElement(Pane, { ...initial, historyLoading: true }));
      list.scrollTop = 150;
      if (movement === "scroll event") fireEvent.scroll(list);
      view.rerender(
        createElement(Pane, {
          ...initial,
          messages: [{ id: "older-a" }, { id: "message-a" }],
          rowTops: { "older-a": 120, "message-a": 320 },
          scrollHeight: 1200,
        }),
      );
      expect(list.scrollTop).toBe(150);
    },
  );

  it.each(["wheel", "touch move", "pointer down", "scroll key"] as const)(
    "cancels a pending history anchor on %s input",
    (input) => {
      const initial = options({ rowTops: { "message-a": 120 } });
      const view = render(createElement(Pane, initial));
      const list = screen.getByTestId("pane");
      list.scrollTop = 100;
      fireEvent.scroll(list);
      fireEvent.click(screen.getByRole("button", { name: "Load older" }));
      view.rerender(createElement(Pane, { ...initial, historyLoading: true }));
      if (input === "wheel") fireEvent.wheel(list, { deltaY: -100 });
      else if (input === "touch move") fireEvent.touchMove(list);
      else if (input === "pointer down") fireEvent.pointerDown(list);
      else fireEvent.keyDown(list, { key: "PageUp" });
      view.rerender(
        createElement(Pane, {
          ...initial,
          messages: [{ id: "older-a" }, { id: "message-a" }],
          rowTops: { "older-a": 120, "message-a": 320 },
          scrollHeight: 1200,
        }),
      );
      expect(list.scrollTop).toBe(100);
    },
  );

  it("consumes a focused jump once its row arrives and repeats only new requests", () => {
    const initial = options({ focusedMessageId: "message-b", focusedMessageRequest: 4 });
    const view = render(createElement(Pane, initial));
    const arrived = { ...initial, messages: [{ id: "message-a" }, { id: "message-b" }] };
    view.rerender(createElement(Pane, arrived));
    const message = document.getElementById("message-message-b")!;
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    vi.mocked(message.scrollIntoView).mockClear();
    const list = screen.getByTestId("pane");
    list.scrollTop = 100;
    fireEvent.scroll(list);
    const prepended = {
      ...arrived,
      messages: [{ id: "older-a" }, ...arrived.messages],
    };
    view.rerender(createElement(Pane, prepended));
    expect(message.scrollIntoView).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(100);
    view.rerender(createElement(Pane, { ...prepended, focusedMessageRequest: 5 }));
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
  });

  it("clears a consumed focus request when the focused message is cleared", () => {
    const initial = options({ focusedMessageId: "message-a", focusedMessageRequest: 4 });
    const view = render(createElement(Pane, initial));
    const message = document.getElementById("message-message-a")!;
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    vi.mocked(message.scrollIntoView).mockClear();
    view.rerender(createElement(Pane, { ...initial, focusedMessageId: null }));
    view.rerender(createElement(Pane, initial));
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
  });

  it("preserves thread focus and read tracking when another reply arrives", () => {
    const initial = options({
      position: { kind: "thread", rootId: "root" },
      focusedMessageId: "message-a",
      historyActive: false,
    });
    const view = render(createElement(Pane, initial));
    const message = document.getElementById("thread-message-message-a")!;
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    vi.mocked(message.scrollIntoView).mockClear();
    flushFrames();
    vi.mocked(initial.markRead).mockClear();
    view.rerender(
      createElement(Pane, {
        ...initial,
        messages: [{ id: "message-a" }, { id: "message-b" }],
      }),
    );
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    flushFrames();
    expect(initial.markRead).toHaveBeenCalledExactlyOnceWith("conversation-a", "message-b");
  });

  it("retires a history anchor when a newer focused jump takes ownership", () => {
    const initial = options({ rowTops: { "message-a": 120 } });
    const view = render(createElement(Pane, initial));
    const list = screen.getByTestId("pane");
    list.scrollTop = 100;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    view.rerender(createElement(Pane, { ...initial, historyLoading: true }));
    const focused = { ...initial, focusedMessageId: "message-a", focusedMessageRequest: 1 };
    view.rerender(createElement(Pane, { ...focused, historyLoading: true }));
    const message = document.getElementById("message-message-a")!;
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    view.rerender(
      createElement(Pane, {
        ...focused,
        messages: [{ id: "older-a" }, { id: "message-a" }],
        rowTops: { "older-a": 120, "message-a": 320 },
        scrollHeight: 1200,
      }),
    );
    expect(list.scrollTop).toBe(100);
    expect(message.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("gates history and focused jumps while chat is hidden without recentering on return", () => {
    const initial = options({
      focusedMessageId: "message-a",
      focusedMessageRequest: 1,
      historyActive: false,
      rowTops: { "message-a": 120 },
    });
    const view = render(createElement(Pane, initial));
    const message = document.getElementById("message-message-a")!;
    expect(message.scrollIntoView).not.toHaveBeenCalled();
    view.rerender(createElement(Pane, { ...initial, historyActive: true }));
    expect(message.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    vi.mocked(message.scrollIntoView).mockClear();
    const list = screen.getByTestId("pane");
    list.scrollTop = 100;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    view.rerender(createElement(Pane, { ...initial, historyActive: true, historyLoading: true }));
    view.rerender(createElement(Pane, { ...initial, historyLoading: true }));
    view.rerender(
      createElement(Pane, {
        ...initial,
        historyActive: true,
        messages: [{ id: "older-a" }, { id: "message-a" }],
        rowTops: { "older-a": 120, "message-a": 320 },
        scrollHeight: 1200,
      }),
    );
    expect(list.scrollTop).toBe(100);
    expect(message.scrollIntoView).not.toHaveBeenCalled();
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
