import type {
  AdvanceReadCursorResponse,
  CacheCryptoStatus,
  CacheDecryptBatchRequest,
  CacheDecryptBatchResponse,
  CacheEncryptBatchRequest,
  CacheEncryptBatchResponse,
  CacheScope,
  ChatSessionState,
  ConversationMutationResponse,
  CreateChannelRequest,
  DirectConversationRequest,
  MagicLinkDeliveryState,
  MessageHistoryResponse,
  ProductRealtimeEvent,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
  WorkspaceBootstrapResponse,
} from "@hmm-chat/contracts";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export interface NotificationAction {
  readonly type: "open-channel";
  readonly channelId: string;
}

export type ServerStatus = "reachable" | "unreachable";
export type RealtimeConnectionState = "connecting" | "live" | "offline" | "reconnecting";

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
  readonly getConversationMessages: (input: {
    readonly conversationId: string;
    readonly before?: string;
    readonly limit?: number;
  }) => Promise<MessageHistoryResponse>;
  readonly sendConversationMessage: (input: SendMessageOperation) => Promise<SendAttemptResult>;
  readonly createChannel: (input: CreateChannelRequest) => Promise<ConversationMutationResponse>;
  readonly archiveChannel: (conversationId: string) => Promise<ConversationMutationResponse>;
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
