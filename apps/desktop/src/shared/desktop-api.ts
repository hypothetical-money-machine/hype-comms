import type {
  AdvanceReadCursorResponse,
  AddReactionResponse,
  CacheCryptoStatus,
  CacheDecryptBatchRequest,
  CacheDecryptBatchResponse,
  CacheEncryptBatchRequest,
  CacheEncryptBatchResponse,
  CacheScope,
  ChatSessionState,
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  ConversationMutationResponse,
  CreateTaskOperation,
  CreateChannelOperation,
  DirectConversationRequest,
  ListConversationsQuery,
  ListConversationsResponse,
  ListMembersResponse,
  ListMessageReactionsResponse,
  MagicLinkDeliveryState,
  MessageHistoryResponse,
  MessageThreadResponse,
  MessageSearchQuery,
  MessageSearchResponse,
  MoveTaskOperation,
  ReactionEmoji,
  RemoveReactionResponse,
  ProductRealtimeEvent,
  RealtimeConnectionState,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
  TaskListQuery,
  TaskListResponse,
  TaskMutationResponse,
  ThemePreference,
  ThemeState,
  UpdateState,
  HumanWorkspaceBootstrapResponse,
  UpdateTaskOperation,
} from "@hmm-chat/contracts";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface NotificationAction {
  readonly type: "open-channel";
  readonly channelId: string;
}

export type ServerStatus = "reachable" | "unreachable";
/** Re-exported from the contracts package so main, preload, and the renderer cannot drift. */
export type { RealtimeConnectionState };

export interface SessionTransport {
  readonly getServerStatus: () => Promise<ServerStatus>;
  readonly getSessionState: () => Promise<ChatSessionState>;
  readonly requestMagicLink: (email: string) => Promise<MagicLinkDeliveryState>;
  readonly signOut: () => Promise<ChatSessionState>;
  readonly onSessionChanged: (listener: (state: ChatSessionState) => void) => () => void;
}

export interface ThemeTransport {
  readonly initialThemeState: ThemeState;
  readonly getThemeState: () => Promise<ThemeState>;
  readonly setThemePreference: (preference: ThemePreference) => Promise<ThemeState>;
  readonly onThemeStateChanged: (listener: (state: ThemeState) => void) => () => void;
}

export interface DesktopApi extends SessionTransport, ThemeTransport {
  readonly platform: DesktopPlatform;
  readonly getAppVersion: () => Promise<string>;
  readonly getUpdateState: () => Promise<UpdateState>;
  readonly checkForUpdates: () => Promise<void>;
  readonly restartToInstallUpdate: () => Promise<void>;
  readonly onUpdateStateChanged: (listener: (state: UpdateState) => void) => () => void;
  readonly onNotificationAction: (listener: (action: NotificationAction) => void) => () => void;
  readonly initializeCacheCrypto: (scope: CacheScope) => Promise<CacheCryptoStatus>;
  readonly encryptCacheRecords: (
    input: CacheEncryptBatchRequest,
  ) => Promise<CacheEncryptBatchResponse>;
  readonly decryptCacheRecords: (
    input: CacheDecryptBatchRequest,
  ) => Promise<CacheDecryptBatchResponse>;
  readonly resetCacheCrypto: () => Promise<void>;
  readonly getWorkspaceBootstrap: () => Promise<HumanWorkspaceBootstrapResponse>;
  /**
   * Re-reads the authoritative workspace member directory. The server returns only active
   * memberships, so this is the one call that can tell a client a member has gone away:
   * `member.updated` announces that the directory changed but its payload cannot express removal.
   */
  readonly listWorkspaceMembers: () => Promise<ListMembersResponse>;
  /**
   * Fetches one page of conversation summaries. Bootstrap returns the first page; callers page
   * with `after` until `hasMore` is false so a large workspace cannot exceed the wire contract.
   */
  readonly listConversations: (
    input?: Partial<ListConversationsQuery>,
  ) => Promise<ListConversationsResponse>;
  readonly getConversationMessages: (input: {
    readonly conversationId: string;
    readonly before?: string;
    readonly limit?: number;
  }) => Promise<MessageHistoryResponse>;
  readonly getMessageThread: (input: {
    readonly messageId: string;
    readonly before?: string;
    readonly limit?: number;
  }) => Promise<MessageThreadResponse>;
  readonly listMessageReactions: (
    messageIds: readonly string[],
  ) => Promise<ListMessageReactionsResponse>;
  readonly addMessageReaction: (
    messageId: string,
    emoji: ReactionEmoji,
  ) => Promise<AddReactionResponse>;
  readonly removeMessageReaction: (
    messageId: string,
    emoji: ReactionEmoji,
  ) => Promise<RemoveReactionResponse>;
  readonly searchMessages: (input: MessageSearchQuery) => Promise<MessageSearchResponse>;
  readonly listConversationTasks: (
    conversationId: string,
    input?: Partial<TaskListQuery>,
  ) => Promise<TaskListResponse>;
  readonly listMyTasks: (input?: Partial<TaskListQuery>) => Promise<TaskListResponse>;
  readonly createTask: (input: CreateTaskOperation) => Promise<TaskMutationResponse>;
  readonly updateTask: (input: UpdateTaskOperation) => Promise<TaskMutationResponse>;
  readonly moveTask: (input: MoveTaskOperation) => Promise<TaskMutationResponse>;
  readonly sendConversationMessage: (input: SendMessageOperation) => Promise<SendAttemptResult>;
  readonly createChannel: (input: CreateChannelOperation) => Promise<ConversationMutationResponse>;
  readonly archiveChannel: (conversationId: string) => Promise<ConversationMutationResponse>;
  readonly getChannelMembers: (conversationId: string) => Promise<ChannelMembersResponse>;
  readonly upsertChannelMember: (
    conversationId: string,
    userId: string,
    role: "owner" | "member",
  ) => Promise<ChannelMembershipMutationResponse>;
  readonly removeChannelMember: (
    conversationId: string,
    userId: string,
  ) => Promise<ChannelMembershipMutationResponse>;
  readonly createDirectConversation: (
    input: DirectConversationRequest,
  ) => Promise<ConversationMutationResponse>;
  readonly advanceReadCursor: (
    conversationId: string,
    lastReadMessageId: string,
  ) => Promise<AdvanceReadCursorResponse>;
  readonly syncWorkspace: (after: string) => Promise<SyncAttemptResult>;
  readonly startWorkspaceRealtime: (after: string) => Promise<void>;
  readonly stopWorkspaceRealtime: () => Promise<void>;
  readonly acknowledgeWorkspaceEvent: (cursor: string) => Promise<void>;
  readonly getRealtimeState: () => Promise<RealtimeConnectionState>;
  readonly onRealtimeStateChanged: (
    listener: (state: RealtimeConnectionState) => void,
  ) => () => void;
  readonly onWorkspaceEvent: (listener: (event: ProductRealtimeEvent) => void) => () => void;
}
