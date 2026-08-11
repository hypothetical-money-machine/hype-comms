import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
  NOTIFICATION_ACTIVITY_IPC_MAX_BYTES,
  NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
  NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
  NOTIFICATION_PREFERENCE_IPC_MAX_BYTES,
  NOTIFICATION_STATE_IPC_MAX_BYTES,
  authAppVersionSchema,
  authDevicePlatformSchema,
  cacheDecryptBatchRequestSchema,
  cacheEncryptBatchRequestSchema,
  cacheScopeSchema,
  channelMemberTargetSchema,
  compactModePreferenceSchema,
  createChannelOperationSchema,
  createTaskOperationSchema,
  directConversationRequestSchema,
  entityIdSchema,
  listConversationsQuerySchema,
  listMessageReactionsRequestSchema,
  messageThreadRequestSchema,
  messageReactionTargetSchema,
  messageSearchQuerySchema,
  moveTaskOperationSchema,
  notificationActionDrainRequestSchema,
  notificationActionDrainResponseSchema,
  notificationActionAcknowledgementSchema,
  notificationActivityUpdateSchema,
  notificationCaptureActivationRequestSchema,
  notificationCaptureActivationResponseSchema,
  notificationContextSchema,
  notificationPreferenceSchema,
  notificationStateSchema,
  realtimeAcknowledgementSchema,
  realtimeSessionScopeSchema,
  requestMagicLinkSchema,
  sendMessageOperationSchema,
  sequenceSchema,
  taskListQuerySchema,
  themeDesignSchema,
  themePreferenceSchema,
  updateTaskOperationSchema,
  upsertChannelMemberOperationSchema,
  type ChatSessionState,
  type HumanWorkspaceBootstrapResponse,
  type NotificationContext,
  type NotificationState,
  type ProductRealtimeEvent,
  type ScopedProductRealtimeEvent,
  type ThemeState,
  type UpdateState,
} from "@hype-comms/contracts";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from "electron";
import type { Event, IpcMainInvokeEvent, Session, WebContents } from "electron";
import { autoUpdater } from "electron-updater";

import { createServerHealthUrl } from "../shared/api-origin";
import { DESKTOP_CHANNELS } from "../shared/channels";
import { createInitialCompactModeArgument } from "../shared/compact-mode";
import type { RealtimeConnectionState, ServerStatus } from "../shared/desktop-api";
import { createInitialThemeStateArgument, getThemeDefinition } from "../shared/theme";
import { parseAuthCallback } from "./auth-callback";
import { AuthKitFlow } from "./authkit-flow";
import {
  AuthKitProtectedStoreCorruptError,
  AuthKitProtectedStoreUnavailableError,
  SafeStorageAuthKitPendingStore,
} from "./authkit-pending-store";
import { configureWindowsApplicationIdentity } from "./application-identity";
import { CHECK_FOR_UPDATES_MENU_ITEM_ID, buildApplicationMenu } from "./application-menu";
import { ChatSession, ChatSessionError } from "./chat-session";
import { CacheCrypto } from "./cache-crypto";
import { CompactModeController } from "./compact-mode-controller";
import { CompactModePreferenceStore } from "./compact-mode-preference-store";
import {
  callbackForSignedOutSession,
  consumeDevelopmentAuthCallbackFile,
  resolveDevelopmentAuthCallbackFile,
  resolveDevelopmentProfile,
  resolveDevelopmentUserDataPath,
} from "./development-profile";
import {
  HEADLESS_DESKTOP_CDP_ADDRESS,
  assertHeadlessDesktopCommandLine,
  resolveHeadlessDesktopConfiguration,
  shouldAdvanceReadCursor,
  shouldFocusDesktopWindow,
  shouldShowDesktopWindow,
} from "./headless-mode";
import {
  HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV,
  openHeadlessNotificationCaptureArtifact,
  type HeadlessNotificationCaptureArtifact,
} from "./headless-notification-capture";
import { protectMainProcessLogStreams, reportMainProcessError } from "./main-process-log";
import { MainWindowLifecycle, MainWindowRecreationCoordinator } from "./main-window-recreation";
import { NotificationController } from "./notification-controller";
import { NotificationPreferenceStore } from "./notification-preference-store";
import {
  NotificationProjectionRepairCoordinator,
  type NotificationProjectionRepairFailure,
} from "./notification-projection-repair";
import {
  CaptureNotificationPresenter,
  ElectronNotificationCapabilitySource,
  ElectronNotificationPresenter,
  NoopNotificationPresenter,
  type NotificationPresenter,
} from "./notification-presenter";
import {
  NotificationSettingsController,
  type NotificationCapabilitySource,
} from "./notification-settings-controller";
import { LEGACY_PRODUCT_NAME, migrateLegacyUserData } from "./user-data-migration";
import { WorkspaceRealtime } from "./workspace-realtime";
import { WorkspaceTransport } from "./workspace-transport";
import { handleLastWindowClosed } from "./window-lifecycle";
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
import {
  dialogForWindowRestoreFailure,
  isCheckForUpdatesEnabled,
  runUserInitiatedUpdateCheck,
  shouldParentUpdateCheckDialog,
  type UpdateCheckDialog,
} from "./user-update-check";
const RENDERER_ORIGIN = "http://127.0.0.1:5173";
const WINDOW_MIN_HEIGHT = 640;
const WINDOW_MIN_WIDTH = 960;
/**
 * Compact mode hides the workspace rail and sidebar, so the window may shrink further.
 * Mirrored by the `html[data-compact] body` min-width in renderer styles.css.
 */
const COMPACT_WINDOW_MIN_WIDTH = 640;

configureWindowsApplicationIdentity(app, process.platform);
protectMainProcessLogStreams([process.stdout, process.stderr]);

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
let rendererSessionGeneration = 0;
const mainWindowRecreationCoordinator = new MainWindowRecreationCoordinator();
let trustedDevelopmentRendererUrl: string | null = null;
let serverStatusRequest: Promise<ServerStatus> | null = null;
interface PendingAuthCallback {
  readonly transientAttempts: number;
  readonly value: string;
}

