export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface NotificationAction {
  readonly type: "open-channel";
  readonly channelId: string;
}

export type ServerStatus = "reachable" | "unreachable";

export interface ChatTransport {
  readonly getServerStatus: () => Promise<ServerStatus>;
}

export interface DesktopApi extends ChatTransport {
  readonly platform: DesktopPlatform;
  readonly getAppVersion: () => Promise<string>;
  readonly onNotificationAction: (listener: (action: NotificationAction) => void) => () => void;
}
