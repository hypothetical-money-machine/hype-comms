import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from "electron";
import type { Event, IpcMainInvokeEvent, Session, WebContents } from "electron";

import { createServerHealthUrl } from "../shared/api-origin";
import { DESKTOP_CHANNELS } from "../shared/channels";
import type { NotificationAction, ServerStatus } from "../shared/desktop-api";
import {
  APP_PROTOCOL,
  APP_PROTOCOL_HOST,
  findAuthCallbackUrl,
  isTrustedRendererUrl,
  normalizeAuthCallbackUrl,
  normalizeDevelopmentServerUrl,
  normalizeExternalHttpsUrl,
  resolveRendererAssetPath,
} from "./security";

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

function flushPendingRendererEvents(): void {
  while (pendingNotificationActions.length > 0) {
    const action = pendingNotificationActions.shift();
    if (action !== undefined) {
      sendToRenderer(DESKTOP_CHANNELS.notificationAction, action);
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

function handleAuthCallback(value: string): void {
  if (normalizeAuthCallbackUrl(value) === null) {
    return;
  }

  // M1 exchanges the callback code here in main. Callback URLs and credentials must never
  // cross the preload boundary; until that flow exists, a valid callback only focuses the app.
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    const callbackUrl = findAuthCallbackUrl(commandLine);
    if (callbackUrl !== null) {
      handleAuthCallback(callbackUrl);
    }
    focusMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleAuthCallback(url);
    focusMainWindow();
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
      registerIpcHandlers();

      if (app.isPackaged) {
        app.setAsDefaultProtocolClient("hmm-chat");
      }

      await createMainWindow();

      const initialCallbackUrl = findAuthCallbackUrl(process.argv);
      if (initialCallbackUrl !== null) {
        handleAuthCallback(initialCallbackUrl);
      }

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
}
