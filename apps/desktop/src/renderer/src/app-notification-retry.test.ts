// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ChatSessionState,
  HumanWorkspaceBootstrapResponse,
  Message,
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainRequest,
  NotificationActivityUpdate,
  NotificationContext,
  NotificationState,
  RealtimeSessionScope,
  ThemeState,
  UpdateState,
} from "@hmm-chat/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopApi } from "../../shared/desktop-api";
import { App } from "./App";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import type { ThemeRuntime } from "./theme-runtime";

const USER_ID = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "20000000-0000-4000-8000-000000000004";
const NOW = "2026-08-10T12:00:00.000Z";

const session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  status: "signed-in",
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

const bootstrap: HumanWorkspaceBootstrapResponse = {
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
    slug: "hmm-chat",
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  members: [],
  conversations: [],
  conversationsNextCursor: null,
  conversationsHasMore: false,
  syncCursor: "10",
  featureFlags: {
    channels: true,
    directMessages: true,
    mentions: true,
    announcementChannels: false,
  },
};

const channelBootstrap: HumanWorkspaceBootstrapResponse = {
  ...bootstrap,
  conversations: [
    {
      conversation: {
        id: CONVERSATION_ID,
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
      participantIds: [],
      membershipRole: null,
      lastMessage: null,
      unreadCount: 0,
      mentionCount: 0,
      readCursor: null,
    },
  ],
};

const activeContext: Extract<NotificationContext, { status: "active" }> = {
  version: 1,
  status: "active",
  sessionGeneration: 4,
  rendererSessionGeneration: 2,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

const notificationMessage: Message = {
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  conversationSequence: "1",
  version: 1,
  clientMessageId: "20000000-0000-4000-8000-000000000005",
  authorId: USER_ID,
  threadRootId: null,
  body: "Recovered notification target",
  bodyFormat: "hmm_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const notificationAction: NotificationAction = {
  version: 1,
  type: "open-message",
  sessionGeneration: activeContext.sessionGeneration,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  threadRootId: null,
};

const notificationState: NotificationState = {
  version: 1,
  devicePreference: "enabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "granted",
};

interface RetryHarness {
  readonly client: DesktopApi;
  readonly activities: NotificationActivityUpdate[];
  readonly drains: NotificationActionDrainRequest[];
  readonly acknowledgements: NotificationActionAcknowledgement[];
  readonly contextRequests: number;
  readonly bootstrapRequests: number;
  readonly realtimeStarts: number;
  readonly messageRequests: number;
  readonly reactionHydrations: number;
  readonly emitSession: (next: ChatSessionState) => void;
  readonly releaseFirstActivity: () => void;
  readonly releaseFirstMessage: () => void;
}

interface RetryHarnessOptions {
  readonly failFirstBootstrap?: boolean;
  readonly bootstrap?: HumanWorkspaceBootstrapResponse;
  readonly delayFirstActivity?: boolean;
  readonly delayFirstMessage?: boolean;
  readonly notificationAction?: NotificationAction;
}

function createRetryHarness(options: RetryHarnessOptions = {}): RetryHarness {
  let bootstrapRequests = 0;
  let contextRequests = 0;
  let realtimeStarts = 0;
  let messageRequests = 0;
  let reactionHydrations = 0;
  let releaseFirstActivity = (): void => undefined;
  const firstActivity = new Promise<void>((resolve) => {
    releaseFirstActivity = resolve;
  });
  let releaseFirstMessage = (): void => undefined;
  const firstMessage = new Promise<{ readonly message: Message }>((resolve) => {
    releaseFirstMessage = () => resolve({ message: notificationMessage });
  });
  const activities: NotificationActivityUpdate[] = [];
  const drains: NotificationActionDrainRequest[] = [];
  const acknowledgements: NotificationActionAcknowledgement[] = [];
  const sessionListeners = new Set<(next: ChatSessionState) => void>();
  const failFirstBootstrap = options.failFirstBootstrap ?? true;
  const bootstrapResponse = options.bootstrap ?? bootstrap;

  const client = {
    platform: "linux",
    isHeadless: true,
    getSessionState: async () => session,
    onSessionChanged: (listener: (next: ChatSessionState) => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    signOut: async () => ({ status: "signed-out" }) as const,
    getAppVersion: async () => "0.1.21-test",
    getUpdateState: async (): Promise<UpdateState> => ({ status: "idle" }),
    checkForUpdates: async () => undefined,
    restartToInstallUpdate: async () => undefined,
    onUpdateStateChanged: () => () => undefined,
    initializeCacheCrypto: async (scope: {
      readonly userId: string;
      readonly workspaceId: string;
    }) => ({ mode: "memory_only", scope, reason: "credential_store_unavailable" }) as const,
    getWorkspaceBootstrap: async () => {
      bootstrapRequests += 1;
      if (failFirstBootstrap && bootstrapRequests === 1) {
        throw new Error("The workspace is temporarily unavailable");
      }
      return bootstrapResponse;
    },
    getConversationMessages: async () => ({
      messages: [],
      threadSummaries: [],
      threadsSupported: true,
      nextCursor: null,
    }),
    getMessageById: async () => {
      messageRequests += 1;
      if (options.delayFirstMessage === true && messageRequests === 1) return firstMessage;
      return { message: notificationMessage };
    },
    listMessageReactions: async () => {
      reactionHydrations += 1;
      return { reactions: [] };
    },
    listConversationTasks: async () => ({ tasks: [], nextCursor: null, hasMore: false }),
    syncWorkspace: async (after: string) =>
      ({
        status: "accepted",
        response: {
          events: [],
          nextCursor: after,
          highWaterCursor: after,
          hasMore: false,
        },
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
    onRealtimeStateChanged: () => () => undefined,
    onWorkspaceEvent: () => () => undefined,
    getNotificationContext: async (): Promise<NotificationContext> => {
      contextRequests += 1;
      return failFirstBootstrap && contextRequests === 1
        ? {
            version: 1,
            status: "inactive",
            sessionGeneration: null,
            rendererSessionGeneration: activeContext.rendererSessionGeneration,
            userId: null,
            workspaceId: null,
          }
        : activeContext;
    },
    reportNotificationActivity: async (activity: NotificationActivityUpdate) => {
      activities.push(activity);
      if (options.delayFirstActivity === true && activities.length === 1) {
        await firstActivity;
      }
    },
    drainNotificationActions: async (ready: NotificationActionDrainRequest) => {
      drains.push(ready);
      return {
        ...ready,
        actions: options.notificationAction === undefined ? [] : [options.notificationAction],
      };
    },
    acknowledgeNotificationAction: async (acknowledgement: NotificationActionAcknowledgement) => {
      acknowledgements.push(acknowledgement);
    },
    onNotificationAction: () => () => undefined,
    getNotificationState: async () => notificationState,
    setNotificationPreference: async () => notificationState,
    refreshNotificationCapability: async () => notificationState,
    onNotificationStateChanged: () => () => undefined,
  };

  return {
    client: client as unknown as DesktopApi,
    activities,
    drains,
    acknowledgements,
    get contextRequests() {
      return contextRequests;
    },
    get bootstrapRequests() {
      return bootstrapRequests;
    },
    get realtimeStarts() {
      return realtimeStarts;
    },
    get messageRequests() {
      return messageRequests;
    },
    get reactionHydrations() {
      return reactionHydrations;
    },
    emitSession(next) {
      for (const listener of sessionListeners) listener(next);
    },
    releaseFirstActivity() {
      releaseFirstActivity();
    },
    releaseFirstMessage() {
      releaseFirstMessage();
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

afterEach(() => cleanup());

describe("App notification session recovery", () => {
  it("rebinds and reports activity when workspace Retry recovers a failed bootstrap", async () => {
    const harness = createRetryHarness();
    render(
      createElement(App, {
        client: harness.client,
        theme: createTheme(),
        compactMode: createCompactMode(),
      }),
    );

    await screen.findByRole("heading", { name: "Workspace unavailable" });
    await waitFor(() => expect(harness.contextRequests).toBe(1));
    expect(harness.bootstrapRequests).toBe(1);
    expect(harness.drains).toEqual([]);
    expect(harness.activities).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByTestId("workspace-ready");
    await waitFor(() => {
      expect(harness.contextRequests).toBe(2);
      expect(harness.drains).toEqual([
        {
          version: 1,
          sessionGeneration: activeContext.sessionGeneration,
          rendererSessionGeneration: activeContext.rendererSessionGeneration,
          userId: USER_ID,
          workspaceId: WORKSPACE_ID,
        },
      ]);
      expect(harness.activities).toContainEqual({
        version: 1,
        sessionGeneration: activeContext.sessionGeneration,
        rendererSessionGeneration: activeContext.rendererSessionGeneration,
        revision: 1,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        view: { pane: "none" },
      });
    });
    expect(harness.bootstrapRequests).toBe(2);
  });

  it("rebinds a same-scope session push without resetting its activity revision", async () => {
    const harness = createRetryHarness({
      failFirstBootstrap: false,
      bootstrap,
      delayFirstActivity: true,
    });
    render(
      createElement(App, {
        client: harness.client,
        theme: createTheme(),
        compactMode: createCompactMode(),
      }),
    );

    await screen.findByTestId("workspace-ready");
    await waitFor(() => {
      expect(harness.contextRequests).toBe(1);
      expect(harness.drains).toHaveLength(1);
      expect(harness.activities).toHaveLength(1);
      expect(harness.realtimeStarts).toBe(1);
    });

    act(() => harness.emitSession(session));
    await waitFor(() => {
      expect(harness.realtimeStarts).toBe(2);
      expect(harness.contextRequests).toBe(2);
      expect(harness.drains).toHaveLength(2);
      expect(harness.activities.length).toBeGreaterThan(1);
    });
    // Invalidation detaches the new report from the hung old tail, but its revision remains
    // renderer-lifetime monotonic so the late revision 1 cannot overwrite revision 2 in main.
    expect(harness.activities[0]?.revision).toBe(1);
    expect(harness.activities[1]?.revision).toBe(2);

    await act(async () => {
      harness.releaseFirstActivity();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(harness.activities.map((activity) => activity.revision)).toEqual(
      harness.activities.map((_, index) => index + 1),
    );
    expect(harness.contextRequests).toBe(2);
    expect(harness.drains).toHaveLength(2);
  });

  it("re-drains an action across workspace restart and acknowledges only the current handler", async () => {
    const harness = createRetryHarness({
      failFirstBootstrap: false,
      bootstrap: channelBootstrap,
      delayFirstMessage: true,
      notificationAction,
    });
    render(
      createElement(App, {
        client: harness.client,
        theme: createTheme(),
        compactMode: createCompactMode(),
      }),
    );

    await screen.findByTestId("workspace-ready");
    await waitFor(() => expect(harness.messageRequests).toBe(1));
    expect(harness.acknowledgements).toEqual([]);

    act(() => harness.emitSession(session));
    await waitFor(() => {
      expect(harness.realtimeStarts).toBe(2);
      expect(harness.contextRequests).toBe(2);
      expect(harness.drains).toHaveLength(2);
      expect(harness.messageRequests).toBe(2);
      expect(harness.acknowledgements).toEqual([
        {
          version: 1,
          sessionGeneration: activeContext.sessionGeneration,
          rendererSessionGeneration: activeContext.rendererSessionGeneration,
          userId: USER_ID,
          workspaceId: WORKSPACE_ID,
          action: notificationAction,
        },
      ]);
    });
    expect(harness.reactionHydrations).toBe(1);
    expect(screen.getByText(notificationMessage.body)).toBeTruthy();

    await act(async () => {
      harness.releaseFirstMessage();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(harness.messageRequests).toBe(2);
    expect(harness.reactionHydrations).toBe(1);
    expect(harness.acknowledgements).toHaveLength(1);
  });
});
