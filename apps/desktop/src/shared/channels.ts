export const DESKTOP_CHANNELS = Object.freeze({
  appVersion: "desktop:app-version",
  serverStatus: "desktop:server-status",
  sessionState: "chat:session-state",
  sessionSignIn: "chat:session-sign-in",
  sessionRequestMagicLink: "chat:session-request-magic-link",
  sessionSignOut: "chat:session-sign-out",
  sessionChanged: "chat:session-changed",
  suggestedName: "chat:suggested-name",
  welcomeHistory: "chat:welcome-history",
  welcomeSend: "chat:welcome-send",
  welcomeMessage: "chat:welcome-message",
  notificationAction: "desktop:notification-action",
} as const);
