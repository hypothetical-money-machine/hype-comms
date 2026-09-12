import * as c from "@hype-comms/contracts";
import { z } from "zod";

import { attachmentUploadRequestSchema, attachmentUploadResultSchema } from "./attachment-upload";
import { DESKTOP_CHANNELS, type DESKTOP_INVOKE_CHANNELS } from "./channels";
import { parseBuiltInThemeState } from "./theme";

// Invoke budgets count the serialized argument tuple, including its brackets. File bytes never
// cross this interface: main owns the native picker, upload, download, and encryption key.
const REQUEST_MAX_BYTES = 64 * 1_024;
const RESPONSE_MAX_BYTES = 16 * 1_024 * 1_024;
// Sixty-four maximum-length plaintext records can require six JSON bytes per code unit.
const CACHE_BATCH_MAX_BYTES = 32 * 1_024 * 1_024;

function invokeContract<
  const Channel extends string,
  Request extends z.ZodType<unknown[]>,
  Response extends z.ZodType,
>(
  channel: Channel,
  request: Request,
  response: Response,
  requestMaxBytes = REQUEST_MAX_BYTES,
  responseMaxBytes = RESPONSE_MAX_BYTES,
) {
  return Object.freeze({ channel, request, response, requestMaxBytes, responseMaxBytes });
}

const noArguments = z.tuple([]);
const noResponse = z.void({ error: "IPC returned an unexpected payload" });
const themeState = c.themeStateSchema.transform(parseBuiltInThemeState);
const systemThemeState = themeState.refine((state) => state.preference === "system", {
  message: "Main returned a non-system appearance for the system preview",
});
const historyRequest = c.messageHistoryQuerySchema
  .extend({ conversationId: c.entityIdSchema })
  .strict();
const filesRequest = z
  .object({
    conversationId: c.entityIdSchema,
    query: c.conversationFilesQuerySchema,
  })
  .strict();
const tasksRequest = z
  .object({
    conversationId: c.entityIdSchema,
    query: c.taskListQuerySchema,
  })
  .strict();
const readRequest = z
  .object({
    conversationId: c.entityIdSchema,
    lastReadMessageId: c.entityIdSchema,
  })
  .strict();

