import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
  NOTIFICATION_ACTION_IPC_MAX_BYTES,
  NOTIFICATION_ACTIVITY_IPC_MAX_BYTES,
  NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
  NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
  NOTIFICATION_PREFERENCE_IPC_MAX_BYTES,
  NOTIFICATION_STATE_IPC_MAX_BYTES,
  advanceReadCursorResponseSchema,
  addReactionResponseSchema,
  cacheCryptoStatusSchema,
  cacheDecryptBatchRequestSchema,
  cacheDecryptBatchResponseSchema,
  cacheEncryptBatchRequestSchema,
  cacheEncryptBatchResponseSchema,
  cacheScopeSchema,
  channelMemberTargetSchema,
  channelMembershipMutationResponseSchema,
  channelMembersResponseSchema,
  compactModePreferenceSchema,
  conversationMutationResponseSchema,
  createChannelOperationSchema,
  createTaskOperationSchema,
  directConversationRequestSchema,
  entityIdSchema,
  chatSessionStateSchema,
  listConversationsQuerySchema,
  listConversationsResponseSchema,
  listMembersResponseSchema,
  listMessageReactionsRequestSchema,
  listMessageReactionsResponseSchema,
  magicLinkDeliveryStateSchema,
  messageHistoryResponseSchema,
  messageByIdResponseSchema,
  messageThreadRequestSchema,
  messageThreadResponseSchema,
  messageReactionTargetSchema,
  messageSearchQuerySchema,
  messageSearchResponseSchema,
  moveTaskOperationSchema,
  notificationActionSchema,
  notificationActionAcknowledgementSchema,
  notificationActionDrainRequestSchema,
  notificationActionDrainResponseSchema,
  notificationActivityUpdateSchema,
  notificationContextSchema,
  notificationCaptureActivationRequestSchema,
  notificationCaptureActivationResponseSchema,
  notificationPreferenceSchema,
  notificationStateSchema,
  realtimeConnectionStateSchema,
  realtimeAcknowledgementSchema,
  realtimeSessionScopeSchema,
  requestMagicLinkSchema,
  removeReactionResponseSchema,
  sendAttemptResultSchema,
  sendMessageOperationSchema,
  sequenceSchema,
  syncAttemptResultSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
  themePreferenceSchema,
  updateStateSchema,
  updateTaskOperationSchema,
  upsertChannelMemberRequestSchema,
  upsertChannelMemberOperationSchema,
  humanWorkspaceBootstrapResponseSchema,
  scopedProductRealtimeEventSchema,
  type ChatSessionState,
  type CacheDecryptBatchRequest,
  type CacheEncryptBatchRequest,
  type CacheScope,
  type CreateChannelOperation,
  type CreateTaskOperation,
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
  type ScopedProductRealtimeEvent,
  type SendMessageOperation,
  type ThemePreference,
  type ThemeState,
  type TaskListQuery,
  type UpdateState,
  type UpdateTaskOperation,
} from "@hmm-chat/contracts";

import { DESKTOP_CHANNELS } from "../shared/channels";
import { resolveInitialCompactModeArgument } from "../shared/compact-mode";
import type {
  DesktopApi,
  DesktopPlatform,
  NotificationCaptureTransport,
  NotificationTransport,
  RealtimeConnectionState,
  ServerStatus,
} from "../shared/desktop-api";
import {
  isBuiltInThemeState,
  parseBuiltInThemeState,
  resolveInitialThemeStateArgument,
} from "../shared/theme";

function subscribe<T>(
  channel: string,
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

interface IpcPayloadSchema<T> {
  readonly parse: (value: unknown) => T;
}

function parseBoundedNotificationPayload<T>(
  schema: IpcPayloadSchema<T>,
  value: unknown,
  maxBytes: number,
): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Notification IPC payload must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new TypeError("Notification IPC payload must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError("Notification IPC payload exceeds its byte limit");
  }
  return schema.parse(value);
}

