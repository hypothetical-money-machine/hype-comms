// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { autosizeComposer, composerSizeStyle } from "./composer-autosize";

const size = { minHeight: 48, maxHeight: 180 } as const;
const CLIENT_HEIGHT = 178;
const OFFSET_HEIGHT = 180;

function composerTextarea(value: string, scrollHeight: number): HTMLTextAreaElement {
  const element = document.createElement("textarea");
  element.value = value;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    offsetHeight: { configurable: true, value: OFFSET_HEIGHT },
    clientHeight: { configurable: true, value: CLIENT_HEIGHT },
  });
  // happy-dom stores scrollTop verbatim; a real browser clamps it to the scrollable distance,
  // which is what turns our "scroll to the content bottom" request into the last visible line.
  const maxScrollTop = Math.max(0, scrollHeight - CLIENT_HEIGHT);
  let scrollTop = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(Math.max(value, 0), maxScrollTop);
    },
  });
  return element;
}

function longPrompt(): string {
  return Array.from({ length: 20 }, (_, index) => `Line ${String(index + 1)}`).join("\n");
}

describe("composer autosizing", () => {
  it("preserves the scroll position while editing before the end", () => {
    const element = composerTextarea(longPrompt(), 240);
    element.setSelectionRange(60, 60);
    element.scrollTop = 40;

    autosizeComposer(element, size);

    expect(element.style.height).toBe("180px");
    expect(element.style.overflowY).toBe("auto");
    expect(element.scrollTop).toBe(40);
  });

  it("scrolls to the browser-clamped bottom while typing at the end", () => {
    const element = composerTextarea(longPrompt(), 240);
    element.setSelectionRange(element.value.length, element.value.length);

    autosizeComposer(element, size);

    expect(element.scrollTop).toBe(240 - CLIENT_HEIGHT);
  });

  it("includes borders when deciding whether capped content overflows", () => {
    const element = composerTextarea("Boundary content", 180);
    element.setSelectionRange(element.value.length, element.value.length);

    autosizeComposer(element, size);

    expect(element.style.height).toBe("180px");
    expect(element.style.overflowY).toBe("auto");
  });

  it("provides the CSS limits from the same size configuration", () => {
    expect(composerSizeStyle(size)).toEqual({
      "--composer-min-height": "48px",
      "--composer-max-height": "180px",
    });
  });
});
