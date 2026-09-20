import {
  AI_CHANNEL_STATE_IPC_MAX_BYTES,
  DEVICE_PREFERENCES_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_IPC_MAX_BYTES,
  NOTIFICATION_STATE_IPC_MAX_BYTES,
  aiChannelStateSchema,
  chatSessionStateSchema,
  compactModePreferenceSchema,
  devicePreferencesSchema,
  notificationActionSchema,
  notificationStateSchema,
  realtimeConnectionStateSchema,
  scopedEphemeralActivityFrameSchema,
  scopedProductRealtimeEventSchema,
  updateStateSchema,
  type AiChannelGenerationRequest,
  type AiChannelPermissionResponse,
  type AiChannelPromptRequest,
  type AiChannelState,
  type CacheDecryptBatchRequest,
  type CacheEncryptBatchRequest,
  type ChatSessionState,
  type ConversationFilesQuery,
  type CreateChannelOperation,
  type CreateTaskOperation,
  type DevicePreferences,
  type DevicePreferencesPatch,
  type DirectConversationRequest,
  type ListConversationsQuery,
  type MessageSearchQuery,
  type MoveTaskOperation,
  type NotificationAction,
  type NotificationActionAcknowledgement,
  type NotificationActionDrainRequest,
  type NotificationActivityUpdate,
  type NotificationPreference,
  type NotificationState,
  type ReactionEmoji,
  type RealtimeAcknowledgement,
  type RealtimeSessionScope,
  type ReviewAgentEnrollmentRequest,
  type ScopedEphemeralActivityFrame,
  type ScopedProductRealtimeEvent,
  type ScopedTypingActivityUpdate,
  type SendMessageOperation,
  type TaskListQuery,
  type ThemeDesign,
  type ThemePreference,
  type ThemeState,
  type UpdateState,
  type UpdateTaskOperation,
  type User,
} from "@hype-comms/contracts";
import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";
import { readDesktopInitialValues } from "../shared/ipc-initial-values";
import {
  createDesktopInvoker,
  parseBoundedIpcPayload,
  type IpcPayloadSchema,
} from "../shared/ipc-invoke";

import { DESKTOP_CHANNELS, type DesktopPushChannel } from "../shared/channels";
import { resolveInitialCompactModeArgument } from "../shared/compact-mode";
import type {
  DesktopApi,
  DesktopPlatform,
  NotificationCaptureTransport,
  NotificationTransport,
  RealtimeConnectionState,
} from "../shared/desktop-api";
import { resolveInitialDevicePreferencesArgument } from "../shared/device-preferences";
import { isBuiltInThemeState, resolveInitialThemeStateArgument } from "../shared/theme";

