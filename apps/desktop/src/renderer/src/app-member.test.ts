// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ChatSessionState,
  ConversationMutationResponse,
  HumanWorkspaceBootstrapResponse,
  NotificationContext,
  NotificationState,
  RealtimeSessionScope,
  ThemeState,
  UpdateState,
  User,
} from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../shared/desktop-api";
import { App } from "./App";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import type { SidebarPositionRuntime } from "./sidebar-position-runtime";
import type { ThemeRuntime } from "./theme-runtime";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const PEER_ID = "40000000-0000-4000-8000-000000000002";
const OTHER_ID = "40000000-0000-4000-8000-000000000003";
const WORKSPACE_ID = "40000000-0000-4000-8000-000000000010";
const GENERAL_ID = "40000000-0000-4000-8000-000000000020";
const PEER_DM_ID = "40000000-0000-4000-8000-000000000021";
const NOW = "2026-08-23T12:00:00.000Z";

const session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  status: "signed-in",
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

function user(id: string, displayName: string, title?: string | null): User {
  return {
    id,
    kind: "human",
    username: displayName.toLowerCase(),
    displayName,
    avatarUrl: null,
    title: title ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const currentUser = user(USER_ID, "Morgan", "Founder");
const peer = user(PEER_ID, "Sam", "Product");
const other = user(OTHER_ID, "Taylor");

const bootstrap = {
  currentUser: {
    user: currentUser,
    email: session.email,
    workspaceId: WORKSPACE_ID,
    role: "owner",
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "Hype Comms",
    slug: "hype-comms",
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [currentUser, peer, other],
  conversations: [
    {
      conversation: {
        id: GENERAL_ID,
        workspaceId: WORKSPACE_ID,
        kind: "channel",
        name: "General",
        slug: "general",
        topic: null,
        access: "workspace",
        channelMode: "chat",
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
      participantIds: [USER_ID, PEER_ID, OTHER_ID],
      membershipRole: null,
      lastMessage: null,
      unreadCount: 0,
      mentionCount: 0,
      readCursor: null,
    },
  ],
  conversationsNextCursor: null,
  conversationsHasMore: false,
  syncCursor: "10",
  featureFlags: {
    channels: true,
    directMessages: true,
    mentions: true,
    announcementChannels: false,
  },
} as unknown as HumanWorkspaceBootstrapResponse;

const notificationState: NotificationState = {
  version: 1,
  devicePreference: "enabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "granted",
};

const activeContext: Extract<NotificationContext, { status: "active" }> = {
  version: 1,
  status: "active",
  sessionGeneration: 1,
  rendererSessionGeneration: 1,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

function createClient() {
  let realtimeStarts = 0;
  const createDirectConversation = vi.fn(async (): Promise<ConversationMutationResponse> => ({
    conversation: {
      conversation: {
        id: PEER_DM_ID,
        workspaceId: WORKSPACE_ID,
        kind: "direct_message",
        name: null,
        slug: null,
        topic: null,
        access: null,
        channelMode: null,
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
      participantIds: [USER_ID, PEER_ID],
      membershipRole: null,
      lastMessage: null,
      unreadCount: 0,
      mentionCount: 0,
      readCursor: null,
    },
    syncCursor: "11",
  }));

  const client = {
    platform: "linux",
    isHeadless: true,
    getSessionState: async () => session,
    retrySession: async () => session,
    onSessionChanged: () => () => undefined,
    signOut: async () => ({ status: "signed-out" }) as const,
    getAppVersion: async () => "0.1.29-test",
    getUpdateState: async (): Promise<UpdateState> => ({ status: "idle" }),
    checkForUpdates: async () => undefined,
    restartToInstallUpdate: async () => undefined,
    onUpdateStateChanged: () => () => undefined,
    initializeCacheCrypto: async () =>
      ({
        mode: "memory_only",
        scope: { userId: USER_ID, workspaceId: WORKSPACE_ID },
        reason: "credential_store_unavailable",
      }) as const,
    getWorkspaceBootstrap: async () => bootstrap,
    updateProfile: async () => currentUser,
    listWorkspaceMembers: async () => ({ members: bootstrap.members }),
    listConversations: async () => ({
      conversations: bootstrap.conversations,
      nextCursor: null,
      hasMore: false,
    }),
    createChannel: async () => {
      throw new Error("unused");
    },
    archiveChannel: async () => {
      throw new Error("unused");
    },
    getChannelMembers: async () => {
      throw new Error("unused");
    },
    upsertChannelMember: async () => {
      throw new Error("unused");
    },
    removeChannelMember: async () => {
      throw new Error("unused");
    },
    createDirectConversation,
    getConversationMessages: async () => ({
      messages: [],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    }),
    getMessageById: async () => {
      throw new Error("unused");
    },
    getMessageThread: async () => ({
      root: null,
      replies: [],
      nextCursor: null,
    }),
    listMessageReactions: async () => ({ reactions: [] }),
    searchMessages: async () => ({ results: [], nextCursor: null }),
    listConversationTasks: async () => ({ tasks: [], nextCursor: null, hasMore: false }),
    listMyTasks: async () => ({ tasks: [], nextCursor: null, hasMore: false }),
    advanceReadCursor: async () => undefined,
    syncWorkspace: async (after: string) =>
      ({
        status: "accepted",
        response: { events: [], nextCursor: after, highWaterCursor: after, hasMore: false },
      }) as const,
    startWorkspaceRealtime: async (): Promise<RealtimeSessionScope> => {
      realtimeStarts += 1;
      return Object.freeze({
        userId: session.userId,
        workspaceId: session.workspaceId,
        epoch: realtimeStarts,
      });
    },
    activateWorkspaceRealtime: async () => undefined,
    stopWorkspaceRealtime: async () => undefined,
    acknowledgeWorkspaceEvent: async () => undefined,
    getRealtimeState: async () => "offline",
    onRealtimeStateChanged: () => () => undefined,
    onWorkspaceEvent: () => () => undefined,
    getNotificationContext: async (): Promise<NotificationContext> => activeContext,
    reportNotificationActivity: async () => undefined,
    drainNotificationActions: async (ready: unknown) => ({
      ...(ready as Record<string, unknown>),
      actions: [],
    }),
    acknowledgeNotificationAction: async () => undefined,
    onNotificationAction: () => () => undefined,
    getNotificationState: async () => notificationState,
    setNotificationPreference: async () => notificationState,
    refreshNotificationCapability: async () => notificationState,
    onNotificationStateChanged: () => () => undefined,
    getAiChannelState: async () => ({
      version: 1,
      generation: 1,
      status: "configured",
      workspaceName: "hype-comms",
      entries: [],
      plan: [],
      permissionRequest: null,
      error: null,
    }),
    startAiChannel: async () => {
      throw new Error("unused");
    },
    chooseAiChannelWorkspace: async () => {
      throw new Error("unused");
    },
    newAiChannelSession: async () => {
      throw new Error("unused");
    },
    sendAiChannelPrompt: async () => {
      throw new Error("unused");
    },
    cancelAiChannelPrompt: async () => {
      throw new Error("unused");
    },
    respondAiChannelPermission: async () => {
      throw new Error("unused");
    },
    onAiChannelStateChanged: () => () => undefined,
  } as unknown as DesktopApi;

  return client;
}

function createTheme(): ThemeRuntime {
  const state: ThemeState = {
    preference: "system",
    resolvedThemeId: "dark",
    resolvedColorScheme: "dark",
  };
  return {
    state,
    subscribe: () => () => undefined,
    setPreference: async () => state,
  } as unknown as ThemeRuntime;
}

function createCompactMode(): CompactModeRuntime {
  return {
    enabled: false,
    subscribe: () => () => undefined,
    toggle: async () => false,
  } as unknown as CompactModeRuntime;
}

function createSidebarPosition(): SidebarPositionRuntime {
  return {
    position: "left",
    subscribe: () => () => undefined,
    setPosition: () => undefined,
  } as unknown as SidebarPositionRuntime;
}

async function renderWorkspace(): Promise<DesktopApi> {
  const client = createClient();
  render(
    createElement(App, {
      client,
      theme: createTheme(),
      compactMode: createCompactMode(),
      fencedBlockquotes: new FencedBlockquoteRuntime(null),
      sidebarPosition: createSidebarPosition(),
    }),
  );
  await screen.findByTestId("workspace-ready");
  return client;
}

afterEach(() => cleanup());

describe("workspace member directory", () => {
  it("renders member titles when present and starts a direct message", async () => {
    const client = await renderWorkspace();

    const morganButton = screen.getByRole("button", { name: /Morgan/u });
    expect(morganButton.querySelector(".member-title")?.textContent).toBe("Founder");
    const samButton = screen.getByRole("button", { name: /Sam/u });
    expect(samButton.querySelector(".member-title")?.textContent).toBe("Product");
    const taylorButton = screen.getByRole("button", { name: /Taylor/u });
    expect(taylorButton.querySelector(".member-title")).toBeNull();

    fireEvent.click(samButton);

    expect(client.createDirectConversation).toHaveBeenCalledWith({ memberId: PEER_ID });
  });
});
