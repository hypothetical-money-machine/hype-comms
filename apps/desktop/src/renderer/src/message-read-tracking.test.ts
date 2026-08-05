// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { isTimelineAtBottom, lastFullyVisibleMessageId } from "./message-read-tracking";

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

describe("message read tracking", () => {
  it("returns the last message whose bottom edge is visible", () => {
    const container = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rectangle(100, 500));
    for (const [id, top, bottom] of [
      ["first", 50, 150],
      ["second", 150, 300],
      ["third", 300, 520],
    ] as const) {
      const element = document.createElement("article");
      element.dataset.messageId = id;
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rectangle(top, bottom));
      container.append(element);
    }

    expect(lastFullyVisibleMessageId(container)).toBe("second");
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
