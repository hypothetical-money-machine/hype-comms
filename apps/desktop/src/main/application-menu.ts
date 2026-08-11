import type { MenuItemConstructorOptions } from "electron";

export const CHECK_FOR_UPDATES_MENU_ITEM_ID = "check-for-updates";

export interface ApplicationMenuOptions {
  readonly platform: NodeJS.Platform;
  readonly checkForUpdatesEnabled: boolean;
  readonly onCheckForUpdates: () => void;
}

/**
 * Builds the application menu from documented Electron roles. Electron's generated Linux menu
 * has no Help menu, and the Menu returned by getApplicationMenu() does not support adding items.
 * Owning the template keeps the native platform roles while guaranteeing a home for the update
 * command.
 */
export function buildApplicationMenu(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
    label: "Check for Updates…",
    enabled: options.checkForUpdatesEnabled,
    click: options.onCheckForUpdates,
  };

  const standardMenus: MenuItemConstructorOptions[] = [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  if (options.platform === "darwin") {
    return [
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          checkForUpdatesItem,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      ...standardMenus,
    ];
  }

  return [...standardMenus, { role: "help", submenu: [checkForUpdatesItem] }];
}