function subscribeToBoundedNotificationPayload<T>(
  channel: string,
  schema: IpcPayloadSchema<T>,
  maxBytes: number,
  listener: (value: T) => void,
): () => void {
  const wrappedListener = (_event: IpcRendererEvent, value: unknown): void => {
    try {
      listener(parseBoundedNotificationPayload(schema, value, maxBytes));
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
const isHeadless = ipcRenderer.sendSync(DESKTOP_CHANNELS.automationHeadless) === true;
const initialCompactMode = resolveInitialCompactModeArgument(process.argv);

const desktopApi: DesktopApi & NotificationTransport & NotificationCaptureTransport = Object.freeze(
  {
    platform: platform as DesktopPlatform,
    isHeadless,
    initialThemeState,
    initialCompactMode,
    getAppVersion: () => ipcRenderer.invoke(DESKTOP_CHANNELS.appVersion) as Promise<string>,
    getUpdateState: async () =>
      updateStateSchema.parse(await ipcRenderer.invoke(DESKTOP_CHANNELS.updateState)),
    checkForUpdates: async () => {
      await ipcRenderer.invoke(DESKTOP_CHANNELS.updateCheck);
    },
    restartToInstallUpdate: async () => {
      await ipcRenderer.invoke(DESKTOP_CHANNELS.updateInstall);
    },
    onUpdateStateChanged: (listener: (state: UpdateState) => void) =>
      subscribe(
        DESKTOP_CHANNELS.updateChanged,
        listener,
        (value): value is UpdateState => updateStateSchema.safeParse(value).success,
      ),
    getThemeState: async () =>
      parseBuiltInThemeState(await ipcRenderer.invoke(DESKTOP_CHANNELS.themeState)),
    setThemePreference: async (preference: ThemePreference) =>
      parseBuiltInThemeState(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.themeSet,
          themePreferenceSchema.parse(preference),
        ),
      ),
    onThemeStateChanged: (listener: (state: ThemeState) => void) =>
      subscribe(DESKTOP_CHANNELS.themeChanged, listener, isBuiltInThemeState),
    getCompactMode: async () =>
      compactModePreferenceSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.compactModeState),
      ),
    setCompactMode: async (enabled: boolean) =>
      compactModePreferenceSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.compactModeSet,
          compactModePreferenceSchema.parse(enabled),
        ),
      ),
    onCompactModeChanged: (listener: (enabled: boolean) => void) =>
      subscribe(
        DESKTOP_CHANNELS.compactModeChanged,
        listener,
        (value): value is boolean => compactModePreferenceSchema.safeParse(value).success,
      ),
    getServerStatus: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.serverStatus) as Promise<ServerStatus>,
    getSessionState: async () =>
      chatSessionStateSchema.parse(await ipcRenderer.invoke(DESKTOP_CHANNELS.sessionState)),
    requestMagicLink: async (email: string) => {
      const request = requestMagicLinkSchema.parse({ email });
      return magicLinkDeliveryStateSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.sessionRequestMagicLink, request),
      );
    },
    signOut: async () =>
      chatSessionStateSchema.parse(await ipcRenderer.invoke(DESKTOP_CHANNELS.sessionSignOut)),
    onSessionChanged: (listener: (state: ChatSessionState) => void) =>
      subscribe(
        DESKTOP_CHANNELS.sessionChanged,
        listener,
        (value): value is ChatSessionState => chatSessionStateSchema.safeParse(value).success,
      ),
    getNotificationContext: async () =>
      parseBoundedNotificationPayload(
        notificationContextSchema,
        await ipcRenderer.invoke(DESKTOP_CHANNELS.notificationContext),
        NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
      ),
    reportNotificationActivity: async (activity: NotificationActivityUpdate) => {
      const request = parseBoundedNotificationPayload(
        notificationActivityUpdateSchema,
        activity,
        NOTIFICATION_ACTIVITY_IPC_MAX_BYTES,
      );
      const response: unknown = await ipcRenderer.invoke(
        DESKTOP_CHANNELS.notificationActivityUpdate,
        request,
      );
      if (response !== undefined) {
        throw new TypeError("Notification activity update returned an unexpected payload");
      }
    },
    drainNotificationActions: async (ready: NotificationActionDrainRequest) => {
      const request = parseBoundedNotificationPayload(
        notificationActionDrainRequestSchema,
        ready,
        NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES,
      );
      return parseBoundedNotificationPayload(
        notificationActionDrainResponseSchema,
        await ipcRenderer.invoke(DESKTOP_CHANNELS.notificationActionsDrain, request),
        NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
      );
    },
    acknowledgeNotificationAction: async (acknowledgement: NotificationActionAcknowledgement) => {
      const request = parseBoundedNotificationPayload(
        notificationActionAcknowledgementSchema,
        acknowledgement,
        NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES,
      );
      const response: unknown = await ipcRenderer.invoke(
        DESKTOP_CHANNELS.notificationActionAcknowledge,
        request,
      );
      if (response !== undefined) {
        throw new TypeError("Notification action acknowledgement returned an unexpected payload");
      }
    },
    onNotificationAction: (listener: (action: NotificationAction) => void) =>
      subscribeToBoundedNotificationPayload(
        DESKTOP_CHANNELS.notificationAction,
        notificationActionSchema,
        NOTIFICATION_ACTION_IPC_MAX_BYTES,
        listener,
      ),
    getNotificationState: async () =>
      parseBoundedNotificationPayload(
        notificationStateSchema,
        await ipcRenderer.invoke(DESKTOP_CHANNELS.notificationState),
        NOTIFICATION_STATE_IPC_MAX_BYTES,
      ),
    setNotificationPreference: async (preference: NotificationPreference) => {
      const request = parseBoundedNotificationPayload(
        notificationPreferenceSchema,
        preference,
        NOTIFICATION_PREFERENCE_IPC_MAX_BYTES,
      );
      return parseBoundedNotificationPayload(
        notificationStateSchema,
        await ipcRenderer.invoke(DESKTOP_CHANNELS.notificationPreferenceSet, request),
        NOTIFICATION_STATE_IPC_MAX_BYTES,
      );
    },
    refreshNotificationCapability: async () =>
      parseBoundedNotificationPayload(
        notificationStateSchema,
        await ipcRenderer.invoke(DESKTOP_CHANNELS.notificationCapabilityRefresh),
        NOTIFICATION_STATE_IPC_MAX_BYTES,
      ),
    onNotificationStateChanged: (listener: (state: NotificationState) => void) =>
      subscribeToBoundedNotificationPayload(
        DESKTOP_CHANNELS.notificationStateChanged,
        notificationStateSchema,
        NOTIFICATION_STATE_IPC_MAX_BYTES,
        listener,
      ),
    activateCapturedNotification: async (captureId: string) => {
      if (!isHeadless) {
        throw new Error("Captured notification activation is available only in headless mode");
      }
      const request = parseBoundedNotificationPayload(
        notificationCaptureActivationRequestSchema,
        { version: 1, captureId },
        NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
      );
      const response = parseBoundedNotificationPayload(
        notificationCaptureActivationResponseSchema,
        await ipcRenderer.invoke(DESKTOP_CHANNELS.notificationCaptureActivate, request),
        NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
      );
      return response.activated;
    },
    initializeCacheCrypto: async (scope: CacheScope) =>
      cacheCryptoStatusSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.cacheCryptoInitialize,
          cacheScopeSchema.parse(scope),
        ),
      ),
    encryptCacheRecords: async (input: CacheEncryptBatchRequest) =>
      cacheEncryptBatchResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.cacheCryptoEncrypt,
          cacheEncryptBatchRequestSchema.parse(input),
        ),
      ),
    decryptCacheRecords: async (input: CacheDecryptBatchRequest) =>
      cacheDecryptBatchResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.cacheCryptoDecrypt,
          cacheDecryptBatchRequestSchema.parse(input),
        ),
      ),
    resetCacheCrypto: async () => {
      await ipcRenderer.invoke(DESKTOP_CHANNELS.cacheCryptoReset);
    },
    getWorkspaceBootstrap: async () =>
      humanWorkspaceBootstrapResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceBootstrap),
      ),
    listWorkspaceMembers: async () =>
      listMembersResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceMembersList),
      ),
    listConversations: async (input: Partial<ListConversationsQuery> = {}) =>
      listConversationsResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceConversationsList,
          listConversationsQuerySchema.parse(input),
        ),
      ),
    getConversationMessages: async (input: {
      readonly conversationId: string;
      readonly before?: string;
      readonly limit?: number;
    }) =>
      messageHistoryResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceMessagesList, input),
      ),
    getMessageById: async (messageId: string) =>
      messageByIdResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceMessageGet,
          entityIdSchema.parse(messageId),
        ),
      ),
    getMessageThread: async (input: {
      readonly messageId: string;
      readonly before?: string;
      readonly limit?: number;
    }) => {
      const request = messageThreadRequestSchema.parse(input);
      return messageThreadResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceMessageThread, request),
      );
    },
    listMessageReactions: async (messageIds: readonly string[]) => {
      const request = listMessageReactionsRequestSchema.parse({ messageIds });
      return listMessageReactionsResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceReactionsList, request),
      );
    },
    addMessageReaction: async (messageId: string, emoji: ReactionEmoji) => {
      const target = messageReactionTargetSchema.parse({ messageId, emoji });
      return addReactionResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceReactionAdd, target),
      );
    },
    removeMessageReaction: async (messageId: string, emoji: ReactionEmoji) => {
      const target = messageReactionTargetSchema.parse({ messageId, emoji });
      return removeReactionResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceReactionRemove, target),
      );
    },
    searchMessages: async (input: MessageSearchQuery) =>
      messageSearchResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceMessageSearch,
          messageSearchQuerySchema.parse(input),
        ),
      ),
    listConversationTasks: async (conversationId: string, input: Partial<TaskListQuery> = {}) =>
      taskListResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceTasksList, {
          conversationId,
          query: taskListQuerySchema.parse(input),
        }),
      ),
    listMyTasks: async (input: Partial<TaskListQuery> = {}) =>
      taskListResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceMyTasksList,
          taskListQuerySchema.parse(input),
        ),
      ),
    createTask: async (input: CreateTaskOperation) =>
      taskMutationResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceTaskCreate,
          createTaskOperationSchema.parse(input),
        ),
      ),
    updateTask: async (input: UpdateTaskOperation) =>
      taskMutationResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceTaskUpdate,
          updateTaskOperationSchema.parse(input),
        ),
      ),
    moveTask: async (input: MoveTaskOperation) =>
      taskMutationResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceTaskMove,
          moveTaskOperationSchema.parse(input),
        ),
      ),
    sendConversationMessage: async (input: SendMessageOperation) =>
      sendAttemptResultSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceMessageSend,
          sendMessageOperationSchema.parse(input),
        ),
      ),
    createChannel: async (input: CreateChannelOperation) =>
      conversationMutationResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceChannelCreate,
          createChannelOperationSchema.parse(input),
        ),
      ),
    archiveChannel: async (conversationId: string) =>
      conversationMutationResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceChannelArchive, conversationId),
      ),
    getChannelMembers: async (conversationId: string) =>
      channelMembersResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceChannelMembersList, conversationId),
      ),
    upsertChannelMember: async (
      conversationId: string,
      userId: string,
      role: "owner" | "member",
    ) => {
      const operation = upsertChannelMemberOperationSchema.parse({
        conversationId,
        userId,
        ...upsertChannelMemberRequestSchema.parse({ role }),
      });
      return channelMembershipMutationResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceChannelMemberUpsert, operation),
      );
    },
    removeChannelMember: async (conversationId: string, userId: string) => {
      const target = channelMemberTargetSchema.parse({
        conversationId,
        userId,
      });
      return channelMembershipMutationResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceChannelMemberRemove, target),
      );
    },
    createDirectConversation: async (input: DirectConversationRequest) =>
      conversationMutationResponseSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceDirectCreate,
          directConversationRequestSchema.parse(input),
        ),
      ),
    advanceReadCursor: async (conversationId: string, lastReadMessageId: string) => {
      if (isHeadless) {
        throw new Error("Read cursors are disabled for headless automation clients");
      }
      return advanceReadCursorResponseSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceReadAdvance, {
          conversationId,
          lastReadMessageId,
        }),
      );
    },
    syncWorkspace: async (after: string) =>
      syncAttemptResultSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceSync, sequenceSchema.parse(after)),
      ),
    startWorkspaceRealtime: async (after: string): Promise<RealtimeSessionScope> =>
      realtimeSessionScopeSchema.parse(
        await ipcRenderer.invoke(
          DESKTOP_CHANNELS.workspaceRealtimeStart,
          sequenceSchema.parse(after),
        ),
      ),
    activateWorkspaceRealtime: async (scope: RealtimeSessionScope) => {
      await ipcRenderer.invoke(
        DESKTOP_CHANNELS.workspaceRealtimeActivate,
        realtimeSessionScopeSchema.parse(scope),
      );
    },
    stopWorkspaceRealtime: async (scope?: RealtimeSessionScope) => {
      await ipcRenderer.invoke(
        DESKTOP_CHANNELS.workspaceRealtimeStop,
        scope === undefined ? undefined : realtimeSessionScopeSchema.parse(scope),
      );
    },
    acknowledgeWorkspaceEvent: async (input: RealtimeAcknowledgement) => {
      await ipcRenderer.invoke(
        DESKTOP_CHANNELS.workspaceRealtimeAcknowledge,
        realtimeAcknowledgementSchema.parse(input),
      );
    },
    getRealtimeState: async () =>
      realtimeConnectionStateSchema.parse(
        await ipcRenderer.invoke(DESKTOP_CHANNELS.realtimeStateGet),
      ),
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
  },
);

contextBridge.exposeInMainWorld("hmmChat", desktopApi);
