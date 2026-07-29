import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  cacheDecryptBatchRequestSchema,
  cacheEncryptBatchRequestSchema,
  cacheScopeSchema,
  channelMemberTargetSchema,
  createChannelRequestSchema,
  directConversationRequestSchema,
  entityIdSchema,
  listConversationsQuerySchema,
  listMessageReactionsRequestSchema,
  messageReactionTargetSchema,
  messageSearchQuerySchema,
  requestMagicLinkSchema,
  sendMessageOperationSchema,
  sequenceSchema,
  themePreferenceSchema,
  upsertChannelMemberOperationSchema,
  type ChatSessionState,
  type ProductRealtimeEvent,
  type ThemeState,
  type UpdateState,
} from "@hmm-chat/contracts";
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import type { Event, IpcMainInvokeEvent, Session, WebContents } from "electron";
import { autoUpdater } from "electron-updater";

import { createServerHealthUrl } from "../shared/api-origin";
import { DESKTOP_CHANNELS } from "../shared/channels";
import type {
  NotificationAction,
  RealtimeConnectionState,
  ServerStatus,
} from "../shared/desktop-api";
import { createInitialThemeStateArgument, getThemeDefinition } from "../shared/theme";
import {
  parseAuthCallbackToken,
  processAuthCallback,
  type AuthCallbackOutcome,
} from "./auth-callback";
import { ChatSession, ChatSessionError } from "./chat-session";
import { CacheCrypto } from "./cache-crypto";
import {
  callbackForSignedOutSession,
  consumeDevelopmentAuthCallbackFile,
  resolveDevelopmentAuthCallbackFile,
  resolveDevelopmentProfile,
  resolveDevelopmentUserDataPath,
} from "./development-profile";
import { WorkspaceRealtime } from "./workspace-realtime";
import { WorkspaceTransport } from "./workspace-transport";
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
import { UpdateController, type UpdateSource, type UpdateSourceConfiguration } from "./updater";
import { ThemeController } from "./theme-controller";
import { ThemePreferenceStore } from "./theme-preference-store";
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
const pendingAuthCallbackUrls: string[] = [];
let authCallbacksReady = false;
let drainingAuthCallbacks = false;
const developmentProfile = app.isPackaged ? "" : resolveDevelopmentProfile(process.env);
const developmentAuthCallbackFile = resolveDevelopmentAuthCallbackFile(
  process.env,
  app.isPackaged,
  developmentProfile,
);
app.setPath(
  "userData",
  resolveDevelopmentUserDataPath(
    process.env,
    app.isPackaged,
    developmentProfile,
    app.getPath("userData"),
  ),
);
let chatSession: ChatSession | null = null;
let workspaceTransport: WorkspaceTransport | null = null;
let workspaceRealtime: WorkspaceRealtime | null = null;
let cacheCrypto: CacheCrypto | null = null;
let realtimeState: RealtimeConnectionState = "offline";
let updateController: UpdateController | null = null;
let themeController: ThemeController | null = null;
let stopThemeSubscription: (() => void) | null = null;

function createUpdateSource(): UpdateSource {
  return {
    configure(configuration: UpdateSourceConfiguration): void {
      autoUpdater.autoDownload = configuration.autoDownload;
      autoUpdater.autoInstallOnAppQuit = configuration.autoInstallOnAppQuit;
      autoUpdater.allowDowngrade = configuration.allowDowngrade;
      autoUpdater.allowPrerelease = configuration.allowPrerelease;
    },
    onCheckingForUpdate(listener) {
      autoUpdater.on("checking-for-update", listener);
      return () => autoUpdater.off("checking-for-update", listener);
    },
    onUpdateAvailable(listener) {
      autoUpdater.on("update-available", listener);
      return () => autoUpdater.off("update-available", listener);
    },
    onUpdateNotAvailable(listener) {
      autoUpdater.on("update-not-available", listener);
      return () => autoUpdater.off("update-not-available", listener);
    },
    onDownloadProgress(listener) {
      autoUpdater.on("download-progress", listener);
      return () => autoUpdater.off("download-progress", listener);
    },
    onUpdateDownloaded(listener) {
      autoUpdater.on("update-downloaded", listener);
      return () => autoUpdater.off("update-downloaded", listener);
    },
    onUpdateCancelled(listener) {
      autoUpdater.on("update-cancelled", listener);
      return () => autoUpdater.off("update-cancelled", listener);
    },
    onError(listener) {
      autoUpdater.on("error", listener);
      return () => autoUpdater.off("error", listener);
    },
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: (isSilent, isForceRunAfter) =>
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
  };
}

