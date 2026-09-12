import path from "node:path";

import { app, BrowserWindow, safeStorage } from "electron";

import { CacheCrypto } from "../../apps/desktop/src/main/cache-crypto";
import { DevicePreferencesStore } from "../../apps/desktop/src/main/device-preferences-store";
import { DEFAULT_DEVICE_PREFERENCES } from "../../apps/desktop/src/shared/device-preferences";
import { scope } from "./cache-fixture";

const directory = process.env.HYPE_COMMS_REHEARSAL_DIRECTORY;
if (directory === undefined || !path.isAbsolute(directory)) {
  throw new Error("The native rehearsal requires its own absolute temporary directory");
}
app.setName("Hype Comms Upgrade Rehearsal");
app.setPath("userData", path.join(directory, "profile"));

async function start(): Promise<void> {
  await app.whenReady();
  const cipher = new CacheCrypto({
    userDataPath: app.getPath("userData"),
    apiOrigin: "https://rehearsal.example.test",
    platform: process.platform,
    safeStorage,
  });
  const status = await cipher.initialize(scope);
  if (status.mode !== "persistent") {
    throw new Error("The native rehearsal requires OS-protected cache encryption");
  }
  const preferences = new DevicePreferencesStore({ userDataPath: app.getPath("userData") });
  if (process.env.HYPE_COMMS_REHEARSAL_STAGE === "seed") {
    await preferences.save({
      ...DEFAULT_DEVICE_PREFERENCES,
      spellCheck: false,
      sendMessageShortcut: "mod-enter",
    });
  }
  Object.assign(globalThis, {
    rehearsalMain: {
      cipher,
      preferences,
      backend:
        process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : process.platform,
    },
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("file:") });
  });
  await window.loadFile(path.join(__dirname, "index.html"));
}

void start().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Native cache rehearsal could not initialize its protected profile",
  );
  app.exit(1);
});
