/**
 * Evidence capture for the Check for Updates menu item.
 *
 * Builds the same owned, role-based Linux menu as production, opens a real Electron BrowserWindow,
 * asserts the Help submenu order, and captures the live native menu bar. On Wayland, native submenu
 * popups are separate surfaces and are not included in active-window captures.
 *
 * Usage:
 *   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/capture-check-for-updates-menu.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu } from "electron";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = path.join(projectRoot, "docs", "screenshots", "check-for-updates-menu.png");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app
  .whenReady()
  .then(async () => {
    // Mirrors apps/desktop/src/main/application-menu.ts for non-macOS platforms.
    const applicationMenu = Menu.buildFromTemplate([
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            id: "check-for-updates",
            label: "Check for Updates…",
            enabled: true,
          },
        ],
      },
    ]);
    Menu.setApplicationMenu(applicationMenu);

    const helpParent = applicationMenu.items.at(-1);
    const firstHelpLabel = helpParent?.submenu?.items[0]?.label;
    if (firstHelpLabel !== "Check for Updates…") {
      throw new Error(
        `expected Help[0] to be Check for Updates…, got ${JSON.stringify(firstHelpLabel)}`,
      );
    }

    const win = new BrowserWindow({
      width: 960,
      height: 560,
      show: true,
      backgroundColor: "#16181d",
      title: "Hype Comms",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(applicationMenu);
    win.setMenuBarVisibility(true);

    await win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Hype Comms</title>
  <style>
    html, body { margin: 0; height: 100%; background: #16181d; color: #e8eaed;
      font: 15px/1.45 system-ui, sans-serif; }
    main { padding: 48px 56px; max-width: 40rem; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
    p { margin: 0 0 10px; opacity: 0.82; }
    code { font: 13px/1.4 ui-monospace, monospace; color: #93c5fd; }
  </style></head>
  <body><main>
    <h1>Hype Comms</h1>
    <p>Native application menu (Linux/Windows).</p>
    <p><code>Help</code> → first item is <code>Check for Updates…</code>
      (built from the owned production template; asserted before capture).</p>
  </main></body>
</html>`),
    );

    win.show();
    win.focus();
    win.moveTop();
    await sleep(700);

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    execFileSync(
      "spectacle",
      ["--background", "--nonotify", "--activewindow", "--output", OUTPUT],
      { stdio: "inherit" },
    );

    // Spectacle may return before the file is fully visible to the next stat on some systems.
    await sleep(200);
    if (!fs.existsSync(OUTPUT) || fs.statSync(OUTPUT).size < 5_000) {
      throw new Error(`screenshot missing or too small: ${OUTPUT}`);
    }

    console.log(`Wrote ${OUTPUT} (${fs.statSync(OUTPUT).size} bytes)`);
    console.log(`Native Help[0]: ${firstHelpLabel}`);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
