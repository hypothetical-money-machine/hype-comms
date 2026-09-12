import { spawnSync } from "node:child_process";
import { realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseBoundedIpcPayload } from "../shared/ipc-invoke";
import type { DesktopInvokeHandlers } from "../shared/ipc-invoke-contract";
import { registerDesktopInitialValues } from "./ipc-initial-values";
import { registerDesktopInvokes } from "./ipc-registrar";
import { createWorkspaceInvokeHandlers } from "./workspace-ipc-handlers";

import {
  AI_CHANNEL_STATE_IPC_MAX_BYTES,
  DEVICE_PREFERENCES_IPC_MAX_BYTES,
  aiChannelStateSchema,
  authAppVersionSchema,
  authDevicePlatformSchema,
  devicePreferencesSchema,
  notificationContextSchema,
  type AiChannelState,
  type ChatSessionState,
  type DevicePreferences,
  type HumanWorkspaceBootstrapResponse,
  type NotificationContext,
  type NotificationState,
  type ProductRealtimeEvent,
  type ProtocolHandlerState,
  type ScopedEphemeralActivityFrame,
  type ScopedProductRealtimeEvent,
  type ThemeState,
  type UpdateState,
} from "@hype-comms/contracts";
import type { Event, IpcMainInvokeEvent, OpenDialogOptions, Session, WebContents } from "electron";
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";

import { createServerHealthUrl } from "../shared/api-origin";
import { assertCurrentUploadScope } from "../shared/attachment-upload";
import { DESKTOP_CHANNELS } from "../shared/channels";
import { createInitialCompactModeArgument } from "../shared/compact-mode";
import {
  AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE,
  type RealtimeConnectionState,
  type ServerStatus,
} from "../shared/desktop-api";
import { createInitialDevicePreferencesArgument } from "../shared/device-preferences";
import { normalizeExternalMailtoUrl } from "../shared/external-mailto";
import { createInitialThemeStateArgument, getThemeDefinition } from "../shared/theme";
import { AiChannelController } from "./ai-channel-controller";
import { AiChannelPreferenceStore } from "./ai-channel-preference-store";
import { resolveApplicationIconPath } from "./application-icon";
import { configureApplicationIdentity, shouldMigrateLegacyProfile } from "./application-identity";
import { CHECK_FOR_UPDATES_MENU_ITEM_ID, buildApplicationMenu } from "./application-menu";
import {
  attachmentUploadDialogOptions,
  uploadSelectedConversationFiles,
} from "./attachment-upload";
import { parseAuthCallback } from "./auth-callback";
import { AuthenticatedSessionContextStore } from "./authenticated-session-context-store";
import { AuthKitFlow } from "./authkit-flow";
import {
  AuthKitProtectedStoreCorruptError,
  AuthKitProtectedStoreUnavailableError,
  SafeStorageAuthKitPendingStore,
} from "./authkit-pending-store";
import { CacheCrypto, cacheScopeForSession, scopesEqual } from "./cache-crypto";
import { ChatSession, ChatSessionError, INVALID_MAGIC_LINK_MESSAGE } from "./chat-session";
import { createClaudeAiAgentHost } from "./claude-ai-agent-host";
import { CompactModeController } from "./compact-mode-controller";
import { CompactModePreferenceStore } from "./compact-mode-preference-store";
import {
  DeepLinkSignInQueue,
  routeOpenUrlMagicLink,
  routeSecondInstanceMagicLink,
} from "./deep-link-sign-in";
import {
  callbackForSignedOutSession,
  consumeDevelopmentAuthCallbackFile,
  resolveDevelopmentAuthCallbackFile,
  resolveDevelopmentProfile,
  resolveDevelopmentUserDataPath,
} from "./development-profile";
import { DevicePreferencesController } from "./device-preferences-controller";
import { DevicePreferencesStore } from "./device-preferences-store";
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
import {
  createLinuxProtocolRegistrationTarget,
  installAndQueryLinuxProtocolHandler,
} from "./linux-protocol-registration";
import {
  resolveMacosNativeNotificationEvidenceConfiguration,
  startMacosNativeNotificationEvidence,
  type MacosNativeNotificationEvidenceSession,
} from "./macos-native-notification-evidence";
import {
  createMacosNotificationAuthorization,
  requestAuthorizationForPersistedEnabledPreference,
  setNotificationPreferenceWithAuthorization,
  type MacosNotificationAuthorization,
} from "./macos-notification-authorization";
import {
  protectMainProcessLogStreams,
  reportMainProcessError,
  reportMainProcessEvent,
} from "./main-process-log";
import { MainWindowLifecycle, MainWindowRecreationCoordinator } from "./main-window-recreation";
import { NotificationController } from "./notification-controller";
import { NotificationPreferenceStore } from "./notification-preference-store";
import {
  CaptureNotificationPresenter,
  ElectronNotificationCapabilitySource,
  ElectronNotificationPresenter,
  NoopNotificationPresenter,
  type NotificationPresenter,
} from "./notification-presenter";
import {
  NotificationProjectionRepairCoordinator,
  type NotificationProjectionRepairFailure,
} from "./notification-projection-repair";
import {
  NotificationSettingsController,
  type NotificationCapabilitySource,
} from "./notification-settings-controller";
import {
  PendingNotificationAuthorizationBarrier,
  settlePendingNotificationAuthorization,
} from "./pending-notification-authorization-barrier";
import { PresenceController } from "./presence-controller";
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
import { authCapabilitiesForSession } from "./session-auth-lifecycle";
import { ThemeController } from "./theme-controller";
import { ThemePreferenceStore } from "./theme-preference-store";
import { UpdateController, type UpdateSource, type UpdateSourceConfiguration } from "./updater";
import { LEGACY_PRODUCT_NAME, migrateLegacyUserData } from "./user-data-migration";
import {
  dialogForWindowRestoreFailure,
  isCheckForUpdatesEnabled,
  runUserInitiatedUpdateCheck,
  shouldParentUpdateCheckDialog,
  type UpdateCheckDialog,
} from "./user-update-check";
import {
  BeforeQuitCoordinator,
  FinalQuitCoordinator,
  handleLastWindowClosed,
} from "./window-lifecycle";
import { WorkspaceRealtime, createRealtimeEpochAllocator } from "./workspace-realtime";
import { DesktopSessionLifecycle } from "./desktop-session-lifecycle";
import { scopedWorkspaceSession } from "./scoped-workspace-session";
import { openWorkspaceAttachment } from "./open-workspace-attachment";
import { suspendLocalAi } from "./suspend-local-ai";
import { startDesktopSession } from "./start-desktop-session";
import { WorkspaceSessionOwner, type OwnedWorkspaceSession } from "./workspace-session-owner";
import { WorkspaceTransport } from "./workspace-transport";
const RENDERER_ORIGIN = "http://127.0.0.1:5173";
const WINDOW_MIN_HEIGHT = 640;
const WINDOW_MIN_WIDTH = 960;
/**
 * Compact mode hides the workspace rail and sidebar, so the window may shrink further.
 * Mirrored by the `html[data-compact] body` min-width in renderer styles.css.
 */