const AUTH_CALLBACK_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const pendingAuthCallbacks: PendingAuthCallback[] = [];
let authCallbacksReady = false;
let drainingAuthCallbacks = false;
let authCallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
let authIntentGeneration = 0;
const developmentProfile = app.isPackaged ? "" : resolveDevelopmentProfile(process.env);
const headlessDesktopConfiguration = resolveHeadlessDesktopConfiguration(
  process.env,
  app.isPackaged,
  developmentProfile,
);
if (headlessDesktopConfiguration !== null) {
  assertHeadlessDesktopCommandLine(process.argv);
  app.commandLine.appendSwitch("remote-debugging-address", HEADLESS_DESKTOP_CDP_ADDRESS);
  app.commandLine.appendSwitch(
    "force-device-scale-factor",
    String(headlessDesktopConfiguration.deviceScaleFactor),
  );
}
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
let authKitFlow: AuthKitFlow | null = null;
let authKitPendingStore: SafeStorageAuthKitPendingStore | null = null;
let authKitCancellationPromise: Promise<void> | null = null;
let authKitCancellationRetryTimer: ReturnType<typeof setTimeout> | null = null;
let authKitCancellationFenced = false;
let authKitPendingIntentGeneration: number | null = null;
let authKitStartPromise: Promise<void> | null = null;
let workspaceTransport: WorkspaceTransport | null = null;
let workspaceRealtime: WorkspaceRealtime | null = null;
let macWindowlessRealtimeActive = false;
let cacheCrypto: CacheCrypto | null = null;
let realtimeState: RealtimeConnectionState = "offline";
let updateController: UpdateController | null = null;
let themeController: ThemeController | null = null;
let stopThemeSubscription: (() => void) | null = null;
let userUpdateCheckInFlight = false;
let compactModeController: CompactModeController | null = null;
let stopCompactModeSubscription: (() => void) | null = null;
let notificationSettingsController: NotificationSettingsController | null = null;
let stopNotificationSettingsSubscription: (() => void) | null = null;
let notificationController: NotificationController | null = null;
let notificationProjectionRepairCoordinator: NotificationProjectionRepairCoordinator | null = null;
let captureNotificationPresenter: CaptureNotificationPresenter | null = null;
let headlessNotificationCaptureArtifact: HeadlessNotificationCaptureArtifact | null = null;
let notificationSessionGeneration = 0;
let notificationScope: {
  readonly sessionGeneration: number;
  readonly userId: string;
  readonly workspaceId: string;
} | null = null;
let notificationActiveGeneration: number | null = null;

function createNotificationCapabilitySource(): NotificationCapabilitySource {
  if (!__HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED__) {
    return {
      read: () => ({ nativeSupport: "unsupported", osPermission: "unknown" }),
    };
  }
  if (headlessDesktopConfiguration !== null) {
    return {
      read: () => ({ nativeSupport: "supported", osPermission: "unknown" }),
    };
  }
  return new ElectronNotificationCapabilitySource(Notification);
}

function createNotificationPresenter(): NotificationPresenter {
  if (headlessDesktopConfiguration === null) {
    return new ElectronNotificationPresenter(Notification);
  }

  const artifactDirectory = process.env[HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]?.trim() ?? "";
  if (artifactDirectory === "") return new NoopNotificationPresenter();
  headlessNotificationCaptureArtifact = openHeadlessNotificationCaptureArtifact({
    env: process.env,
    isPackaged: app.isPackaged,
    profile: developmentProfile,
  });
  if (headlessNotificationCaptureArtifact === null) {
    return new NoopNotificationPresenter();
  }
  const artifact = headlessNotificationCaptureArtifact;
  captureNotificationPresenter = new CaptureNotificationPresenter({
    onRecord: (record) => {
      if (!artifact.append(record)) {
        throw new Error("Headless notification capture capacity reached");
      }
    },
  });
  return captureNotificationPresenter;
}

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
  const window = mainWindow;
  if (
    window === null ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    window.webContents.isCrashed() ||
    !rendererReady
  ) {
    return false;
  }

  try {
    window.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

interface IpcPayloadSchema<T> {
  readonly parse: (value: unknown) => T;
}

function parseBoundedNotificationIpc<T>(
  schema: IpcPayloadSchema<T>,
  value: unknown,
  maximumBytes: number,
): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Notification IPC payload is not JSON-serializable");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error("Notification IPC payload exceeds its byte limit");
  }
  return schema.parse(value);
}

function inactiveNotificationContext(): NotificationContext {
  return notificationContextSchema.parse({
    version: 1,
    status: "inactive",
    sessionGeneration: null,
    rendererSessionGeneration: Math.max(1, rendererSessionGeneration),
    userId: null,
    workspaceId: null,
  });
}

function evaluateWorkspaceNotification(event: ProductRealtimeEvent): void {
  try {
    notificationController?.handleEvent(event, {
      ...(notificationScope === null
        ? {}
        : { sessionGeneration: notificationScope.sessionGeneration }),
      ...(event.type === "system.connected" ? { connectionId: event.payload.connectionId } : {}),
    });
  } catch {
    // Notification bookkeeping is deliberately outside durable renderer delivery. Never include
    // the canonical event or thrown value here because either may contain private message data.
    reportMainProcessError("Native notification evaluation failed");
  }
}

function deliverWorkspaceEvent(frame: ScopedProductRealtimeEvent): boolean {
  evaluateWorkspaceNotification(frame.event);
  return sendToRenderer(DESKTOP_CHANNELS.workspaceEvent, frame);
}

function observeWindowlessWorkspaceEvent(event: ProductRealtimeEvent): void {
  evaluateWorkspaceNotification(event);
}

function deliverRealtimeState(state: RealtimeConnectionState): void {
  realtimeState = state;
  try {
    notificationController?.setRealtimeState(state);
  } catch {
    reportMainProcessError("Native notification realtime transition failed");
  }
  sendToRenderer(DESKTOP_CHANNELS.realtimeStateChanged, state);
}

function transitionNotificationSession(state: ChatSessionState): void {
  if (state.status === "signed-in" && state.method === "email") {
    if (
      notificationScope?.userId === state.userId &&
      notificationScope.workspaceId === state.workspaceId
    ) {
      return;
    }
    notificationController?.markReplacing();
    if (notificationSessionGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Notification session generation is exhausted");
    }
    notificationSessionGeneration += 1;
    notificationScope = {
      sessionGeneration: notificationSessionGeneration,
      userId: state.userId,
      workspaceId: state.workspaceId,
    };
    notificationActiveGeneration = null;
    return;
  }

  notificationScope = null;
  notificationActiveGeneration = null;
  if (state.status === "signed-out") {
    notificationController?.signOut();
  } else {
    notificationController?.markReplacing();
  }
}

function sessionStateMatchesNotificationScope(
  state: ChatSessionState,
  scope: NonNullable<typeof notificationScope> | null,
): boolean {
  return (
    scope !== null &&
    state.status === "signed-in" &&
    state.method === "email" &&
    state.userId === scope.userId &&
    state.workspaceId === scope.workspaceId
  );
}

function beginSessionReplacement(): void {
  macWindowlessRealtimeActive = false;
  workspaceRealtime?.resetSession();
  notificationScope = null;
  notificationActiveGeneration = null;
  notificationController?.markReplacing();
}

