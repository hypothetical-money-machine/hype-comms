import type {
  AgentCurrentPrincipal,
  ConversationSummary,
  User,
  WorkspaceBootstrapResponse,
} from "@hype-comms/contracts";

export const TIMESTAMP = "2026-07-26T20:00:00.000Z";
export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const USER_ID = "22222222-2222-4222-8222-222222222222";
export const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
export const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
export const CLIENT_MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

export function user(
  overrides: Partial<Omit<User, "kind">> = {},
): User & { readonly kind: "agent" } {
  return {
    id: USER_ID,
    kind: "agent",
    username: "hermes",
    displayName: "Hermes",
    avatarUrl: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

export function agentPrincipal(): AgentCurrentPrincipal {
  return {
    type: "agent",
    user: user(),
    workspaceId: WORKSPACE_ID,
    role: "member",
    scopes: ["workspace:read", "messages:write"],
  };
}

export function channelSummary(): ConversationSummary {
  return {
    conversation: {
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name: "Launch Planning",
      slug: "launch-planning",
      topic: "Ship it",
      access: "workspace",
      channelMode: "chat",
      isArchived: false,
      createdBy: USER_ID,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    participantIds: [],
    membershipRole: null,
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

export function bootstrap(): WorkspaceBootstrapResponse {
  return {
    currentUser: agentPrincipal(),
    workspace: {
      id: WORKSPACE_ID,
      name: "Hype Comms",
      slug: "hype-comms",
      createdBy: USER_ID,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    members: [user()],
    conversations: [],
    conversationsNextCursor: null,
    conversationsHasMore: false,
    syncCursor: "5",
    featureFlags: {
      channels: true,
      directMessages: true,
      mentions: true,
      announcementChannels: false,
    },
  };
}
