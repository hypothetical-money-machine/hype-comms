import type { ChatMessage, ChatSessionState } from "@hmm-chat/contracts";

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
  readonly getSessionState: () => Promise<ChatSessionState>;
  readonly signIn: (request: SignInRequest) => Promise<ChatSessionState>;
  readonly signOut: () => Promise<ChatSessionState>;
  readonly onSessionChanged: (listener: (state: ChatSessionState) => void) => () => void;
  readonly getWelcomeMessages: () => Promise<readonly ChatMessage[]>;
  readonly sendWelcomeMessage: (body: string) => Promise<ChatMessage>;
  readonly onWelcomeMessage: (listener: (message: ChatMessage) => void) => () => void;
}

export interface DesktopApi extends ChatTransport {
  readonly platform: DesktopPlatform;
  readonly getAppVersion: () => Promise<string>;
  readonly onNotificationAction: (listener: (action: NotificationAction) => void) => () => void;
}