function advanceAuthIntent(): number {
  if (authIntentGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Authentication intent generation is exhausted");
  }
  authIntentGeneration += 1;
  return authIntentGeneration;
}

function scheduleAuthKitCancellationRetry(): void {
  if (
    authKitCancellationRetryTimer !== null ||
    authKitFlow === null ||
    authKitPendingStore === null
  ) {
    return;
  }
  authKitCancellationRetryTimer = setTimeout(() => {
    authKitCancellationRetryTimer = null;
    void cancelPendingAuthKit().catch(() => undefined);
  }, 5_000);
  authKitCancellationRetryTimer.unref();
}

async function cancelPendingAuthKit(): Promise<void> {
  if (authKitCancellationPromise !== null) return authKitCancellationPromise;
  const flow = authKitFlow;
  const store = authKitPendingStore;
  if (flow === null || store === null) return;
  authKitCancellationFenced = true;
  const cancellation = (async (): Promise<void> => {
    try {
      await store.armCancellationFence();
      try {
        await flow.cancel();
      } catch (error) {
        if (!(error instanceof AuthKitProtectedStoreCorruptError)) throw error;
        // Corrupt pending material cannot produce a valid callback. Remove it directly because the
        // flow deliberately refuses to initialize from an unauthenticated/ill-formed record.
        await store.clear();
      }
      authKitPendingIntentGeneration = null;
      await store.clearCancellationFence();
      authKitCancellationFenced = false;
      if (authKitCancellationRetryTimer !== null) {
        clearTimeout(authKitCancellationRetryTimer);
        authKitCancellationRetryTimer = null;
      }
    } catch (error) {
      scheduleAuthKitCancellationRetry();
      throw error;
    }
  })();
  authKitCancellationPromise = cancellation;
  try {
    await cancellation;
  } finally {
    if (authKitCancellationPromise === cancellation) authKitCancellationPromise = null;
  }
}

function isCurrentNotificationScope(scope: NonNullable<typeof notificationScope>): boolean {
  const state = chatSession?.state;
  return (
    notificationScope?.sessionGeneration === scope.sessionGeneration &&
    notificationScope.userId === scope.userId &&
    notificationScope.workspaceId === scope.workspaceId &&
    state?.status === "signed-in" &&
    state.method === "email" &&
    state.userId === scope.userId &&
    state.workspaceId === scope.workspaceId
  );
}

function currentNotificationRepairScope(): NonNullable<typeof notificationScope> | null {
  const scope = notificationScope;
  return scope !== null && isCurrentNotificationScope(scope) ? { ...scope } : null;
}

function reportNotificationProjectionRepairFailure(
  failure: NotificationProjectionRepairFailure,
): void {
  if (failure === "members") {
    reportMainProcessError("Native notification member projection repair failed");
    return;
  }
  if (failure === "conversation_limit") {
    reportMainProcessError("Native notification conversation projection exceeds its limit");
    return;
  }
  reportMainProcessError("Native notification conversation projection repair failed");
}

function projectNotificationBootstrap(
  scope: NonNullable<typeof notificationScope>,
  bootstrap: HumanWorkspaceBootstrapResponse,
): void {
  const controller = notificationController;
  if (
    controller === null ||
    !isCurrentNotificationScope(scope) ||
    bootstrap.currentUser.user.id !== scope.userId ||
    bootstrap.workspace.id !== scope.workspaceId
  ) {
    return;
  }
  try {
    const firstActivation = notificationActiveGeneration !== scope.sessionGeneration;
    if (firstActivation) {
      // Realtime is stopped before a new scope can bootstrap, so this first response safely seeds
      // the session baseline and member labels.
      controller.startSession({
        ...scope,
        bootstrapCursor: bootstrap.syncCursor,
      });
      controller.replaceMembers(bootstrap.members);
      notificationActiveGeneration = scope.sessionGeneration;
    } else {
      // A same-generation bootstrap can race a newer ordered realtime invalidation. It is useful
      // evidence that a renderer/window resumed, but its member payload must not directly overwrite
      // main's projection; force a fresh coordinator read that starts after this response instead.
      controller.invalidateMemberProjection();
    }
    const repairCoordinator = notificationProjectionRepairCoordinator;
    if (repairCoordinator === null) {
      controller.disableConversationProjection();
    } else {
      void repairCoordinator.seedConversationCatalog({
        conversations: bootstrap.conversations,
        nextCursor: bootstrap.conversationsNextCursor,
        hasMore: bootstrap.conversationsHasMore,
      });
    }
  } catch {
    notificationActiveGeneration = null;
    reportMainProcessError("Native notification bootstrap projection failed");
  }
}

function deliverSessionState(state: ChatSessionState): void {
  if (!sessionStateMatchesNotificationScope(state, notificationScope)) {
    macWindowlessRealtimeActive = false;
    workspaceRealtime?.resetSession();
  }
  try {
    transitionNotificationSession(state);
  } catch {
    notificationScope = null;
    notificationActiveGeneration = null;
    notificationController?.signOut();
    reportMainProcessError("Native notification session transition failed");
  }
  sendToRenderer(DESKTOP_CHANNELS.sessionChanged, state);
}

function deliverNotificationState(state: NotificationState): void {
  sendToRenderer(DESKTOP_CHANNELS.notificationStateChanged, state);
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

/** The single owner of the compact-mode window-size policy; call from every site that applies it. */
function applyCompactModeWindowBounds(window: BrowserWindow, enabled: boolean): void {
  if (enabled) {
    window.setMinimumSize(COMPACT_WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT);
    return;
  }
  // The restored minimum is clamped to the display's work area: reinstating a raw 960px
  // minimum on a narrower display would stop the bounds update below from ever bringing the
  // window back inside the usable screen.
  const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
  const minimumWidth = Math.min(WINDOW_MIN_WIDTH, workArea.width);
  window.setMinimumSize(minimumWidth, WINDOW_MIN_HEIGHT);
  // A maximized or fullscreen window already spans its display; resizing it here would
  // silently un-maximize it (and could exceed the screen on narrow displays).
  if (window.isMaximized() || window.isFullScreen()) {
    return;
  }
  // Leaving compact mode has to widen a window the user shrank below the standard minimum,
  // otherwise the restored rail and sidebar have nowhere to go — but the widened window must
  // stay inside its display's work area instead of growing past the screen edge.
  const bounds = window.getBounds();
  if (bounds.width >= minimumWidth) {
    return;
  }
  const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - minimumWidth));
  window.setBounds({ x, y: bounds.y, width: minimumWidth, height: bounds.height });
}

