import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
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
  conversationMutationResponseSchema,
  createChannelOperationSchema,
  createTaskOperationSchema,
  directConversationRequestSchema,
  chatSessionStateSchema,
  listConversationsQuerySchema,
  listConversationsResponseSchema,
  listMessageReactionsRequestSchema,
  listMessageReactionsResponseSchema,
  magicLinkDeliveryStateSchema,
  messageHistoryResponseSchema,
  messageThreadRequestSchema,
  messageThreadResponseSchema,
  messageReactionTargetSchema,
  messageSearchQuerySchema,
  messageSearchResponseSchema,
  moveTaskOperationSchema,
  productRealtimeEventSchema,
  realtimeConnectionStateSchema,
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
  workspaceBootstrapResponseSchema,
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
  type ReactionEmoji,
  type ProductRealtimeEvent,
  type SendMessageOperation,
  type ThemePreference,
  type ThemeState,
  type TaskListQuery,
  type UpdateState,
  type UpdateTaskOperation,
} from "@hmm-chat/contracts";

import { DESKTOP_CHANNELS } from "../shared/channels";
import type {
  DesktopApi,
  DesktopPlatform,
  NotificationAction,
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

function isNotificationAction(value: unknown): value is NotificationAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === "open-channel" && typeof candidate.channelId === "string";
}

const platform = process.platform;
if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
  throw new Error(`Unsupported desktop platform: ${platform}`);
}
const initialThemeState = resolveInitialThemeStateArgument(process.argv);

const desktopApi: DesktopApi = Object.freeze({
  platform: platform as DesktopPlatform,
  initialThemeState,
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
      await ipcRenderer.invoke(DESKTOP_CHANNELS.themeSet, themePreferenceSchema.parse(preference)),
    ),
  onThemeStateChanged: (listener: (state: ThemeState) => void) =>
    subscribe(DESKTOP_CHANNELS.themeChanged, listener, isBuiltInThemeState),
  getServerStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.serverStatus) as Promise<ServerStatus>,
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
  onNotificationAction: (listener: (action: NotificationAction) => void) =>
    subscribe(DESKTOP_CHANNELS.notificationAction, listener, isNotificationAction),
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
    workspaceBootstrapResponseSchema.parse(
      await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceBootstrap),
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
  upsertChannelMember: async (conversationId: string, userId: string, role: "owner" | "member") => {
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
  advanceReadCursor: async (conversationId: string, lastReadMessageId: string) =>
    advanceReadCursorResponseSchema.parse(
      await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceReadAdvance, {
        conversationId,
        lastReadMessageId,
      }),
    ),
  syncWorkspace: async (after: string) =>
    syncAttemptResultSchema.parse(
      await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceSync, sequenceSchema.parse(after)),
    ),
  startWorkspaceRealtime: async (after: string) => {
    await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceRealtimeStart, sequenceSchema.parse(after));
  },
  stopWorkspaceRealtime: async () => {
    await ipcRenderer.invoke(DESKTOP_CHANNELS.workspaceRealtimeStop);
  },
  acknowledgeWorkspaceEvent: async (cursor: string) => {
    await ipcRenderer.invoke(
      DESKTOP_CHANNELS.workspaceRealtimeAcknowledge,
      sequenceSchema.parse(cursor),
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
  onWorkspaceEvent: (listener: (event: ProductRealtimeEvent) => void) =>
    subscribe(
      DESKTOP_CHANNELS.workspaceEvent,
      listener,
      (value): value is ProductRealtimeEvent => productRealtimeEventSchema.safeParse(value).success,
    ),
});

contextBridge.exposeInMainWorld("hmmChat", desktopApi);
