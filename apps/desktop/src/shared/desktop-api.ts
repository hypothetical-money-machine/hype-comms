import type { DevelopmentIdentity, DevelopmentWelcomeMessage } from "@hmm-chat/contracts";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface NotificationAction {
  readonly type: "open-channel";
  readonly channelId: string;
}

export type ServerStatus = "reachable" | "unreachable";

export interface ChatTransport {
  readonly getServerStatus: () => Promise<ServerStatus>;
  readonly getIdentity: () => Promise<DevelopmentIdentity>;
  readonly getWelcomeMessages: () => Promise<readonly DevelopmentWelcomeMessage[]>;
  readonly sendWelcomeMessage: (body: string) => Promise<DevelopmentWelcomeMessage>;
  readonly onWelcomeMessage: (listener: (message: DevelopmentWelcomeMessage) => void) => () => void;
}

export interface DesktopApi extends ChatTransport {
  readonly platform: DesktopPlatform;
  readonly getAppVersion: () => Promise<string>;
  readonly onNotificationAction: (listener: (action: NotificationAction) => void) => () => void;
}
