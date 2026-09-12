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

export function createWorkspaceInvokeHandlers(
  getTransport: () => WorkspaceIpcTransport | null,
): Pick<DesktopInvokeHandlers, WorkspaceInvokeName> {
  const transport = (): WorkspaceIpcTransport => {
    const current = getTransport();
    if (current === null) throw new Error("Workspace transport is unavailable");
    return current;
  };
  return {
    workspaceMembersList: async () => {
      return transport().members();
    },
    workspaceProfileUpdate: async (_context, title) => {
      return { user: await transport().updateProfile(title) };
    },
    workspaceAdminCommunicationPaths: async () => {
      return transport().communicationPaths();
    },
    workspaceAgentEnrollmentsList: async () => {
      return transport().listAgentEnrollments();
    },
    workspaceAgentEnrollmentReview: async (_context, enrollmentId, decision) => {
      return transport().reviewAgentEnrollment(enrollmentId, decision);
    },
    workspaceAgentEnrollmentCancel: async (_context, enrollmentId) => {
      return transport().cancelAgentEnrollment(enrollmentId);
    },
    workspaceConversationsList: async (_context, input) => {
      return transport().conversations(input);
    },
    workspaceMessagesList: async (_context, input) => {
      return transport().history(input);
    },
    workspaceMessageGet: async (_context, id) => {
      return transport().messageById(id);
    },
    workspaceMessageRetract: async (_context, id) => {
      return transport().retractMessage(id);
    },
    workspaceMessageSearch: async (_context, input) => {
      return transport().searchMessages(input);
    },
    workspaceAttachmentsList: async (_context, input) => {
      return transport().attachments(input.messageIds);
    },
    workspaceConversationFilesList: async (_context, input) => {
      return transport().conversationFiles(input.conversationId, input.query);
    },
    workspaceTasksList: async (_context, input) => {
      return transport().tasks(input.conversationId, input.query);
    },
    workspaceMyTasksList: async (_context, input) => {
      return transport().myTasks(input);
    },
    workspaceTaskCreate: async (_context, input) => {
      return transport().createTask(input);
    },
    workspaceTaskUpdate: async (_context, input) => {
      return transport().updateTask(input);
    },
    workspaceTaskMove: async (_context, input) => {
      return transport().moveTask(input);
    },
    workspaceMessageThread: async (_context, input) => {
      return transport().thread(input);
    },
    workspaceReactionsList: async (_context, input) => {
      return transport().reactions(input.messageIds);
    },
    workspaceReactionAdd: async (_context, input) => {
      return transport().addReaction(input.messageId, input.emoji);
    },
    workspaceReactionRemove: async (_context, input) => {
      return transport().removeReaction(input.messageId, input.emoji);
    },
    workspaceMessageSend: async (_context, input) => {
      return transport().send(input);
    },
    workspaceChannelCreate: async (_context, input) => {
      return transport().createChannel(input);
    },
    workspaceChannelArchive: async (_context, id) => {
      return transport().archiveChannel(id, { isArchived: true });
    },
    workspaceChannelMembersList: async (_context, id) => {
      return transport().channelMembers(id);
    },
    workspaceChannelMemberUpsert: async (_context, value) => {
      return transport().upsertChannelMember(value.conversationId, value.userId, {
        role: value.role,
      });
    },
    workspaceChannelMemberRemove: async (_context, value) => {
      return transport().removeChannelMember(value.conversationId, value.userId);
    },
    workspaceDirectCreate: async (_context, input) => {
      return transport().createDirectConversation(input);
    },
    workspaceSync: async (_context, after) => {
      return transport().sync(after);
    },
  };
}
