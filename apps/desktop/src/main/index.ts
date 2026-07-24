import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  chatSignInRequestSchema,
  messageBodySchema,
  requestMagicLinkSchema,
  type ChatMessage,
  type ChatSessionState,
} from "@hmm-chat/contracts";
import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from "electron";
import type { Event, IpcMainInvokeEvent, Session, WebContents } from "electron";

import { createServerHealthUrl } from "../shared/api-origin";
import { DESKTOP_CHANNELS } from "../shared/channels";
import type { NotificationAction, ServerStatus } from "../shared/desktop-api";
import {
  parseAuthCallbackToken,
  processAuthCallback,
  type AuthCallbackOutcome,
} from "./auth-callback";
import { ChatSession, ChatSessionError } from "./chat-session";
import { ChatTransport } from "./chat-transport";
import { resolveSuggestedName } from "./suggested-name";
import {
  APP_PROTOCOL,
  APP_PROTOCOL_HOST,
  createProtocolClientRegistration,
  findAuthCallbackUrl,
  isTrustedRendererUrl,
  normalizeDevelopmentServerUrl,
  normalizeExternalHttpsUrl,
  resolveRendererAssetPath,
} from "./security";
const RENDERER_ORIGIN = "http://127.0.0.1:5173";

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let rendererReady = false;
let trustedDevelopmentRendererUrl: string | null = null;
let serverStatusRequest: Promise<ServerStatus> | null = null;
const pendingNotificationActions: NotificationAction[] = [];
const pendingWelcomeMessages: ChatMessage[] = [];
const pendingAuthCallbackUrls: string[] = [];
let authCallbacksReady = false;
let drainingAuthCallbacks = false;
// Only a hint for the sign-in form. The server derives the real author from the session.
const suggestedName = app.isPackaged ? "" : resolveSuggestedName(process.argv, process.env);
if (!app.isPackaged && suggestedName !== "") {
  const identityProfile = createHash("sha256").update(suggestedName).digest("hex").slice(0, 16);
  app.setPath("userData", path.join(app.getPath("userData"), `development-${identityProfile}`));
}
let chatSession: ChatSession | null = null;
let chatTransport: ChatTransport | null = null;

function sendToRenderer(channel: string, payload: unknown): boolean {
  if (mainWindow === null || mainWindow.isDestroyed() || !rendererReady) {
    return false;
  }

  mainWindow.webContents.send(channel, payload);
  return true;
}

// Native notification wiring can call this once notification creation is added.
export function deliverNotificationAction(action: NotificationAction): void {
  if (!sendToRenderer(DESKTOP_CHANNELS.notificationAction, action)) {
    pendingNotificationActions.push(action);
  }
}

function deliverWelcomeMessage(message: ChatMessage): void {
  if (!sendToRenderer(DESKTOP_CHANNELS.welcomeMessage, message)) {
    pendingWelcomeMessages.push(message);
  }
}

function deliverSessionState(state: ChatSessionState): void {
  sendToRenderer(DESKTOP_CHANNELS.sessionChanged, state);
  if (state.status === "signed-in") {
    chatTransport?.start();
  } else {
    chatTransport?.stop();
  }
}

function flushPendingRendererEvents(): void {
  if (chatSession !== null) {
    sendToRenderer(DESKTOP_CHANNELS.sessionChanged, chatSession.state);
  }
  while (pendingNotificationActions.length > 0) {
    const action = pendingNotificationActions.shift();
    if (action !== undefined) {
      sendToRenderer(DESKTOP_CHANNELS.notificationAction, action);
    }
  }
  while (pendingWelcomeMessages.length > 0) {
    const message = pendingWelcomeMessages.shift();
    if (message !== undefined) {
      sendToRenderer(DESKTOP_CHANNELS.welcomeMessage, message);
    }
  }
}

function safelyOpenExternal(url: string): void {
  const safeUrl = normalizeExternalHttpsUrl(url);
  if (safeUrl !== null) {
    void shell.openExternal(safeUrl).catch((error: unknown) => {
      console.error("Failed to open an external link", error);
    });
  }
}

