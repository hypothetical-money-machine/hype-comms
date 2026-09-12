import type { DesktopInvokeHandlers } from "../shared/ipc-invoke-contract";
import type { WorkspaceTransport } from "./workspace-transport";

export type WorkspaceIpcTransport = Pick<
  WorkspaceTransport,
  | "members"
  | "updateProfile"
  | "communicationPaths"
  | "listAgentEnrollments"
  | "reviewAgentEnrollment"
  | "cancelAgentEnrollment"
  | "conversations"
  | "history"
  | "messageById"
  | "retractMessage"
  | "searchMessages"
  | "attachments"
  | "conversationFiles"
  | "tasks"
  | "myTasks"
  | "createTask"
  | "updateTask"
  | "moveTask"
  | "thread"
  | "reactions"
  | "addReaction"
  | "removeReaction"
  | "send"
  | "createChannel"
  | "archiveChannel"
  | "channelMembers"
  | "upsertChannelMember"
  | "removeChannelMember"
  | "createDirectConversation"
  | "sync"
>;
export type WorkspaceInvokeName =
  | "workspaceMembersList"
  | "workspaceProfileUpdate"
  | "workspaceAdminCommunicationPaths"
  | "workspaceAgentEnrollmentsList"
  | "workspaceAgentEnrollmentReview"
  | "workspaceAgentEnrollmentCancel"
  | "workspaceConversationsList"
  | "workspaceMessagesList"
  | "workspaceMessageGet"
  | "workspaceMessageRetract"
  | "workspaceMessageSearch"
  | "workspaceAttachmentsList"
  | "workspaceConversationFilesList"
  | "workspaceTasksList"
  | "workspaceMyTasksList"
  | "workspaceTaskCreate"
  | "workspaceTaskUpdate"
  | "workspaceTaskMove"
  | "workspaceMessageThread"
  | "workspaceReactionsList"
  | "workspaceReactionAdd"
  | "workspaceReactionRemove"
  | "workspaceMessageSend"
  | "workspaceChannelCreate"
  | "workspaceChannelArchive"
  | "workspaceChannelMembersList"
  | "workspaceChannelMemberUpsert"
  | "workspaceChannelMemberRemove"
  | "workspaceDirectCreate"
  | "workspaceSync";

export type RunWorkspaceOperation = <T>(
  operation: (transport: WorkspaceIpcTransport) => Promise<T>,
) => Promise<T>;

export function createWorkspaceInvokeHandlers(
  run: RunWorkspaceOperation,
): Pick<DesktopInvokeHandlers, WorkspaceInvokeName> {
  return {
    workspaceMembersList: async () => {
      return run((transport) => transport.members());
    },
    workspaceProfileUpdate: async (_context, title) => {
      return run(async (transport) => ({ user: await transport.updateProfile(title) }));
    },
    workspaceAdminCommunicationPaths: async () => {
      return run((transport) => transport.communicationPaths());
    },
    workspaceAgentEnrollmentsList: async () => {
      return run((transport) => transport.listAgentEnrollments());
    },
    workspaceAgentEnrollmentReview: async (_context, enrollmentId, decision) => {
      return run((transport) => transport.reviewAgentEnrollment(enrollmentId, decision));
    },
    workspaceAgentEnrollmentCancel: async (_context, enrollmentId) => {
      return run((transport) => transport.cancelAgentEnrollment(enrollmentId));
    },
    workspaceConversationsList: async (_context, input) => {
      return run((transport) => transport.conversations(input));
    },
    workspaceMessagesList: async (_context, input) => {
      return run((transport) =>
        transport.history({
          conversationId: input.conversationId,
          limit: input.limit,
          ...(input.before === undefined ? {} : { before: input.before }),
        }),
      );
    },
    workspaceMessageGet: async (_context, id) => {
      return run((transport) => transport.messageById(id));
    },
    workspaceMessageRetract: async (_context, id) => {
      return run((transport) => transport.retractMessage(id));
    },
    workspaceMessageSearch: async (_context, input) => {
      return run((transport) => transport.searchMessages(input));
    },
    workspaceAttachmentsList: async (_context, input) => {
      return run((transport) => transport.attachments(input.messageIds));
    },
    workspaceConversationFilesList: async (_context, input) => {
      return run((transport) => transport.conversationFiles(input.conversationId, input.query));
    },
    workspaceTasksList: async (_context, input) => {
      return run((transport) => transport.tasks(input.conversationId, input.query));
    },
    workspaceMyTasksList: async (_context, input) => {
      return run((transport) => transport.myTasks(input));
    },
    workspaceTaskCreate: async (_context, input) => {
      return run((transport) => transport.createTask(input));
    },
    workspaceTaskUpdate: async (_context, input) => {
      return run((transport) => transport.updateTask(input));
    },
    workspaceTaskMove: async (_context, input) => {
      return run((transport) => transport.moveTask(input));
    },
    workspaceMessageThread: async (_context, input) => {
      return run((transport) => transport.thread(input));
    },
    workspaceReactionsList: async (_context, input) => {
      return run((transport) => transport.reactions(input.messageIds));
    },
    workspaceReactionAdd: async (_context, input) => {
      return run((transport) => transport.addReaction(input.messageId, input.emoji));
    },
    workspaceReactionRemove: async (_context, input) => {
      return run((transport) => transport.removeReaction(input.messageId, input.emoji));
    },
    workspaceMessageSend: async (_context, input) => {
      return run((transport) => transport.send(input));
    },
    workspaceChannelCreate: async (_context, input) => {
      return run((transport) => transport.createChannel(input));
    },
    workspaceChannelArchive: async (_context, id) => {
      return run((transport) => transport.archiveChannel(id, { isArchived: true }));
    },
    workspaceChannelMembersList: async (_context, id) => {
      return run((transport) => transport.channelMembers(id));
    },
    workspaceChannelMemberUpsert: async (_context, value) => {
      return run((transport) =>
        transport.upsertChannelMember(value.conversationId, value.userId, {
          role: value.role,
        }),
      );
    },
    workspaceChannelMemberRemove: async (_context, value) => {
      return run((transport) => transport.removeChannelMember(value.conversationId, value.userId));
    },
    workspaceDirectCreate: async (_context, input) => {
      return run((transport) => transport.createDirectConversation(input));
    },
    workspaceSync: async (_context, after) => {
      return run((transport) => transport.sync(after));
    },
  };
}
