// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ChatSessionState,
  ConversationMutationResponse,
  HumanWorkspaceBootstrapResponse,
  Message,
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
const AGENT_ID = "40000000-0000-4000-8000-000000000004";
const WORKSPACE_ID = "40000000-0000-4000-8000-000000000010";
const GENERAL_ID = "40000000-0000-4000-8000-000000000020";
const PEER_DM_ID = "40000000-0000-4000-8000-000000000021";
const HUMANS_CHANNEL_ID = "40000000-0000-4000-8000-000000000022";
const HUMANS_THREAD_ROOT_ID = "40000000-0000-4000-8000-000000000023";
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
const agent: User = {
  ...user(AGENT_ID, "Hermes"),
  kind: "agent",
  username: "hermes",
};

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
    humansOnlyChannels: false,
  },
} as unknown as HumanWorkspaceBootstrapResponse;

const humansOnlyBootstrap = {
  ...bootstrap,
  members: [...bootstrap.members, agent],
  conversations: [
    ...bootstrap.conversations,
    {
      ...bootstrap.conversations[0],
      conversation: {
        ...bootstrap.conversations[0]!.conversation,
        id: HUMANS_CHANNEL_ID,
        name: "People Planning",
        slug: "people-planning",
        access: "humans",
      },
      participantIds: [USER_ID, PEER_ID],
    },
  ],
  featureFlags: { ...bootstrap.featureFlags, humansOnlyChannels: true },
} as unknown as HumanWorkspaceBootstrapResponse;

const humansThreadRoot: Message = {
  id: HUMANS_THREAD_ROOT_ID,
  conversationId: HUMANS_CHANNEL_ID,
  conversationSequence: "1",
  version: 1,
  clientMessageId: "40000000-0000-4000-8000-000000000024",
  authorId: PEER_ID,
  threadRootId: null,
  body: "People planning belongs here",
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

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

function createClient(workspaceBootstrap: HumanWorkspaceBootstrapResponse = bootstrap) {
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
    getWorkspaceBootstrap: async () => workspaceBootstrap,
    updateProfile: async () => currentUser,
    listWorkspaceMembers: async () => ({ members: workspaceBootstrap.members }),
    listAgentEnrollments: async () => ({ enrollments: [] }),
    reviewAgentEnrollment: async () => {
      throw new Error("unused");
    },
    cancelAgentEnrollment: async () => {
      throw new Error("unused");
    },
    listConversations: async () => ({
      conversations: workspaceBootstrap.conversations,
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
    getConversationMessages: async ({ conversationId }: { conversationId: string }) => ({
      messages: conversationId === HUMANS_CHANNEL_ID ? [humansThreadRoot] : [],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    }),
    getMessageById: async () => {
      throw new Error("unused");
    },
    getMessageThread: async () => ({
      root: humansThreadRoot,
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

async function renderWorkspace(
  workspaceBootstrap: HumanWorkspaceBootstrapResponse = bootstrap,
): Promise<DesktopApi> {
  const client = createClient(workspaceBootstrap);
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

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    const morganRow = screen.getByText("Morgan (you)").closest("li");
    expect(morganRow?.querySelector(".channel-member-title")?.textContent).toBe("Founder");
    const samRow = screen.getByText("Sam").closest("li");
    expect(samRow?.querySelector(".channel-member-title")?.textContent).toBe("Product");
    const taylorRow = screen.getByText("Taylor").closest("li");
    expect(taylorRow?.querySelector(".channel-member-title")).toBeNull();

    if (samRow === null) throw new Error("Sam directory row was not rendered");
    fireEvent.click(within(samRow).getByRole("button", { name: "Message" }));

    expect(client.createDirectConversation).toHaveBeenCalledWith({ memberId: PEER_ID });
  });

  it("opens a 1:1 from a People name click and dismisses the directory", async () => {
    const client = await renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(await screen.findByRole("heading", { name: "People" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "People" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Sam/ }));

    expect(client.createDirectConversation).toHaveBeenCalledTimes(1);
    expect(client.createDirectConversation).toHaveBeenCalledWith({ memberId: PEER_ID });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "People" })).toBeNull());
  });

  it("opens a 1:1 from a People row click and dismisses the directory", async () => {
    const client = await renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    const samRow = screen.getByText("Sam").closest("li");
    if (samRow === null) throw new Error("Sam directory row was not rendered");
    fireEvent.click(samRow);

    expect(client.createDirectConversation).toHaveBeenCalledTimes(1);
    expect(client.createDirectConversation).toHaveBeenCalledWith({ memberId: PEER_ID });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "People" })).toBeNull());
  });

  it("labels humans-only channels and excludes agents from their mention picker", async () => {
    await renderWorkspace(humansOnlyBootstrap);

    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    expect(screen.getByRole("radio", { name: /Humans only/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close channel creation" }));

    fireEvent.click(screen.getByRole("button", { name: /Humans-only channel: People Planning/u }));
    expect(screen.getByRole("button", { name: "Humans only" })).toBeTruthy();

    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.change(composer, {
      target: { value: "@", selectionStart: 1, selectionEnd: 1 },
    });

    expect(screen.getByRole("option", { name: /Morgan/u })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Sam/u })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Hermes/u })).toBeNull();

    fireEvent.change(composer, {
      target: { value: "", selectionStart: 0, selectionEnd: 0 },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reply in thread" }));
    const threadComposer = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Reply",
    });
    fireEvent.change(threadComposer, {
      target: { value: "@", selectionStart: 1, selectionEnd: 1 },
    });

    expect(screen.getByRole("option", { name: /Morgan/u })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Sam/u })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Hermes/u })).toBeNull();
  });
});

describe("owner administration", () => {
  it("opens agent enrollment requests for the workspace owner", async () => {
    const client = await renderWorkspace();
    const listAgentEnrollments = vi.spyOn(client, "listAgentEnrollments");
    const navigation = screen.getByRole("button", { name: "Agent requests" });

    fireEvent.click(navigation);

    await screen.findByRole("heading", { name: "Agent requests" });
    await waitFor(() => expect(listAgentEnrollments).toHaveBeenCalledTimes(1));
    expect(navigation.getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("agent-enrollments-view").hidden).toBe(false);
  });

  it("does not show agent enrollment requests to a workspace member", async () => {
    await renderWorkspace({
      ...bootstrap,
      currentUser: { ...bootstrap.currentUser, role: "member" },
    });

    expect(screen.queryByRole("button", { name: "Agent requests" })).toBeNull();
  });
});
