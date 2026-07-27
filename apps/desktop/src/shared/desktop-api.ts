import type {
  AdvanceReadCursorResponse,
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
  CreateChannelRequest,
  DirectConversationRequest,
  ListConversationsQuery,
  ListConversationsResponse,
  MagicLinkDeliveryState,
  MessageHistoryResponse,
  MessageSearchQuery,
  MessageSearchResponse,
  ProductRealtimeEvent,
  RealtimeConnectionState,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
  UpdateState,
  WorkspaceBootstrapResponse,
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

export interface DesktopApi extends SessionTransport {
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
  readonly getWorkspaceBootstrap: () => Promise<WorkspaceBootstrapResponse>;
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
  readonly searchMessages: (input: MessageSearchQuery) => Promise<MessageSearchResponse>;
  readonly sendConversationMessage: (input: SendMessageOperation) => Promise<SendAttemptResult>;
  readonly createChannel: (input: CreateChannelRequest) => Promise<ConversationMutationResponse>;
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