/** Desktop invokes only. Synchronous initial reads and push subscriptions are separate ports. */
export const DESKTOP_INVOKE_CONTRACTS = Object.freeze({
  workspaceTasksList: invokeContract(
    DESKTOP_CHANNELS.workspaceTasksList,
    z.tuple([tasksRequest]),
    c.taskListResponseSchema,
  ),
  workspaceMyTasksList: invokeContract(
    DESKTOP_CHANNELS.workspaceMyTasksList,
    z.tuple([c.taskListQuerySchema]),
    c.taskListResponseSchema,
  ),
  workspaceTaskCreate: invokeContract(
    DESKTOP_CHANNELS.workspaceTaskCreate,
    z.tuple([c.createTaskOperationSchema]),
    c.taskMutationResponseSchema,
  ),
  workspaceTaskUpdate: invokeContract(
    DESKTOP_CHANNELS.workspaceTaskUpdate,
    z.tuple([c.updateTaskOperationSchema]),
    c.taskMutationResponseSchema,
  ),
  workspaceTaskMove: invokeContract(
    DESKTOP_CHANNELS.workspaceTaskMove,
    z.tuple([c.moveTaskOperationSchema]),
    c.taskMutationResponseSchema,
  ),
  appVersion: invokeContract(DESKTOP_CHANNELS.appVersion, noArguments, z.string().min(1).max(128)),
  serverStatus: invokeContract(
    DESKTOP_CHANNELS.serverStatus,
    noArguments,
    z.enum(["reachable", "unreachable"]),
  ),
  protocolHandlerState: invokeContract(
    DESKTOP_CHANNELS.protocolHandlerState,
    noArguments,
    c.protocolHandlerStateSchema,
  ),
  updateState: invokeContract(DESKTOP_CHANNELS.updateState, noArguments, c.updateStateSchema),
  updateCheck: invokeContract(DESKTOP_CHANNELS.updateCheck, noArguments, noResponse),
  updateInstall: invokeContract(DESKTOP_CHANNELS.updateInstall, noArguments, noResponse),
  themeState: invokeContract(DESKTOP_CHANNELS.themeState, noArguments, themeState),
  themeSystemState: invokeContract(
    DESKTOP_CHANNELS.themeSystemState,
    noArguments,
    systemThemeState,
  ),
  themeSet: invokeContract(
    DESKTOP_CHANNELS.themeSet,
    z.tuple([c.themePreferenceSchema]),
    themeState,
  ),
  themeDesignSet: invokeContract(
    DESKTOP_CHANNELS.themeDesignSet,
    z.tuple([c.themeDesignSchema]),
    themeState,
  ),
  compactModeState: invokeContract(
    DESKTOP_CHANNELS.compactModeState,
    noArguments,
    c.compactModePreferenceSchema,
  ),
  compactModeSet: invokeContract(
    DESKTOP_CHANNELS.compactModeSet,
    z.tuple([c.compactModePreferenceSchema]),
    c.compactModePreferenceSchema,
  ),
  devicePreferencesState: invokeContract(
    DESKTOP_CHANNELS.devicePreferencesState,
    noArguments,
    c.devicePreferencesSchema,
    REQUEST_MAX_BYTES,
    c.DEVICE_PREFERENCES_IPC_MAX_BYTES,
  ),
  devicePreferencesUpdate: invokeContract(
    DESKTOP_CHANNELS.devicePreferencesUpdate,
    z.tuple([c.devicePreferencesPatchSchema]),
    c.devicePreferencesSchema,
    c.DEVICE_PREFERENCES_PATCH_IPC_MAX_BYTES + 2,
    c.DEVICE_PREFERENCES_IPC_MAX_BYTES,
  ),
  aiChannelState: invokeContract(
    DESKTOP_CHANNELS.aiChannelState,
    noArguments,
    c.aiChannelStateSchema,
    REQUEST_MAX_BYTES,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  aiChannelStart: invokeContract(
    DESKTOP_CHANNELS.aiChannelStart,
    z.tuple([c.aiChannelGenerationRequestSchema]),
    c.aiChannelStateSchema,
    c.AI_CHANNEL_PERMISSION_RESPONSE_IPC_MAX_BYTES + 2,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  aiChannelWorkspaceChoose: invokeContract(
    DESKTOP_CHANNELS.aiChannelWorkspaceChoose,
    noArguments,
    c.aiChannelStateSchema,
    REQUEST_MAX_BYTES,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  aiChannelSessionNew: invokeContract(
    DESKTOP_CHANNELS.aiChannelSessionNew,
    z.tuple([c.aiChannelGenerationRequestSchema]),
    c.aiChannelStateSchema,
    c.AI_CHANNEL_PERMISSION_RESPONSE_IPC_MAX_BYTES + 2,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  aiChannelPromptSend: invokeContract(
    DESKTOP_CHANNELS.aiChannelPromptSend,
    z.tuple([c.aiChannelPromptRequestSchema]),
    c.aiChannelStateSchema,
    c.AI_CHANNEL_PROMPT_IPC_MAX_BYTES + 2,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  aiChannelPromptCancel: invokeContract(
    DESKTOP_CHANNELS.aiChannelPromptCancel,
    z.tuple([c.aiChannelGenerationRequestSchema]),
    c.aiChannelStateSchema,
    c.AI_CHANNEL_PERMISSION_RESPONSE_IPC_MAX_BYTES + 2,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  aiChannelPermissionRespond: invokeContract(
    DESKTOP_CHANNELS.aiChannelPermissionRespond,
    z.tuple([c.aiChannelPermissionResponseSchema]),
    c.aiChannelStateSchema,
    c.AI_CHANNEL_PERMISSION_RESPONSE_IPC_MAX_BYTES + 2,
    c.AI_CHANNEL_STATE_IPC_MAX_BYTES,
  ),
  sessionState: invokeContract(
    DESKTOP_CHANNELS.sessionState,
    noArguments,
    c.chatSessionStateSchema,
  ),
  sessionRetry: invokeContract(
    DESKTOP_CHANNELS.sessionRetry,
    noArguments,
    c.chatSessionStateSchema,
  ),
  sessionAuthCapabilities: invokeContract(
    DESKTOP_CHANNELS.sessionAuthCapabilities,
    noArguments,
    c.authCapabilitiesSchema,
  ),
  sessionStartAuthKit: invokeContract(
    DESKTOP_CHANNELS.sessionStartAuthKit,
    noArguments,
    noResponse,
  ),
  sessionRequestMagicLink: invokeContract(
    DESKTOP_CHANNELS.sessionRequestMagicLink,
    z.tuple([c.requestMagicLinkSchema]),
    c.magicLinkDeliveryStateSchema,
  ),
  sessionSignOut: invokeContract(
    DESKTOP_CHANNELS.sessionSignOut,
    noArguments,
    c.chatSessionStateSchema,
  ),
  cacheCryptoInitialize: invokeContract(
    DESKTOP_CHANNELS.cacheCryptoInitialize,
    noArguments,
    c.cacheCryptoStatusSchema,
  ),
  cacheCryptoEncrypt: invokeContract(
    DESKTOP_CHANNELS.cacheCryptoEncrypt,
    z.tuple([c.cacheEncryptBatchRequestSchema]),
    c.cacheEncryptBatchResponseSchema,
    CACHE_BATCH_MAX_BYTES,
    CACHE_BATCH_MAX_BYTES,
  ),
  cacheCryptoDecrypt: invokeContract(
    DESKTOP_CHANNELS.cacheCryptoDecrypt,
    z.tuple([c.cacheDecryptBatchRequestSchema]),
    c.cacheDecryptBatchResponseSchema,
    CACHE_BATCH_MAX_BYTES,
    CACHE_BATCH_MAX_BYTES,
  ),
  cacheCryptoReset: invokeContract(DESKTOP_CHANNELS.cacheCryptoReset, noArguments, noResponse),
  workspaceBootstrap: invokeContract(
    DESKTOP_CHANNELS.workspaceBootstrap,
    noArguments,
    c.humanWorkspaceBootstrapResponseSchema,
  ),
  workspaceMembersList: invokeContract(
    DESKTOP_CHANNELS.workspaceMembersList,
    noArguments,
    c.listMembersResponseSchema,
  ),
  workspaceProfileUpdate: invokeContract(
    DESKTOP_CHANNELS.workspaceProfileUpdate,
    z.tuple([c.memberTitleSchema.nullable()]),
    c.updateProfileResponseSchema,
  ),
  workspaceAdminCommunicationPaths: invokeContract(
    DESKTOP_CHANNELS.workspaceAdminCommunicationPaths,
    noArguments,
    c.communicationPathsResponseSchema,
  ),
  workspaceAgentEnrollmentsList: invokeContract(
    DESKTOP_CHANNELS.workspaceAgentEnrollmentsList,
    noArguments,
    c.listAgentEnrollmentsResponseSchema,
  ),
  workspaceAgentEnrollmentReview: invokeContract(
    DESKTOP_CHANNELS.workspaceAgentEnrollmentReview,
    z.tuple([c.entityIdSchema, c.reviewAgentEnrollmentRequestSchema.shape.decision]),
    c.agentEnrollmentResponseSchema,
  ),
  workspaceAgentEnrollmentCancel: invokeContract(
    DESKTOP_CHANNELS.workspaceAgentEnrollmentCancel,
    z.tuple([c.entityIdSchema]),
    c.agentEnrollmentResponseSchema,
  ),
  workspaceConversationsList: invokeContract(
    DESKTOP_CHANNELS.workspaceConversationsList,
    z.tuple([c.listConversationsQuerySchema]),
    c.listConversationsResponseSchema,
  ),
  workspaceMessagesList: invokeContract(
    DESKTOP_CHANNELS.workspaceMessagesList,
    z.tuple([historyRequest]),
    c.messageHistoryResponseSchema,
  ),
  workspaceMessageGet: invokeContract(
    DESKTOP_CHANNELS.workspaceMessageGet,
    z.tuple([c.entityIdSchema]),
    c.messageByIdResponseSchema,
  ),
  workspaceMessageRetract: invokeContract(
    DESKTOP_CHANNELS.workspaceMessageRetract,
    z.tuple([c.entityIdSchema]),
    c.retractMessageResponseSchema,
  ),
  workspaceMessageThread: invokeContract(
    DESKTOP_CHANNELS.workspaceMessageThread,
    z.tuple([c.messageThreadRequestSchema]),
    c.messageThreadResponseSchema,
  ),
  workspaceReactionsList: invokeContract(
    DESKTOP_CHANNELS.workspaceReactionsList,
    z.tuple([c.listMessageReactionsRequestSchema]),
    c.listMessageReactionsResponseSchema,
  ),
  workspaceReactionAdd: invokeContract(
    DESKTOP_CHANNELS.workspaceReactionAdd,
    z.tuple([c.messageReactionTargetSchema]),
    c.addReactionResponseSchema,
  ),
  workspaceReactionRemove: invokeContract(
    DESKTOP_CHANNELS.workspaceReactionRemove,
    z.tuple([c.messageReactionTargetSchema]),
    c.removeReactionResponseSchema,
  ),
  workspaceMessageSearch: invokeContract(
    DESKTOP_CHANNELS.workspaceMessageSearch,
    z.tuple([c.messageSearchQuerySchema]),
    c.messageSearchResponseSchema,
  ),
  workspaceAttachmentsList: invokeContract(
    DESKTOP_CHANNELS.workspaceAttachmentsList,
    z.tuple([c.listMessageAttachmentsRequestSchema]),
    c.listMessageAttachmentsResponseSchema,
  ),
  workspaceConversationFilesList: invokeContract(
    DESKTOP_CHANNELS.workspaceConversationFilesList,
    z.tuple([filesRequest]),
    c.conversationFilesResponseSchema,
  ),
  workspaceFileUpload: invokeContract(
    DESKTOP_CHANNELS.workspaceFileUpload,
    z.tuple([attachmentUploadRequestSchema]),
    attachmentUploadResultSchema,
  ),
  workspaceFileOpen: invokeContract(
    DESKTOP_CHANNELS.workspaceFileOpen,
    z.tuple([c.entityIdSchema]),
    c.openAttachmentResponseSchema,
  ),
  workspaceMessageSend: invokeContract(
    DESKTOP_CHANNELS.workspaceMessageSend,
    z.tuple([c.sendMessageOperationSchema]),
    c.sendAttemptResultSchema,
  ),
  workspaceChannelCreate: invokeContract(
    DESKTOP_CHANNELS.workspaceChannelCreate,
    z.tuple([c.createChannelOperationSchema]),
    c.conversationMutationResponseSchema,
  ),
  workspaceChannelArchive: invokeContract(
    DESKTOP_CHANNELS.workspaceChannelArchive,
    z.tuple([c.entityIdSchema]),
    c.conversationMutationResponseSchema,
  ),
  workspaceChannelMembersList: invokeContract(
    DESKTOP_CHANNELS.workspaceChannelMembersList,
    z.tuple([c.entityIdSchema]),
    c.channelMembersResponseSchema,
  ),
  workspaceChannelMemberUpsert: invokeContract(
    DESKTOP_CHANNELS.workspaceChannelMemberUpsert,
    z.tuple([c.upsertChannelMemberOperationSchema]),
    c.channelMembershipMutationResponseSchema,
  ),
  workspaceChannelMemberRemove: invokeContract(
    DESKTOP_CHANNELS.workspaceChannelMemberRemove,
    z.tuple([c.channelMemberTargetSchema]),
    c.channelMembershipMutationResponseSchema,
  ),
  workspaceDirectCreate: invokeContract(
    DESKTOP_CHANNELS.workspaceDirectCreate,
    z.tuple([c.directConversationRequestSchema]),
    c.conversationMutationResponseSchema,
  ),
  workspaceReadAdvance: invokeContract(
    DESKTOP_CHANNELS.workspaceReadAdvance,
    z.tuple([readRequest]),
    c.advanceReadCursorResponseSchema,
  ),
  workspaceSync: invokeContract(
    DESKTOP_CHANNELS.workspaceSync,
    z.tuple([c.sequenceSchema]),
    c.syncAttemptResultSchema,
  ),
  workspaceRealtimeStart: invokeContract(
    DESKTOP_CHANNELS.workspaceRealtimeStart,
    z.tuple([c.sequenceSchema]),
    c.realtimeSessionScopeSchema,
  ),
  workspaceRealtimeActivate: invokeContract(
    DESKTOP_CHANNELS.workspaceRealtimeActivate,
    z.tuple([c.realtimeSessionScopeSchema]),
    noResponse,
  ),
  workspaceRealtimeStop: invokeContract(
    DESKTOP_CHANNELS.workspaceRealtimeStop,
    z.tuple([c.realtimeSessionScopeSchema.optional()]),
    noResponse,
  ),
  workspaceRealtimeAcknowledge: invokeContract(
    DESKTOP_CHANNELS.workspaceRealtimeAcknowledge,
    z.tuple([c.realtimeAcknowledgementSchema]),
    noResponse,
  ),
  workspaceActivityTypingSet: invokeContract(
    DESKTOP_CHANNELS.workspaceActivityTypingSet,
    z.tuple([c.scopedTypingActivityUpdateSchema]),
    noResponse,
  ),
  realtimeStateGet: invokeContract(
    DESKTOP_CHANNELS.realtimeStateGet,
    noArguments,
    c.realtimeConnectionStateSchema,
  ),
  notificationContext: invokeContract(
    DESKTOP_CHANNELS.notificationContext,
    noArguments,
    c.notificationContextSchema,
    REQUEST_MAX_BYTES,
    c.NOTIFICATION_CONTEXT_IPC_MAX_BYTES,
  ),
  notificationActivityUpdate: invokeContract(
    DESKTOP_CHANNELS.notificationActivityUpdate,
    z.tuple([c.notificationActivityUpdateSchema]),
    noResponse,
    c.NOTIFICATION_ACTIVITY_IPC_MAX_BYTES + 2,
  ),
  notificationActionsDrain: invokeContract(
    DESKTOP_CHANNELS.notificationActionsDrain,
    z.tuple([c.notificationActionDrainRequestSchema]),
    c.notificationActionDrainResponseSchema,
    c.NOTIFICATION_ACTION_DRAIN_REQUEST_IPC_MAX_BYTES + 2,
    c.NOTIFICATION_ACTION_DRAIN_RESPONSE_IPC_MAX_BYTES,
  ),
  notificationActionAcknowledge: invokeContract(
    DESKTOP_CHANNELS.notificationActionAcknowledge,
    z.tuple([c.notificationActionAcknowledgementSchema]),
    noResponse,
    c.NOTIFICATION_ACTION_ACKNOWLEDGEMENT_IPC_MAX_BYTES + 2,
  ),
  notificationState: invokeContract(
    DESKTOP_CHANNELS.notificationState,
    noArguments,
    c.notificationStateSchema,
    REQUEST_MAX_BYTES,
    c.NOTIFICATION_STATE_IPC_MAX_BYTES,
  ),
  notificationPreferenceSet: invokeContract(
    DESKTOP_CHANNELS.notificationPreferenceSet,
    z.tuple([c.notificationPreferenceSchema]),
    c.notificationStateSchema,
    c.NOTIFICATION_PREFERENCE_IPC_MAX_BYTES + 2,
    c.NOTIFICATION_STATE_IPC_MAX_BYTES,
  ),
  notificationCapabilityRefresh: invokeContract(
    DESKTOP_CHANNELS.notificationCapabilityRefresh,
    noArguments,
    c.notificationStateSchema,
    REQUEST_MAX_BYTES,
    c.NOTIFICATION_STATE_IPC_MAX_BYTES,
  ),
  notificationCaptureActivate: invokeContract(
    DESKTOP_CHANNELS.notificationCaptureActivate,
    z.tuple([c.notificationCaptureActivationRequestSchema]),
    c.notificationCaptureActivationResponseSchema,
    c.NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES + 2,
    c.NOTIFICATION_CAPTURE_ACTIVATION_IPC_MAX_BYTES,
  ),
} satisfies {
  [K in keyof typeof DESKTOP_INVOKE_CHANNELS]: ReturnType<typeof invokeContract> & {
    readonly channel: (typeof DESKTOP_INVOKE_CHANNELS)[K];
  };
});

export type DesktopInvokeName = keyof typeof DESKTOP_INVOKE_CONTRACTS;
export type DesktopInvokeInput<K extends DesktopInvokeName> = z.input<
  (typeof DESKTOP_INVOKE_CONTRACTS)[K]["request"]
>;
export type DesktopInvokeArguments<K extends DesktopInvokeName> = z.output<
  (typeof DESKTOP_INVOKE_CONTRACTS)[K]["request"]
>;
export type DesktopInvokeResult<K extends DesktopInvokeName> = z.output<
  (typeof DESKTOP_INVOKE_CONTRACTS)[K]["response"]
>;

export interface DesktopInvokeContext {
  readonly senderId: number;
}

export type DesktopInvokeHandlers = {
  readonly [K in DesktopInvokeName]: (
    context: DesktopInvokeContext,
    ...args: DesktopInvokeArguments<K>
  ) => DesktopInvokeResult<K> | Promise<DesktopInvokeResult<K>>;
};
