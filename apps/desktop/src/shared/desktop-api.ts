import type {
  AdvanceReadCursorResponse,
  AddReactionResponse,
  AuthCapabilities,
  AiChannelGenerationRequest,
  AiChannelPermissionResponse,
  AiChannelPromptRequest,
  AiChannelState,
  CacheCryptoStatus,
  CacheDecryptBatchRequest,
  CacheDecryptBatchResponse,
  CacheEncryptBatchRequest,
  CacheEncryptBatchResponse,
  ChatSessionState,
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  CommunicationPathsResponse,
  Attachment,
  ConversationFilesResponse,
  ConversationMutationResponse,
  CreateTaskOperation,
  CreateChannelOperation,
  DirectConversationRequest,
  ConversationFilesQuery,
  ListConversationsQuery,
  ListConversationsResponse,
  ListMembersResponse,
  ListMessageAttachmentsResponse,
  ListMessageReactionsResponse,
  MagicLinkDeliveryState,
  MessageHistoryResponse,
  MessageByIdResponse,
  RetractMessageResponse,
  MessageThreadResponse,
  MessageSearchQuery,
  MessageSearchResponse,
  MoveTaskOperation,
  OpenAttachmentResponse,
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainRequest,
  NotificationActionDrainResponse,
  NotificationActivityUpdate,
  NotificationContext,
  NotificationCaptureActivationRequest,
  NotificationCaptureActivationResponse,
  NotificationPreference,
  NotificationState,
  ReactionEmoji,
  RemoveReactionResponse,
  RealtimeAcknowledgement,
  RealtimeConnectionState,
  RealtimeSessionScope,
  ScopedProductRealtimeEvent,
  SendAttemptResult,
  SendMessageOperation,
  SyncAttemptResult,
  TaskListQuery,
  TaskListResponse,
  TaskMutationResponse,
  ThemeDesign,
  ThemePreference,
  ThemeState,
  UpdateState,
  HumanWorkspaceBootstrapResponse,
  UpdateTaskOperation,
} from "@hype-comms/contracts";

export type DesktopPlatform = "darwin" | "linux" | "win32";

export type ServerStatus = "reachable" | "unreachable";
export const AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE = "AuthKit sign-in is unavailable";
/** Re-exported from the contracts package so main, preload, and the renderer cannot drift. */
export type {
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainRequest,
  NotificationActionDrainResponse,
  NotificationActivityUpdate,
  NotificationContext,
  NotificationCaptureActivationRequest,
  NotificationCaptureActivationResponse,
  NotificationPreference,
  NotificationState,
  RealtimeConnectionState,
};

export interface SessionTransport {
  readonly getServerStatus: () => Promise<ServerStatus>;
  readonly getSessionState: () => Promise<ChatSessionState>;
  readonly retrySession: () => Promise<ChatSessionState>;
  /** Optional only so narrow test transports and older embedders remain source-compatible. */
  readonly getAuthCapabilities?: () => Promise<AuthCapabilities>;
  readonly startAuthKitSignIn?: () => Promise<void>;
  readonly requestMagicLink: (email: string) => Promise<MagicLinkDeliveryState>;
  readonly signOut: () => Promise<ChatSessionState>;
  readonly onSessionChanged: (listener: (state: ChatSessionState) => void) => () => void;
}

export interface ThemeTransport {
  readonly initialThemeState: ThemeState;
  readonly getThemeState: () => Promise<ThemeState>;
  readonly getSystemThemeState: () => Promise<ThemeState>;
  readonly setThemePreference: (preference: ThemePreference) => Promise<ThemeState>;
  readonly setThemeDesign: (design: ThemeDesign) => Promise<ThemeState>;
  readonly onThemeStateChanged: (listener: (state: ThemeState) => void) => () => void;
}

export interface CompactModeTransport {
  readonly initialCompactMode: boolean;
  readonly getCompactMode: () => Promise<boolean>;
  readonly setCompactMode: (enabled: boolean) => Promise<boolean>;
  readonly onCompactModeChanged: (listener: (enabled: boolean) => void) => () => void;
}

/**
 * A device-local Claude Code destination. It is deliberately separate from workspace transport:
 * prompts can execute tools and must never enter the durable chat outbox or server projection.
 */
