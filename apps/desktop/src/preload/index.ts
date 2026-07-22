import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import { DESKTOP_CHANNELS } from "../shared/channels";
import type {
  DesktopApi,
  DesktopPlatform,
  NotificationAction,
  ServerStatus,
} from "../shared/desktop-api";

function subscribe<T>(
  channel: string,
  listener: (value: T) => void,
  validate: (value: unknown) => value is T,
): () => void {
  const wrappedListener = (_event: IpcRendererEvent, value: unknown): void => {
    if (validate(value)) {
      listener(value);
    }
  };

  ipcRenderer.on(channel, wrappedListener);
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

function isNotificationAction(value: unknown): value is NotificationAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === "open-channel" && typeof candidate.channelId === "string";
}

const platform = process.platform;
if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

const desktopApi: DesktopApi = Object.freeze({
  platform: platform as DesktopPlatform,
  getAppVersion: () => ipcRenderer.invoke(DESKTOP_CHANNELS.appVersion) as Promise<string>,
  getServerStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.serverStatus) as Promise<ServerStatus>,
  onNotificationAction: (listener: (action: NotificationAction) => void) =>
    subscribe(DESKTOP_CHANNELS.notificationAction, listener, isNotificationAction),
});

contextBridge.exposeInMainWorld("hmmChat", desktopApi);
