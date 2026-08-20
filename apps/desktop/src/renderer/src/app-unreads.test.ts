// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  AiChannelState,
  ChatSessionState,
  HumanWorkspaceBootstrapResponse,
  Message,
  NotificationContext,
  NotificationState,
  RealtimeSessionScope,
  ThemeState,
  UpdateState,
} from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopApi } from "../../shared/desktop-api";
import { App } from "./App";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import type { SidebarPositionRuntime } from "./sidebar-position-runtime";
import type { ThemeRuntime } from "./theme-runtime";

const USER_ID = "30000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000002";
const GENERAL_ID = "30000000-0000-4000-8000-000000000003";
const LAUNCH_ID = "30000000-0000-4000-8000-000000000004";
const DAN_ID = "30000000-0000-4000-8000-000000000005";
const DAN_DM_ID = "30000000-0000-4000-8000-000000000006";
const NOW = "2026-08-20T12:00:00.000Z";

const session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  status: "signed-in",
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

function message(conversationId: string, id: string, body: string): Message {
  return {
    id,
    conversationId,
    conversationSequence: "1",
    version: 1,
    clientMessageId: `${id.slice(0, -1)}9`,
    authorId: DAN_ID,
    threadRootId: null,
    body,
    bodyFormat: "hype_comms_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const launchMessage = message(
  LAUNCH_ID,
  "30000000-0000-4000-8000-000000000007",
  "@morgan can you look at the cut?",
);
const danMessage = message(
  DAN_DM_ID,
  "30000000-0000-4000-8000-000000000008",
  "Dogfood notes from standup",
);

const bootstrap = {
  currentUser: {
    user: {
      id: USER_ID,
      kind: "human",
      username: "morgan",
      displayName: "Morgan",
      avatarUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
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
  members: [
    {
      id: DAN_ID,
      kind: "human",
      username: "dan",
      displayName: "Dan",
      avatarUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
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
      participantIds: [USER_ID, DAN_ID],
      membershipRole: null,
      lastMessage: null,
      unreadCount: 0,
      mentionCount: 0,
      readCursor: null,
    },
    {
      conversation: {
        id: LAUNCH_ID,
        workspaceId: WORKSPACE_ID,
        kind: "channel",
        name: "Launch Planning",
        slug: "launch-planning",
        topic: null,
        access: "workspace",
        channelMode: "chat",
        isArchived: false,
        createdBy: USER_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
      participantIds: [USER_ID, DAN_ID],
      membershipRole: null,
      lastMessage: launchMessage,
      unreadCount: 3,
      mentionCount: 1,
      readCursor: null,
    },
    {
      conversation: {
        id: DAN_DM_ID,
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
      participantIds: [USER_ID, DAN_ID],
      membershipRole: null,
      lastMessage: danMessage,
      unreadCount: 2,
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

const aiChannelState: AiChannelState = {
  version: 1,
  generation: 1,
  status: "configured",
  workspaceName: "hype-comms",
  entries: [],
  plan: [],
  permissionRequest: null,
  error: null,
};

const activeContext: Extract<NotificationContext, { status: "active" }> = {
  version: 1,
  status: "active",
  sessionGeneration: 4,
  rendererSessionGeneration: 2,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

function createClient(): DesktopApi {
  let realtimeStarts = 0;
  return {
    platform: "linux",
    isHeadless: true,
    getSessionState: async () => session,
    onSessionChanged: () => () => undefined,
    signOut: async () => ({ status: "signed-out" }) as const,
    getAppVersion: async () => "0.1.29-test",
    getUpdateState: async (): Promise<UpdateState> => ({ status: "idle" }),
    checkForUpdates: async () => undefined,
    restartToInstallUpdate: async () => undefined,
    onUpdateStateChanged: () => () => undefined,
    initializeCacheCrypto: async (scope: {
      readonly userId: string;
      readonly workspaceId: string;
    }) => ({ mode: "memory_only", scope, reason: "credential_store_unavailable" }) as const,
    getWorkspaceBootstrap: async () => bootstrap,
    listWorkspaceMembers: async () => ({ members: bootstrap.members }),
    listConversations: async () => ({
      conversations: bootstrap.conversations,
      nextCursor: null,
      hasMore: false,
    }),
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
      root: launchMessage,
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
    getAiChannelState: async () => aiChannelState,
    startAiChannel: async () => aiChannelState,
    chooseAiChannelWorkspace: async () => aiChannelState,
    newAiChannelSession: async () => aiChannelState,
    sendAiChannelPrompt: async () => aiChannelState,
    cancelAiChannelPrompt: async () => aiChannelState,
    respondAiChannelPermission: async () => aiChannelState,
    onAiChannelStateChanged: () => () => undefined,
  } as unknown as DesktopApi;
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

async function renderWorkspace(): Promise<void> {
  render(
    createElement(App, {
      client: createClient(),
      theme: createTheme(),
      compactMode: createCompactMode(),
      fencedBlockquotes: new FencedBlockquoteRuntime(null),
      sidebarPosition: createSidebarPosition(),
    }),
  );
  await screen.findByTestId("workspace-ready");
}

afterEach(() => cleanup());

describe("in-app Unreads destination", () => {
  it("opens the Unreads list from the sidebar and jumps to a conversation", async () => {
    await renderWorkspace();

    const unreadsNav = screen.getByRole("button", { name: /Unreads.*1 mention/u });
    expect(unreadsNav.getAttribute("aria-current")).toBeNull();
    fireEvent.click(unreadsNav);

    expect(
      screen.getByRole("button", { name: /Unreads.*1 mention/u }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByTestId("unreads-view").hidden).toBe(false);
    expect(screen.getByRole("heading", { name: "Mentions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unread" })).toBeTruthy();
    expect(document.querySelector(".conversation-pane")?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: /Dan.*Direct message.*2 unread messages/u }),
    );

    expect(screen.getByTestId("unreads-view").hidden).toBe(true);
    expect(document.querySelector(".conversation-pane")?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("heading", { name: "Dan" })).toBeTruthy();
  });
});
