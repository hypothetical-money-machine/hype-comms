import type { Menu, MenuItem } from "electron";
import { describe, expect, it } from "vitest";

import { installCheckForUpdatesMenuItem } from "./application-menu";

function createMenu(items: MenuItem[]): Menu {
  return {
    items,
    insert: (position: number, item: MenuItem) => {
      items.splice(position, 0, item);
    },
  } as unknown as Menu;
}

function createItem(properties: Partial<MenuItem>): MenuItem {
  return properties as MenuItem;
}

describe("installCheckForUpdatesMenuItem", () => {
  it("places the command after About in the macOS application menu", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const appSubmenu = createMenu([
      createItem({ role: "about" }),
      createItem({ type: "separator" }),
      createItem({ role: "services" }),
    ]);
    const applicationMenu = createMenu([createItem({ label: "Hype Comms", submenu: appSubmenu })]);

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "darwin")).toBe(true);
    expect(appSubmenu.items[1]).toBe(updateItem);
  });

  it("places the command at the top of Help on Windows and Linux", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const helpSubmenu = createMenu([createItem({ label: "Learn More" })]);
    const applicationMenu = createMenu([
      createItem({ label: "File" }),
      // A localized label pins the match to the role branch, which is how Electron's real
      // default menu is matched.
      createItem({ role: "help", label: "Hilfe", submenu: helpSubmenu }),
    ]);

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "win32")).toBe(true);
    expect(helpSubmenu.items[0]).toBe(updateItem);
  });

  it("falls back to matching Help by label when no role is present", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const helpSubmenu = createMenu([createItem({ label: "Learn More" })]);
    const applicationMenu = createMenu([
      createItem({ label: "File" }),
      createItem({ label: "Help", submenu: helpSubmenu }),
    ]);

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "win32")).toBe(true);
    expect(helpSubmenu.items[0]).toBe(updateItem);
  });

  it("leaves an unexpected menu unchanged", () => {
    const applicationMenu = createMenu([createItem({ label: "File" })]);
    const updateItem = createItem({ label: "Check for Updates…" });

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "linux")).toBe(false);
  });

  it("does not throw when a top-level item has no runtime label and still finds Help", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const helpSubmenu = createMenu([createItem({ label: "Learn More" })]);
    const applicationMenu = createMenu([
      createItem({ role: "editMenu", label: undefined }),
      createItem({ role: "help", label: "Help", submenu: helpSubmenu }),
    ]);

    expect(() =>
      installCheckForUpdatesMenuItem(applicationMenu, updateItem, "win32"),
    ).not.toThrow();
    expect(helpSubmenu.items[0]).toBe(updateItem);
  });

  it("places the command directly after About on macOS even without a separator", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const appSubmenu = createMenu([
      createItem({ role: "about" }),
      createItem({ role: "services" }),
    ]);
    const applicationMenu = createMenu([createItem({ label: "Hype Comms", submenu: appSubmenu })]);

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "darwin")).toBe(true);
    expect(appSubmenu.items[1]).toBe(updateItem);
  });

  it("falls back to the first separator on macOS when About is absent", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const appSubmenu = createMenu([
      createItem({ role: "services" }),
      createItem({ type: "separator" }),
      createItem({ role: "quit" }),
    ]);
    const applicationMenu = createMenu([createItem({ label: "Hype Comms", submenu: appSubmenu })]);

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "darwin")).toBe(true);
    expect(appSubmenu.items[1]).toBe(updateItem);
  });

  it("falls back to the top of the macOS app menu with no About and no separator", () => {
    const updateItem = createItem({ label: "Check for Updates…" });
    const appSubmenu = createMenu([createItem({ role: "services" }), createItem({ role: "quit" })]);
    const applicationMenu = createMenu([createItem({ label: "Hype Comms", submenu: appSubmenu })]);

    expect(installCheckForUpdatesMenuItem(applicationMenu, updateItem, "darwin")).toBe(true);
    expect(appSubmenu.items[0]).toBe(updateItem);
  });
});
