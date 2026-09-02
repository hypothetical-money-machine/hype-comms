// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  AiChannelState,
  ChatSessionState,
  HumanWorkspaceBootstrapResponse,
  Message,
  NotificationContext,
  NotificationState,
  ProductRealtimeEvent,
  RealtimeSessionScope,
  ScopedProductRealtimeEvent,
  ThemeState,
  UpdateState,
} from "@hype-comms/contracts";
import { SYSTEM_USER_ID } from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const ATHENA_ID = "30000000-0000-4000-8000-000000000009";
const GROUP_DM_ID = "30000000-0000-4000-8000-00000000000a";
const RELEASE_NOTES_ID = "30000000-0000-4000-8000-00000000000b";
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
    {
      id: ATHENA_ID,
      kind: "agent",
      username: "athena",
      displayName: "Athena",
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
    {
      conversation: {
        id: GROUP_DM_ID,
        workspaceId: WORKSPACE_ID,
        kind: "group_direct_message",
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
      participantIds: [USER_ID, DAN_ID, ATHENA_ID],
      membershipRole: "owner",
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

interface ClientHarness {
  readonly client: DesktopApi;
  readonly emitWorkspaceEvent: (event: ProductRealtimeEvent) => void;
  readonly signOut: () => Promise<{ readonly status: "signed-out" }>;
}

function createClient(
  bootstrapResponse: HumanWorkspaceBootstrapResponse = bootstrap,
): ClientHarness {
  let realtimeStarts = 0;
  let realtimeScope: RealtimeSessionScope | null = null;
  const eventListeners = new Set<(frame: ScopedProductRealtimeEvent) => void>();
  const signOut = vi
    .fn<() => Promise<{ readonly status: "signed-out" }>>()
    .mockResolvedValue({ status: "signed-out" });
  const client = {
    platform: "linux",
    isHeadless: true,
    getSessionState: async () => session,
    retrySession: async () => session,
    onSessionChanged: () => () => undefined,
    signOut,
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
    getWorkspaceBootstrap: async () => bootstrapResponse,
    listWorkspaceMembers: async () => ({ members: bootstrapResponse.members }),
    listConversations: async () => ({
      conversations: bootstrapResponse.conversations,
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
      realtimeScope = Object.freeze({
        userId: session.userId,
        workspaceId: session.workspaceId,
        epoch: realtimeStarts,
      });
      return realtimeScope;
    },
    activateWorkspaceRealtime: async () => undefined,
    stopWorkspaceRealtime: async () => undefined,
    acknowledgeWorkspaceEvent: async () => undefined,
    getRealtimeState: async () => "offline",
    onRealtimeStateChanged: () => () => undefined,
    onWorkspaceEvent: (listener: (frame: ScopedProductRealtimeEvent) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
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
  return {
    client,
    signOut,
    emitWorkspaceEvent: (event: ProductRealtimeEvent): void => {
      if (realtimeScope === null) return;
      for (const listener of eventListeners) listener({ scope: realtimeScope, event });
    },
  };
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
  bootstrapResponse: HumanWorkspaceBootstrapResponse = bootstrap,
): Promise<ClientHarness> {
  const client = createClient(bootstrapResponse);
  render(
    createElement(App, {
      client: client.client,
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

// Authored by the system user, which never appears in the member directory.
const bulletin = {
  ...message(
    RELEASE_NOTES_ID,
    "30000000-0000-4000-8000-00000000000c",
    "**Hype Comms v0.1.36**\n\n## Highlights\n\n- Humans-only channels",
  ),
  authorId: SYSTEM_USER_ID,
};

const releaseNotesSummary = {
  conversation: {
    id: RELEASE_NOTES_ID,
    workspaceId: WORKSPACE_ID,
    kind: "channel",
    name: "Release notes",
    slug: "hype/release-notes",
    topic: "What changed in each Hype Comms release, posted by the app.",
    access: "workspace",
    channelMode: "announcement",
    isBuiltIn: true,
    isArchived: false,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  participantIds: [USER_ID, DAN_ID],
  membershipRole: null,
  lastMessage: bulletin,
  unreadCount: 1,
  mentionCount: 0,
  readCursor: null,
};

const withBuiltInChannel = {
  ...bootstrap,
  conversations: [...bootstrap.conversations, releaseNotesSummary],
} as unknown as HumanWorkspaceBootstrapResponse;

describe("built-in channels", () => {
  it("lists a built-in channel in its own sidebar section, not among member channels", async () => {
    await renderWorkspace(withBuiltInChannel);

    // The Channels heading also holds the create-channel control, so match on its leading label.
    const sections = [...document.querySelectorAll(".nav-heading")].map(
      (node) => node.querySelector("span")?.textContent?.trim() ?? "",
    );
    expect(sections).toContain("Built-in");
    // The built-in section is listed ahead of the member-created channels, not inside them.
    expect(sections.indexOf("Built-in")).toBeLessThan(sections.indexOf("Channels"));

    const releaseNotes = screen.getByRole("button", { name: /Release notes/u });
    expect(within(releaseNotes).getByText("Built-in")).not.toBeNull();
  });

  it("refuses the composer to an owner and explains who posts there", async () => {
    await renderWorkspace(withBuiltInChannel);

    fireEvent.click(screen.getByRole("button", { name: /Release notes/u }));

    expect(screen.getByRole("heading", { level: 2, name: /Release notes/u })).not.toBeNull();
    expect(
      screen.getByText(
        "Hype Comms posts release notes here. Everyone can reply in threads and react.",
      ),
    ).not.toBeNull();

    // The signed-in user is a workspace owner, who may publish in an ordinary announcement channel.
    const notice = screen.getByRole("note", { name: "Announcement posting restricted" });
    expect(within(notice).getByText("Only Hype Comms posts in this channel")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Bulletin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Post bulletin" })).toBeNull();
  });

  it("does not offer to archive a built-in channel", async () => {
    await renderWorkspace(withBuiltInChannel);

    fireEvent.click(screen.getByRole("button", { name: /Release notes/u }));
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();

    // An ordinary channel still offers it to the same owner.
    fireEvent.click(screen.getByRole("button", { name: /Launch Planning/u }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Archive" })).not.toBeNull();
    });
  });

  it("keeps the sidebar free of a Built-in section when no built-in channel exists", async () => {
    await renderWorkspace();

    const sections = [...document.querySelectorAll(".nav-heading")].map(
      (node) => node.querySelector("span")?.textContent?.trim() ?? "",
    );
    expect(sections).not.toContain("Built-in");
    expect(document.querySelector(".built-in-channel-badge")).toBeNull();
  });
});