function deliverCompactModeState(enabled: boolean): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    applyCompactModeWindowBounds(mainWindow, enabled);
  }
  sendToRenderer(DESKTOP_CHANNELS.compactModeChanged, enabled);
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
  if (compactModeController !== null) {
    sendToRenderer(DESKTOP_CHANNELS.compactModeChanged, compactModeController.enabled);
  }
  if (notificationSettingsController !== null) {
    sendToRenderer(DESKTOP_CHANNELS.notificationStateChanged, notificationSettingsController.state);
  }
}

function safelyOpenExternal(url: string): void {
  const safeUrl = normalizeExternalHttpsUrl(url);
  if (safeUrl !== null) {
    void shell.openExternal(safeUrl).catch((error: unknown) => {
      reportMainProcessError("Failed to open an external link", error);
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
          "Content-Security-Policy": [__HYPE_COMMS_PRODUCTION_CSP__],
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

  // This one synchronous, read-only capability is queried by preload before the renderer can
  // schedule read tracking. Unlike a renderer command-line marker, it stays authoritative when a
  // packaged client is launched with arbitrary application arguments.
  ipcMain.removeAllListeners(DESKTOP_CHANNELS.automationHeadless);
  ipcMain.on(DESKTOP_CHANNELS.automationHeadless, (event) => {
    event.returnValue = headlessDesktopConfiguration !== null;
  });

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
      .fetch(createServerHealthUrl(__HYPE_COMMS_API_ORIGIN__), {
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

  ipcMain.removeHandler(DESKTOP_CHANNELS.themeDesignSet);
  ipcMain.handle(DESKTOP_CHANNELS.themeDesignSet, async (event, design: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted theme-design-set IPC sender");
    }
    if (themeController === null) {
      throw new Error("Appearance is unavailable");
    }
    const parsed = themeDesignSchema.safeParse(design);
    if (!parsed.success) {
      throw new Error("Invalid theme design");
    }
    try {
      return await themeController.setDesign(parsed.data);
    } catch (error) {
      throw new Error("Could not save the theme design", { cause: error });
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.compactModeState);
  ipcMain.handle(DESKTOP_CHANNELS.compactModeState, (event): boolean => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted compact-mode-state IPC sender");
    }
    if (compactModeController === null) {
      throw new Error("Compact mode is unavailable");
    }
    return compactModeController.enabled;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.compactModeSet);
  ipcMain.handle(DESKTOP_CHANNELS.compactModeSet, async (event, preference: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted compact-mode-set IPC sender");
    }
    if (compactModeController === null) {
      throw new Error("Compact mode is unavailable");
    }
    const parsed = compactModePreferenceSchema.safeParse(preference);
    if (!parsed.success) {
      throw new Error("Invalid compact mode preference");
    }
    try {
      return await compactModeController.setEnabled(parsed.data);
    } catch (error) {
      throw new Error("Could not save the compact mode preference", { cause: error });
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionState);
  ipcMain.handle(DESKTOP_CHANNELS.sessionState, (event): ChatSessionState => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted session-state IPC sender");
    }
    return chatSession?.state ?? { status: "signed-out" };
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionAuthCapabilities);
  ipcMain.handle(DESKTOP_CHANNELS.sessionAuthCapabilities, async (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted authentication-capabilities IPC sender");
    }
    if (chatSession === null) {
      throw new Error("Chat is not configured");
    }

    const capabilities = await chatSession.getAuthCapabilities();
    if (!capabilities.authKit || authKitPendingStore === null) return capabilities;
    if (authKitCancellationFenced) return { ...capabilities, authKit: false };
    try {
      await authKitPendingStore.assertAvailable();
      return capabilities;
    } catch {
      return { ...capabilities, authKit: false };
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionStartAuthKit);
  ipcMain.handle(DESKTOP_CHANNELS.sessionStartAuthKit, async (event): Promise<void> => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted AuthKit IPC sender");
    }
    if (chatSession === null || authKitFlow === null || authKitPendingStore === null) {
      throw new Error("AuthKit sign-in is unavailable");
    }
    if (chatSession.state.status !== "signed-out") {
      throw new Error("Sign out before starting a different authentication attempt");
    }

    // Coalesce duplicate trusted IPC while the first start is persisting state and opening the
    // browser. Advancing a second intent here could make the first continuation cancel the shared
    // AuthKitFlow operation after it had already opened a usable authorization URL.
    if (authKitStartPromise !== null) return authKitStartPromise;

    const startIntent = advanceAuthIntent();
    const start = (async (): Promise<void> => {
      try {
        // Retire any older attempt through the durable fence before replacing it. This also keeps
        // a failed protected-store deletion from resurrecting the superseded attempt on restart.
        await cancelPendingAuthKit();
        // Preflight stable device metadata before opening the system browser. A credential-store
        // failure after the callback would otherwise consume an otherwise usable handoff.
        await authKitPendingStore.loadOrCreateInstallationId();
        if (startIntent !== authIntentGeneration) {
          throw new Error("AuthKit authorization was superseded");
        }
        // Bind the intent before awaiting the browser open. A very fast provider callback queues
        // behind AuthKitFlow.start(), but may snapshot this generation before start() resolves.
        authKitPendingIntentGeneration = startIntent;
        await authKitFlow.start();
        if (startIntent !== authIntentGeneration) {
          await cancelPendingAuthKit();
          throw new Error("AuthKit authorization was superseded");
        }
      } catch (error) {
        if (authKitPendingIntentGeneration === startIntent) {
          authKitPendingIntentGeneration = null;
        }
        reportMainProcessError("AuthKit authorization could not be started");
        throw new Error("Could not start WorkOS sign-in", { cause: error });
      }
    })();
    authKitStartPromise = start;
    try {
      await start;
    } finally {
      if (authKitStartPromise === start) authKitStartPromise = null;
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.sessionSignOut);
  ipcMain.handle(DESKTOP_CHANNELS.sessionSignOut, async (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted sign-out IPC sender");
    }
    advanceAuthIntent();
    let cancellationFailed = false;
    try {
      await cancelPendingAuthKit();
    } catch {
      cancellationFailed = true;
      reportMainProcessError("Pending AuthKit authorization cancellation will be retried");
    }

    beginSessionReplacement();
    const state = (await chatSession?.signOut()) ?? { status: "signed-out" as const };
    const logoutUrl = chatSession?.consumeLogoutUrl() ?? null;
    if (logoutUrl !== null) {
      void shell.openExternal(logoutUrl).catch(() => {
        reportMainProcessError("WorkOS logout page could not be opened");
      });
    }
    if (cancellationFailed && headlessDesktopConfiguration === null) {
      const content = {
        type: "warning" as const,
        message: "Signed out, but secure sign-in cancellation is still pending",
        detail:
          "Close any WorkOS sign-in window. Hype Comms will keep retrying the protected cancellation.",
      };
      const window = mainWindow;
      if (window === null || window.isDestroyed()) {
        await dialog.showMessageBox(content);
      } else {
        await dialog.showMessageBox(window, content);
      }
    }
    return state;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationContext);
  ipcMain.handle(DESKTOP_CHANNELS.notificationContext, (event): NotificationContext => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-context IPC sender");
    }
    const controller = notificationController;
    const scope = notificationScope;
    if (
      controller === null ||
      scope === null ||
      notificationActiveGeneration !== scope.sessionGeneration
    ) {
      return parseBoundedNotificationIpc(
        notificationContextSchema,
        inactiveNotificationContext(),
        NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
      );
    }
    return parseBoundedNotificationIpc(
      notificationContextSchema,
      controller.bindRenderer(event.sender.id, rendererSessionGeneration),
      NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationActivityUpdate);
  ipcMain.handle(DESKTOP_CHANNELS.notificationActivityUpdate, (event, input: unknown): void => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-activity IPC sender");
    }
    const controller = notificationController;
    if (controller === null) throw new Error("Native notifications are unavailable");
    const activity = parseBoundedNotificationIpc(
      notificationActivityUpdateSchema,
      input,
      NOTIFICATION_ACTIVITY_IPC_MAX_BYTES,
    );
    if (!controller.updateActivity(event.sender.id, activity)) {
      throw new Error("Notification activity does not match the active renderer");
    }
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationActionsDrain);
  ipcMain.handle(DESKTOP_CHANNELS.notificationActionsDrain, (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-action IPC sender");
    }
    const controller = notificationController;
    if (controller === null) throw new Error("Native notifications are unavailable");
    const request = parseBoundedNotificationIpc(
      notificationActionDrainRequestSchema,
      input,
      NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES,
    );
    return parseBoundedNotificationIpc(
      notificationActionDrainResponseSchema,
      controller.rendererReadyAndDrain(event.sender.id, request),
      NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationActionAcknowledge);
  ipcMain.handle(DESKTOP_CHANNELS.notificationActionAcknowledge, (event, input: unknown): void => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-action acknowledgement IPC sender");
    }
    const controller = notificationController;
    if (controller === null) throw new Error("Native notifications are unavailable");
    const acknowledgement = parseBoundedNotificationIpc(
      notificationActionAcknowledgementSchema,
      input,
      NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES,
    );
    controller.acknowledgeAction(event.sender.id, acknowledgement);
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationState);
  ipcMain.handle(DESKTOP_CHANNELS.notificationState, (event): NotificationState => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted notification-state IPC sender");
    if (notificationSettingsController === null) {
      throw new Error("Notification settings are unavailable");
    }
    return parseBoundedNotificationIpc(
      notificationStateSchema,
      notificationSettingsController.state,
      NOTIFICATION_STATE_IPC_MAX_BYTES,
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationPreferenceSet);
  ipcMain.handle(DESKTOP_CHANNELS.notificationPreferenceSet, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-preference IPC sender");
    }
    if (notificationSettingsController === null) {
      throw new Error("Notification settings are unavailable");
    }
    const preference = parseBoundedNotificationIpc(
      notificationPreferenceSchema,
      input,
      NOTIFICATION_PREFERENCE_IPC_MAX_BYTES,
    );
    return parseBoundedNotificationIpc(
      notificationStateSchema,
      await notificationSettingsController.setPreference(preference),
      NOTIFICATION_STATE_IPC_MAX_BYTES,
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationCapabilityRefresh);
  ipcMain.handle(DESKTOP_CHANNELS.notificationCapabilityRefresh, async (event) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-capability IPC sender");
    }
    if (notificationSettingsController === null) {
      throw new Error("Notification settings are unavailable");
    }
    return parseBoundedNotificationIpc(
      notificationStateSchema,
      await notificationSettingsController.refreshCapability(),
      NOTIFICATION_STATE_IPC_MAX_BYTES,
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.notificationCaptureActivate);
  ipcMain.handle(DESKTOP_CHANNELS.notificationCaptureActivate, (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) {
      throw new Error("Untrusted notification-capture IPC sender");
    }
    if (headlessDesktopConfiguration === null || captureNotificationPresenter === null) {
      throw new Error("Notification capture activation is unavailable");
    }
    const request = parseBoundedNotificationIpc(
      notificationCaptureActivationRequestSchema,
      input,
      NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
    );
    return parseBoundedNotificationIpc(
      notificationCaptureActivationResponseSchema,
      {
        version: 1,
        activated: captureNotificationPresenter.activate(request.captureId),
      },
      NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
    );
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
    const scope = notificationScope;
    const response = await workspaceTransport.bootstrap();
    if (scope !== null) projectNotificationBootstrap(scope, response);
    return response;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMembersList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMembersList, async (event) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace members sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.members();
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

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMessageGet);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMessageGet, async (event, id: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace message sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.messageById(entityIdSchema.parse(id));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMessageSearch);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMessageSearch, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace search sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.searchMessages(messageSearchQuerySchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceTasksList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceTasksList, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace tasks sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    if (
      typeof input !== "object" ||
      input === null ||
      !("conversationId" in input) ||
      !("query" in input)
    ) {
      throw new Error("Invalid workspace task request");
    }
    return workspaceTransport.tasks(
      entityIdSchema.parse(input.conversationId),
      taskListQuerySchema.parse(input.query),
    );
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMyTasksList);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMyTasksList, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted personal tasks sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.myTasks(taskListQuerySchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceTaskCreate);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceTaskCreate, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted task creation sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.createTask(createTaskOperationSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceTaskUpdate);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceTaskUpdate, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted task update sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.updateTask(updateTaskOperationSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceTaskMove);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceTaskMove, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted task move sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.moveTask(moveTaskOperationSchema.parse(input));
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceMessageThread);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceMessageThread, async (event, input: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted workspace thread sender");
    if (workspaceTransport === null) throw new Error("Workspace transport is unavailable");
    return workspaceTransport.thread(messageThreadRequestSchema.parse(input));
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
    return workspaceTransport.createChannel(createChannelOperationSchema.parse(input));
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
    if (!shouldAdvanceReadCursor(headlessDesktopConfiguration)) {
      throw new Error("Read cursors are disabled for headless automation clients");
    }
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
    const state = chatSession?.state;
    if (state?.status !== "signed-in" || state.method !== "email") {
      throw new Error("A signed-in member session is required for realtime");
    }
    if (workspaceRealtime === null) throw new Error("Workspace realtime is unavailable");
    return workspaceRealtime.prepare({
      after: sequenceSchema.parse(after),
      userId: state.userId,
      workspaceId: state.workspaceId,
    });
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceRealtimeActivate);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceRealtimeActivate, (event, value: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime activation sender");
    if (workspaceRealtime === null) throw new Error("Workspace realtime is unavailable");
    const scope = realtimeSessionScopeSchema.parse(value);
    if (!workspaceRealtime.activate(scope)) {
      throw new Error("The realtime scope was superseded before activation");
    }
    macWindowlessRealtimeActive = false;
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceRealtimeStop);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceRealtimeStop, (event, value: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime stop sender");
    if (value !== undefined) {
      workspaceRealtime?.stop(realtimeSessionScopeSchema.parse(value));
      return;
    }
    if (macWindowlessRealtimeActive) {
      const state = chatSession?.state;
      if (state?.status === "signed-in" && state.method === "email") {
        workspaceRealtime?.enterWindowless({
          userId: state.userId,
          workspaceId: state.workspaceId,
        });
        return;
      }
      macWindowlessRealtimeActive = false;
    }
    workspaceRealtime?.stop();
  });

  ipcMain.removeHandler(DESKTOP_CHANNELS.workspaceRealtimeAcknowledge);
  ipcMain.handle(DESKTOP_CHANNELS.workspaceRealtimeAcknowledge, (event, value: unknown) => {
    if (!isTrustedIpcSender(event)) throw new Error("Untrusted realtime acknowledgement sender");
    workspaceRealtime?.acknowledge(realtimeAcknowledgementSchema.parse(value));
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
  if (compactModeController === null) {
    throw new Error("Compact mode must be initialized before creating a window");
  }
  const compactModeEnabled = compactModeController.enabled;
  const window = new BrowserWindow({
    width: headlessDesktopConfiguration?.contentWidth ?? 1_280,
    height: headlessDesktopConfiguration?.contentHeight ?? 800,
    ...(headlessDesktopConfiguration === null
      ? { minWidth: WINDOW_MIN_WIDTH, minHeight: WINDOW_MIN_HEIGHT }
      : {
          focusable: headlessDesktopConfiguration.focusable,
          useContentSize: true,
          resizable: false,
        }),
    show: false,
    backgroundColor: getThemeDefinition(themeController.state.resolvedThemeId).windowBackground,
    title: "Hype Comms",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      additionalArguments: [
        createInitialThemeStateArgument(themeController.state),
        createInitialCompactModeArgument(compactModeEnabled),
      ],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      ...(headlessDesktopConfiguration === null
        ? {}
        : {
            backgroundThrottling: !headlessDesktopConfiguration.disableBackgroundThrottling,
            focusOnNavigation: headlessDesktopConfiguration.focusOnNavigation,
            zoomFactor: headlessDesktopConfiguration.deviceScaleFactor,
          }),
    },
  });

  mainWindow = window;
  rendererReady = false;
  rendererSessionGeneration += 1;
  notificationController?.invalidateRenderer();
  const webContentsId = window.webContents.id;
  const lifecycle = new MainWindowLifecycle({
    window,
    webContentsId,
    state: {
      currentWindow: () => mainWindow,
      setCurrentWindow: (nextWindow) => {
        mainWindow = nextWindow;
      },
      setRendererReady: (ready) => {
        rendererReady = ready;
        if (!ready) workspaceRealtime?.rendererUnavailable();
      },
      advanceRendererSessionGeneration: () => {
        rendererSessionGeneration += 1;
      },
      invalidateRendererBinding: (rendererWebContentsId) => {
        notificationController?.invalidateRenderer(rendererWebContentsId);
      },
    },
  });
  applyCompactModeWindowBounds(window, compactModeEnabled);
  blockNavigation(window.webContents);

  try {
    if (shouldShowDesktopWindow(headlessDesktopConfiguration)) {
      window.once("ready-to-show", () => {
        if (mainWindow === window) window.show();
      });
    }
    window.webContents.on("did-finish-load", () => {
      lifecycle.rendererDidFinishLoad(flushPendingRendererEvents);
    });
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace || !isMainFrame) return;
      lifecycle.invalidateRenderer();
    });
    window.webContents.on("render-process-gone", () => lifecycle.invalidateRenderer());
    window.webContents.once("destroyed", () => lifecycle.invalidateRenderer());
    window.on("closed", () => {
      lifecycle.windowClosed();
    });

    // loadRenderer can reject after the BrowserWindow exists; clear the half-built window so
    // callers do not treat it as a usable main window (hidden parent for sheets, false restore).
    await loadRenderer(window);
  } catch (error) {
    lifecycle.loadFailed();
    if (!window.isDestroyed()) {
      window.destroy();
    }
    throw error;
  }

  return window;
}

function focusMainWindow(): void {
  if (!shouldFocusDesktopWindow(headlessDesktopConfiguration) || mainWindow === null) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

async function showOrRecreateMainWindow(): Promise<void> {
  await mainWindowRecreationCoordinator.run(async () => {
    const window = mainWindow;
    if (
      window === null ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isCrashed()
    ) {
      if (window !== null && !window.isDestroyed()) window.destroy();
      await createMainWindow();
      return;
    }
    focusMainWindow();
  });
}

async function handleCheckForUpdatesMenuClick(): Promise<void> {
  const controller = updateController;
  // One check and one dialog at a time: repeated clicks while a check or its dialog is pending
  // would queue stacked message-box sheets on macOS.
  if (controller === null || userUpdateCheckInFlight) {
    return;
  }
  userUpdateCheckInFlight = true;

  try {
    // Update feedback flows through the renderer, and macOS keeps the app and menu alive with no
    // windows, so the window has to be back before the check runs. Fail closed if it cannot: a
    // successful check that lands in available/downloading/ready would otherwise be silent.
    try {
      await showOrRecreateMainWindow();
    } catch (error) {
      reportMainProcessError("Failed to show the main window for an update check", error);
      // Always unparented: a partially constructed mainWindow (show: false, load failed) would
      // attach this as an invisible macOS sheet and still count as "restored" later.
      await showUpdateCheckDialog(dialogForWindowRestoreFailure(), { parentToMainWindow: false });
      return;
    }

    const content = await runUserInitiatedUpdateCheck({
      checkNow: () => controller.checkNow(),
      readState: () => controller.state,
      subscribe: (listener) => controller.subscribe(listener),
      appVersion: app.getVersion(),
    });
    if (content === null) {
      return;
    }

    await showUpdateCheckDialog(content);
  } finally {
    userUpdateCheckInFlight = false;
  }
}

async function showUpdateCheckDialog(
  content: UpdateCheckDialog,
  options: { readonly parentToMainWindow?: boolean } = {},
): Promise<void> {
  const messageBoxOptions = {
    type: content.type,
    message: content.message,
    detail: content.detail,
  };
  if (shouldParentUpdateCheckDialog(mainWindow, options) && mainWindow !== null) {
    await dialog.showMessageBox(mainWindow, messageBoxOptions);
  } else {
    await dialog.showMessageBox(messageBoxOptions);
  }
}

function scheduleAuthCallbackRetry(callback: PendingAuthCallback): boolean {
  const delay = AUTH_CALLBACK_RETRY_DELAYS_MS[callback.transientAttempts];
  if (delay === undefined) return false;
  pendingAuthCallbacks.unshift({
    value: callback.value,
    transientAttempts: callback.transientAttempts + 1,
  });
  if (authCallbackRetryTimer === null) {
    authCallbackRetryTimer = setTimeout(() => {
      authCallbackRetryTimer = null;
      void drainPendingAuthCallbacks();
    }, delay);
    authCallbackRetryTimer.unref();
  }
  return true;
}

async function drainPendingAuthCallbacks(): Promise<void> {
  if (
    !authCallbacksReady ||
    chatSession === null ||
    drainingAuthCallbacks ||
    authCallbackRetryTimer !== null
  ) {
    return;
  }

  drainingAuthCallbacks = true;
  try {
    while (pendingAuthCallbacks.length > 0) {
      const pendingCallback = pendingAuthCallbacks.shift();
      if (pendingCallback === undefined) continue;
      const parsed = parseAuthCallback(pendingCallback.value);
      if (parsed === null) continue;
      if (parsed.kind === "authkit" && authKitCancellationFenced) {
        // A fenced flow has been superseded by sign-out, magic-link authentication, or an
        // explicit restart. Retaining its callback would let stale provider state sign the user
        // back in after that newer intent once protected storage becomes available again.
        continue;
      }
      const currentSession = chatSession;
      if (parsed.kind === "magic_link") {
        const callbackIntent = advanceAuthIntent();
        try {
          await cancelPendingAuthKit();
        } catch {
          // This callback remains authoritative in the current process because its generation
          // invalidates AuthKit. Protected deletion continues in the background and is retried on
          // every restore before another provider callback can be accepted.
        }
        if (callbackIntent !== authIntentGeneration) continue;
        try {
          beginSessionReplacement();
          await currentSession.exchangeMagicLink(parsed.token);
          focusMainWindow();
        } catch {
          // ChatSession publishes the credential-preserving or terminal failure state.
        }
        continue;
      }

      const flow = authKitFlow;
      const store = authKitPendingStore;
      if (flow === null || store === null) {
        currentSession.reportAuthKitFailure();
        continue;
      }

      const callbackIntent = authKitPendingIntentGeneration;
      try {
        // Load metadata before retiring PKCE state. A temporarily locked credential store then
        // leaves the whole callback retryable instead of burning a valid one-time handoff.
        const installationId =
          "code" in parsed.callback ? await store.loadOrCreateInstallationId() : null;
        const outcome = await flow.handleCallback(parsed.callback);
        if (outcome.status === "ignored") continue;
        if (outcome.status === "expired" || outcome.status === "authentication_failed") {
          authKitPendingIntentGeneration = null;
          currentSession.reportAuthKitFailure();
          focusMainWindow();
          continue;
        }
        authKitPendingIntentGeneration = null;
        if (
          installationId === null ||
          callbackIntent === null ||
          callbackIntent !== authIntentGeneration ||
          currentSession.state.status !== "signed-out"
        ) {
          continue;
        }

        // Once enqueued, ChatSession serializes this exchange against sign-out. The generation
        // check covers a sign-out that completed while protected state was being read; a later
        // sign-out queues behind the exchange and therefore wins.
        beginSessionReplacement();
        await currentSession.exchangeAuthKitHandoff({
          code: outcome.handoff.callback.code,
          codeVerifier: outcome.handoff.codeVerifier,
          installationId,
          platform: authDevicePlatformSchema.parse(process.platform),
          appVersion: authAppVersionSchema.parse(app.getVersion()),
        });
        focusMainWindow();
      } catch (error) {
        if (
          error instanceof AuthKitProtectedStoreUnavailableError &&
          scheduleAuthCallbackRetry(pendingCallback)
        ) {
          break;
        }
        currentSession.reportAuthKitFailure();
      }
    }
  } finally {
    drainingAuthCallbacks = false;
    if (pendingAuthCallbacks.length > 0 && authCallbackRetryTimer === null) {
      void drainPendingAuthCallbacks();
    }
  }
}

function handleAuthCallback(value: string): boolean {
  const parsed = parseAuthCallback(value);
  if (parsed === null) return false;
  if (parsed.kind === "authkit" && authKitCancellationFenced) {
    // Acknowledge the owned protocol URL without retaining a callback from a superseded flow.
    return true;
  }

  pendingAuthCallbacks.push({ value, transientAttempts: 0 });
  void drainPendingAuthCallbacks();
  return true;
}

let userDataMigrationFailed = false;
if (app.isPackaged) {
  try {
    migrateLegacyUserData({
      currentPath: app.getPath("userData"),
      legacyPath: path.join(app.getPath("appData"), LEGACY_PRODUCT_NAME),
    });
  } catch (error) {
    userDataMigrationFailed = true;
    reportMainProcessError("Failed to migrate legacy HMM Chat user data", error);
  }
}

const hasSingleInstanceLock = !userDataMigrationFailed && app.requestSingleInstanceLock();

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
      compactModeController = new CompactModeController({
        persistence: new CompactModePreferenceStore({ userDataPath: app.getPath("userData") }),
      });
      notificationSettingsController = new NotificationSettingsController({
        persistence: new NotificationPreferenceStore({ userDataPath: app.getPath("userData") }),
        capability: createNotificationCapabilitySource(),
      });
      // Independent preference files; reading them sequentially would serialize disk I/O
      // on the window-show critical path.
      await Promise.all([
        themeController.initialize(),
        compactModeController.initialize(),
        notificationSettingsController.initialize(),
      ]);
      stopThemeSubscription = themeController.subscribe(deliverThemeState);
      stopCompactModeSubscription = compactModeController.subscribe(deliverCompactModeState);
      stopNotificationSettingsSubscription =
        notificationSettingsController.subscribe(deliverNotificationState);

      if (__HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED__) {
        notificationController = new NotificationController({
          presenter: createNotificationPresenter(),
          settings: notificationSettingsController,
          headless: headlessDesktopConfiguration !== null,
          getWindowState: () => {
            const window = mainWindow;
            return window === null || window.isDestroyed()
              ? null
              : {
                  focused: window.isFocused(),
                  shown: window.isVisible(),
                  minimized: window.isMinimized(),
                };
          },
          onNotificationClick: () => {
            void showOrRecreateMainWindow()
              .then(() => {
                notificationController?.deliverPendingToReadyRenderer();
              })
              .catch(() => {
                // The action remains queued for a later authorized renderer-ready drain.
                reportMainProcessError("Failed to restore the window for a notification action");
              });
          },
          onActionReady: (webContentsId, action) => {
            const window = mainWindow;
            if (
              window === null ||
              window.isDestroyed() ||
              window.webContents.id !== webContentsId
            ) {
              return false;
            }
            return sendToRenderer(DESKTOP_CHANNELS.notificationAction, action);
          },
          schedulePresentation: (operation) => {
            setImmediate(operation);
          },
          onRepairRequested: (reason) => {
            void notificationProjectionRepairCoordinator?.request(reason);
          },
        });
      }

      chatSession = new ChatSession({
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        cookies: session.defaultSession.cookies,
        request: (url, init) => net.fetch(url, init),
      });
      authKitPendingStore = new SafeStorageAuthKitPendingStore({
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        platform: process.platform,
        safeStorage,
        userDataPath: app.getPath("userData"),
      });
      authKitFlow = new AuthKitFlow({
        api: chatSession,
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        openExternal: (url) => shell.openExternal(url),
        store: authKitPendingStore,
      });
      try {
        authKitCancellationFenced = await authKitPendingStore.hasCancellationFence();
        if (authKitCancellationFenced) {
          await cancelPendingAuthKit();
        } else {
          const authKitStatus = await authKitFlow.initialize();
          authKitPendingIntentGeneration =
            authKitStatus.status === "pending" ? authIntentGeneration : null;
        }
      } catch {
        // Async safeStorage may be temporarily unavailable while the OS keyring is locked. A
        // durable cancellation fence stays fail-closed and the cleanup loop retries it without
        // preventing magic-link restore or application startup.
        reportMainProcessError("Protected AuthKit state is temporarily unavailable");
        authKitCancellationFenced = true;
        scheduleAuthKitCancellationRetry();
      }
      workspaceTransport = new WorkspaceTransport(__HYPE_COMMS_API_ORIGIN__, chatSession);
      if (notificationController !== null) {
        notificationProjectionRepairCoordinator = new NotificationProjectionRepairCoordinator({
          transport: workspaceTransport,
          target: notificationController,
          getScope: currentNotificationRepairScope,
          onFailure: reportNotificationProjectionRepairFailure,
        });
      }
      workspaceRealtime = new WorkspaceRealtime({
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        rendererOrigin: app.isPackaged ? `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}` : RENDERER_ORIGIN,
        transport: workspaceTransport,
        onEvent: deliverWorkspaceEvent,
        onWindowlessEvent: observeWindowlessWorkspaceEvent,
        onState: deliverRealtimeState,
      });
      cacheCrypto = new CacheCrypto({
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        platform: process.platform,
        safeStorage,
        userDataPath: app.getPath("userData"),
      });
      chatSession.subscribe(deliverSessionState);
      updateController = new UpdateController({
        updater: createUpdateSource(),
        isPackaged: app.isPackaged,
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        platform: process.platform,
        ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
        hasMacDeveloperIdSignature:
          !app.isPackaged || process.platform !== "darwin" || hasMacDeveloperIdSignature(),
      });
      updateController.subscribe(deliverUpdateState);
      const applicationMenu = Menu.buildFromTemplate(
        buildApplicationMenu({
          platform: process.platform,
          checkForUpdatesEnabled: isCheckForUpdatesEnabled(updateController.state),
          onCheckForUpdates: () => {
            void handleCheckForUpdatesMenuClick().catch((error: unknown) => {
              console.error("Check for Updates failed", error);
            });
          },
        }),
      );
      const checkForUpdatesItem = applicationMenu.getMenuItemById(CHECK_FOR_UPDATES_MENU_ITEM_ID);
      if (checkForUpdatesItem === null) {
        throw new Error("The application menu is missing Check for Updates");
      }
      updateController.subscribe((state) => {
        checkForUpdatesItem.enabled = isCheckForUpdatesEnabled(state);
      });
      Menu.setApplicationMenu(applicationMenu);

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
      if (restoredSession.status !== "signed-out") {
        advanceAuthIntent();
        await cancelPendingAuthKit().catch(() => {
          reportMainProcessError("Pending AuthKit authorization cancellation will be retried");
        });
      }

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
        throw new Error(
          "HYPE_COMMS_DEVELOPMENT_AUTH_CALLBACK_FILE did not contain a valid auth callback",
        );
      }
      authCallbacksReady = true;
      await drainPendingAuthCallbacks();

      app.on("activate", () => {
        void showOrRecreateMainWindow().catch((error: unknown) => {
          reportMainProcessError("Failed to recreate the main window", error);
        });
      });
    })
    .catch((error: unknown) => {
      reportMainProcessError("Failed to initialize Hype Comms", error);
      app.quit();
    });

  app.on("window-all-closed", () => {
    handleLastWindowClosed({
      platform: process.platform,
      windowlessRealtimeEnabled: __HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED__,
      continueRealtimeWithoutRenderer: () => {
        const state = chatSession?.state;
        if (state?.status !== "signed-in" || state.method !== "email") {
          macWindowlessRealtimeActive = false;
          workspaceRealtime?.stop();
          return;
        }
        macWindowlessRealtimeActive = true;
        workspaceRealtime?.enterWindowless({
          userId: state.userId,
          workspaceId: state.workspaceId,
        });
      },
      stopRealtime: () => {
        macWindowlessRealtimeActive = false;
        workspaceRealtime?.stop();
      },
      quit: () => app.quit(),
    });
  });

  app.on("before-quit", () => {
    if (authCallbackRetryTimer !== null) {
      clearTimeout(authCallbackRetryTimer);
      authCallbackRetryTimer = null;
    }
    if (authKitCancellationRetryTimer !== null) {
      clearTimeout(authKitCancellationRetryTimer);
      authKitCancellationRetryTimer = null;
    }
    authKitFlow?.dispose();
    authKitFlow = null;
    authKitPendingStore = null;
    authKitStartPromise = null;
    macWindowlessRealtimeActive = false;
    workspaceRealtime?.resetSession();
    notificationScope = null;
    notificationActiveGeneration = null;
    notificationProjectionRepairCoordinator = null;
    notificationController?.shutdown();
    notificationController = null;
    stopNotificationSettingsSubscription?.();
    stopNotificationSettingsSubscription = null;
    notificationSettingsController?.dispose();
    notificationSettingsController = null;
    headlessNotificationCaptureArtifact?.close();
    headlessNotificationCaptureArtifact = null;
    captureNotificationPresenter = null;
    updateController?.dispose();
    stopThemeSubscription?.();
    stopThemeSubscription = null;
    themeController?.dispose();
    stopCompactModeSubscription?.();
    stopCompactModeSubscription = null;
    compactModeController?.dispose();
  });
}
