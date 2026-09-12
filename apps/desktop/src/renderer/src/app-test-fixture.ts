import { afterEach, expect } from "vitest";
import type {
  AiChannelState,
  ChatSessionState,
  HumanWorkspaceBootstrapResponse,
  NotificationContext,
  NotificationState,
  RealtimeSessionScope,
  ThemeState,
} from "@hype-comms/contracts";
import type { DesktopApi } from "../../shared/desktop-api";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { ThemeRuntime } from "./theme-runtime";

type SignedInSession = Extract<ChatSessionState, { status: "signed-in"; method: "email" }>;
const unexpectedCalls: string[] = [];
const disposals: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  // A product catch handler must not turn an unexpected fixture call into a passing test.
  expect(unexpectedCalls.splice(0), "Unexpected App fixture calls").toEqual([]);
});

function unexpected(method: keyof DesktopApi): never {
  unexpectedCalls.push(method);
  throw new Error(`Unexpected App fixture call: ${method}`);
}

const themeState: ThemeState = {
  preference: "system",
  resolvedThemeId: "dark",
  resolvedColorScheme: "dark",
};

const notificationState: NotificationState = {
  version: 1,
  devicePreference: "enabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "granted",
};

const aiState: AiChannelState = {
  version: 1,
  generation: 1,
  status: "configured",
  workspaceName: "hype-comms",
  entries: [],
  plan: [],
  permissionRequest: null,
  error: null,
};

