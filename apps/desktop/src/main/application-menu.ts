import type { Menu, MenuItem } from "electron";

/**
 * Adds the update command to Electron's existing default menu without replacing the native
 * platform roles and shortcuts.
 */
export function installCheckForUpdatesMenuItem(
  applicationMenu: Menu | null,
  item: MenuItem,
  platform: NodeJS.Platform,
): boolean {
  if (applicationMenu === null) {
    return false;
  }

  const parent =
    platform === "darwin"
      ? applicationMenu.items[0]
      : applicationMenu.items.find(
          (candidate) => candidate.role === "help" || candidate.label?.toLowerCase() === "help",
        );
  const submenu = parent?.submenu;
  if (submenu === undefined || submenu === null) {
    return false;
  }

  const position = platform === "darwin" ? findDarwinInsertPosition(submenu.items) : 0;
  submenu.insert(position, item);
  return true;
}

/**
 * Finds where to insert the update command in the macOS application submenu: immediately after
 * "About …" so it reads as a natural extension of the app-identity section. Electron lowercases
 * built-in roles at runtime, so the role comparison is case-insensitive defensively. Falls back
 * to the first separator, then to the top of the menu, when no About item is present.
 */
function findDarwinInsertPosition(items: readonly MenuItem[]): number {
  const aboutIndex = items.findIndex((candidate) => candidate.role?.toLowerCase() === "about");
  if (aboutIndex >= 0) {
    return aboutIndex + 1;
  }

  const firstSeparator = items.findIndex((candidate) => candidate.type === "separator");
  return firstSeparator >= 0 ? firstSeparator : 0;
}
