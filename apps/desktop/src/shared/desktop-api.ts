import type { DogfoodMessage, DogfoodSessionState } from "@hmm-chat/contracts";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface NotificationAction {
  readonly type: "open-channel";
  readonly channelId: string;
}

export type ServerStatus = "reachable" | "unreachable";

export interface SignInRequest {
  readonly name: string;
  readonly accessCode: string;
}

export interface ChatTransport {
  readonly getServerStatus: () => Promise<ServerStatus>;
  /** Name to pre-fill on the sign-in form. Empty when the app has no hint to offer. */
  readonly getSuggestedName: () => Promise<string>;
  readonly getSessionState: () => Promise<DogfoodSessionState>;
  readonly signIn: (request: SignInRequest) => Promise<DogfoodSessionState>;
  readonly signOut: () => Promise<DogfoodSessionState>;
  readonly onSessionChanged: (listener: (state: DogfoodSessionState) => void) => () => void;
  readonly getWelcomeMessages: () => Promise<readonly DogfoodMessage[]>;
  readonly sendWelcomeMessage: (body: string) => Promise<DogfoodMessage>;
  readonly onWelcomeMessage: (listener: (message: DogfoodMessage) => void) => () => void;
}

export interface DesktopApi extends ChatTransport {
  readonly platform: DesktopPlatform;
  readonly getAppVersion: () => Promise<string>;
  readonly onNotificationAction: (listener: (action: NotificationAction) => void) => () => void;
}
