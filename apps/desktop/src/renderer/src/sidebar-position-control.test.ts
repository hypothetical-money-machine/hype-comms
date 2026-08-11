// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  SIDEBAR_POSITION_STORAGE_KEY,
  SidebarPositionRuntime,
  type SidebarPositionStorage,
} from "./sidebar-position-runtime";
import { SidebarPositionControl } from "./sidebar-position-control";

class MemoryStorage implements SidebarPositionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.sidebarPosition;
});

describe("SidebarPositionControl", () => {
  it("offers an accessible left or right choice", () => {
    const runtime = new SidebarPositionRuntime(document.documentElement, new MemoryStorage());
    render(createElement(SidebarPositionControl, { sidebarPosition: runtime }));

    expect(screen.getByRole("group", { name: "Sidebar position" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Left" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "Right" }) as HTMLInputElement).checked).toBe(false);
  });

  it("applies and persists the selected side", () => {
    const storage = new MemoryStorage();
    const runtime = new SidebarPositionRuntime(document.documentElement, storage);
    render(createElement(SidebarPositionControl, { sidebarPosition: runtime }));

    fireEvent.click(screen.getByRole("radio", { name: "Right" }));

    expect((screen.getByRole("radio", { name: "Right" }) as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.sidebarPosition).toBe("right");
    expect(storage.values.get(SIDEBAR_POSITION_STORAGE_KEY)).toBe("right");
  });
});
