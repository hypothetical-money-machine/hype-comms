// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor } from "./timeline-scroll-anchor";

function rect(top: number, bottom: number): DOMRect {
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

it("preserves a fully visible row across a prepend without doubling browser anchoring", () => {
  const list = document.createElement("div");
  let viewportTop = 100;
  vi.spyOn(list, "getBoundingClientRect").mockImplementation(() =>
    rect(viewportTop, viewportTop + 300),
  );
  const clipped = document.createElement("article");
  clipped.dataset.messageId = "clipped";
  vi.spyOn(clipped, "getBoundingClientRect").mockReturnValue(rect(80, 125));
  const row = document.createElement("article");
  row.dataset.messageId = "anchor";
  let rowOffset = 40;
  vi.spyOn(row, "getBoundingClientRect").mockImplementation(() =>
    rect(viewportTop + rowOffset, viewportTop + rowOffset + 30),
  );
  list.append(clipped, row);
  list.scrollTop = 20;
  const anchor = captureTimelineScrollAnchor(list);
  expect(anchor).toEqual({ messageId: "anchor", offset: 40 });
  if (anchor === null) throw new Error("Missing anchor");
  rowOffset += 420;
  restoreTimelineScrollAnchor(list, anchor);
  expect(list.scrollTop).toBe(440);

  // After scrolling (including native browser anchoring), the row is back at the desired offset.
  rowOffset = 40;
  viewportTop = 200;
  restoreTimelineScrollAnchor(list, anchor);
  expect(list.scrollTop).toBe(440);
});

it("anchors within a message taller than the viewport and ignores a removed anchor", () => {
  const list = document.createElement("div");
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(100, 400));
  const row = document.createElement("article");
  row.dataset.messageId = "tall";
  const bounds = vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(-200, 800));
  list.append(row);
  const anchor = captureTimelineScrollAnchor(list);
  expect(anchor).toEqual({ messageId: "tall", offset: -300 });
  if (anchor === null) throw new Error("Missing anchor");
  bounds.mockReturnValue(rect(300, 1300));
  restoreTimelineScrollAnchor(list, anchor);
  expect(list.scrollTop).toBe(500);
  row.remove();
  restoreTimelineScrollAnchor(list, anchor);
  expect(list.scrollTop).toBe(500);
});

it("does not capture an empty or hidden timeline", () => {
  const list = document.createElement("div");
  expect(captureTimelineScrollAnchor(list)).toBeNull();
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(100, 400));
  expect(captureTimelineScrollAnchor(list)).toBeNull();
});