function blockNavigation(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    safelyOpenExternal(url);
    return { action: "deny" };
  });

  const preventNavigation = (event: Event, url: string): void => {
    event.preventDefault();
    safelyOpenExternal(url);
  };

  webContents.on("will-navigate", preventNavigation);
  webContents.on("will-redirect", preventNavigation);
  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function lockDownSession(appSession: Session): void {
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  appSession.setDevicePermissionHandler(() => false);
  appSession.on("will-download", (event) => {
    event.preventDefault();
  });

  appSession.webRequest.onHeadersReceived(
    { urls: [`${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/*`] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [__HMM_CHAT_PRODUCTION_CSP__],
        },
      });
    },
  );
}

async function installBundledRendererProtocol(rendererRoot: string): Promise<void> {
  await protocol.handle(APP_PROTOCOL, (request) => {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const assetPath = resolveRendererAssetPath(rendererRoot, request.url);
    if (assetPath === null) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(assetPath).href);
  });
}

function registerIpcHandlers(): void {
  const isTrustedIpcSender = (event: IpcMainInvokeEvent): boolean => {
    const senderFrame = event.senderFrame;
    return (
      mainWindow !== null &&
      event.sender === mainWindow.webContents &&
      senderFrame !== null &&
      senderFrame === event.sender.mainFrame &&
      isTrustedRendererUrl(senderFrame.url, trustedDevelopmentRendererUrl)
    );
  };

  ipcMain.removeHandler(DESKTOP_CHANNELS.appVersion);
  ipcMain.handle(DESKTOP_CHANNELS.appVersion, (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted app-version IPC sender");
    }

    return app.getVersion();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.serverStatus);
  ipcMain.handle(DESKTOP_CHANNELS.serverStatus, async (event): Promise<ServerStatus> => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted server-status IPC sender");
    }

    if (serverStatusRequest !== null) {
      return serverStatusRequest;
    }

    const request = net
      .fetch(createServerHealthUrl(__HMM_CHAT_API_ORIGIN__), {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(2_500),
      })
      .then((response): ServerStatus => (response.ok ? "reachable" : "unreachable"))
      .catch((): ServerStatus => "unreachable")
      .finally(() => {
        serverStatusRequest = null;
      });

    serverStatusRequest = request;
    return request;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.suggestedName);
  ipcMain.handle(DESKTOP_CHANNELS.suggestedName, (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted suggested-name IPC sender");
    }
    return suggestedName;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionState);
  ipcMain.handle(DESKTOP_CHANNELS.sessionState, (event): ChatSessionState => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted session-state IPC sender");
    }
    return chatSession?.state ?? { status: "signed-out" };
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionSignIn);
  ipcMain.handle(DESKTOP_CHANNELS.sessionSignIn, async (event, request: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted sign-in IPC sender");
    }
    if (chatSession === null) {
      throw new Error("Chat is not configured");
    }

    const parsed = chatSignInRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new Error("Enter a name and an access code");
    }

    try {
      return await chatSession.signIn(parsed.data);
    } catch (error) {
      // Only the message crosses IPC. The cause stays in the main process, so a transport error
      // carrying request details can never reach renderer code.
      throw new Error(error instanceof ChatSessionError ? error.message : "Sign-in failed", {
        cause: error,
      });
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionSignOut);
  ipcMain.handle(DESKTOP_CHANNELS.sessionSignOut, async (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted sign-out IPC sender");
    }
    return (await chatSession?.signOut()) ?? { status: "signed-out" };
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionRequestMagicLink);
  ipcMain.handle(DESKTOP_CHANNELS.sessionRequestMagicLink, async (event, request: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted magic-link IPC sender");
    }
    if (chatSession === null) {
      throw new Error("Chat is not configured");
    }

    const parsed = requestMagicLinkSchema.safeParse(request);
    if (!parsed.success) {
      throw new Error("Enter a valid email address");
    }

    try {
      return await chatSession.requestMagicLink(parsed.data);
    } catch (error) {
      throw new Error(
        error instanceof ChatSessionError ? error.message : "Could not request a sign-in link",
        { cause: error },
      );
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.welcomeHistory);
  ipcMain.handle(DESKTOP_CHANNELS.welcomeHistory, async (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted welcome-history IPC sender");
    }
    return (await chatTransport?.getMessages()) ?? [];
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.welcomeSend);
  ipcMain.handle(DESKTOP_CHANNELS.welcomeSend, async (event, body: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted welcome-send IPC sender");
    }
    if (chatTransport === null) {
      throw new Error("Chat is not configured");
    }
    return chatTransport.sendMessage(messageBodySchema.parse(body));
  });
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    const developmentUrl = normalizeDevelopmentServerUrl(process.env.ELECTRON_RENDERER_URL ?? "");
    if (developmentUrl === null) {
      throw new Error("Electron renderer development URL is missing or untrusted");
    }

    trustedDevelopmentRendererUrl = developmentUrl;
    await window.loadURL(developmentUrl);
    return;
  }

  trustedDevelopmentRendererUrl = null;
  await window.loadURL(`${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`);
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1_280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b1020",
    title: "HMM Chat",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
    },
  });

  mainWindow = window;
  rendererReady = false;
  blockNavigation(window.webContents);

  window.once("ready-to-show", () => {
    window.show();
  });
  window.webContents.once("did-finish-load", () => {
    rendererReady = true;
    flushPendingRendererEvents();
  });
  window.on("closed", () => {
    rendererReady = false;
    mainWindow = null;
  });

  await loadRenderer(window);
  return window;
}

