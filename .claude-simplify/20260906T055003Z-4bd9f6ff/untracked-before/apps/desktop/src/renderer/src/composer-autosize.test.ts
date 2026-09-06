// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { autosizeComposer, composerSizeStyle } from "./composer-autosize";

const size = { minHeight: 48, maxHeight: 180 } as const;

function overflowingTextarea(): HTMLTextAreaElement {
  const element = document.createElement("textarea");
  element.value = Array.from({ length: 20 }, (_, index) => `Line ${String(index + 1)}`).join("\n");
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 240 },
    offsetHeight: { configurable: true, value: 180 },
    clientHeight: { configurable: true, value: 178 },
  });
  let scrollTop = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(Math.max(value, 0), 62);
    },
  });
  return element;
}

describe("composer autosizing", () => {
  it("preserves the scroll position while editing before the end", () => {
    const element = overflowingTextarea();
    element.setSelectionRange(60, 60);
    element.scrollTop = 40;

    autosizeComposer(element, size);

    expect(element.style.height).toBe("180px");
    expect(element.style.overflowY).toBe("auto");
    expect(element.scrollTop).toBe(40);
  });

  it("scrolls to the browser-clamped bottom while typing at the end", () => {
    const element = overflowingTextarea();
    element.setSelectionRange(element.value.length, element.value.length);

    autosizeComposer(element, size);

    expect(element.scrollTop).toBe(62);
  });

  it("includes borders when deciding whether capped content overflows", () => {
    const element = document.createElement("textarea");
    element.value = "Boundary content";
    element.setSelectionRange(element.value.length, element.value.length);
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 180 },
      offsetHeight: { configurable: true, value: 180 },
      clientHeight: { configurable: true, value: 178 },
    });

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