function subscribe<T>(
  channel: DesktopPushChannel,
  listener: (value: T) => void,
  validate: (value: unknown) => value is T,
): () => void {
  const wrappedListener = (_event: IpcRendererEvent, value: unknown): void => {
    if (validate(value)) {
      listener(value);
    }
  };

  ipcRenderer.on(channel, wrappedListener);
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

function subscribeToBoundedIpcPayload<T>(
  channel: DesktopPushChannel,
  schema: IpcPayloadSchema<T>,
  maxBytes: number,
  listener: (value: T) => void,
): () => void {
  const wrappedListener = (_event: IpcRendererEvent, value: unknown): void => {
    try {
      listener(parseBoundedIpcPayload(schema, value, maxBytes));
    } catch {
      // Invalid or oversized main-to-renderer pushes fail closed at the preload boundary.
    }
  };

  ipcRenderer.on(channel, wrappedListener);
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

const platform = process.platform;
if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
  throw new Error(`Unsupported desktop platform: ${platform}`);
}
const initialThemeState = resolveInitialThemeStateArgument(process.argv);
const isHeadless = readDesktopInitialValues(ipcRenderer).automationHeadless;
const initialCompactMode = resolveInitialCompactModeArgument(process.argv);
const initialDevicePreferences = resolveInitialDevicePreferencesArgument(process.argv);

const invokeDesktop = createDesktopInvoker(ipcRenderer);

const desktopApi: DesktopApi & NotificationTransport & NotificationCaptureTransport = Object.freeze(
  {
    platform: platform as DesktopPlatform,
    isHeadless,
    initialThemeState,
    initialCompactMode,
    initialDevicePreferences,
    getAppVersion: () => invokeDesktop("appVersion"),
    getUpdateState: async () => invokeDesktop("updateState"),
    checkForUpdates: async () => {
      await invokeDesktop("updateCheck");
    },
    restartToInstallUpdate: async () => {
      await invokeDesktop("updateInstall");
    },
    onUpdateStateChanged: (listener: (state: UpdateState) => void) =>
      subscribe(
        DESKTOP_CHANNELS.updateChanged,
        listener,
        (value): value is UpdateState => updateStateSchema.safeParse(value).success,
      ),
    getThemeState: async () => invokeDesktop("themeState"),
    getSystemThemeState: () => invokeDesktop("themeSystemState"),
    setThemePreference: async (preference: ThemePreference) =>
      invokeDesktop("themeSet", preference),
    setThemeDesign: async (design: ThemeDesign) => invokeDesktop("themeDesignSet", design),
    onThemeStateChanged: (listener: (state: ThemeState) => void) =>
      subscribe(DESKTOP_CHANNELS.themeChanged, listener, isBuiltInThemeState),
    getCompactMode: async () => invokeDesktop("compactModeState"),
    setCompactMode: async (enabled: boolean) => invokeDesktop("compactModeSet", enabled),
    onCompactModeChanged: (listener: (enabled: boolean) => void) =>
      subscribe(
        DESKTOP_CHANNELS.compactModeChanged,
        listener,
        (value): value is boolean => compactModePreferenceSchema.safeParse(value).success,
      ),
    getDevicePreferences: async () => invokeDesktop("devicePreferencesState"),
    updateDevicePreferences: async (patch: DevicePreferencesPatch) => {
      return invokeDesktop("devicePreferencesUpdate", patch);
    },
    onDevicePreferencesChanged: (listener: (preferences: DevicePreferences) => void) =>
      subscribeToBoundedIpcPayload(
        DESKTOP_CHANNELS.devicePreferencesChanged,
        devicePreferencesSchema,
        DEVICE_PREFERENCES_IPC_MAX_BYTES,
        listener,
      ),
    getAiChannelState: async () => invokeDesktop("aiChannelState"),
    startAiChannel: async (input: AiChannelGenerationRequest) =>
      invokeDesktop("aiChannelStart", input),
    chooseAiChannelWorkspace: async () => invokeDesktop("aiChannelWorkspaceChoose"),
    newAiChannelSession: async (input: AiChannelGenerationRequest) =>
      invokeDesktop("aiChannelSessionNew", input),
    sendAiChannelPrompt: async (input: AiChannelPromptRequest) =>
      invokeDesktop("aiChannelPromptSend", input),
    cancelAiChannelPrompt: async (input: AiChannelGenerationRequest) =>
      invokeDesktop("aiChannelPromptCancel", input),
    respondAiChannelPermission: async (input: AiChannelPermissionResponse) =>
      invokeDesktop("aiChannelPermissionRespond", input),
    onAiChannelStateChanged: (listener: (state: AiChannelState) => void) =>
      subscribeToBoundedIpcPayload(
        DESKTOP_CHANNELS.aiChannelChanged,
        aiChannelStateSchema,
        AI_CHANNEL_STATE_IPC_MAX_BYTES,
        listener,
      ),
    getServerStatus: () => invokeDesktop("serverStatus"),
    getProtocolHandlerState: async () => invokeDesktop("protocolHandlerState"),
    getSessionState: async () => invokeDesktop("sessionState"),
    retrySession: async () => invokeDesktop("sessionRetry"),
    getAuthCapabilities: async () => invokeDesktop("sessionAuthCapabilities"),
    startAuthKitSignIn: () => invokeDesktop("sessionStartAuthKit"),
    requestMagicLink: async (email: string) => {
      const request = { email };
      return await invokeDesktop("sessionRequestMagicLink", request);
    },
    signOut: async () => invokeDesktop("sessionSignOut"),
    onSessionChanged: (listener: (state: ChatSessionState) => void) =>
      subscribe(
        DESKTOP_CHANNELS.sessionChanged,
        listener,
        (value): value is ChatSessionState => chatSessionStateSchema.safeParse(value).success,
      ),
    getNotificationContext: async () => invokeDesktop("notificationContext"),
    reportNotificationActivity: (activity: NotificationActivityUpdate) =>
      invokeDesktop("notificationActivityUpdate", activity),
    drainNotificationActions: async (ready: NotificationActionDrainRequest) => {
      return invokeDesktop("notificationActionsDrain", ready);
    },
    acknowledgeNotificationAction: (acknowledgement: NotificationActionAcknowledgement) =>
      invokeDesktop("notificationActionAcknowledge", acknowledgement),
    onNotificationAction: (listener: (action: NotificationAction) => void) =>
      subscribeToBoundedIpcPayload(
        DESKTOP_CHANNELS.notificationAction,
        notificationActionSchema,
        NOTIFICATION_ACTION_IPC_MAX_BYTES,
        listener,
      ),
    getNotificationState: async () => invokeDesktop("notificationState"),
    setNotificationPreference: async (preference: NotificationPreference) => {
      return invokeDesktop("notificationPreferenceSet", preference);
    },
    refreshNotificationCapability: async () => invokeDesktop("notificationCapabilityRefresh"),
    onNotificationStateChanged: (listener: (state: NotificationState) => void) =>
      subscribeToBoundedIpcPayload(
        DESKTOP_CHANNELS.notificationStateChanged,
        notificationStateSchema,
        NOTIFICATION_STATE_IPC_MAX_BYTES,
        listener,
      ),
    activateCapturedNotification: async (captureId: string) => {
      if (!isHeadless) {
        throw new Error("Captured notification activation is available only in headless mode");
      }
      const request = { version: 1 as const, captureId };
      const response = await invokeDesktop("notificationCaptureActivate", request);
      return response.activated;
    },
    initializeCacheCrypto: async () => invokeDesktop("cacheCryptoInitialize"),
    encryptCacheRecords: async (input: CacheEncryptBatchRequest) =>
      invokeDesktop("cacheCryptoEncrypt", input),
    decryptCacheRecords: async (input: CacheDecryptBatchRequest) =>
      invokeDesktop("cacheCryptoDecrypt", input),
    resetCacheCrypto: async () => {
      await invokeDesktop("cacheCryptoReset");
    },
    getWorkspaceBootstrap: async () => invokeDesktop("workspaceBootstrap"),
    listWorkspaceMembers: async () => invokeDesktop("workspaceMembersList"),
    getCommunicationPaths: async () => invokeDesktop("workspaceAdminCommunicationPaths"),
    listAgentEnrollments: async () => invokeDesktop("workspaceAgentEnrollmentsList"),
    reviewAgentEnrollment: async (
      enrollmentId: string,
      decision: ReviewAgentEnrollmentRequest["decision"],
    ) => {
      return invokeDesktop("workspaceAgentEnrollmentReview", enrollmentId, decision);
    },
    cancelAgentEnrollment: async (enrollmentId: string) =>
      invokeDesktop("workspaceAgentEnrollmentCancel", enrollmentId),
    updateProfile: async (title: string | null): Promise<User> =>
      (await invokeDesktop("workspaceProfileUpdate", title)).user,
    listConversations: async (input: Partial<ListConversationsQuery> = {}) =>
      invokeDesktop("workspaceConversationsList", input),
    getConversationMessages: async (input: {
      readonly conversationId: string;
      readonly before?: string;
      readonly limit?: number;
    }) => invokeDesktop("workspaceMessagesList", input),
    getMessageById: async (messageId: string) => invokeDesktop("workspaceMessageGet", messageId),
    retractMessage: async (messageId: string) =>
      invokeDesktop("workspaceMessageRetract", messageId),
    getMessageThread: async (input: {
      readonly messageId: string;
      readonly before?: string;
      readonly limit?: number;
    }) => {
      return invokeDesktop("workspaceMessageThread", input);
    },
    listMessageReactions: async (messageIds: readonly string[]) => {
      const request = { messageIds: [...messageIds] };
      return await invokeDesktop("workspaceReactionsList", request);
    },
    addMessageReaction: async (messageId: string, emoji: ReactionEmoji) => {
      const target = { messageId, emoji };
      return await invokeDesktop("workspaceReactionAdd", target);
    },
    removeMessageReaction: async (messageId: string, emoji: ReactionEmoji) => {
      const target = { messageId, emoji };
      return await invokeDesktop("workspaceReactionRemove", target);
    },
    searchMessages: async (input: MessageSearchQuery) =>
      invokeDesktop("workspaceMessageSearch", input),
    listConversationFiles: async (
      conversationId: string,
      input: Partial<ConversationFilesQuery> = {},
    ) =>
      invokeDesktop("workspaceConversationFilesList", {
        conversationId,
        query: input,
      }),
    listMessageAttachments: async (messageIds: readonly string[]) => {
      const request = { messageIds: [...messageIds] };
      return await invokeDesktop("workspaceAttachmentsList", request);
    },
    chooseAndUploadConversationFiles: async (conversationId: string, maxFiles: number) => {
      const request = { conversationId, maxFiles };
      const result = await invokeDesktop("workspaceFileUpload", request);
      if (
        (result.status === "completed" || result.status === "partial") &&
        result.attachments.length > request.maxFiles
      ) {
        throw new Error("File upload result exceeded the requested limit");
      }
      return result;
    },
    openConversationFile: async (attachmentId: string) =>
      invokeDesktop("workspaceFileOpen", attachmentId),
    listConversationTasks: async (conversationId: string, input: Partial<TaskListQuery> = {}) =>
      invokeDesktop("workspaceTasksList", {
        conversationId,
        query: input,
      }),
    listMyTasks: async (input: Partial<TaskListQuery> = {}) =>
      invokeDesktop("workspaceMyTasksList", input),
    createTask: async (input: CreateTaskOperation) => invokeDesktop("workspaceTaskCreate", input),
    updateTask: async (input: UpdateTaskOperation) => invokeDesktop("workspaceTaskUpdate", input),
    moveTask: async (input: MoveTaskOperation) => invokeDesktop("workspaceTaskMove", input),
    sendConversationMessage: async (input: SendMessageOperation) =>
      invokeDesktop("workspaceMessageSend", input),
    createChannel: async (input: CreateChannelOperation) =>
      invokeDesktop("workspaceChannelCreate", input),
    archiveChannel: async (conversationId: string) =>
      invokeDesktop("workspaceChannelArchive", conversationId),
    getChannelMembers: async (conversationId: string) =>
      invokeDesktop("workspaceChannelMembersList", conversationId),
    upsertChannelMember: async (
      conversationId: string,
      userId: string,
      role: "owner" | "member",
    ) => {
      const operation = {
        conversationId,
        userId,
        ...{ role },
      };
      return await invokeDesktop("workspaceChannelMemberUpsert", operation);
    },
    removeChannelMember: async (conversationId: string, userId: string) => {
      const target = {
        conversationId,
        userId,
      };
      return await invokeDesktop("workspaceChannelMemberRemove", target);
    },
    createDirectConversation: async (input: DirectConversationRequest) =>
      invokeDesktop("workspaceDirectCreate", input),
    advanceReadCursor: async (conversationId: string, lastReadMessageId: string) => {
      if (isHeadless) {
        throw new Error("Read cursors are disabled for headless automation clients");
      }
      return await invokeDesktop("workspaceReadAdvance", {
        conversationId,
        lastReadMessageId,
      });
    },
    syncWorkspace: async (after: string) => invokeDesktop("workspaceSync", after),
    startWorkspaceRealtime: async (after: string): Promise<RealtimeSessionScope> =>
      invokeDesktop("workspaceRealtimeStart", after),
    activateWorkspaceRealtime: async (scope: RealtimeSessionScope) => {
      await invokeDesktop("workspaceRealtimeActivate", scope);
    },
    stopWorkspaceRealtime: async (scope?: RealtimeSessionScope) => {
      await invokeDesktop("workspaceRealtimeStop", scope === undefined ? undefined : scope);
    },
    acknowledgeWorkspaceEvent: async (input: RealtimeAcknowledgement) => {
      await invokeDesktop("workspaceRealtimeAcknowledge", input);
    },
    getRealtimeState: async () => invokeDesktop("realtimeStateGet"),
    onRealtimeStateChanged: (listener: (state: RealtimeConnectionState) => void) =>
      subscribe(
        DESKTOP_CHANNELS.realtimeStateChanged,
        listener,
        (value): value is RealtimeConnectionState =>
          realtimeConnectionStateSchema.safeParse(value).success,
      ),
    onWorkspaceEvent: (listener: (frame: ScopedProductRealtimeEvent) => void) =>
      subscribe(
        DESKTOP_CHANNELS.workspaceEvent,
        listener,
        (value): value is ScopedProductRealtimeEvent =>
          scopedProductRealtimeEventSchema.safeParse(value).success,
      ),
    setWorkspaceTyping: async (input: ScopedTypingActivityUpdate) => {
      await invokeDesktop("workspaceActivityTypingSet", input);
    },
    onWorkspaceActivity: (listener: (frame: ScopedEphemeralActivityFrame) => void) =>
      subscribe(
        DESKTOP_CHANNELS.workspaceActivity,
        listener,
        (value): value is ScopedEphemeralActivityFrame =>
          scopedEphemeralActivityFrameSchema.safeParse(value).success,
      ),
  },
);

contextBridge.exposeInMainWorld("hypeComms", desktopApi);
