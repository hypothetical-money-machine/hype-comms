// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AiChannelState,
  ChatSessionState,
  HumanWorkspaceBootstrapResponse,
  Message,
  NotificationAction,
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
const ROOT_MESSAGE_ID = "30000000-0000-4000-8000-000000000005";
const REPLY_MESSAGE_ID = "30000000-0000-4000-8000-000000000006";
const LAUNCH_MESSAGE_ID = "30000000-0000-4000-8000-000000000009";
const GENERAL_MESSAGE_ID = "30000000-0000-4000-8000-000000000010";
const NOW = "2026-08-10T12:00:00.000Z";

const session: Extract<ChatSessionState, { status: "signed-in"; method: "email" }> = {
  status: "signed-in",
  method: "email",
  name: "Morgan",
  email: "morgan@example.com",
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

function conversationSummary(id: string, name: string, slug: string) {
  return {
    conversation: {
      id,
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name,
      slug,
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
  };
}

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
  members: [],
  conversations: [
    conversationSummary(GENERAL_ID, "General", "general"),
    conversationSummary(LAUNCH_ID, "Launch Planning", "launch-planning"),
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

const threadRoot: Message = {
  id: ROOT_MESSAGE_ID,
  conversationId: LAUNCH_ID,
  conversationSequence: "1",
  version: 1,
  clientMessageId: "30000000-0000-4000-8000-000000000007",
  authorId: USER_ID,
  threadRootId: null,
  body: "Launch checklist",
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const threadReply: Message = {
  ...threadRoot,
  id: REPLY_MESSAGE_ID,
  conversationSequence: "2",
  clientMessageId: "30000000-0000-4000-8000-000000000008",
  threadRootId: ROOT_MESSAGE_ID,
  body: "Who owns the notarization step?",
};

const launchMessage: Message = {
  ...threadRoot,
  id: LAUNCH_MESSAGE_ID,
  conversationSequence: "3",
  clientMessageId: "30000000-0000-4000-8000-000000000011",
  body: "Release notes are drafted",
};

const generalMessage: Message = {
  ...threadRoot,
  id: GENERAL_MESSAGE_ID,
  conversationId: GENERAL_ID,
  conversationSequence: "1",
  clientMessageId: "30000000-0000-4000-8000-000000000012",
  body: "Morning, everyone",
};

const notificationTargets: readonly Message[] = [threadReply, launchMessage, generalMessage];

const activeContext: Extract<NotificationContext, { status: "active" }> = {
  version: 1,
  status: "active",
  sessionGeneration: 4,
  rendererSessionGeneration: 2,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
};

function openMessageAction(message: Message): NotificationAction {
  return {
    version: 1,
    type: "open-message",
    sessionGeneration: activeContext.sessionGeneration,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    conversationId: message.conversationId,
    messageId: message.id,
    threadRootId: message.threadRootId,
  };
}

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

interface Harness {
  readonly client: DesktopApi;
  readonly pushNotificationAction: (action: NotificationAction) => void;
}

function createHarness(): Harness {
  let realtimeStarts = 0;
  const actionListeners = new Set<(action: NotificationAction) => void>();

  const client = {
    platform: "linux",
    isHeadless: true,
    getSessionState: async () => session,
    onSessionChanged: () => () => undefined,
    signOut: async () => ({ status: "signed-out" }) as const,
    getAppVersion: async () => "0.1.27-test",
    getUpdateState: async (): Promise<UpdateState> => ({ status: "idle" }),
    checkForUpdates: async () => undefined,
    restartToInstallUpdate: async () => undefined,
    onUpdateStateChanged: () => () => undefined,
    initializeCacheCrypto: async (scope: {
      readonly userId: string;
      readonly workspaceId: string;
    }) => ({ mode: "memory_only", scope, reason: "credential_store_unavailable" }) as const,
    getWorkspaceBootstrap: async () => bootstrap,
    listWorkspaceMembers: async () => ({ members: [] }),
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
    getMessageById: async (messageId: string) => {
      const message = notificationTargets.find((candidate) => candidate.id === messageId);
      if (message === undefined) throw new Error(`Unknown message ${messageId}`);
      return { message };
    },
    getMessageThread: async () => {
      // A real macrotask gap, like the network round trip it stands in for: it guarantees React
      // flushes the selection commit while the search dialog is still open, which is the ordering
      // the thread search-jump regression below depends on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        root: threadRoot,
        replies: [threadReply],
        nextCursor: null,
      };
    },
    listMessageReactions: async () => ({ reactions: [] }),
    listConversationFiles: async () => ({ files: [], nextCursor: null, hasMore: false }),
    listMessageAttachments: async () => ({ attachments: [] }),
    chooseAndUploadConversationFile: async () => null,
    openConversationFile: async () => ({ opened: true }),
    searchMessages: async () => ({
      results: [{ message: launchMessage }, { message: threadReply }],
      nextCursor: null,
    }),
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
    onNotificationAction: (listener: (action: NotificationAction) => void) => {
      actionListeners.add(listener);
      return () => actionListeners.delete(listener);
    },
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
  };

  return {
    client: client as unknown as DesktopApi,
    pushNotificationAction(action) {
      for (const listener of actionListeners) listener(action);
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

async function renderWorkspace(): Promise<Harness> {
  const harness = createHarness();
  render(
    createElement(App, {
      client: harness.client,
      theme: createTheme(),
      compactMode: createCompactMode(),
      fencedBlockquotes: new FencedBlockquoteRuntime(null),
      sidebarPosition: createSidebarPosition(),
    }),
  );
  await screen.findByTestId("workspace-ready");
  await screen.findByRole("textbox", { name: "Message" });
  return harness;
}

function channelComposer(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
}

/**
 * Parks focus on a disposable control outside the App so the assertions below can only pass or
 * fail on focus the App actively moves — never on focus merely staying wherever it happened to be.
 */
function parkFocus(): { readonly sentinel: HTMLButtonElement; readonly dispose: () => void } {
  const sentinel = document.createElement("button");
  document.body.append(sentinel);
  sentinel.focus();
  expect(document.activeElement).toBe(sentinel);
  return { sentinel, dispose: () => sentinel.remove() };
}

afterEach(() => cleanup());

describe("main composer focus on conversation changes", () => {
  it("focuses the composer when the user switches conversations", async () => {
    await renderWorkspace();
    const { dispose } = parkFocus();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Launch Planning" }));

      await waitFor(() => expect(channelComposer().placeholder).toBe("Message # Launch Planning"));
      await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
    } finally {
      dispose();
    }
  });

  it("focuses the thread composer, not the channel composer, for a reply notification", async () => {
    // Opening a notification for a reply selects the other conversation, opens its thread, and
    // focuses a specific thread message — all in one runtime commit. Focus must land in the
    // thread composer, never on the main composer behind the pane, or a typed reply posts to
    // the channel.
    const harness = await renderWorkspace();
    const { dispose } = parkFocus();
    try {
      act(() => harness.pushNotificationAction(openMessageAction(threadReply)));

      const replyComposer = await screen.findByRole("textbox", { name: "Reply" });
      await waitFor(() => expect(channelComposer().placeholder).toBe("Message # Launch Planning"));

      await waitFor(() => expect(document.activeElement).toBe(replyComposer));
      // Compare against a fresh query: if the switch remounted the composer, a node captured
      // before the notification would make this assertion pass vacuously.
      expect(document.activeElement).not.toBe(channelComposer());
    } finally {
      dispose();
    }
  });

  it("moves focus out of the channel composer when a reply notification opens a thread", async () => {
    // The channel composer is exactly where this feature parks focus after every switch, so a
    // deep-linked thread must take focus from it even though it is a text control: leaving the
    // caret there sends the typed reply to the whole channel.
    const harness = await renderWorkspace();
    channelComposer().focus();
    expect(document.activeElement).toBe(channelComposer());

    act(() => harness.pushNotificationAction(openMessageAction(threadReply)));

    const replyComposer = await screen.findByRole("textbox", { name: "Reply" });
    await waitFor(() => expect(document.activeElement).toBe(replyComposer));
  });

  it("focuses the thread composer when a reply notification arrives on the Tasks pane", async () => {
    // With the Tasks pane showing, the composer mounts in the same React commit that opens the
    // thread pane. The mount-time retry must see that commit's thread state — a stale snapshot
    // here once focused the main composer behind the just-opened thread.
    const harness = await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull());
    const { dispose } = parkFocus();
    try {
      act(() => harness.pushNotificationAction(openMessageAction(threadReply)));

      const replyComposer = await screen.findByRole("textbox", { name: "Reply" });
      await waitFor(() => expect(document.activeElement).toBe(replyComposer));
      expect(document.activeElement).not.toBe(channelComposer());
    } finally {
      dispose();
    }
  });

  it("focuses the channel composer once a notification-opened thread is closed", async () => {
    // The conversation change is suppressed while the thread pane owns the workspace, but the
    // intent must survive: closing the thread lands focus on the conversation the notification
    // opened instead of stranding it.
    const harness = await renderWorkspace();
    const { dispose } = parkFocus();
    try {
      act(() => harness.pushNotificationAction(openMessageAction(threadReply)));
      await screen.findByRole("textbox", { name: "Reply" });

      fireEvent.click(screen.getByRole("button", { name: "Close thread" }));

      await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
      expect(channelComposer().placeholder).toBe("Message # Launch Planning");
    } finally {
      dispose();
    }
  });

  it("leaves focus inside an open modal when the selection changes underneath it", async () => {
    // WorkspaceSearch commits the selection before its dialog closes, and PreferencesDialog can
    // see a background selection reassignment; both portal an aria-modal dialog into the body
    // while the composer stays mounted behind them, so a detached node is a faithful stand-in.
    const harness = await renderWorkspace();
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const control = document.createElement("button");
    control.type = "button";
    dialog.append(control);
    document.body.append(dialog);
    try {
      control.focus();
      expect(document.activeElement).toBe(control);

      act(() => harness.pushNotificationAction(openMessageAction(launchMessage)));

      await waitFor(() => expect(channelComposer().placeholder).toBe("Message # Launch Planning"));
      await waitFor(() => expect(document.activeElement).toBe(control), { timeout: 5_000 });
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      dialog.remove();
    }
  });

  it("focuses the channel composer when the focused close button dismisses the thread", async () => {
    // In a real browser the click focuses the close button first, and that focusin expires the
    // pending conversation intent — so the handoff to the composer must be explicit, not a
    // side effect of the intent surviving.
    const harness = await renderWorkspace();
    act(() => harness.pushNotificationAction(openMessageAction(threadReply)));
    await screen.findByRole("textbox", { name: "Reply" });

    const closeButton = screen.getByRole("button", { name: "Close thread" });
    closeButton.focus();
    fireEvent.click(closeButton);

    await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
    expect(channelComposer().placeholder).toBe("Message # Launch Planning");
  });

  it("focuses the thread composer for a reply notification arriving over Preferences", async () => {
    // Closing Preferences restores focus to its trigger; that restore must happen before the
    // navigation records its focus intents, or the restore's focusin would expire them and
    // leave focus stuck on the trigger.
    const harness = await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    await screen.findByRole("dialog");

    act(() => harness.pushNotificationAction(openMessageAction(threadReply)));

    const replyComposer = await screen.findByRole("textbox", { name: "Reply" });
    await waitFor(() => expect(document.activeElement).toBe(replyComposer));
  });

  it("expires a deferred intent when the dialog closes by restoring its trigger", async () => {
    // A selection change that lands while the search dialog holds focus defers the intent. If
    // the user then closes the dialog with Escape — which restores focus to the trigger — the
    // deferral is over without a landing, and the stale intent must not fire at a later retry
    // point such as the pane toggle's composer remount.
    const harness = await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    const searchInput = await screen.findByRole<HTMLInputElement>("searchbox", {
      name: "Search messages",
    });
    expect(document.activeElement).toBe(searchInput);

    act(() => harness.pushNotificationAction(openMessageAction(launchMessage)));
    await waitFor(() => expect(channelComposer().placeholder).toBe("Message # Launch Planning"));
    expect(document.activeElement).toBe(searchInput);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search messages" }));

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull());
    const chatToggle = screen.getByRole("button", { name: "Chat" });
    chatToggle.focus();
    fireEvent.click(chatToggle);

    await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(chatToggle), { timeout: 5_000 });
  });

  it("does not steal focus when the pane toggle remounts the composer", async () => {
    // Tasks -> Chat swaps TasksView for the message list + composer on the same conversation, so
    // the remounted composer must leave focus on the toggle the user just pressed.
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull());

    const chatToggle = screen.getByRole("button", { name: "Chat" });
    chatToggle.focus();
    fireEvent.click(chatToggle);

    await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(chatToggle), { timeout: 5_000 });
  });

  it("focuses the composer when the conversation changes while the Tasks pane is showing", async () => {
    // Selecting a conversation flips the pane back to chat one render later, so the composer is
    // still unmounted when the conversation change commits. The focus intent has to survive until
    // the composer mounts.
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Launch Planning" }));

    await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
    expect(channelComposer().placeholder).toBe("Message # Launch Planning");
  });

  it("focuses the jumped-to conversation's composer after a search result closes the dialog", async () => {
    // WorkspaceSearch commits the selection while its aria-modal dialog still holds focus (the
    // guard rightly defers), then closeSearch(false) unmounts the focused dialog with no restore.
    // The deferred intent must complete when the dialog's close strands focus.
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    const searchInput = await screen.findByRole<HTMLInputElement>("searchbox", {
      name: "Search messages",
    });
    expect(document.activeElement).toBe(searchInput);

    fireEvent.change(searchInput, { target: { value: "Release notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const result = await screen.findByRole("button", { name: /Release notes are drafted/ });

    fireEvent.click(result);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
    expect(channelComposer().placeholder).toBe("Message # Launch Planning");
  });

  it("focuses the thread composer after a thread search result closes the dialog", async () => {
    // A thread result awaits the thread fetch between the selection commit and closeSearch(false),
    // so the selection flushes while the dialog still holds focus and the guard defers. The close
    // then unmounts the focused dialog with no restore; the stranded focus must land in the
    // opened thread, never on <body> or the channel composer behind the pane.
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    const searchInput = await screen.findByRole<HTMLInputElement>("searchbox", {
      name: "Search messages",
    });
    fireEvent.change(searchInput, { target: { value: "notarization" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const result = await screen.findByRole("button", { name: /Who owns the notarization step/ });

    fireEvent.click(result);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const threadComposer = await screen.findByRole("textbox", { name: "Reply" });
    await waitFor(() => expect(document.activeElement).toBe(threadComposer));
    expect(document.activeElement).not.toBe(channelComposer());
  });

  it("focuses the composer when a search jump leaves the AI pane", async () => {
    // openResult flips the destination to the workspace before committing the selection, so the
    // jump both reveals the conversation pane and closes the dialog stranded; the deferred
    // intent must land in the now-visible composer.
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /AI Channel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
    const searchInput = await screen.findByRole<HTMLInputElement>("searchbox", {
      name: "Search messages",
    });
    fireEvent.change(searchInput, { target: { value: "Release notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const result = await screen.findByRole("button", { name: /Release notes are drafted/ });

    fireEvent.click(result);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
    expect(channelComposer().placeholder).toBe("Message # Launch Planning");
  });

  it("focuses the composer on return from the AI pane, even for the already-selected conversation", async () => {
    // While the AI pane is shown the conversation pane is hidden and focusing the composer would
    // be a no-op, so the focus must land when the workspace pane comes back — including when the
    // notification targets the conversation that was already selected.
    const harness = await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /AI Channel/ }));
    const { dispose } = parkFocus();
    try {
      act(() => harness.pushNotificationAction(openMessageAction(generalMessage)));

      await waitFor(() => expect(document.activeElement).toBe(channelComposer()));
    } finally {
      dispose();
    }
  });

  it("focuses the thread composer when a thread notification arrives on the AI pane", async () => {
    // The thread state commits while the workspace pane is still hidden. In a real browser a
    // click on the AI Channel button leaves focus on that button — in the always-visible aside,
    // so no focus fixup ever strands it on <body> — and the thread intent must still land in the
    // thread once the workspace pane appears, never on the channel composer behind it.
    const harness = await renderWorkspace();
    const aiButton = screen.getByRole("button", { name: /AI Channel/ });
    aiButton.focus();
    fireEvent.click(aiButton);
    expect(document.activeElement).toBe(aiButton);

    act(() => harness.pushNotificationAction(openMessageAction(threadReply)));

    const threadComposer = await screen.findByRole("textbox", { name: "Reply" });
    await waitFor(() => expect(document.activeElement).toBe(threadComposer));
    expect(document.activeElement).not.toBe(channelComposer());
  });
});
