import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  displayNameSchema,
  dogfoodHistorySchema,
  dogfoodMessageSchema,
  dogfoodSessionStateSchema,
  messageBodySchema,
  type DogfoodMessage,
  type DogfoodSessionState,
} from "@hmm-chat/contracts";

import { DESKTOP_CHANNELS } from "../shared/channels";
import type {
  DesktopApi,
  DesktopPlatform,
  NotificationAction,
  ServerStatus,
  SignInRequest,
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
  getSuggestedName: async () => {
    const name: unknown = await ipcRenderer.invoke(DESKTOP_CHANNELS.suggestedName);
    return typeof name === "string" ? name : "";
  },
  getSessionState: async () =>
    dogfoodSessionStateSchema.parse(await ipcRenderer.invoke(DESKTOP_CHANNELS.sessionState)),
  signIn: async (request: SignInRequest) =>
    dogfoodSessionStateSchema.parse(
      await ipcRenderer.invoke(DESKTOP_CHANNELS.sessionSignIn, {
        name: displayNameSchema.parse(request.name),
        accessCode: String(request.accessCode),
      }),
    ),
  signOut: async () =>
    dogfoodSessionStateSchema.parse(await ipcRenderer.invoke(DESKTOP_CHANNELS.sessionSignOut)),
  onSessionChanged: (listener: (state: DogfoodSessionState) => void) =>
    subscribe(
      DESKTOP_CHANNELS.sessionChanged,
      listener,
      (value): value is DogfoodSessionState => dogfoodSessionStateSchema.safeParse(value).success,
    ),
  getWelcomeMessages: async () => {
    const messages: unknown = await ipcRenderer.invoke(DESKTOP_CHANNELS.welcomeHistory);
    return dogfoodHistorySchema.parse({ messages }).messages;
  },
  sendWelcomeMessage: async (body: string) => {
    const validatedBody = messageBodySchema.parse(body);
    return dogfoodMessageSchema.parse(
      await ipcRenderer.invoke(DESKTOP_CHANNELS.welcomeSend, validatedBody),
    );
  },
  onWelcomeMessage: (listener: (message: DogfoodMessage) => void) =>
    subscribe(
      DESKTOP_CHANNELS.welcomeMessage,
      listener,
      (value): value is DogfoodMessage => dogfoodMessageSchema.safeParse(value).success,
    ),
  onNotificationAction: (listener: (action: NotificationAction) => void) =>
    subscribe(DESKTOP_CHANNELS.notificationAction, listener, isNotificationAction),
});

contextBridge.exposeInMainWorld("hmmChat", desktopApi);
