// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { isTimelineAtBottom, lastReadEligibleMessageId } from "./message-read-tracking";

function rectangle(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 500,
    width: 500,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function visibilityMemory() {
  return { observedStarts: new Set<string>(), observedEnds: new Set<string>() };
}

describe("message read tracking", () => {
  it("returns the last message whose start and end have been observed", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rectangle(100, 500));
    for (const [id, sequence, top, bottom] of [
      ["first", "1", 50, 150],
      ["second", "2", 150, 300],
      ["third", "3", 300, 520],
    ] as const) {
      const element = document.createElement("article");
      element.dataset.messageId = id;
      element.dataset.messageSequence = sequence;
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rectangle(top, bottom));
      container.append(element);
    }

    const memory = visibilityMemory();
    expect(lastReadEligibleMessageId(container, memory, "1")).toBe("second");
    expect(memory.observedStarts.has("first")).toBe(false);
  });

  it("does not leapfrog a top-clipped unread message", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rectangle(100, 500));
    for (const [id, sequence, top, bottom] of [
      ["clipped", "1", 50, 300],
      ["later", "2", 300, 450],
    ] as const) {
      const message = document.createElement("article");
      message.dataset.messageId = id;
      message.dataset.messageSequence = sequence;
      vi.spyOn(message, "getBoundingClientRect").mockReturnValue(rectangle(top, bottom));
      container.append(message);
    }

    expect(lastReadEligibleMessageId(container, visibilityMemory(), null)).toBeNull();
  });

  it("reads a tall message after both edges have been observed", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rectangle(100, 500));
    const message = document.createElement("article");
    message.dataset.messageId = "tall";
    message.dataset.messageSequence = "1";
    let messageBounds = rectangle(150, 650);
    vi.spyOn(message, "getBoundingClientRect").mockImplementation(() => messageBounds);
    container.append(message);
    const memory = visibilityMemory();

    expect(lastReadEligibleMessageId(container, memory, null)).toBeNull();
    messageBounds = rectangle(50, 450);
    expect(lastReadEligibleMessageId(container, memory, null)).toBe("tall");
  });

  it("does not read remembered messages from a hidden pane", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rectangle(0, 0));
    const message = document.createElement("article");
    message.dataset.messageId = "hidden";
    message.dataset.messageSequence = "1";
    vi.spyOn(message, "getBoundingClientRect").mockReturnValue(rectangle(0, 0));
    container.append(message);

    const memory = visibilityMemory();
    memory.observedStarts.add("hidden");
    memory.observedEnds.add("hidden");

    expect(lastReadEligibleMessageId(container, memory, null)).toBeNull();
  });

  it("detects the bottom with a small layout tolerance", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 400 },
      scrollTop: { value: 555, writable: true },
    });
    expect(isTimelineAtBottom(container)).toBe(true);
    container.scrollTop = 500;
    expect(isTimelineAtBottom(container)).toBe(false);
  });
});
