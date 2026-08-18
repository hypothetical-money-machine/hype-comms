// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MEMBER_LIST_HEIGHT,
  MEMBER_LIST_HEIGHT_CSS_VARIABLE,
  MEMBER_LIST_HEIGHT_KEYBOARD_STEP,
  MEMBER_LIST_HEIGHT_STORAGE_KEY,
  MIN_MEMBER_LIST_HEIGHT,
  type MemberListHeightStorage,
} from "./member-list-height";
import { MemberListResizeHandle } from "./member-list-resize-handle";

class MemoryStorage implements MemberListHeightStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function rectangle(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 280,
    width: 280,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function renderHandle(storage = new MemoryStorage()) {
  const { container } = render(
    createElement(
      "div",
      { className: "sidebar-split" },
      createElement("nav"),
      createElement(MemberListResizeHandle, { storage, root: document.documentElement }),
      createElement("section", { id: "workspace-members", className: "member-list" }),
    ),
  );
  const split = container.firstElementChild as HTMLElement;
  vi.spyOn(split, "getBoundingClientRect").mockReturnValue(rectangle(100, 500));
  return { storage, split, handle: screen.getByRole("separator", { name: "Resize members list" }) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(MEMBER_LIST_HEIGHT_CSS_VARIABLE);
  delete document.documentElement.dataset.memberListResizing;
});

describe("MemberListResizeHandle", () => {
  it("exposes a horizontal splitter for the members list", () => {
    renderHandle();
    const handle = screen.getByRole("separator", { name: "Resize members list" });

    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-controls")).toBe("workspace-members");
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_MEMBER_LIST_HEIGHT));
    expect(document.documentElement.style.getPropertyValue(MEMBER_LIST_HEIGHT_CSS_VARIABLE)).toBe(
      `${String(DEFAULT_MEMBER_LIST_HEIGHT)}px`,
    );
  });

  it("restores a saved height when the handle mounts", () => {
    const storage = new MemoryStorage();
    storage.values.set(MEMBER_LIST_HEIGHT_STORAGE_KEY, "140");

    renderHandle(storage);

    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("140");
    expect(document.documentElement.style.getPropertyValue(MEMBER_LIST_HEIGHT_CSS_VARIABLE)).toBe(
      "140px",
    );
  });

  it("resizes from pointer movement and persists on release", () => {
    const { storage, handle } = renderHandle();

    fireEvent.pointerDown(handle, { button: 0, clientY: 300 });
    expect(document.documentElement.dataset.memberListResizing).toBe("true");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");

    fireEvent.pointerMove(window, { clientY: 250 });
    expect(handle.getAttribute("aria-valuenow")).toBe("250");
    expect(storage.values.has(MEMBER_LIST_HEIGHT_STORAGE_KEY)).toBe(false);

    fireEvent.pointerUp(window);
    expect(document.documentElement.dataset.memberListResizing).toBeUndefined();
    expect(storage.values.get(MEMBER_LIST_HEIGHT_STORAGE_KEY)).toBe("250");
    expect(document.documentElement.style.getPropertyValue(MEMBER_LIST_HEIGHT_CSS_VARIABLE)).toBe(
      "250px",
    );
  });

  it("grows and shrinks from the keyboard and clamps at the floor", () => {
    const { storage, handle } = renderHandle();

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe(
      String(DEFAULT_MEMBER_LIST_HEIGHT + MEMBER_LIST_HEIGHT_KEYBOARD_STEP),
    );
    expect(storage.values.get(MEMBER_LIST_HEIGHT_STORAGE_KEY)).toBe(
      String(DEFAULT_MEMBER_LIST_HEIGHT + MEMBER_LIST_HEIGHT_KEYBOARD_STEP),
    );

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(MIN_MEMBER_LIST_HEIGHT));

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(MIN_MEMBER_LIST_HEIGHT));
  });

  it("resets to the default height on double-click", () => {
    const storage = new MemoryStorage();
    storage.values.set(MEMBER_LIST_HEIGHT_STORAGE_KEY, "300");
    const { handle } = renderHandle(storage);

    fireEvent.doubleClick(handle);

    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_MEMBER_LIST_HEIGHT));
    expect(storage.values.get(MEMBER_LIST_HEIGHT_STORAGE_KEY)).toBe(
      String(DEFAULT_MEMBER_LIST_HEIGHT),
    );
  });
});