function hasMacDeveloperIdSignature(): boolean {
  if (process.platform !== "darwin") {
    return true;
  }

  const result = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", process.execPath], {
    encoding: "utf8",
  });
  const signingDetails = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status === 0 && /^Authority=Developer ID Application:/mu.test(signingDetails);
}

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

function deliverWorkspaceEvent(event: ProductRealtimeEvent): void {
  sendToRenderer(DESKTOP_CHANNELS.workspaceEvent, event);
}

function deliverRealtimeState(state: RealtimeConnectionState): void {
  realtimeState = state;
  sendToRenderer(DESKTOP_CHANNELS.realtimeStateChanged, state);
}

function deliverSessionState(state: ChatSessionState): void {
  sendToRenderer(DESKTOP_CHANNELS.sessionChanged, state);
  if (state.status === "signed-out") {
    workspaceRealtime?.stop();
  }
}

function deliverUpdateState(state: UpdateState): void {
  sendToRenderer(DESKTOP_CHANNELS.updateChanged, state);
}

function deliverThemeState(state: ThemeState): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(getThemeDefinition(state.resolvedThemeId).windowBackground);
  }
  sendToRenderer(DESKTOP_CHANNELS.themeChanged, state);
}

function flushPendingRendererEvents(): void {
  if (chatSession !== null) {
    sendToRenderer(DESKTOP_CHANNELS.sessionChanged, chatSession.state);
  }
  if (updateController !== null) {
    sendToRenderer(DESKTOP_CHANNELS.updateChanged, updateController.state);
  }
  if (themeController !== null) {
    sendToRenderer(DESKTOP_CHANNELS.themeChanged, themeController.state);
  }
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

  ipcMain.removeHandler(DESKTOP_CHANNELS.updateState);
  ipcMain.handle(DESKTOP_CHANNELS.updateState, (event): UpdateState => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted update-state IPC sender");
    }
    return updateController?.state ?? { status: "unsupported" };
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.updateCheck);
  ipcMain.handle(DESKTOP_CHANNELS.updateCheck, async (event): Promise<void> => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted update-check IPC sender");
    }
    await updateController?.checkNow();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.updateInstall);
  ipcMain.handle(DESKTOP_CHANNELS.updateInstall, (event): void => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted update-install IPC sender");
    }
    updateController?.quitAndInstall();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.themeState);
  ipcMain.handle(DESKTOP_CHANNELS.themeState, (event): ThemeState => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted theme-state IPC sender");
    }
    if (themeController === null) {
      throw new Error("Appearance is unavailable");
    }
    return themeController.state;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.themeSet);
  ipcMain.handle(DESKTOP_CHANNELS.themeSet, async (event, preference: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted theme-set IPC sender");
    }
    if (themeController === null) {
      throw new Error("Appearance is unavailable");
    }
    const parsed = themePreferenceSchema.safeParse(preference);
    if (!parsed.success) {
      throw new Error("Invalid appearance preference");
    }
    try {
      return await themeController.setPreference(parsed.data);
    } catch (error) {
      throw new Error("Could not save the appearance preference", { cause: error });
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionState);
  ipcMain.handle(DESKTOP_CHANNELS.sessionState, (event): ChatSessionState => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted session-state IPC sender");
    }
    return chatSession?.state ?? { status: "signed-out" };
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

  ipcMain.removeHandler(DESKTOP_CHANNELS.cacheCryptoInitialize);
  ipcMain.handle(DESKTOP_CHANNELS.cacheCryptoInitialize, async (event, scope: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted cache initialization sender");
    if (cacheCrypto === null) throw new Error("Cache encryption is unavailable");
    return cacheCrypto.initialize(cacheScopeSchema.parse(scope));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.cacheCryptoEncrypt);
  ipcMain.handle(DESKTOP_CHANNELS.cacheCryptoEncrypt, (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted cache encryption sender");
    if (cacheCrypto === null) throw new Error("Cache encryption is unavailable");
    return cacheCrypto.encrypt(cacheEncryptBatchRequestSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.cacheCryptoDecrypt);
  ipcMain.handle(DESKTOP_CHANNELS.cacheCryptoDecrypt, (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted cache decryption sender");
    if (cacheCrypto === null) throw new Error("Cache encryption is unavailable");
    return cacheCrypto.decrypt(cacheDecryptBatchRequestSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.cacheCryptoReset);
  ipcMain.handle(DESKTOP_CHANNELS.cacheCryptoReset, async (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted cache reset sender");
    await cacheCrypto?.clear();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceBootstrap);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceBootstrap, async (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace bootstrap sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.bootstrap();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceConversationsList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceConversationsList, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace conversations sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.conversations(listConversationsQuerySchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMessagesList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMessagesList, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace history sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    if (typeof input !== "object" || input === null || !("conversationId" in input)) {
      throw new Error("Invalid workspace history request");
    }
    const request = input as {
      readonly conversationId: unknown;
      readonly before?: unknown;
      readonly limit?: unknown;
    };
    return workspaceTransport.history({
      conversationId: entityIdSchema.parse(request.conversationId),
      ...(typeof request.before === "string" ? { before: request.before } : {}),
      ...(typeof request.limit === "number" ? { limit: request.limit } : {}),
    });
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMessageSearch);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMessageSearch, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace search sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.searchMessages(messageSearchQuerySchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceReactionsList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceReactionsList, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace reactions sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    const request = listMessageReactionsRequestSchema.parse(input);
    return workspaceTransport.reactions(request.messageIds);
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceReactionAdd);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceReactionAdd, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted reaction add sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    const target = messageReactionTargetSchema.parse(input);
    return workspaceTransport.addReaction(target.messageId, target.emoji);
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceReactionRemove);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceReactionRemove, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted reaction remove sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    const target = messageReactionTargetSchema.parse(input);
    return workspaceTransport.removeReaction(target.messageId, target.emoji);
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMessageSend);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMessageSend, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace send sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.send(sendMessageOperationSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceChannelCreate);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceChannelCreate, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted channel creation sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.createChannel(createChannelRequestSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceChannelArchive);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceChannelArchive, async (event, id: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted channel archive sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.archiveChannel(entityIdSchema.parse(id), { isArchived: true });
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceChannelMembersList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceChannelMembersList, async (event, id: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted channel members sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.channelMembers(entityIdSchema.parse(id));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceChannelMemberUpsert);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceChannelMemberUpsert, async (event, value: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted channel member sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    const operation = upsertChannelMemberOperationSchema.parse(value);
    return workspaceTransport.upsertChannelMember(operation.conversationId, operation.userId, {
      role: operation.role,
    });
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceChannelMemberRemove);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceChannelMemberRemove, async (event, value: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted channel member sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    const target = channelMemberTargetSchema.parse(value);
    return workspaceTransport.removeChannelMember(target.conversationId, target.userId);
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceDirectCreate);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceDirectCreate, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted direct conversation sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.createDirectConversation(
      directConversationRequestSchema.parse(input),
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceReadAdvance);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceReadAdvance, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted read-cursor sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    if (
      typeof input !== "object" ||
      input === null ||
      !("conversationId" in input) ||
      !("lastReadMessageId" in input)
    ) {
      throw new Error("Invalid read-cursor request");
    }
    return workspaceTransport.advanceRead(
      entityIdSchema.parse(input.conversationId),
      entityIdSchema.parse(input.lastReadMessageId),
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceSync);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceSync, async (event, after: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace sync sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.sync(sequenceSchema.parse(after));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceRealtimeStart);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceRealtimeStart, (event, after: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime start sender");
    workspaceRealtime?.start(sequenceSchema.parse(after));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceRealtimeStop);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceRealtimeStop, (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime stop sender");
    workspaceRealtime?.stop();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceRealtimeAcknowledge);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceRealtimeAcknowledge, (event, cursor: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime acknowledgement sender");
    workspaceRealtime?.acknowledge(sequenceSchema.parse(cursor));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.realtimeStateGet);
  ipcMain.handle(DESKTOP_CHANNELS.realtimeStateGet, (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime state sender");
    return realtimeState;
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
  if (themeController === null) {
    throw new Error("Appearance must be initialized before creating a window");
  }
  const window = new BrowserWindow({
    width: 1_280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: getThemeDefinition(themeController.state.resolvedThemeId).windowBackground,
    title: "HMM Chat",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      additionalArguments: [createInitialThemeStateArgument(themeController.state)],
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

      themeController = new ThemeController({
        nativeTheme,
        persistence: new ThemePreferenceStore({ userDataPath: app.getPath("userData") }),
      });
      await themeController.initialize();
      stopThemeSubscription = themeController.subscribe(deliverThemeState);

      chatSession = new ChatSession({
        apiOrigin: __HMM_CHAT_API_ORIGIN__,
        cookies: session.defaultSession.cookies,
        request: (url, init) => net.fetch(url, init),
      });
      workspaceTransport = new WorkspaceTransport(__HMM_CHAT_API_ORIGIN__, chatSession);
      workspaceRealtime = new WorkspaceRealtime({
        apiOrigin: __HMM_CHAT_API_ORIGIN__,
        rendererOrigin: app.isPackaged ? `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}` : RENDERER_ORIGIN,
        transport: workspaceTransport,
        onEvent: deliverWorkspaceEvent,
        onState: deliverRealtimeState,
      });
      cacheCrypto = new CacheCrypto({
        apiOrigin: __HMM_CHAT_API_ORIGIN__,
        platform: process.platform,
        safeStorage,
        userDataPath: app.getPath("userData"),
      });
      chatSession.subscribe(deliverSessionState);
      updateController = new UpdateController({
        updater: createUpdateSource(),
        isPackaged: app.isPackaged,
        apiOrigin: __HMM_CHAT_API_ORIGIN__,
        platform: process.platform,
        ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
        hasMacDeveloperIdSignature:
          !app.isPackaged || process.platform !== "darwin" || hasMacDeveloperIdSignature(),
      });
      updateController.subscribe(deliverUpdateState);

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
      const restoredSession = await chatSession.restore();

      const initialCallbackUrl = findAuthCallbackUrl(process.argv);
      if (initialCallbackUrl !== null) {
        handleAuthCallback(initialCallbackUrl);
      }
      const developmentCallback =
        developmentAuthCallbackFile === null
          ? null
          : await consumeDevelopmentAuthCallbackFile(developmentAuthCallbackFile);
      const signedOutCallback = callbackForSignedOutSession(developmentCallback, restoredSession);
      if (signedOutCallback !== null && !handleAuthCallback(signedOutCallback)) {
        throw new Error("HMM_DEVELOPMENT_AUTH_CALLBACK_FILE did not contain a valid auth callback");
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
    workspaceRealtime?.stop();
    updateController?.dispose();
    stopThemeSubscription?.();
    stopThemeSubscription = null;
    themeController?.dispose();
  });
}
