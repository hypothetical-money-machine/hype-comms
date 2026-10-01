// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import {
  captureTimelineScrollAnchor,
  isTimelineScrollAnchorPreserved,
  restoreTimelineScrollAnchor,
} from "./timeline-scroll-anchor";

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
  expect(anchor).toEqual({ messageId: "anchor", row, offset: 40 });
  if (anchor === null) throw new Error("Missing anchor");
  rowOffset += 420;
  expect(isTimelineScrollAnchorPreserved(list, anchor)).toBe(false);
  restoreTimelineScrollAnchor(list, anchor);
  expect(list.scrollTop).toBe(440);

  // After scrolling (including native browser anchoring), the row is back at the desired offset.
  rowOffset = 40;
  viewportTop = 200;
  expect(isTimelineScrollAnchorPreserved(list, anchor)).toBe(true);
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
  expect(anchor).toEqual({ messageId: "tall", row, offset: -300 });
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

it("finds a visible row in long history without measuring every preceding message", () => {
  const list = document.createElement("div");
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(100, 400));
  const measurements = vi.fn();
  const rows = Array.from({ length: 10_000 }, (_, index) => {
    const row = document.createElement("article");
    row.dataset.messageId = `history-${index}`;
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      measurements(index);
      return rect((index - 9_000) * 40 + 80, (index - 9_000) * 40 + 110);
    });
    list.append(row);
    return row;
  });
  expect(captureTimelineScrollAnchor(list)).toEqual({
    messageId: "history-9001",
    row: rows[9_001],
    offset: 20,
  });
  expect(measurements.mock.calls.length).toBeLessThan(20);
});

it("stops after the viewport when only a partial row is visible", () => {
  const list = document.createElement("div");
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(100, 400));
  const rows = Array.from({ length: 1_000 }, (_, index) => {
    const row = document.createElement("article");
    row.dataset.messageId = `tall-${index}`;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
      rect((index - 500) * 1_000 - 200, (index - 500) * 1_000 + 800),
    );
    list.append(row);
    return row;
  });
  expect(captureTimelineScrollAnchor(list)).toEqual({
    messageId: "tall-500",
    row: rows[500],
    offset: -300,
  });
  expect(vi.mocked(rows[999]!.getBoundingClientRect)).not.toHaveBeenCalled();
});