export interface AiChannelTransport {
  readonly getAiChannelState: () => Promise<AiChannelState>;
  readonly startAiChannel: (input: AiChannelGenerationRequest) => Promise<AiChannelState>;
  readonly chooseAiChannelWorkspace: () => Promise<AiChannelState>;
  readonly newAiChannelSession: (input: AiChannelGenerationRequest) => Promise<AiChannelState>;
  readonly sendAiChannelPrompt: (input: AiChannelPromptRequest) => Promise<AiChannelState>;
  readonly cancelAiChannelPrompt: (input: AiChannelGenerationRequest) => Promise<AiChannelState>;
  readonly respondAiChannelPermission: (
    input: AiChannelPermissionResponse,
  ) => Promise<AiChannelState>;
  readonly onAiChannelStateChanged: (listener: (state: AiChannelState) => void) => () => void;
}

/**
 * Body-free native-notification bridge. The action drain is also the renderer-ready handshake:
 * callers invoke it only after their exact workspace session and navigation subscriber are ready.
 */
export interface NotificationTransport {
  readonly getNotificationContext: () => Promise<NotificationContext>;
  readonly reportNotificationActivity: (activity: NotificationActivityUpdate) => Promise<void>;
  readonly drainNotificationActions: (
    ready: NotificationActionDrainRequest,
  ) => Promise<NotificationActionDrainResponse>;
  readonly acknowledgeNotificationAction: (
    acknowledgement: NotificationActionAcknowledgement,
  ) => Promise<void>;
  readonly onNotificationAction: (listener: (action: NotificationAction) => void) => () => void;
  readonly getNotificationState: () => Promise<NotificationState>;
  readonly setNotificationPreference: (
    preference: NotificationPreference,
  ) => Promise<NotificationState>;
  readonly refreshNotificationCapability: () => Promise<NotificationState>;
  readonly onNotificationStateChanged: (listener: (state: NotificationState) => void) => () => void;
}

/** Separate because ordinary renderer transports and their fakes never expose headless controls. */
export interface NotificationCaptureTransport {
  /** Available only to the unpackaged headless automation client. */
  readonly activateCapturedNotification: (captureId: string) => Promise<boolean>;
}

export interface DesktopApi
  extends
    SessionTransport,
    ThemeTransport,
    CompactModeTransport,
    AiChannelTransport,
    Partial<NotificationTransport>,
    Partial<NotificationCaptureTransport> {
  readonly platform: DesktopPlatform;
  /** True only for the unpackaged, hidden-window automation client. */
  readonly isHeadless?: boolean;
  readonly getAppVersion: () => Promise<string>;
  readonly getUpdateState: () => Promise<UpdateState>;
  readonly checkForUpdates: () => Promise<void>;
  readonly restartToInstallUpdate: () => Promise<void>;
  readonly onUpdateStateChanged: (listener: (state: UpdateState) => void) => () => void;
  /** Main derives the authorized cache scope; the renderer supplies no scope selector. */
  readonly initializeCacheCrypto: () => Promise<CacheCryptoStatus>;
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
   * Owner-only workspace administration: member-to-member communication links with per-link
   * message volume. The server rejects non-owners, so callers must gate the UI on the role.
   */
  readonly getCommunicationPaths: () => Promise<CommunicationPathsResponse>;
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
  readonly getMessageById: (messageId: string) => Promise<MessageByIdResponse>;
  readonly retractMessage: (messageId: string) => Promise<RetractMessageResponse>;
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
  readonly listConversationFiles: (
    conversationId: string,
    input?: Partial<ConversationFilesQuery>,
  ) => Promise<ConversationFilesResponse>;
  readonly listMessageAttachments: (
    messageIds: readonly string[],
  ) => Promise<ListMessageAttachmentsResponse>;
  readonly chooseAndUploadConversationFile: (conversationId: string) => Promise<Attachment | null>;
  readonly openConversationFile: (attachmentId: string) => Promise<OpenAttachmentResponse>;
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
  /** Prepares and returns a scope without opening a socket. */
  readonly startWorkspaceRealtime: (after: string) => Promise<RealtimeSessionScope>;
  /** Opens the socket only after the renderer has installed the prepared scope. */
  readonly activateWorkspaceRealtime: (scope: RealtimeSessionScope) => Promise<void>;
  readonly stopWorkspaceRealtime: (scope?: RealtimeSessionScope) => Promise<void>;
  readonly acknowledgeWorkspaceEvent: (input: RealtimeAcknowledgement) => Promise<void>;
  readonly getRealtimeState: () => Promise<RealtimeConnectionState>;
  readonly onRealtimeStateChanged: (
    listener: (state: RealtimeConnectionState) => void,
  ) => () => void;
  readonly onWorkspaceEvent: (listener: (frame: ScopedProductRealtimeEvent) => void) => () => void;
}
