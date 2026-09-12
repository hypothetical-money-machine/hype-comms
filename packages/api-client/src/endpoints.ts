import * as c from "@hype-comms/contracts";
import type { z } from "zod";
import { ApiClientError } from "./errors.js";

function parse<S extends z.ZodType>(schema: S, value: z.input<S>): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiClientError("request", "The client produced an invalid API request");
  return parsed.data;
}
function id(value: string): string {
  return encodeURIComponent(parse(c.entityIdSchema, value));
}

/** Request definitions shared by desktop and CLI. Entity and payload types come from contracts. */
export const workspaceEndpoints = {
  agents: () => ({
    method: "GET" as const,
    path: "/v2/agents",
    responseSchema: c.listAgentsResponseSchema,
  }),
  invitations: () => ({
    method: "GET" as const,
    path: "/v2/invitations",
    responseSchema: c.listInvitationsResponseSchema,
  }),
  createInvitation: (body: z.input<typeof c.createInvitationSchema>) => ({
    method: "POST" as const,
    path: "/v2/invitations",
    responseSchema: c.invitationSchema,
    requestSchema: c.createInvitationSchema,
    body,
  }),
  removeInvitation: (invitationId: string) => ({
    method: "DELETE" as const,
    path: `/v2/invitations/${id(invitationId)}`,
  }),
  createAgent: (body: z.input<typeof c.createAgentRequestSchema>) => ({
    method: "POST" as const,
    path: "/v2/agents",
    responseSchema: c.createAgentResponseSchema,
    requestSchema: c.createAgentRequestSchema,
    body,
  }),
  removeAgent: (agentId: string) => ({
    method: "DELETE" as const,
    path: `/v2/agents/${id(agentId)}`,
  }),
  agentTokens: (agentId: string) => ({
    method: "GET" as const,
    path: `/v2/agents/${id(agentId)}/tokens`,
    responseSchema: c.listAgentTokensResponseSchema,
  }),
  createAgentToken: (agentId: string, body: z.input<typeof c.createAgentTokenRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/agents/${id(agentId)}/tokens`,
    responseSchema: c.createAgentTokenResponseSchema,
    requestSchema: c.createAgentTokenRequestSchema,
    body,
  }),
  removeAgentToken: (agentId: string, tokenId: string) => ({
    method: "DELETE" as const,
    path: `/v2/agents/${id(agentId)}/tokens/${id(tokenId)}`,
  }),
  requestMagicLink: (body: z.input<typeof c.requestMagicLinkSchema>) => ({
    method: "POST" as const,
    path: "/v2/auth/magic-link",
    responseSchema: c.magicLinkRequestedSchema,
    requestSchema: c.requestMagicLinkSchema,
    body,
  }),
  verifyMagicLink: (body: z.input<typeof c.verifyMagicLinkSchema>) => ({
    method: "POST" as const,
    path: "/v2/auth/session",
    responseSchema: c.currentUserSchema,
    requestSchema: c.verifyMagicLinkSchema,
    body,
  }),
  currentPrincipal: () => ({
    method: "GET" as const,
    path: "/v2/auth/me",
    responseSchema: c.currentPrincipalSchema,
  }),
  refreshSession: () => ({ method: "POST" as const, path: "/v2/auth/session/refresh" }),
  signOut: () => ({ method: "DELETE" as const, path: "/v2/auth/session" }),
  deviceSessions: () => ({
    method: "GET" as const,
    path: "/v2/auth/devices",
    responseSchema: c.deviceSessionSchema.array(),
  }),
  removeDeviceSession: (sessionId: string) => ({
    method: "DELETE" as const,
    path: `/v2/auth/devices/${id(sessionId)}`,
  }),
  requestAgentEnrollment: (body: z.input<typeof c.requestAgentEnrollmentSchema>) => ({
    method: "POST" as const,
    path: "/v2/agent-enrollments",
    responseSchema: c.agentEnrollmentResponseSchema,
    requestSchema: c.requestAgentEnrollmentSchema,
    body,
  }),
  redeemAgentEnrollment: (enrollmentId: string) => ({
    method: "POST" as const,
    path: `/v2/agent-enrollments/${id(enrollmentId)}/redeem`,
    responseSchema: c.redeemAgentEnrollmentResponseSchema,
  }),
  agentEnrollment: (enrollmentId: string) => ({
    method: "GET" as const,
    path: `/v2/agent-enrollments/${id(enrollmentId)}`,
    responseSchema: c.agentEnrollmentResponseSchema,
  }),
  agentEnrollmentPolicy: () => ({
    method: "GET" as const,
    path: "/v2/agent-enrollment-policy",
    responseSchema: c.agentEnrollmentPolicyResponseSchema,
  }),
  updateAgentEnrollmentPolicy: (
    body: z.input<typeof c.updateAgentEnrollmentPolicyRequestSchema>,
  ) => ({
    method: "PATCH" as const,
    path: "/v2/agent-enrollment-policy",
    responseSchema: c.agentEnrollmentPolicyResponseSchema,
    requestSchema: c.updateAgentEnrollmentPolicyRequestSchema,
    body,
  }),

  bootstrap: () => ({
    method: "GET" as const,
    path: `/v2/bootstrap`,
    responseSchema: c.workspaceBootstrapResponseSchema,
  }),
  humanBootstrap: () => ({
    method: "GET" as const,
    path: `/v2/bootstrap`,
    responseSchema: c.humanWorkspaceBootstrapResponseSchema,
  }),
  members: () => ({
    method: "GET" as const,
    path: `/v2/members`,
    responseSchema: c.listMembersResponseSchema,
  }),
  communicationPaths: () => ({
    method: "GET" as const,
    path: `/v2/admin/communication-paths`,
    responseSchema: c.communicationPathsResponseSchema,
  }),
  agentEnrollments: () => ({
    method: "GET" as const,
    path: `/v2/agent-enrollments`,
    responseSchema: c.listAgentEnrollmentsResponseSchema,
  }),
  reviewAgentEnrollment: (
    enrollmentId: string,
    body: z.input<typeof c.reviewAgentEnrollmentRequestSchema>,
  ) => ({
    method: "POST" as const,
    path: `/v2/agent-enrollments/${id(enrollmentId)}/review`,
    responseSchema: c.agentEnrollmentResponseSchema,
    requestSchema: c.reviewAgentEnrollmentRequestSchema,
    body,
  }),
  cancelAgentEnrollment: (enrollmentId: string) => ({
    method: "POST" as const,
    path: `/v2/agent-enrollments/${id(enrollmentId)}/cancel`,
    responseSchema: c.agentEnrollmentResponseSchema,
  }),
  updateProfile: (body: z.input<typeof c.updateProfileRequestSchema>) => ({
    method: "PATCH" as const,
    path: `/v2/profile`,
    responseSchema: c.updateProfileResponseSchema,
    requestSchema: c.updateProfileRequestSchema,
    body,
  }),
  conversations: (query: z.input<typeof c.listConversationsQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/conversations`,
    responseSchema: c.listConversationsResponseSchema,
    query: parse(c.listConversationsQuerySchema, query),
  }),
  publicChannels: (query: z.input<typeof c.listConversationsQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/channels`,
    responseSchema: c.listPublicChannelsResponseSchema,
    query: parse(c.listConversationsQuerySchema, query),
  }),
  createChannel: (body: z.input<typeof c.createChannelRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/channels`,
    responseSchema: c.conversationMutationResponseSchema,
    requestSchema: c.createChannelRequestSchema,
    body,
  }),
  archiveChannel: (
    conversationId: string,
    body: z.input<typeof c.archiveChannelRequestSchema>,
  ) => ({
    method: "PATCH" as const,
    path: `/v2/channels/${id(conversationId)}`,
    responseSchema: c.conversationMutationResponseSchema,
    requestSchema: c.archiveChannelRequestSchema,
    body,
  }),
  joinChannel: (conversationId: string) => ({
    method: "PUT" as const,
    path: `/v2/channels/${id(conversationId)}/membership`,
    responseSchema: c.conversationMutationResponseSchema,
  }),
  channelMembers: (conversationId: string) => ({
    method: "GET" as const,
    path: `/v2/channels/${id(conversationId)}/members`,
    responseSchema: c.channelMembersResponseSchema,
  }),
  upsertChannelMember: (
    conversationId: string,
    userId: string,
    body: z.input<typeof c.upsertChannelMemberRequestSchema>,
  ) => ({
    method: "PUT" as const,
    path: `/v2/channels/${id(conversationId)}/members/${id(userId)}`,
    responseSchema: c.channelMembershipMutationResponseSchema,
    requestSchema: c.upsertChannelMemberRequestSchema,
    body,
  }),
  removeChannelMember: (conversationId: string, userId: string) => ({
    method: "DELETE" as const,
    path: `/v2/channels/${id(conversationId)}/members/${id(userId)}`,
    responseSchema: c.channelMembershipMutationResponseSchema,
  }),
  directConversation: (body: z.input<typeof c.directConversationRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/direct-conversations`,
    responseSchema: c.conversationMutationResponseSchema,
    requestSchema: c.directConversationRequestSchema,
    body,
  }),
  groupDirectConversation: (body: z.input<typeof c.groupDirectConversationRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/group-direct-conversations`,
    responseSchema: c.conversationMutationResponseSchema,
    requestSchema: c.groupDirectConversationRequestSchema,
    body,
  }),
  history: (conversationId: string, query: z.input<typeof c.messageHistoryQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/conversations/${id(conversationId)}/messages`,
    responseSchema: c.messageHistoryResponseSchema,
    query: parse(c.messageHistoryQuerySchema, query),
  }),
  contextHistory: (
    conversationId: string,
    query: z.input<typeof c.agentContextHistoryQuerySchema>,
  ) => ({
    method: "GET" as const,
    path: `/v2/conversations/${id(conversationId)}/messages`,
    responseSchema: c.agentContextHistoryResponseSchema,
    query: parse(c.agentContextHistoryQuerySchema, query),
  }),
  thread: (messageId: string, query: z.input<typeof c.messageHistoryQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/messages/${id(messageId)}/thread`,
    responseSchema: c.messageThreadResponseSchema,
    query: parse(c.messageHistoryQuerySchema, query),
  }),
  message: (messageId: string) => ({
    method: "GET" as const,
    path: `/v2/messages/${id(messageId)}`,
    responseSchema: c.messageByIdResponseSchema,
  }),
  retractMessage: (messageId: string) => ({
    method: "DELETE" as const,
    path: `/v2/messages/${id(messageId)}`,
    responseSchema: c.retractMessageResponseSchema,
  }),
  sendMessage: (
    conversationId: string,
    body: z.input<typeof c.sendConversationMessageRequestSchema>,
  ) => ({
    method: "POST" as const,
    path: `/v2/conversations/${id(conversationId)}/messages`,
    responseSchema: c.sendMessageResponseSchema,
    requestSchema: c.sendConversationMessageRequestSchema,
    body,
  }),
  reactions: (body: z.input<typeof c.listMessageReactionsRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/reactions/query`,
    responseSchema: c.listMessageReactionsResponseSchema,
    requestSchema: c.listMessageReactionsRequestSchema,
    body,
  }),
  addReaction: (messageId: string, emoji: c.ReactionEmoji) => ({
    method: "PUT" as const,
    path: `/v2/messages/${id(messageId)}/reactions/${encodeURIComponent(emoji)}`,
    responseSchema: c.addReactionResponseSchema,
  }),
  removeReaction: (messageId: string, emoji: c.ReactionEmoji) => ({
    method: "DELETE" as const,
    path: `/v2/messages/${id(messageId)}/reactions/${encodeURIComponent(emoji)}`,
    responseSchema: c.removeReactionResponseSchema,
  }),
  search: (query: z.input<typeof c.messageSearchQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/search`,
    responseSchema: c.messageSearchResponseSchema,
    query: parse(c.messageSearchQuerySchema, query),
  }),
  tasks: (conversationId: string, query: z.input<typeof c.taskListQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/conversations/${id(conversationId)}/tasks`,
    responseSchema: c.taskListResponseSchema,
    query: parse(c.taskListQuerySchema, query),
  }),
  myTasks: (query: z.input<typeof c.taskListQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/tasks/mine`,
    responseSchema: c.taskListResponseSchema,
    query: parse(c.taskListQuerySchema, query),
  }),
  createTask: (conversationId: string, body: z.input<typeof c.createTaskRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/conversations/${id(conversationId)}/tasks`,
    responseSchema: c.taskMutationResponseSchema,
    requestSchema: c.createTaskRequestSchema,
    body,
  }),
  updateTask: (taskId: string, body: z.input<typeof c.updateTaskRequestSchema>) => ({
    method: "PATCH" as const,
    path: `/v2/tasks/${id(taskId)}`,
    responseSchema: c.taskMutationResponseSchema,
    requestSchema: c.updateTaskRequestSchema,
    body,
  }),
  moveTask: (taskId: string, body: z.input<typeof c.moveTaskRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/tasks/${id(taskId)}/move`,
    responseSchema: c.taskMutationResponseSchema,
    requestSchema: c.moveTaskRequestSchema,
    body,
  }),
  advanceRead: (
    conversationId: string,
    body: z.input<typeof c.advanceReadCursorRequestSchema>,
  ) => ({
    method: "PUT" as const,
    path: `/v2/conversations/${id(conversationId)}/read-cursor`,
    responseSchema: c.advanceReadCursorResponseSchema,
    requestSchema: c.advanceReadCursorRequestSchema,
    body,
  }),
  files: (conversationId: string, query: z.input<typeof c.conversationFilesQuerySchema>) => ({
    method: "GET" as const,
    path: `/v2/conversations/${id(conversationId)}/files`,
    responseSchema: c.conversationFilesResponseSchema,
    query: parse(c.conversationFilesQuerySchema, query),
  }),
  attachments: (body: z.input<typeof c.listMessageAttachmentsRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/attachments/query`,
    responseSchema: c.listMessageAttachmentsResponseSchema,
    requestSchema: c.listMessageAttachmentsRequestSchema,
    body,
  }),
  createUpload: (body: z.input<typeof c.createFileUploadRequestSchema>) => ({
    method: "POST" as const,
    path: `/v2/files/uploads`,
    responseSchema: c.createFileUploadResponseSchema,
    requestSchema: c.createFileUploadRequestSchema,
    body,
  }),
  completeUpload: (
    attachmentId: string,
    body: z.input<typeof c.completeFileUploadRequestSchema>,
  ) => ({
    method: "POST" as const,
    path: `/v2/files/${id(attachmentId)}/complete`,
    responseSchema: c.completeFileUploadResponseSchema,
    requestSchema: c.completeFileUploadRequestSchema,
    body,
  }),
  ticket: () => ({
    method: "POST" as const,
    path: `/v2/realtime/tickets`,
    responseSchema: c.realtimeTicketResponseSchema,
  }),
  sync: (after: c.SyncPosition, limit = 100) => ({
    method: "GET" as const,
    path: "/v2/sync",
    responseSchema: c.syncResponseSchema,
    query: {
      after: c.encodeSyncPosition(after),
      limit: parse(c.syncQuerySchema, { after: c.encodeSyncPosition(after), limit }).limit,
    },
  }),
  attachmentContent: (attachmentId: string) => `/v2/files/${id(attachmentId)}/content`,
};