/** Common App startup behavior. Each feature supplies only the operations its scenario exercises. */
export function createAppClient(options: {
  readonly session: SignedInSession;
  readonly bootstrap: () => HumanWorkspaceBootstrapResponse;
  readonly overrides?: Partial<DesktopApi>;
}): DesktopApi {
  const { session, bootstrap } = options;
  let realtimeStarts = 0;
  const notificationContext: NotificationContext = {
    version: 1,
    status: "active",
    sessionGeneration: 1,
    rendererSessionGeneration: 1,
    userId: session.userId,
    workspaceId: session.workspaceId,
  };
  return {
    // Required methods without a common implementation are listed explicitly below. Adding a
    // desktop method fails typechecking until its fixture policy is chosen.
    platform: "linux",
    isHeadless: true,
    getServerStatus: async () => "reachable",
    getSessionState: async () => session,
    retrySession: async () => session,
    onSessionChanged: () => () => undefined,
    signOut: async () => ({ status: "signed-out" }),
    getAppVersion: async () => "0.1.37-test",
    getUpdateState: async () => ({ status: "idle" }),
    onUpdateStateChanged: () => () => undefined,
    initializeCacheCrypto: async () => ({
      mode: "memory_only",
      scope: { userId: session.userId, workspaceId: session.workspaceId },
      reason: "credential_store_unavailable",
    }),
    resetCacheCrypto: async () => undefined,
    getWorkspaceBootstrap: async () => bootstrap(),
    listWorkspaceMembers: async () => ({ members: bootstrap().members }),
    getConversationMessages: async () => ({
      attachments: [],
      reactions: [],
      snapshotPosition: bootstrap().syncCursor,
      messages: [],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    }),
    listMessageReactions: async () => ({ reactions: [] }),
    listMessageAttachments: async () => ({ attachments: [] }),
    syncWorkspace: async (after) => ({
      status: "accepted",
      response: { events: [], nextCursor: after, highWaterCursor: after, hasMore: false },
    }),
    startWorkspaceRealtime: async (): Promise<RealtimeSessionScope> => ({
      userId: session.userId,
      workspaceId: session.workspaceId,
      epoch: ++realtimeStarts,
    }),
    activateWorkspaceRealtime: async () => undefined,
    stopWorkspaceRealtime: async () => undefined,
    acknowledgeWorkspaceEvent: async () => undefined,
    getRealtimeState: async () => "offline",
    onRealtimeStateChanged: () => () => undefined,
    onWorkspaceEvent: () => () => undefined,
    setWorkspaceTyping: async () => undefined,
    onWorkspaceActivity: () => () => undefined,
    getNotificationContext: async () => notificationContext,
    reportNotificationActivity: async () => undefined,
    drainNotificationActions: async (ready) => ({ ...ready, actions: [] }),
    acknowledgeNotificationAction: async () => undefined,
    onNotificationAction: () => () => undefined,
    getNotificationState: async () => notificationState,
    setNotificationPreference: () => unexpected("setNotificationPreference"),
    refreshNotificationCapability: async () => notificationState,
    onNotificationStateChanged: () => () => undefined,
    getAiChannelState: async () => aiState,
    onAiChannelStateChanged: () => () => undefined,
    initialThemeState: themeState,
    getThemeState: async () => themeState,
    getSystemThemeState: async () => themeState,
    onThemeStateChanged: () => () => undefined,
    initialCompactMode: false,
    getCompactMode: async () => false,
    onCompactModeChanged: () => () => undefined,
    initialDevicePreferences: DEFAULT_DEVICE_PREFERENCES,
    getDevicePreferences: async () => DEFAULT_DEVICE_PREFERENCES,
    onDevicePreferencesChanged: () => () => undefined,
    checkForUpdates: () => unexpected("checkForUpdates"),
    restartToInstallUpdate: () => unexpected("restartToInstallUpdate"),
    encryptCacheRecords: () => unexpected("encryptCacheRecords"),
    decryptCacheRecords: () => unexpected("decryptCacheRecords"),
    getCommunicationPaths: () => unexpected("getCommunicationPaths"),
    listAgentEnrollments: () => unexpected("listAgentEnrollments"),
    reviewAgentEnrollment: () => unexpected("reviewAgentEnrollment"),
    cancelAgentEnrollment: () => unexpected("cancelAgentEnrollment"),
    updateProfile: () => unexpected("updateProfile"),
    listConversations: () => unexpected("listConversations"),
    getMessageById: () => unexpected("getMessageById"),
    retractMessage: () => unexpected("retractMessage"),
    getMessageThread: () => unexpected("getMessageThread"),
    addMessageReaction: () => unexpected("addMessageReaction"),
    removeMessageReaction: () => unexpected("removeMessageReaction"),
    searchMessages: () => unexpected("searchMessages"),
    listConversationFiles: () => unexpected("listConversationFiles"),
    chooseAndUploadConversationFiles: () => unexpected("chooseAndUploadConversationFiles"),
    openConversationFile: () => unexpected("openConversationFile"),
    listConversationTasks: () => unexpected("listConversationTasks"),
    listMyTasks: () => unexpected("listMyTasks"),
    createTask: () => unexpected("createTask"),
    updateTask: () => unexpected("updateTask"),
    moveTask: () => unexpected("moveTask"),
    sendConversationMessage: () => unexpected("sendConversationMessage"),
    createChannel: () => unexpected("createChannel"),
    archiveChannel: () => unexpected("archiveChannel"),
    getChannelMembers: () => unexpected("getChannelMembers"),
    upsertChannelMember: () => unexpected("upsertChannelMember"),
    removeChannelMember: () => unexpected("removeChannelMember"),
    createDirectConversation: () => unexpected("createDirectConversation"),
    advanceReadCursor: () => unexpected("advanceReadCursor"),
    requestMagicLink: () => unexpected("requestMagicLink"),
    setThemePreference: () => unexpected("setThemePreference"),
    setThemeDesign: () => unexpected("setThemeDesign"),
    setCompactMode: () => unexpected("setCompactMode"),
    updateDevicePreferences: () => unexpected("updateDevicePreferences"),
    startAiChannel: () => unexpected("startAiChannel"),
    chooseAiChannelWorkspace: () => unexpected("chooseAiChannelWorkspace"),
    newAiChannelSession: () => unexpected("newAiChannelSession"),
    sendAiChannelPrompt: () => unexpected("sendAiChannelPrompt"),
    cancelAiChannelPrompt: () => unexpected("cancelAiChannelPrompt"),
    respondAiChannelPermission: () => unexpected("respondAiChannelPermission"),
    ...options.overrides,
  };
}

/** Use actual observable runtimes, so preferences tests need no private-class casts. */
export function createAppRuntimes(client: DesktopApi) {
  const theme = new ThemeRuntime(client, document.documentElement);
  const compactMode = new CompactModeRuntime(client, document.documentElement);
  const sidebarPosition = new SidebarPositionRuntime(document.documentElement, null);
  const fencedBlockquotes = new FencedBlockquoteRuntime(null);
  disposals.push(() => {
    theme.dispose();
    compactMode.dispose();
    sidebarPosition.dispose();
  });
  return { theme, compactMode, sidebarPosition, fencedBlockquotes };
}