const COMPACT_WINDOW_MIN_WIDTH = 640;
const IS_PRODUCTION_BUILD = __HYPE_COMMS_BUILD_FLAVOR__ === "production";

configureApplicationIdentity(app, process.platform, {
  appId: __HYPE_COMMS_APPLICATION_ID__,
  desktopName: __HYPE_COMMS_DESKTOP_NAME__,
  isProductionBuild: IS_PRODUCTION_BUILD,
  productName: __HYPE_COMMS_PRODUCT_NAME__,
});
const applicationIconPath = resolveApplicationIconPath({
  appPath: app.getAppPath(),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
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
let protocolHandlerState: ProtocolHandlerState = {
  scheme: __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__,
  binding: "unknown",
};
let protocolHandlerProbe: Promise<ProtocolHandlerState> | null = null;

/**
 * On Linux the xdg database, not Electron, decides whether hype-comms:// URLs reach this app.
 * electron-builder only stamps MimeType onto an uninstalled `.desktop` inside the AppImage, so this
 * writes a user-level entry and claims `xdg-mime default`. `$APPIMAGE` is the durable Exec when the
 * runtime set it; an extracted packaged binary is used when that path is not a FUSE mount. The deb
 * already installs its entry, so that path only verifies. The result feeds the sign-in card so a
 * missing handler warns before AuthKit strands the user in the browser (issue #75).
 */
async function probeLinuxProtocolHandler(): Promise<ProtocolHandlerState> {
  if (process.platform !== "linux" || !app.isPackaged) {
    return protocolHandlerState;
  }
  const { binding } = await installAndQueryLinuxProtocolHandler(
    {
      scheme: __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__,
      installedDesktopName: __HYPE_COMMS_DESKTOP_NAME__,
      productName: __HYPE_COMMS_PRODUCT_NAME__,
      appImagePath: process.env.APPIMAGE,
      packagedExecutablePath: process.execPath,
      appDir: process.env.APPDIR,
      homeDirectory: homedir(),
      xdgDataHome: process.env.XDG_DATA_HOME,
    },
    createLinuxProtocolRegistrationTarget(),
    {
      onInvalidPath: () => {
        reportMainProcessError("The AppImage path cannot be written to a desktop entry");
      },
      onRegisterError: (error) => {
        reportMainProcessError("Could not self-register the AppImage protocol handler", error);
      },
    },
  );
  protocolHandlerState = { ...protocolHandlerState, binding };
  return protocolHandlerState;
}
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
const deepLinkSignInQueue = new DeepLinkSignInQueue({
  confirm: confirmDeepLinkSignIn,
  exchange: async (token) => {
    const callbackIntent = advanceAuthIntent();
    try {
      await cancelPendingAuthKit();
    } catch {
      // This callback remains authoritative in the current process because its generation
      // invalidates AuthKit. Protected deletion continues in the background and is retried on
      // every restore before another provider callback can be accepted.
    }
    if (callbackIntent !== authIntentGeneration) return "failed";
    const currentSession = chatSession;
    if (currentSession === null) return "failed";
    try {
      await replaceDesktopAuthentication(async () => {
        if (callbackIntent !== authIntentGeneration)
          throw new Error("Authentication was superseded");
        return currentSession.exchangeMagicLink(token);
      });
      focusMainWindow();
      return "succeeded";
    } catch (error) {
      if (error instanceof ChatSessionError && error.message === INVALID_MAGIC_LINK_MESSAGE) {
        return "invalid";
      }
      throw error;
    }
  },
  onInvalidLink: showInvalidDeepLinkSignIn,
});
const developmentProfile = app.isPackaged ? "" : resolveDevelopmentProfile(process.env);
const macosNativeNotificationEvidenceConfiguration =
  resolveMacosNativeNotificationEvidenceConfiguration({
    compiledIn: __HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED__,
    isPackaged: app.isPackaged,
    platform: process.platform,
    argv: process.argv,
    env: process.env,
  });
const macosNotificationAuthorization: MacosNotificationAuthorization | null =
  createMacosNotificationAuthorization({
    compiledIn: __HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED__,
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
  });
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
  macosNativeNotificationEvidenceConfiguration?.userDataPath ??
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
interface WorkspaceResources {
  readonly transport: WorkspaceTransport;
  readonly realtime: WorkspaceRealtime;
  readonly notificationRepair: NotificationProjectionRepairCoordinator | null;
}
let workspaceSessions: WorkspaceSessionOwner<WorkspaceResources> | null = null;
let desktopSessionLifecycle: DesktopSessionLifecycle<WorkspaceResources> | null = null;
const nextRealtimeEpoch = createRealtimeEpochAllocator();
function currentWorkspaceSession(): OwnedWorkspaceSession<WorkspaceResources> {
  const current = workspaceSessions?.current;
  if (current == null) throw new Error("Workspace transport is unavailable");
  current.assertActive();
  return current;
}
function currentWorkspaceRealtime(): WorkspaceRealtime | null {
  return workspaceSessions?.current?.resources.realtime ?? null;
}
function currentNotificationRepair(): NotificationProjectionRepairCoordinator | null {
  return workspaceSessions?.current?.resources.notificationRepair ?? null;
}
let macWindowlessRealtimeActive = false;
let cacheCrypto: CacheCrypto | null = null;
let realtimeState: RealtimeConnectionState = "offline";
let updateController: UpdateController | null = null;
let themeController: ThemeController | null = null;
let stopThemeSubscription: (() => void) | null = null;
let userUpdateCheckInFlight = false;
let compactModeController: CompactModeController | null = null;
let stopCompactModeSubscription: (() => void) | null = null;
let devicePreferencesController: DevicePreferencesController | null = null;
let stopDevicePreferencesSubscription: (() => void) | null = null;
let aiChannelController: AiChannelController | null = null;
let stopAiChannelSubscription: (() => void) | null = null;
let notificationSettingsController: NotificationSettingsController | null = null;
let stopNotificationSettingsSubscription: (() => void) | null = null;
let pendingNotificationAuthorizationBarrier: PendingNotificationAuthorizationBarrier | null = null;
let notificationController: NotificationController | null = null;
let captureNotificationPresenter: CaptureNotificationPresenter | null = null;
let headlessNotificationCaptureArtifact: HeadlessNotificationCaptureArtifact | null = null;
let notificationSessionGeneration = 0;
let notificationScope: {
  readonly sessionGeneration: number;
  readonly userId: string;
  readonly workspaceId: string;
} | null = null;
let notificationActiveGeneration: number | null = null;
let macosNativeNotificationEvidenceSession: MacosNativeNotificationEvidenceSession | null = null;

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
  if (macosNotificationAuthorization !== null) return macosNotificationAuthorization;
  if (app.isPackaged && process.platform === "darwin") {
    // A compiled-in packaged Mac must use the identity-aware addon. Falling through to Electron
    // after an addon load failure would advertise support while bypassing the required preflight.
    return {
      read: () => ({ nativeSupport: "unsupported", osPermission: "unknown" }),
    };
  }
  return new ElectronNotificationCapabilitySource(Notification);
}

function createNotificationPresenter(): NotificationPresenter {
  if (headlessDesktopConfiguration === null) {
    return new ElectronNotificationPresenter(Notification, applicationIconPath);
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

function boundedAiChannelState(value: unknown): AiChannelState {
  return parseBoundedIpcPayload(aiChannelStateSchema, value, AI_CHANNEL_STATE_IPC_MAX_BYTES);
}

function deliverAiChannelState(state: AiChannelState): void {
  sendToRenderer(DESKTOP_CHANNELS.aiChannelChanged, boundedAiChannelState(state));
}

function suspendAiChannel(controller = aiChannelController): Promise<void> {
  return suspendLocalAi(controller, () =>
    reportMainProcessError("Failed to suspend the local AI Channel"),
  );
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

function deliverWorkspaceActivity(frame: ScopedEphemeralActivityFrame): boolean {
  return sendToRenderer(DESKTOP_CHANNELS.workspaceActivity, frame);
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

function attachmentUploadScopeKey(state: ChatSessionState): string | null {
  if (state.status === "signed-in") return `${state.userId}:${state.workspaceId}`;
  if (state.status === "session-unavailable" && state.lastAuthenticatedSession !== undefined) {
    const { userId, workspaceId } = state.lastAuthenticatedSession;
    return `${userId}:${workspaceId}`;
  }
  return null;
}

function replaceDesktopAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  const lifecycle = desktopSessionLifecycle;
  if (lifecycle === null) throw new Error("Desktop session is unavailable");
  // Offline Claude can run without an online transport. Retire that work before changing cookies.
  const localSuspension = workspaceSessions?.current == null ? suspendAiChannel() : undefined;
  const replacement = lifecycle.replaceAuthentication(async (assertCurrent) => {
    await localSuspension;
    assertCurrent();
    return operation();
  });
  void localSuspension?.catch(() => undefined);
  macWindowlessRealtimeActive = false;
  notificationScope = null;
  notificationActiveGeneration = null;
  notificationController?.markReplacing();
  return replacement;
}

function runLocalSessionOperation<T>(
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  if (desktopSessionLifecycle === null) throw new Error("Desktop session is unavailable");
  return desktopSessionLifecycle.run(operation);
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
    const repairCoordinator = currentNotificationRepair();
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

function deliverDevicePreferences(preferences: DevicePreferences): void {
  sendToRenderer(
    DESKTOP_CHANNELS.devicePreferencesChanged,
    parseBoundedIpcPayload(devicePreferencesSchema, preferences, DEVICE_PREFERENCES_IPC_MAX_BYTES),
  );
}

function flushPendingRendererEvents(): void {
  if (desktopSessionLifecycle?.publishedState != null) {
    sendToRenderer(DESKTOP_CHANNELS.sessionChanged, desktopSessionLifecycle.publishedState);
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
  if (devicePreferencesController !== null) {
    deliverDevicePreferences(devicePreferencesController.state);
  }
  if (notificationSettingsController !== null) {
    sendToRenderer(DESKTOP_CHANNELS.notificationStateChanged, notificationSettingsController.state);
  }
}

function safelyOpenExternal(url: string): void {
  const safeUrl = normalizeExternalHttpsUrl(url) ?? normalizeExternalMailtoUrl(url);
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

let disposeIpcInitialValues: (() => void) | null = null;
let disposeIpcInvokes: (() => void) | null = null;

function registerIpcHandlers(): void {
  disposeIpcInvokes?.();
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
  disposeIpcInitialValues = registerDesktopInitialValues(ipcMain, () => ({
    automationHeadless: headlessDesktopConfiguration !== null,
  }));

  const handlers: DesktopInvokeHandlers = {
    ...createWorkspaceInvokeHandlers((operation) =>
      currentWorkspaceSession().run(({ transport }) => operation(transport)),
    ),
    appVersion: () => {
      return app.getVersion();
    },
    serverStatus: async (): Promise<ServerStatus> => {
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
    },
    protocolHandlerState: async () => {
      if (protocolHandlerProbe === null) {
        return protocolHandlerState;
      }
      // A failed probe keeps the stored "unknown" state: never warn on a probe that could not run.
      return protocolHandlerProbe.catch(() => protocolHandlerState);
    },
    updateState: (): UpdateState => {
      return updateController?.state ?? { status: "unsupported" };
    },
    updateCheck: async (): Promise<void> => {
      await updateController?.checkNow();
    },
    updateInstall: (): void => {
      updateController?.quitAndInstall();
    },
    themeState: (): ThemeState => {
      if (themeController === null) {
        throw new Error("Appearance is unavailable");
      }
      return themeController.state;
    },
    themeSystemState: async (): Promise<ThemeState> => {
      if (themeController === null) {
        throw new Error("Appearance is unavailable");
      }
      try {
        return await themeController.resolveSystemState();
      } catch (error) {
        throw new Error("Could not resolve the system appearance", { cause: error });
      }
    },
    themeSet: async (_context, preference) => {
      if (themeController === null) {
        throw new Error("Appearance is unavailable");
      }

      try {
        return await themeController.setPreference(preference);
      } catch (error) {
        throw new Error("Could not save the appearance preference", { cause: error });
      }
    },
    themeDesignSet: async (_context, design) => {
      if (themeController === null) {
        throw new Error("Appearance is unavailable");
      }

      try {
        return await themeController.setDesign(design);
      } catch (error) {
        throw new Error("Could not save the theme design", { cause: error });
      }
    },
    compactModeState: (): boolean => {
      if (compactModeController === null) {
        throw new Error("Compact mode is unavailable");
      }
      return compactModeController.enabled;
    },
    compactModeSet: async (_context, preference) => {
      if (compactModeController === null) {
        throw new Error("Compact mode is unavailable");
      }

      try {
        return await compactModeController.setEnabled(preference);
      } catch (error) {
        throw new Error("Could not save the compact mode preference", { cause: error });
      }
    },
    devicePreferencesState: (): DevicePreferences => {
      if (devicePreferencesController === null) {
        throw new Error("Device preferences are unavailable");
      }
      return devicePreferencesController.state;
    },
    devicePreferencesUpdate: async (_context, value) => {
      if (devicePreferencesController === null) {
        throw new Error("Device preferences are unavailable");
      }
      const patch = value;
      try {
        return await devicePreferencesController.update(patch);
      } catch (error) {
        throw new Error("Could not save the device preferences", { cause: error });
      }
    },
    aiChannelState: (): AiChannelState => {
      if (aiChannelController === null) {
        throw new Error("AI Channel is unavailable");
      }
      return aiChannelController.state;
    },
    aiChannelStart: async (_context, value) => {
      const controller = aiChannelController;
      if (controller === null) throw new Error("AI Channel is unavailable");
      const request = value;
      return runLocalSessionOperation(() => controller.start(request));
    },
    aiChannelWorkspaceChoose: async () => {
      const controller = aiChannelController;
      if (controller === null) throw new Error("AI Channel is unavailable");
      return runLocalSessionOperation(async (assertCurrent) => {
        const window = mainWindow;
        const options: OpenDialogOptions = {
          title: "Choose a folder for AI Channel",
          buttonLabel: "Use this folder",
          properties: ["openDirectory"],
        };
        const selection =
          window === null || window.isDestroyed()
            ? await dialog.showOpenDialog(options)
            : await dialog.showOpenDialog(window, options);
        assertCurrent();
        const selectedPath = selection.filePaths[0];
        if (selection.canceled || selection.filePaths.length !== 1 || selectedPath === undefined) {
          return controller.state;
        }
        try {
          const workspacePath = await realpath(selectedPath);
          if (!(await stat(workspacePath)).isDirectory()) {
            throw new Error("Not a directory");
          }
          assertCurrent();
          return await controller.chooseWorkspace(workspacePath);
        } catch {
          throw new Error("The selected AI Channel folder is unavailable");
        }
      });
    },
    aiChannelSessionNew: async (_context, value) => {
      const controller = aiChannelController;
      if (controller === null) throw new Error("AI Channel is unavailable");
      const request = value;
      return runLocalSessionOperation(() => controller.newSession(request));
    },
    aiChannelPromptSend: async (_context, value) => {
      const controller = aiChannelController;
      if (controller === null) throw new Error("AI Channel is unavailable");
      const request = value;
      return runLocalSessionOperation(() => controller.sendPrompt(request));
    },
    aiChannelPromptCancel: async (_context, value) => {
      const controller = aiChannelController;
      if (controller === null) throw new Error("AI Channel is unavailable");
      const request = value;
      return runLocalSessionOperation(() => controller.cancelPrompt(request));
    },
    aiChannelPermissionRespond: async (_context, value) => {
      const controller = aiChannelController;
      if (controller === null) throw new Error("AI Channel is unavailable");
      const request = value;
      return runLocalSessionOperation(() => controller.respondPermission(request));
    },
    sessionState: async (): Promise<ChatSessionState> => {
      return (await desktopSessionLifecycle?.readState()) ?? { status: "signed-out" };
    },
    sessionRetry: async (): Promise<ChatSessionState> => {
      if (chatSession === null) throw new Error("Chat is not configured");
      await chatSession.restore();
      return (await desktopSessionLifecycle?.readState()) ?? chatSession.state;
    },
    sessionAuthCapabilities: async () => {
      if (chatSession === null) {
        throw new Error("Chat is not configured");
      }

      const capabilities = authCapabilitiesForSession(
        await chatSession.getAuthCapabilities(),
        { chatSession, authKitFlow, authKitPendingStore },
        authKitCancellationFenced,
      );
      const pendingStore = authKitPendingStore;
      if (!capabilities.authKit || pendingStore === null) return capabilities;
      try {
        await pendingStore.assertAvailable();
        // A final quit teardown can run while protected storage is being checked. If a later
        // will-quit listener cancels that quit, never publish a capability captured before teardown.
        return authCapabilitiesForSession(
          capabilities,
          { chatSession, authKitFlow, authKitPendingStore },
          authKitCancellationFenced,
        );
      } catch {
        return { ...capabilities, authKit: false };
      }
    },
    sessionStartAuthKit: async (): Promise<void> => {
      if (chatSession === null || authKitFlow === null || authKitPendingStore === null) {
        throw new Error(AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE);
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
          reportMainProcessError("AuthKit authorization could not be started", error);
          // Only .message survives IPC serialization, so surface curated ChatSessionError text (it
          // carries the net::ERR_* diagnostic); internal errors keep the generic message.
          throw new Error(
            error instanceof ChatSessionError ? error.message : "Could not start WorkOS sign-in",
            { cause: error },
          );
        }
      })();
      authKitStartPromise = start;
      try {
        await start;
      } finally {
        if (authKitStartPromise === start) authKitStartPromise = null;
      }
    },
    sessionSignOut: async () => {
      const signOutIntent = advanceAuthIntent();
      let cancellationFailed = false;
      try {
        await cancelPendingAuthKit();
      } catch {
        cancellationFailed = true;
        reportMainProcessError("Pending AuthKit authorization cancellation will be retried");
      }

      if (signOutIntent !== authIntentGeneration) throw new Error("Authentication was superseded");
      await replaceDesktopAuthentication(async () => {
        if (signOutIntent !== authIntentGeneration)
          throw new Error("Authentication was superseded");
        return chatSession?.signOut();
      });
      const state = (await desktopSessionLifecycle?.readState()) ?? {
        status: "signed-out" as const,
      };
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
    },
    notificationContext: (context): NotificationContext => {
      const controller = notificationController;
      const scope = notificationScope;
      if (
        controller === null ||
        scope === null ||
        notificationActiveGeneration !== scope.sessionGeneration
      ) {
        return inactiveNotificationContext();
      }
      return controller.bindRenderer(context.senderId, rendererSessionGeneration);
    },
    notificationActivityUpdate: (context, input): void => {
      const controller = notificationController;
      if (controller === null) throw new Error("Native notifications are unavailable");
      const activity = input;
      if (!controller.updateActivity(context.senderId, activity)) {
        throw new Error("Notification activity does not match the active renderer");
      }
    },
    notificationActionsDrain: (context, input) => {
      const controller = notificationController;
      if (controller === null) throw new Error("Native notifications are unavailable");
      const request = input;
      return controller.rendererReadyAndDrain(context.senderId, request);
    },
    notificationActionAcknowledge: (context, input): void => {
      const controller = notificationController;
      if (controller === null) throw new Error("Native notifications are unavailable");
      const acknowledgement = input;
      controller.acknowledgeAction(context.senderId, acknowledgement);
    },
    notificationState: (): NotificationState => {
      if (notificationSettingsController === null) {
        throw new Error("Notification settings are unavailable");
      }
      return notificationSettingsController.state;
    },
    notificationPreferenceSet: async (_context, input) => {
      if (notificationSettingsController === null) {
        throw new Error("Notification settings are unavailable");
      }
      const controller = notificationSettingsController;
      const preference = input;
      return await setNotificationPreferenceWithAuthorization({
        authorization: macosNotificationAuthorization,
        current: controller.state,
        preference,
        refreshCapability: () => controller.refreshCapability(),
        setPreference: (next) => controller.setPreference(next),
      });
    },
    notificationCapabilityRefresh: async () => {
      if (notificationSettingsController === null) {
        throw new Error("Notification settings are unavailable");
      }
      return await notificationSettingsController.refreshCapability();
    },
    notificationCaptureActivate: (_context, input) => {
      if (headlessDesktopConfiguration === null || captureNotificationPresenter === null) {
        throw new Error("Notification capture activation is unavailable");
      }
      const request = input;
      return {
        version: 1,
        activated: captureNotificationPresenter.activate(request.captureId),
      };
    },
    sessionRequestMagicLink: async (_context, request) => {
      if (chatSession === null) {
        throw new Error("Chat is not configured");
      }

      try {
        return await chatSession.requestMagicLink(request);
      } catch (error) {
        throw new Error(
          error instanceof ChatSessionError ? error.message : "Could not request a sign-in link",
          { cause: error },
        );
      }
    },
    cacheCryptoInitialize: async () => {
      if (cacheCrypto === null) throw new Error("Cache encryption is unavailable");
      const scope = cacheScopeForSession(chatSession?.cacheAuthorizationState ?? null);
      if (scope === null) throw new Error("Cache access requires a credential-bound session");
      return cacheCrypto.initialize(scope);
    },
    cacheCryptoEncrypt: (_context, input) => {
      if (cacheCrypto === null) throw new Error("Cache encryption is unavailable");
      const scope = cacheScopeForSession(chatSession?.cacheAuthorizationState ?? null);
      const activeScope = cacheCrypto.activeScope;
      if (scope === null || activeScope === null || !scopesEqual(scope, activeScope)) {
        throw new Error("Cache access requires a credential-bound session");
      }
      return cacheCrypto.encrypt(input);
    },
    cacheCryptoDecrypt: (_context, input) => {
      if (cacheCrypto === null) throw new Error("Cache encryption is unavailable");
      const scope = cacheScopeForSession(chatSession?.cacheAuthorizationState ?? null);
      const activeScope = cacheCrypto.activeScope;
      if (scope === null || activeScope === null || !scopesEqual(scope, activeScope)) {
        throw new Error("Cache access requires a credential-bound session");
      }
      return cacheCrypto.decrypt(input);
    },
    cacheCryptoReset: async () => {
      if (cacheCrypto === null) return;
      const scope = cacheScopeForSession(chatSession?.cacheAuthorizationState ?? null);
      const activeScope = cacheCrypto.activeScope;
      if (scope === null || activeScope === null || !scopesEqual(scope, activeScope)) {
        throw new Error("Cache access requires a credential-bound session");
      }
      await cacheCrypto.clear();
    },
    workspaceBootstrap: async () => {
      const lifetime = currentWorkspaceSession();
      const scope = notificationScope;
      const response = await lifetime.run(({ transport }) => transport.bootstrap());
      lifetime.assertActive();
      if (scope !== null) projectNotificationBootstrap(scope, response);
      return response;
    },

    workspaceFileUpload: async (_context, input) => {
      const lifetime = currentWorkspaceSession();
      const { transport } = lifetime.resources;
      const session = chatSession;
      if (session === null || session.state.status !== "signed-in") {
        throw new Error("A signed-in workspace session is required to attach files");
      }
      const sessionState = session.state;
      const uploadScope = attachmentUploadScopeKey(sessionState);
      const uploadAuthIntentGeneration = authIntentGeneration;
      const isCurrentUploadScope = (): boolean =>
        chatSession === session &&
        !lifetime.signal.aborted &&
        authIntentGeneration === uploadAuthIntentGeneration &&
        attachmentUploadScopeKey(session.state) === uploadScope;
      const request = input;
      const window = mainWindow;
      const selection =
        window === null || window.isDestroyed()
          ? await dialog.showOpenDialog(attachmentUploadDialogOptions)
          : await dialog.showOpenDialog(window, attachmentUploadDialogOptions);
      return lifetime.run(() =>
        uploadSelectedConversationFiles(
          selection,
          request,
          (conversationId, filePath) =>
            transport.uploadLocalFile(conversationId, filePath, () =>
              assertCurrentUploadScope(isCurrentUploadScope),
            ),
          isCurrentUploadScope,
        ),
      );
    },
    workspaceFileOpen: (_context, attachmentId) =>
      openWorkspaceAttachment(currentWorkspaceSession(), attachmentId, {
        destination: (id, name) => path.join(tmpdir(), `hype-comms-${id}-${name}`),
        write: (destination, bytes) => writeFile(destination, bytes),
        open: (destination) => shell.openPath(destination),
      }),

    workspaceReadAdvance: async (_context, input) => {
      if (!shouldAdvanceReadCursor(headlessDesktopConfiguration)) {
        throw new Error("Read cursors are disabled for headless automation clients");
      }
      return currentWorkspaceSession().run(({ transport }) =>
        transport.advanceRead(input.conversationId, input.lastReadMessageId),
      );
    },

    workspaceRealtimeStart: (_context, after) => {
      const state = chatSession?.state;
      if (state?.status !== "signed-in" || state.method !== "email") {
        throw new Error("A signed-in member session is required for realtime");
      }
      const { realtime } = currentWorkspaceSession().resources;
      return realtime.prepare({
        after: after,
        userId: state.userId,
        workspaceId: state.workspaceId,
      });
    },
    workspaceRealtimeActivate: (_context, value) => {
      const { realtime } = currentWorkspaceSession().resources;
      const scope = value;
      if (!realtime.activate(scope)) {
        throw new Error("The realtime scope was superseded before activation");
      }
      macWindowlessRealtimeActive = false;
    },
    workspaceRealtimeStop: (_context, value) => {
      if (value !== undefined) {
        currentWorkspaceRealtime()?.stop(value);
        return;
      }
      if (macWindowlessRealtimeActive) {
        const state = chatSession?.state;
        if (state?.status === "signed-in" && state.method === "email") {
          currentWorkspaceRealtime()?.enterWindowless({
            userId: state.userId,
            workspaceId: state.workspaceId,
          });
          return;
        }
        macWindowlessRealtimeActive = false;
      }
      currentWorkspaceRealtime()?.stop();
    },
    workspaceRealtimeAcknowledge: (_context, value) => {
      currentWorkspaceRealtime()?.acknowledge(value);
    },
    workspaceActivityTypingSet: (_context, value) => {
      currentWorkspaceRealtime()?.setTyping(value);
    },
    realtimeStateGet: () => {
      return realtimeState;
    },
  };
  disposeIpcInvokes = registerDesktopInvokes(
    ipcMain,
    (event: IpcMainInvokeEvent) =>
      isTrustedIpcSender(event) ? { senderId: event.sender.id } : null,
    handlers,
  );
}

const DEVELOPMENT_RENDERER_LOAD_RETRIES = 30;
const DEVELOPMENT_RENDERER_LOAD_RETRY_DELAY_MS = 1_000;

function isDevelopmentRendererConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("ERR_CONNECTION_REFUSED") ||
      error.message.includes("ERR_CONNECTION_RESET") ||
      error.message.includes("ERR_ADDRESS_UNREACHABLE"))
  );
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    const developmentUrl = normalizeDevelopmentServerUrl(process.env.ELECTRON_RENDERER_URL ?? "");
    if (developmentUrl === null) {
      throw new Error("Electron renderer development URL is missing or untrusted");
    }

    trustedDevelopmentRendererUrl = developmentUrl;
    for (let attempt = 0; attempt <= DEVELOPMENT_RENDERER_LOAD_RETRIES; attempt += 1) {
      try {
        await window.loadURL(developmentUrl);
        return;
      } catch (error) {
        if (
          attempt < DEVELOPMENT_RENDERER_LOAD_RETRIES &&
          isDevelopmentRendererConnectionError(error)
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, DEVELOPMENT_RENDERER_LOAD_RETRY_DELAY_MS),
          );
          continue;
        }
        throw error;
      }
    }
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
  if (devicePreferencesController === null) {
    throw new Error("Device preferences must be initialized before creating a window");
  }
  const compactModeEnabled = compactModeController.enabled;
  const devicePreferences = devicePreferencesController.state;
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
    title: __HYPE_COMMS_PRODUCT_NAME__,
    icon: applicationIconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      additionalArguments: [
        createInitialThemeStateArgument(themeController.state),
        createInitialCompactModeArgument(compactModeEnabled),
        createInitialDevicePreferencesArgument(devicePreferences),
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
        if (!ready) {
          currentWorkspaceRealtime()?.rendererUnavailable();
          suspendAiChannel();
        }
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

/** Native prompt seam injected into DeepLinkSignInQueue; it intentionally receives no token. */
async function confirmDeepLinkSignIn(): Promise<boolean> {
  if (headlessDesktopConfiguration !== null) {
    // A hidden automation renderer has no person to prompt; the caller opted into headless mode
    // from an isolated, unpackaged development profile and supplied the auth callback explicitly.
    return true;
  }

  const options = {
    type: "question" as const,
    buttons: ["Cancel", "Sign in"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Sign in from a link?",
    detail: "Continue to sign in to Hype Comms? This will replace any active session.",
  };
  const window = mainWindow;
  const result =
    window === null || window.isDestroyed()
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options);
  return result.response === 1;
}

async function showInvalidDeepLinkSignIn(): Promise<void> {
  const options = {
    type: "error" as const,
    message: "Sign-in link invalid",
    detail: "Request a new sign-in link and try again.",
  };
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    await dialog.showMessageBox(options);
  } else {
    await dialog.showMessageBox(window, options);
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
      const parsed = parseAuthCallback(pendingCallback.value, __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__);
      if (parsed === null) continue;
      if (parsed.kind === "authkit" && authKitCancellationFenced) {
        // A fenced flow has been superseded by sign-out, magic-link authentication, or an
        // explicit restart. Retaining its callback would let stale provider state sign the user
        // back in after that newer intent once protected storage becomes available again.
        continue;
      }
      const currentSession = chatSession;
      if (parsed.kind === "magic_link") {
        deepLinkSignInQueue.enqueue(parsed.token);
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

        if (!(await confirmDeepLinkSignIn()) || callbackIntent !== authIntentGeneration) continue;

        // Once enqueued, ChatSession serializes this exchange against sign-out. The generation
        // check covers a sign-out that completed while protected state was being read; a later
        // sign-out queues behind the exchange and therefore wins.
        await replaceDesktopAuthentication(async () => {
          if (callbackIntent !== authIntentGeneration)
            throw new Error("Authentication was superseded");
          return currentSession.exchangeAuthKitHandoff({
            code: outcome.handoff.callback.code,
            codeVerifier: outcome.handoff.codeVerifier,
            installationId,
            platform: authDevicePlatformSchema.parse(process.platform),
            appVersion: authAppVersionSchema.parse(app.getVersion()),
          });
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
  if (routeOpenUrlMagicLink(value, __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__, deepLinkSignInQueue)) {
    return true;
  }
  const parsed = parseAuthCallback(value, __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__);
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
if (
  shouldMigrateLegacyProfile({
    isPackaged: app.isPackaged,
    isProductionBuild: IS_PRODUCTION_BUILD,
    isNativeNotificationEvidence: macosNativeNotificationEvidenceConfiguration !== null,
  })
) {
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
    if (
      routeSecondInstanceMagicLink(
        commandLine,
        __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__,
        deepLinkSignInQueue,
      )
    ) {
      return;
    }
    const callbackUrl = findAuthCallbackUrl(commandLine, __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__);
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
      if (process.platform === "darwin") app.dock?.setIcon(applicationIconPath);
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
      devicePreferencesController = new DevicePreferencesController({
        persistence: new DevicePreferencesStore({ userDataPath: app.getPath("userData") }),
        reportListenerError: () => {
          reportMainProcessError("Device preferences listener failed");
        },
      });
      aiChannelController = new AiChannelController({
        preferenceStore: new AiChannelPreferenceStore({ userDataPath: app.getPath("userData") }),
        hostFactory: createClaudeAiAgentHost,
        hostPresentation: { displayName: "Claude Code", executableName: "claude" },
        reportListenerError: () => {
          reportMainProcessError("AI Channel state listener failed");
        },
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
        devicePreferencesController.initialize(),
        aiChannelController.initialize().catch(() => {
          reportMainProcessError("Failed to restore the local AI Channel preference");
          return aiChannelController?.state;
        }),
        notificationSettingsController.initialize(),
      ]);
      const initializedNotificationSettings = notificationSettingsController;
      stopThemeSubscription = themeController.subscribe(deliverThemeState);
      stopCompactModeSubscription = compactModeController.subscribe(deliverCompactModeState);
      stopDevicePreferencesSubscription =
        devicePreferencesController.subscribe(deliverDevicePreferences);
      stopAiChannelSubscription = aiChannelController.subscribe(deliverAiChannelState);
      stopNotificationSettingsSubscription =
        notificationSettingsController.subscribe(deliverNotificationState);

      const notificationAuthorizationBarrier = new PendingNotificationAuthorizationBarrier({
        source: notificationSettingsController,
        authorizationPending:
          macosNotificationAuthorization !== null &&
          initializedNotificationSettings.state.devicePreference === "enabled" &&
          initializedNotificationSettings.state.nativeSupport === "supported" &&
          initializedNotificationSettings.state.osPermission === "unknown",
      });

      pendingNotificationAuthorizationBarrier = notificationAuthorizationBarrier;

      if (__HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED__) {
        notificationController = new NotificationController({
          presenter: createNotificationPresenter(),
          settings: pendingNotificationAuthorizationBarrier,
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
            void currentNotificationRepair()?.request(reason);
          },
        });
      }

      chatSession = new ChatSession({
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        authVariant: __HYPE_COMMS_BUILD_FLAVOR__,
        cookies: session.defaultSession.cookies,
        request: (url, init) => net.fetch(url, init),
        contexts: new AuthenticatedSessionContextStore({
          apiOrigin: __HYPE_COMMS_API_ORIGIN__,
          platform: process.platform,
          safeStorage,
          userDataPath: app.getPath("userData"),
        }),
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
        authVariant: __HYPE_COMMS_BUILD_FLAVOR__,
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
      const sessionClient = chatSession;
      workspaceSessions = new WorkspaceSessionOwner((lifetime) => {
        const localAiChannel = aiChannelController;
        lifetime.onDispose(() => suspendAiChannel(localAiChannel));
        lifetime.onDispose(() => {
          macWindowlessRealtimeActive = false;
          notificationScope = null;
          notificationActiveGeneration = null;
          notificationController?.markReplacing();
        });
        const transport = new WorkspaceTransport(
          __HYPE_COMMS_API_ORIGIN__,
          scopedWorkspaceSession(sessionClient, lifetime),
        );
        const notificationRepair =
          notificationController === null
            ? null
            : new NotificationProjectionRepairCoordinator({
                transport,
                target: notificationController,
                getScope: () => (lifetime.signal.aborted ? null : currentNotificationRepairScope()),
                onFailure: reportNotificationProjectionRepairFailure,
              });
        const realtime = new WorkspaceRealtime({
          apiOrigin: __HYPE_COMMS_API_ORIGIN__,
          rendererOrigin: app.isPackaged
            ? `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}`
            : RENDERER_ORIGIN,
          transport,
          nextSessionEpoch: nextRealtimeEpoch,
          onEvent: (frame) => !lifetime.signal.aborted && deliverWorkspaceEvent(frame),
          onActivity: (frame) => !lifetime.signal.aborted && deliverWorkspaceActivity(frame),
          onWindowlessEvent: (event) => {
            if (!lifetime.signal.aborted) observeWindowlessWorkspaceEvent(event);
          },
          onState: (state) => {
            if (!lifetime.signal.aborted) deliverRealtimeState(state);
          },
        });
        lifetime.onDispose(() => {
          realtime.resetSession();
          deliverRealtimeState("offline");
        });
        const presence = new PresenceController({
          getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
          publish: (state) => realtime.setPresence(state),
        });
        lifetime.onDispose(() => presence.stop());
        const handleSuspend = (): void => presence.suspend();
        const handleResume = (): void => presence.resume();
        lifetime.onDispose(() => {
          powerMonitor.removeListener("suspend", handleSuspend);
          powerMonitor.removeListener("resume", handleResume);
        });
        powerMonitor.on("suspend", handleSuspend);
        powerMonitor.on("resume", handleResume);
        presence.start();
        return { transport, realtime, notificationRepair };
      });
      cacheCrypto = new CacheCrypto({
        apiOrigin: __HYPE_COMMS_API_ORIGIN__,
        platform: process.platform,
        safeStorage,
        userDataPath: app.getPath("userData"),
      });
      desktopSessionLifecycle = new DesktopSessionLifecycle({
        source: chatSession,
        sessions: workspaceSessions,
        publish: deliverSessionState,
        reportFailure: () => reportMainProcessError("Desktop session transition failed"),
      });
      updateController = new UpdateController({
        updater: createUpdateSource(),
        isProductionBuild: IS_PRODUCTION_BUILD,
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

      if (macosNativeNotificationEvidenceConfiguration === null) {
        const protocolRegistration = createProtocolClientRegistration(
          app.isPackaged,
          process.execPath,
          process.argv,
          __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__,
        );
        const registered =
          protocolRegistration.executablePath === undefined ||
          protocolRegistration.arguments === undefined
            ? app.setAsDefaultProtocolClient(protocolRegistration.scheme)
            : app.setAsDefaultProtocolClient(
                protocolRegistration.scheme,
                protocolRegistration.executablePath,
                [...protocolRegistration.arguments],
              );
        if (!registered) {
          // Log only: on Linux the xdg probe below is the authoritative binding signal.
          reportMainProcessError("Electron could not register the auth protocol handler");
        }
        // Fire-and-forget so a slow xdg toolchain never delays window creation; the IPC handler
        // awaits this same promise.
        protocolHandlerProbe = probeLinuxProtocolHandler();
        protocolHandlerProbe.catch((error: unknown) => {
          reportMainProcessError("The protocol-handler probe failed", error);
        });
      }

      const restoredSession = await startDesktopSession({
        showWindow: createMainWindow,
        authorizeNotifications: () =>
          settlePendingNotificationAuthorization({
            barrier: notificationAuthorizationBarrier,
            request: () =>
              requestAuthorizationForPersistedEnabledPreference({
                authorization: macosNotificationAuthorization,
                current: initializedNotificationSettings.state,
                refreshCapability: () => initializedNotificationSettings.refreshCapability(),
              }),
            onFailure: (error) => {
              reportMainProcessError("Failed to request persisted notification permission", error);
            },
          }),
        reportAuthorizationFailure: () =>
          reportMainProcessError("Failed to request persisted notification permission"),
        beforeRestore: async () => {
          if (macosNativeNotificationEvidenceConfiguration !== null) {
            mainWindow?.hide();
            app.hide();
            macosNativeNotificationEvidenceSession = await startMacosNativeNotificationEvidence({
              configuration: macosNativeNotificationEvidenceConfiguration,
              presenter: new ElectronNotificationPresenter(Notification, applicationIconPath),
              requestAuthorization: async () => {
                if (macosNotificationAuthorization === null) return "unknown";
                return macosNotificationAuthorization.request();
              },
              getHistory: () => Notification.getHistory(),
              onClick: async () => {
                app.show();
                await showOrRecreateMainWindow();
                const window = mainWindow;
                if (window === null || window.isDestroyed()) {
                  throw new Error("Native notification evidence could not restore the main window");
                }
                void dialog.showMessageBox(window, {
                  type: "info",
                  message: "Native notification click received",
                  detail:
                    "Hype Comms restored its installed window through the native notification callback.",
                  buttons: ["Done"],
                });
              },
            });
            void macosNativeNotificationEvidenceSession.delivery.catch((error: unknown) => {
              reportMainProcessError("Native notification evidence delivery failed", error);
            });
          }
        },
        restore: async () => {
          await sessionClient.restore();
          if (desktopSessionLifecycle === null) throw new Error("Desktop session is unavailable");
          return desktopSessionLifecycle.readState();
        },
      });
      if (restoredSession.status !== "signed-out") {
        advanceAuthIntent();
        await cancelPendingAuthKit().catch(() => {
          reportMainProcessError("Pending AuthKit authorization cancellation will be retried");
        });
      }

      const initialCallbackUrl = findAuthCallbackUrl(
        process.argv,
        __HYPE_COMMS_AUTH_PROTOCOL_SCHEME__,
      );
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
      await deepLinkSignInQueue.markReady();
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
          currentWorkspaceRealtime()?.stop();
          return;
        }
        macWindowlessRealtimeActive = true;
        currentWorkspaceRealtime()?.enterWindowless({
          userId: state.userId,
          workspaceId: state.workspaceId,
        });
      },
      stopRealtime: () => {
        macWindowlessRealtimeActive = false;
        currentWorkspaceRealtime()?.stop();
      },
      quit: () => app.quit(),
    });
  });

  let sessionDisposal: Promise<void> | undefined;
  let quittingAiChannel: AiChannelController | null = null;
  const beforeQuitCoordinator = new BeforeQuitCoordinator({
    cleanup: () => {
      sessionDisposal = desktopSessionLifecycle?.dispose();
      void sessionDisposal?.catch(() => undefined);
      quittingAiChannel = aiChannelController;
      aiChannelController = null;
    },
    teardown: async () => {
      const localAiChannel = quittingAiChannel;
      quittingAiChannel = null;
      try {
        await sessionDisposal;
      } finally {
        await localAiChannel?.dispose();
      }
    },
    reportCleanupFailure: () => {
      reportMainProcessError("Failed to prepare application cleanup before quitting");
    },
    reportTeardownFailure: () => {
      reportMainProcessError("Failed to stop privileged local services");
    },
    quit: () => app.quit(),
  });
  app.on("before-quit", (event) => {
    beforeQuitCoordinator.handle(event);
  });

  const finalQuitCoordinator = new FinalQuitCoordinator({
    teardownSession: () => {
      macosNativeNotificationEvidenceSession?.handle.close();
      macosNativeNotificationEvidenceSession = null;
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
    },
    cleanup: () => {
      disposeIpcInvokes?.();
      disposeIpcInvokes = null;
      disposeIpcInitialValues?.();
      disposeIpcInitialValues = null;
      macWindowlessRealtimeActive = false;
      notificationScope = null;
      notificationActiveGeneration = null;
      notificationController?.shutdown();
      notificationController = null;
      pendingNotificationAuthorizationBarrier?.dispose();
      pendingNotificationAuthorizationBarrier = null;
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
      stopDevicePreferencesSubscription?.();
      stopDevicePreferencesSubscription = null;
      devicePreferencesController?.dispose();
      devicePreferencesController = null;
      stopAiChannelSubscription?.();
      stopAiChannelSubscription = null;
    },
    reportSessionTeardown: () => {
      reportMainProcessEvent("session_teardown", { trigger: "will-quit" });
    },
    reportCleanupFailure: () => {
      reportMainProcessError("Failed to complete final application cleanup");
    },
    reportQuitCancelledAfterTeardown: () => {
      reportMainProcessEvent("quit_cancelled_after_session_teardown", {
        trigger: "will-quit",
      });
    },
    scheduleQuitCancellationCheck: (check) => {
      setImmediate(check).unref();
    },
  });
  app.on("will-quit", (event) => {
    finalQuitCoordinator.handle(event);
  });
}
