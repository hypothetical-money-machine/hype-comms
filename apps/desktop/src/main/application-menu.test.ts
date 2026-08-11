import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { CHECK_FOR_UPDATES_MENU_ITEM_ID, buildApplicationMenu } from "./application-menu";

function submenuItems(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  if (item === undefined || !Array.isArray(item.submenu)) {
    throw new Error("expected an inline submenu");
  }
  return item.submenu;
}

describe("buildApplicationMenu", () => {
  it("places the command after About in the macOS application menu", () => {
    const onCheckForUpdates = vi.fn();
    const template = buildApplicationMenu({
      platform: "darwin",
      checkForUpdatesEnabled: true,
      onCheckForUpdates,
    });

    expect(template[0]?.role).toBe("appMenu");
    const appSubmenu = submenuItems(template[0]);
    expect(appSubmenu[0]?.role).toBe("about");
    expect(appSubmenu[1]).toMatchObject({
      id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
      label: "Check for Updates…",
      enabled: true,
      click: onCheckForUpdates,
    });
    expect(appSubmenu[2]?.type).toBe("separator");
    expect(appSubmenu.at(-1)?.role).toBe("quit");
  });

  it.each(["win32", "linux"] as const)(
    "adds Help with the command on %s instead of relying on Electron's default menu",
    (platform) => {
      const onCheckForUpdates = vi.fn();
      const template = buildApplicationMenu({
        platform,
        checkForUpdatesEnabled: false,
        onCheckForUpdates,
      });

      expect(template.map((item) => item.role)).toEqual([
        "fileMenu",
        "editMenu",
        "viewMenu",
        "windowMenu",
        "help",
      ]);
      expect(submenuItems(template.at(-1))).toEqual([
        expect.objectContaining({
          id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
          label: "Check for Updates…",
          enabled: false,
          click: onCheckForUpdates,
        }),
      ]);
    },
  );

  it("retains the standard native role menus on macOS", () => {
    const template = buildApplicationMenu({
      platform: "darwin",
      checkForUpdatesEnabled: true,
      onCheckForUpdates: vi.fn(),
    });

    expect(template.map((item) => item.role)).toEqual([
      "appMenu",
      "fileMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
  });
});