function focusMainWindow(): void {
  if (mainWindow === null) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

async function drainPendingAuthCallbacks(): Promise<void> {
  if (!authCallbacksReady || chatSession === null || drainingAuthCallbacks) {
    return;
  }

  drainingAuthCallbacks = true;
  try {
    while (pendingAuthCallbackUrls.length > 0) {
      const value = pendingAuthCallbackUrls.shift();
      if (value === undefined) {
        continue;
      }

      const currentSession = chatSession;
      const outcome: AuthCallbackOutcome = await processAuthCallback(value, async (token) => {
        await currentSession.exchangeMagicLink(token);
      });
      if (outcome === "succeeded") {
        focusMainWindow();
      }
    }
  } finally {
    drainingAuthCallbacks = false;
    if (pendingAuthCallbackUrls.length > 0) {
      void drainPendingAuthCallbacks();
    }
  }
}

function handleAuthCallback(value: string): boolean {
  if (parseAuthCallbackToken(value) === null) {
    return false;
  }

  pendingAuthCallbackUrls.push(value);
  void drainPendingAuthCallbacks();
  return true;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    const callbackUrl = findAuthCallbackUrl(commandLine);
    if (callbackUrl === null || !handleAuthCallback(callbackUrl)) {
      focusMainWindow();
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!handleAuthCallback(url)) {
      focusMainWindow();
    }
  });

  app.on("certificate-error", (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });

  app.on("login", (event) => {
    event.preventDefault();
  });

  void app
    .whenReady()
    .then(async () => {
      const rendererRoot = path.join(__dirname, "../renderer");
      lockDownSession(session.defaultSession);
      await installBundledRendererProtocol(rendererRoot);

      chatSession = new ChatSession({
        apiOrigin: __HMM_CHAT_API_ORIGIN__,
        cookies: session.defaultSession.cookies,
        request: (url, init) => net.fetch(url, init),
      });
      chatTransport = new ChatTransport({
        session: chatSession,
        rendererOrigin: app.isPackaged ? `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}` : RENDERER_ORIGIN,
        onMessage: deliverWelcomeMessage,
      });
      chatSession.subscribe(deliverSessionState);

      registerIpcHandlers();

      const protocolRegistration = createProtocolClientRegistration(
        app.isPackaged,
        process.execPath,
        process.argv,
      );
      if (
        protocolRegistration.executablePath === undefined ||
        protocolRegistration.arguments === undefined
      ) {
        app.setAsDefaultProtocolClient(protocolRegistration.scheme);
      } else {
        app.setAsDefaultProtocolClient(
          protocolRegistration.scheme,
          protocolRegistration.executablePath,
          [...protocolRegistration.arguments],
        );
      }

      await createMainWindow();

      // Restores a session left over from a previous run; the cookie outlives the process.
      await chatSession.restore();

      const initialCallbackUrl = findAuthCallbackUrl(process.argv);
      if (initialCallbackUrl !== null) {
        handleAuthCallback(initialCallbackUrl);
      }
      authCallbacksReady = true;
      await drainPendingAuthCallbacks();

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createMainWindow().catch((error: unknown) => {
            console.error("Failed to recreate the main window", error);
          });
        } else {
          focusMainWindow();
        }
      });
    })
    .catch((error: unknown) => {
      console.error("Failed to initialize HMM Chat", error);
      app.quit();
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    chatTransport?.stop();
  });
}
