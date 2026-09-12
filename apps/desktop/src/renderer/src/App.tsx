import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  MessageTimeline,
  WorkspaceMessageRow,
  type MessageTimelineContext,
} from "./message-timeline";

import {
  ATTACHMENTS_PER_MESSAGE_MAX,
  type Attachment,
  type AuthCapabilities,
  type AuthenticatedSessionContext,
  type ChannelAccess,
  type ChannelMode,
  type ChatSessionState,
  type Message,
  type NotificationContext,
  type ProtocolHandlerState,
  type Reaction,
  type Task,
  type UpdateState,
} from "@hype-comms/contracts";

import { AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE, type DesktopApi } from "../../shared/desktop-api";
import { PresenceIndicator } from "./activity-indicators";
import { AgentEnrollmentsView } from "./agent-enrollments-view";
import { AiChannel } from "./ai-channel";
import { BrandMark } from "./brand-mark";
import { isBuiltInConversation } from "./built-in-channels";
import { ChannelCreatePopover } from "./channel-create-popover";
import { ChannelMembersDialog } from "./channel-members-dialog";
import type { ChannelReferenceTarget } from "./channel-references";
import { ClientVersion } from "./client-version";
import { CommunicationPathsView } from "./communication-paths-view";
import { CompactHotzone } from "./compact-hotzone";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { ConversationHealth } from "./conversation-health";
import {
  ChannelIcon,
  ConversationBadge,
  DirectMessageIcon,
  GroupDirectMessageIcon,
} from "./conversation-indicators";
import {
  AnnouncementPostingNotice,
  ArchivedConversationNotice,
  ConversationEmptyState,
} from "./conversation-states";
import { ConversationSwitcher } from "./conversation-switcher";
import type { DevicePreferencesRuntime } from "./device-preferences-runtime";
import type { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { FilesView } from "./files-view";
import { ipcErrorMessage } from "./ipc-error-message";
import { mentionedMemberIds } from "./mentions";
import { MessageComposer } from "./message-composer";
import { createNotificationActivityView } from "./notification-activity";
import {
  NotificationSessionRuntime,
  notificationTransportFrom,
} from "./notification-session-runtime";
import { PreferencesPage, type PreferencesPageHandle } from "./preferences-page";
import type { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { TasksView } from "./tasks-view";
import type { ThemeRuntime } from "./theme-runtime";
import { ThemeSelector } from "./theme-selector";
import { listUnreadConversations, unreadBadgeTotals } from "./unread-conversations";
import { useUnreadDividerMessageId } from "./unread-divider";
import { UnreadsIcon, UnreadsView } from "./unreads-view";
import { useBackgroundUnreadSignal } from "./use-background-unread-signal";
import { isCompactModeShortcut, useCompactChrome } from "./use-compact-chrome";
import { useCompactModeEnabled } from "./use-compact-mode-enabled";
import { useDevicePreferences } from "./use-device-preferences";
import { useMessageComposer } from "./use-message-composer";
import { OverlayProvider } from "./overlay-ownership";
import { useComposerFocus } from "./use-composer-focus";
import { useMessagePane } from "./use-message-pane";
import type { CollectionIdentity } from "./workspace-collections";
import { collectionRecovery } from "./workspace-recovery";
import { cacheFallbackNotice, WorkspaceRuntime } from "./workspace-runtime";
import { WorkspaceSearch } from "./workspace-search";
import {
  equalWorkspaceView,
  selectWorkspaceView,
  useWorkspaceSelection,
} from "./workspace-selection";
import { WorkspaceTypingIndicator } from "./workspace-typing-indicator";

type SignedInSession = Extract<ChatSessionState, { status: "signed-in"; method: "email" }>;
type WorkspaceDestination =
  "workspace" | "ai" | "unreads" | "admin" | "preferences" | "agent-enrollments";
type NavigationGuard = (validateDiscard?: () => boolean) => boolean | Promise<boolean>;

interface AttachmentUploadReservation {
  readonly generation: number;
}

interface AppProps {
  readonly client: DesktopApi;
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly devicePreferences: DevicePreferencesRuntime;
  readonly fencedBlockquotes: FencedBlockquoteRuntime;
  readonly sidebarPosition: SidebarPositionRuntime;
}

type UpdateClient = Pick<
  DesktopApi,
  "getUpdateState" | "checkForUpdates" | "restartToInstallUpdate" | "onUpdateStateChanged"
>;

export function recoverableAuthenticatedSession(
  session: ChatSessionState,
): AuthenticatedSessionContext | null {
  if (session.status === "signed-in") {
    const { method, name, email, userId, workspaceId } = session;
    return { method, name, email, userId, workspaceId };
  }
  return session.status === "session-unavailable"
    ? (session.lastAuthenticatedSession ?? null)
    : null;
}

function attachmentUploadScopeKey(session: ChatSessionState): string | null {
  const context = recoverableAuthenticatedSession(session);
  return context === null ? null : `${context.userId}:${context.workspaceId}`;
}

export function visibleTimelineMessages(
  messages: readonly Message[],
  conversationId: string | null,
  threadsSupported: boolean,
): readonly Message[] {
  return messages.filter(
    (message) =>
      message.deletedAt === null &&
      message.conversationId === conversationId &&
      (!threadsSupported || message.threadRootId === null),
  );
}

export function UpdateControl({
  client,
  beforeRestart,
}: {
  readonly client: UpdateClient;
  readonly beforeRestart?: NavigationGuard;
}) {
  const [update, setUpdate] = useState<UpdateState | null>(null);

  const restart = async (): Promise<void> => {
    if (beforeRestart !== undefined && !(await beforeRestart())) return;
    await client.restartToInstallUpdate();
  };

  useEffect(() => {
    let active = true;
    let receivedLiveState = false;
    const stopUpdateListener = client.onUpdateStateChanged((state) => {
      if (!active) return;
      receivedLiveState = true;
      setUpdate(state);
    });
    void client
      .getUpdateState()
      .then((state) => {
        if (active && !receivedLiveState) setUpdate(state);
      })
      .catch(() => {
        if (active && !receivedLiveState) setUpdate({ status: "unsupported" });
      });

    return () => {
      active = false;
      stopUpdateListener();
    };
  }, [client]);

  if (update === null || update.status === "idle" || update.status === "unsupported") {
    return null;
  }

  let message: string;
  switch (update.status) {
    case "checking":
      message = "Checking for updates…";
      break;
    case "available":
      message = "Update found";
      break;
    case "downloading":
      message = `Downloading update — ${update.percentage}%`;
      break;
    case "ready":
      message = `Update ${update.version} ready`;
      break;
    case "error":
      message = update.message;
      break;
  }

  return (
    <div className={`update-control ${update.status}`} role="status" aria-live="polite">
      <span>{message}</span>
      {update.status === "ready" && (
        <button type="button" onClick={() => void restart()}>
          Restart
        </button>
      )}
      {update.status === "error" && (
        <button type="button" onClick={() => void client.checkForUpdates()}>
          Retry
        </button>
      )}
    </div>
  );
}

export function SignIn({
  client,
  theme,
  sessionMessage,
}: {
  client: DesktopApi;
  theme: ThemeRuntime;
  sessionMessage?: string | undefined;
}) {
  const [email, setEmail] = useState("");
  const [capabilities, setCapabilities] = useState<AuthCapabilities>({
    authKit: false,
    magicLink: true,
  });
  const [authKitStarting, setAuthKitStarting] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [status, setStatus] = useState(sessionMessage ?? "");
  const [protocolHandler, setProtocolHandler] = useState<ProtocolHandlerState | null>(null);

  useEffect(() => {
    let active = true;
    if (client.getAuthCapabilities === undefined) return () => undefined;
    void client
      .getAuthCapabilities()
      .then((nextCapabilities) => {
        if (active) setCapabilities(nextCapabilities);
      })
      .catch(() => {
        // A pre-AuthKit or temporarily unavailable server retains the existing magic-link UI.
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (sessionMessage !== undefined) setStatus(sessionMessage);
  }, [sessionMessage]);

  useEffect(() => {
    let active = true;
    if (client.getProtocolHandlerState === undefined) return () => undefined;
    void client
      .getProtocolHandlerState()
      .then((state) => {
        if (active) setProtocolHandler(state);
      })
      .catch(() => {
        // Without a probe result the card stays quiet; only a confirmed "unbound" warns.
      });
    return () => {
      active = false;
    };
  }, [client]);

  const startAuthKit = async (): Promise<void> => {
    if (authKitStarting || requesting || client.startAuthKitSignIn === undefined) return;
    setAuthKitStarting(true);
    setStatus("");
    try {
      await client.startAuthKitSignIn();
      setStatus("Finish signing in in the browser. You can return here when it completes.");
    } catch (error) {
      if (error instanceof Error && error.message.includes(AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE)) {
        let nextCapabilities = { ...capabilities, authKit: false };
        try {
          if (client.getAuthCapabilities !== undefined) {
            nextCapabilities = {
              ...(await client.getAuthCapabilities()),
              authKit: false,
            };
          }
        } catch {
          // Keep AuthKit hidden if its availability cannot be confirmed after a rejected start.
        }
        setCapabilities(nextCapabilities);
      }
      setStatus(ipcErrorMessage(error, "Could not start WorkOS sign-in"));
    } finally {
      setAuthKitStarting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (requesting || authKitStarting || email.trim() === "") return;
    setRequesting(true);
    setStatus("");
    try {
      const delivery = await client.requestMagicLink(email);
      setStatus(
        delivery.status === "email-sent"
          ? "Check your email, then open the Hype Comms sign-in link."
          : `${delivery.message} Open the private sign-in link an administrator sends you.`,
      );
    } catch (error) {
      setStatus(ipcErrorMessage(error, "Could not request a sign-in link"));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <BrandMark className="brand-mark" label="Hype Comms" />
        <p className="eyebrow">Hypothetical Money Machine</p>
        <h1>Private workspace chat</h1>
        <p className="signin-lede">Sign in with the email address invited to this workspace.</p>
        {protocolHandler?.binding === "unbound" && (
          <p className="signin-warning" role="status" aria-live="polite">
            Browser sign-in can’t return to this app: the {protocolHandler.scheme}:// link handler
            is not registered on this system. Reinstall from the .deb package, or install xdg-utils
            and relaunch to let the AppImage register itself.
          </p>
        )}
        {capabilities.authKit && (
          <button
            className="authkit-button"
            type="button"
            disabled={authKitStarting || requesting}
            onClick={() => void startAuthKit()}
          >
            {authKitStarting ? "Opening secure sign-in…" : "Sign in with WorkOS"}
          </button>
        )}
        {capabilities.authKit && capabilities.magicLink && (
          <div className="signin-divider" aria-hidden="true">
            <span>or</span>
          </div>
        )}
        {capabilities.magicLink && (
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              disabled={authKitStarting}
              required
            />
            <button type="submit" disabled={requesting || authKitStarting || email.trim() === ""}>
              {requesting ? "Requesting link…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        {!capabilities.authKit && !capabilities.magicLink && (
          <p className="signin-status">No sign-in method is currently available.</p>
        )}
        {status !== "" && (
          <p className="signin-status" role="alert" aria-live="assertive">
            {status}
          </p>
        )}

        <ThemeSelector theme={theme} />
        <UpdateControl client={client} />
        <ClientVersion client={client} />
      </section>
    </main>
  );
}

function AiChannelIcon() {
  return (
    <svg className="ai-channel-nav-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 1.9c.5 4 2.1 5.6 6.1 6.1-4 .5-5.6 2.1-6.1 6.1-.5-4-2.1-5.6-6.1-6.1 4-.5 5.6-2.1 6.1-6.1Z" />
      <path d="M15.8 12.4c.2 1.8 1 2.6 2.8 2.8-1.8.2-2.6 1-2.8 2.8-.2-1.8-1-2.6-2.8-2.8 1.8-.2 2.6-1 2.8-2.8Z" />
    </svg>
  );
}

function CommunicationPathsIcon() {
  return (
    <svg className="communication-paths-nav-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="5" cy="5" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="5" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="5" cy="15" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="15" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7.4 5h5.2M5 7.4v5.2M15 7.4v5.2M7.4 15h5.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function AgentRequestsIcon() {
  return (
    <svg
      className="agent-requests-nav-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      strokeWidth="1.6"
    >
      <path d="M10 2.5v3M8.5 2.5h3" />
      <rect x="4" y="5.5" width="12" height="10" rx="3" />
      <circle cx="8" cy="10" r="1" />
      <circle cx="12" cy="10" r="1" />
      <path d="M7.5 13h5" />
    </svg>
  );
}

const ATTACHMENT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1_000;

function attachmentOnlyMessageBody(attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return "";
  if (attachments.length === 1) return attachments[0]?.fileName ?? "";
  return `${String(attachments.length)} attachments`;
}

function withAttachmentUploadTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Attaching files timed out. You can try again."))),
      ATTACHMENT_UPLOAD_TIMEOUT_MS,
    );
    void operation.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function App(props: AppProps) {
  return (
    <OverlayProvider>
      <WorkspaceApp {...props} />
    </OverlayProvider>
  );
}

function WorkspaceApp({
  client,
  theme,
  compactMode,
  devicePreferences,
  fencedBlockquotes,
  sidebarPosition,
}: AppProps) {
  const runtime = useMemo(() => new WorkspaceRuntime(client), [client]);
  const preferences = useDevicePreferences(devicePreferences);
  const isHeadless = client.isHeadless === true;
  const runtimeState = useWorkspaceSelection(runtime, selectWorkspaceView, equalWorkspaceView);
  const [session, setSession] = useState<ChatSessionState | null>(null);
  const setComposerTyping = useCallback(
    (conversationId: string, typing: boolean) => runtime.setTyping(conversationId, typing),
    [runtime],
  );
  const {
    draft,
    setDraft,
    clearDraft,
    resetDrafts,
    editingId: editingClientMessageId,
    setEditingId: setEditingClientMessageId,
    error: composerError,
    setError: setComposerError,
    updateDraft: updateMainDraft,
  } = useMessageComposer({
    conversationId: runtimeState.selectedConversationId,
    threadRootId: null,
    kind: "conversation",
    outbox: runtimeState.outbox,
    setTyping: setComposerTyping,
  });
  const {
    draft: threadDraft,
    setDraft: setThreadDraft,
    clearDraft: clearThreadDraft,
    resetDrafts: resetThreadDrafts,
    editingId: threadEditingClientMessageId,
    setEditingId: setThreadEditingClientMessageId,
    error: threadComposerError,
    setError: setThreadComposerError,
    updateDraft: updateThreadDraft,
  } = useMessageComposer({
    conversationId: runtimeState.selectedConversationId,
    threadRootId: runtimeState.selectedThreadRootId,
    kind: "thread",
    outbox: runtimeState.outbox,
    setTyping: setComposerTyping,
  });
  const [signingOut, setSigningOut] = useState(false);
  const [peopleSource, setPeopleSource] = useState<"workspace" | "channel" | null>(null);
  const previousSelectedConversationId = useRef<string | null>(runtimeState.selectedConversationId);
  const peopleTrigger = useRef<HTMLButtonElement>(null);
  const channelMembersTrigger = useRef<HTMLButtonElement>(null);
  const [paneView, setPaneView] = useState<"chat" | "tasks" | "files">("chat");
  const [pendingAttachments, setPendingAttachments] = useState<
    Readonly<Record<string, readonly Attachment[]>>
  >({});
  const [attachingComposerKeys, setAttachingComposerKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const attachmentUploadReservations = useRef(new Map<string, AttachmentUploadReservation>());
  const attachmentUploadGeneration = useRef(0);
  const attachmentUploadScope = useRef<string | null>(null);
  const [destination, setDestination] = useState<WorkspaceDestination>("workspace");
  const preferencesPage = useRef<PreferencesPageHandle>(null);
  const requestPreferencesNavigationRef = useRef<NavigationGuard>(() => true);
  const [aiChannelVisited, setAiChannelVisited] = useState(false);
  const [notificationContext, setNotificationContext] = useState<NotificationContext | null>(null);
  const notificationBindingGeneration = useRef(0);
  const notificationTransport = useMemo(() => notificationTransportFrom(client), [client]);
  const notificationSession = useMemo(() => {
    if (notificationTransport === null) return null;
    return new NotificationSessionRuntime(notificationTransport, {
      handleNotificationAction: async (action, context) => {
        let invalidatedWhileConfirming = false;
        const validateNotificationAction = (): boolean => {
          const valid = runtime.canHandleNotificationAction(action, context);
          if (!valid) invalidatedWhileConfirming = true;
          return valid;
        };
        if (!validateNotificationAction()) return true;
        if (!(await requestPreferencesNavigationRef.current(validateNotificationAction))) {
          return invalidatedWhileConfirming ? true : false;
        }
        setPeopleSource(null);
        const result = await runtime.handleNotificationAction(action, context);
        if (result === "discarded") return true;
        setDestination("workspace");
        setPaneView("chat");
        return true;
      },
    });
  }, [notificationTransport, runtime]);
  const compact = useCompactModeEnabled(compactMode);
  const chrome = useCompactChrome(compact);

  const requestPreferencesNavigation = useCallback(
    (validateDiscard?: () => boolean): boolean | Promise<boolean> => {
      if (destination !== "preferences") return true;
      return preferencesPage.current?.requestNavigationAway(validateDiscard) ?? true;
    },
    [destination],
  );

  useLayoutEffect(() => {
    requestPreferencesNavigationRef.current = requestPreferencesNavigation;
  }, [requestPreferencesNavigation]);

  const runPreferencesNavigation = useCallback(
    (navigation: () => void): boolean | Promise<boolean> => {
      const allowed = requestPreferencesNavigation();
      if (typeof allowed === "boolean") {
        if (!allowed) return false;
        navigation();
        return true;
      }
      return allowed.then((confirmed) => {
        if (!confirmed) return false;
        navigation();
        return true;
      });
    },
    [requestPreferencesNavigation],
  );

  const selectConversation = useCallback(
    (conversationId: string, onSelected?: () => void): boolean | Promise<boolean> =>
      runPreferencesNavigation(() => {
        setDestination("workspace");
        runtime.selectConversation(conversationId);
        onSelected?.();
      }),
    [runPreferencesNavigation, runtime],
  );

  const openAiChannel = useCallback((): void => {
    runPreferencesNavigation(() => {
      setAiChannelVisited(true);
      setDestination("ai");
      setPaneView("chat");
      setPeopleSource(null);
      runtime.closeThread();
    });
  }, [runPreferencesNavigation, runtime]);

  const openUnreads = useCallback((): void => {
    runPreferencesNavigation(() => {
      setDestination("unreads");
      setPaneView("chat");
      setPeopleSource(null);
      runtime.closeThread();
      chrome.collapse();
    });
  }, [chrome, runPreferencesNavigation, runtime]);

  const openCommunicationPaths = useCallback((): void => {
    runPreferencesNavigation(() => {
      setDestination("admin");
      setPaneView("chat");
      setPeopleSource(null);
      runtime.closeThread();
    });
  }, [runPreferencesNavigation, runtime]);

  const openPreferences = useCallback((): void => {
    setDestination("preferences");
    setPaneView("chat");
    setPeopleSource(null);
    runtime.closeThread();
    chrome.collapse();
  }, [chrome, runtime]);

  const openAgentEnrollments = useCallback((): void => {
    runPreferencesNavigation(() => {
      setDestination("agent-enrollments");
      setPaneView("chat");
      setPeopleSource(null);
      runtime.closeThread();
    });
  }, [runPreferencesNavigation, runtime]);

  useEffect(() => {
    notificationSession?.start();
    return () => notificationSession?.dispose();
  }, [notificationSession]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if (!isCompactModeShortcut(event, client.platform)) return;
      event.preventDefault();
      compactMode.toggle().catch((error: unknown) => {
        console.error("Could not toggle compact mode", error);
      });
    };
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, [client, compactMode]);

  const startWorkspaceSession = useCallback(
    async (
      next: AuthenticatedSessionContext,
      options: {
        readonly offline?: boolean;
        readonly resetLocalCache?: boolean;
      } = {},
    ): Promise<void> => {
      const bindingGeneration = ++notificationBindingGeneration.current;
      // Every workspace restart is a renderer-readiness boundary, even when user/workspace ids do
      // not change. Retire actions and detach the old activity tail before any asynchronous cache
      // or bootstrap work; NotificationSessionRuntime keeps the revision itself monotonic.
      notificationSession?.invalidate();
      setNotificationContext(null);

      try {
        if (options.resetLocalCache === true) {
          await runtime.resetLocalCache();
          if (bindingGeneration !== notificationBindingGeneration.current) return;
        }
        await runtime.start(next, options.offline === true ? { offline: true } : {});
        if (bindingGeneration !== notificationBindingGeneration.current) return;

        if (options.offline === true) return;

        // WorkspaceRuntime reports bootstrap failures in its state instead of rejecting start(),
        // so an inactive result is expected on the first attempt and Retry binds again here.
        const context = (await notificationSession?.bind(next.userId, next.workspaceId)) ?? null;
        if (bindingGeneration === notificationBindingGeneration.current) {
          setNotificationContext(context);
        }
      } catch {
        if (bindingGeneration !== notificationBindingGeneration.current) return;
        notificationSession?.invalidate();
        setNotificationContext(null);
      }
    },
    [notificationSession, runtime],
  );

  const applySession = useCallback(
    (next: ChatSessionState) => {
      const nextAttachmentUploadScope = attachmentUploadScopeKey(next);
      if (attachmentUploadScope.current !== nextAttachmentUploadScope) {
        attachmentUploadScope.current = nextAttachmentUploadScope;
        attachmentUploadGeneration.current += 1;
        attachmentUploadReservations.current.clear();
        setAttachingComposerKeys(new Set());
        setPendingAttachments({});
      }
      setSession(next);
      if (next.status === "signed-in" && next.method === "email") {
        void startWorkspaceSession(next);
        return;
      }
      if (next.status === "session-unavailable" && next.lastAuthenticatedSession !== undefined) {
        void startWorkspaceSession(next.lastAuthenticatedSession, { offline: true });
        return;
      }

      notificationBindingGeneration.current += 1;
      notificationSession?.invalidate();
      setNotificationContext(null);
      if (next.status === "signed-out") {
        setDestination("workspace");
        setAiChannelVisited(false);
        resetDrafts();
        resetThreadDrafts();
        setEditingClientMessageId(null);
        setThreadEditingClientMessageId(null);
        setComposerError("");
        setThreadComposerError("");
        void runtime.stop();
      } else {
        void runtime.stop();
      }
    },
    [notificationSession, resetDrafts, resetThreadDrafts, runtime, startWorkspaceSession],
  );

  const retrySession = useCallback(async (): Promise<void> => {
    try {
      // Main publishes the result through the existing session-changed subscription. Ignoring the
      // matching return value prevents a retry from starting the workspace runtime twice.
      await client.retrySession();
    } catch {
      // Main reports an unreachable server as a preserved session, so there is nothing to add.
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const unsubscribe = client.onSessionChanged((next) => {
      if (active) applySession(next);
    });
    void client.getSessionState().then((next) => {
      if (active) applySession(next);
    });
    return () => {
      active = false;
      unsubscribe();
      notificationBindingGeneration.current += 1;
      notificationSession?.invalidate();
      void runtime.stop();
    };
  }, [applySession, client, notificationSession, runtime]);

  const bootstrap = runtimeState.bootstrap;
  const currentUserRole = bootstrap?.currentUser.role;
  useEffect(() => {
    if (
      currentUserRole !== undefined &&
      currentUserRole !== "owner" &&
      (destination === "admin" || destination === "agent-enrollments")
    ) {
      setDestination("workspace");
    }
  }, [currentUserRole, destination]);
  // Every runtime error used to be readable only before a bootstrap existed, which hid realtime
  // and sync failures for the entire life of a session.
  const workspaceNotice =
    session?.status === "session-unavailable"
      ? session.message
      : (runtimeState.error ?? cacheFallbackNotice(runtimeState.cacheFallbackReason));
  const selectedSummary = bootstrap?.conversations.find(
    (summary) => summary.conversation.id === runtimeState.selectedConversationId,
  );
  const selectedConversationMembers = useMemo(() => {
    if (bootstrap === null || selectedSummary === undefined) return [];
    const participantIds = new Set(selectedSummary.participantIds);
    return bootstrap.members.filter((member) => participantIds.has(member.id));
  }, [bootstrap, selectedSummary]);
  const selectedIsPersonal =
    selectedSummary?.conversation.kind === "direct_message" &&
    selectedSummary.participantIds.length === 1 &&
    selectedSummary.participantIds[0] === bootstrap?.currentUser.user.id;
  const selectedIsAnnouncement = selectedSummary?.conversation.channelMode === "announcement";
  const selectedIsBuiltIn =
    selectedSummary !== undefined && isBuiltInConversation(selectedSummary.conversation);
  const tasksAvailable =
    (selectedSummary?.conversation.kind === "channel" && !selectedIsAnnouncement) ||
    selectedIsPersonal === true;
  const canPublishBulletins =
    selectedIsAnnouncement && !selectedIsBuiltIn && bootstrap?.currentUser.role === "owner";
  const conversationMessages = runtimeState.messages.filter(
    (message) =>
      message.deletedAt === null && message.conversationId === runtimeState.selectedConversationId,
  );
  const messages = visibleTimelineMessages(
    runtimeState.messages,
    runtimeState.selectedConversationId,
    runtimeState.threadsSupported,
  );
  const unreadDividerMessageId = useUnreadDividerMessageId(
    runtimeState.selectedConversationId,
    messages,
    selectedSummary,
  );
  const reactionsByMessage = useMemo(() => {
    const grouped = new Map<string, Reaction[]>();
    for (const reaction of runtimeState.reactions) {
      const values = grouped.get(reaction.messageId) ?? [];
      values.push(reaction);
      grouped.set(reaction.messageId, values);
    }
    return grouped;
  }, [runtimeState.reactions]);
  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, Attachment[]>();
    for (const attachment of runtimeState.attachments) {
      if (attachment.messageId === null) continue;
      const values = grouped.get(attachment.messageId) ?? [];
      values.push(attachment);
      grouped.set(attachment.messageId, values);
    }
    return grouped;
  }, [runtimeState.attachments]);
  const pending = runtimeState.outbox.filter(
    (item) =>
      item.operation.conversationId === runtimeState.selectedConversationId &&
      (!runtimeState.threadsSupported || item.operation.message.threadRootId === null),
  );
  const selectedThreadRootId = runtimeState.threadsSupported
    ? runtimeState.selectedThreadRootId
    : null;
  const threadRoot =
    selectedThreadRootId === null
      ? undefined
      : conversationMessages.find(
          (message) => message.id === selectedThreadRootId && message.threadRootId === null,
        );
  const threadReplies =
    selectedThreadRootId === null
      ? []
      : conversationMessages.filter((message) => message.threadRootId === selectedThreadRootId);
  const threadPending =
    selectedThreadRootId === null
      ? []
      : runtimeState.outbox.filter(
          (item) =>
            item.operation.conversationId === runtimeState.selectedConversationId &&
            item.operation.message.threadRootId === selectedThreadRootId,
        );
  const threadSummaryByRoot = useMemo(
    () =>
      new Map(
        runtimeState.threadSummaries.map((summary) => [summary.threadRootId, summary] as const),
      ),
    [runtimeState.threadSummaries],
  );
  const loadedReplyCountByRoot = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of conversationMessages) {
      if (message.threadRootId !== null) {
        counts.set(message.threadRootId, (counts.get(message.threadRootId) ?? 0) + 1);
      }
    }
    return counts;
  }, [conversationMessages]);
  const pendingThreadRootIds = useMemo(
    () =>
      new Set(
        runtimeState.outbox.flatMap((item) => {
          const threadRootId = item.operation.message.threadRootId;
          return item.operation.conversationId === runtimeState.selectedConversationId &&
            threadRootId !== null
            ? [threadRootId]
            : [];
        }),
      ),
    [runtimeState.outbox, runtimeState.selectedConversationId],
  );
  useEffect(() => {
    const conversationId = runtimeState.selectedConversationId;
    return () => {
      if (conversationId !== null) runtime.setTyping(conversationId, false);
    };
  }, [runtime, runtimeState.selectedConversationId]);
  const selectedThreadSummary =
    selectedThreadRootId === null ? undefined : threadSummaryByRoot.get(selectedThreadRootId);
  const threadReplyCount = Math.max(selectedThreadSummary?.replyCount ?? 0, threadReplies.length);
  useEffect(() => {
    const previous = previousSelectedConversationId.current;
    const next = runtimeState.selectedConversationId;
    previousSelectedConversationId.current = next;
    if (previous === next) return;
    setPaneView("chat");
    // The first assignment is workspace load, not a user switch. Dismissing People there
    // races first paint and closes the directory the user just opened from the header.
    if (previous !== null) setPeopleSource(null);
  }, [runtimeState.selectedConversationId]);

  useEffect(() => {
    const conversationId = runtimeState.selectedConversationId;
    if (paneView !== "tasks" || conversationId === null || !tasksAvailable) return;
    const request = selectedIsPersonal
      ? runtime.loadMyTasks()
      : runtime.loadConversationTasks(conversationId);
    void request.catch(() => undefined);
  }, [paneView, runtime, runtimeState.selectedConversationId, selectedIsPersonal, tasksAvailable]);

  useEffect(() => {
    const conversationId = runtimeState.selectedConversationId;
    if (paneView !== "files" || conversationId === null) return;
    void runtime.loadConversationFiles(conversationId).catch(() => undefined);
  }, [paneView, runtime, runtimeState.selectedConversationId]);

  useBackgroundUnreadSignal(
    bootstrap?.conversations ?? null,
    destination === "workspace" ? runtimeState.selectedConversationId : null,
    chrome.notifyUnread,
  );

  const markPaneRead = useCallback(
    (conversationId: string, messageId: string) =>
      runtime.markConversationReadThrough(conversationId, messageId),
    [runtime],
  );
  const mainPane = useMessagePane({
    position: { kind: "conversation", unreadDividerMessageId },
    conversationId: runtimeState.selectedConversationId,
    active: destination === "workspace",
    isHeadless,
    messages,
    pendingCount: pending.length,
    lastReadSequence: selectedSummary?.readCursor?.lastReadConversationSequence ?? null,
    focusedMessageId: runtimeState.focusedMessageId,
    markRead: markPaneRead,
  });
  const threadPane = useMessagePane({
    position: { kind: "thread", rootId: selectedThreadRootId },
    conversationId: runtimeState.selectedConversationId,
    active: destination === "workspace",
    isHeadless,
    // The root is rendered outside the reply timeline but shares this read/scroll container.
    messages: threadRoot === undefined ? threadReplies : [threadRoot, ...threadReplies],
    pendingCount: threadPending.length,
    lastReadSequence: selectedSummary?.readCursor?.lastReadConversationSequence ?? null,
    focusedMessageId: runtimeState.focusedThreadMessageId,
    markRead: markPaneRead,
  });
  const timelineAtLiveTail = mainPane.atLiveTail;
  const threadAtLiveTail = threadPane.atLiveTail;

  useEffect(() => {
    if (notificationSession === null || notificationContext?.status !== "active") return;
    const view =
      destination !== "workspace"
        ? ({ pane: "none" } as const)
        : createNotificationActivityView({
            pane: paneView === "tasks" ? "tasks" : "chat",
            conversationId: runtimeState.selectedConversationId,
            timelineAtLiveTail: paneView === "chat" && timelineAtLiveTail,
            threadRootId: selectedThreadRootId,
            threadAtLiveTail: paneView === "chat" && threadAtLiveTail,
          });
    void notificationSession.report(view).catch(() => undefined);
  }, [
    notificationContext,
    notificationSession,
    destination,
    paneView,
    runtimeState.selectedConversationId,
    selectedThreadRootId,
    threadAtLiveTail,
    timelineAtLiveTail,
  ]);

  const {
    composerInput,
    threadComposer,
    attachComposerInput,
    attachThreadComposerInput,
    placeAppFocus,
  } = useComposerFocus({
    active: destination === "workspace",
    conversationId: runtimeState.selectedConversationId,
    conversationReady: selectedSummary !== undefined,
    threadRootId: selectedThreadRootId,
    threadReady: threadRoot !== undefined,
    deepLinkedReplyId: runtimeState.focusedThreadMessageId,
  });

  const composerAttachments =
    runtimeState.selectedConversationId === null
      ? []
      : (pendingAttachments[runtimeState.selectedConversationId] ?? []);
  const composerAttachmentUploadInProgress =
    runtimeState.selectedConversationId !== null &&
    attachingComposerKeys.has(runtimeState.selectedConversationId);
  const threadComposerKey =
    runtimeState.selectedConversationId === null || selectedThreadRootId === null
      ? null
      : `${runtimeState.selectedConversationId}:${selectedThreadRootId}`;
  const threadComposerAttachments =
    threadComposerKey === null ? [] : (pendingAttachments[threadComposerKey] ?? []);
  const threadAttachmentUploadInProgress =
    threadComposerKey !== null && attachingComposerKeys.has(threadComposerKey);

  const replacePendingAttachments = (
    key: string,
    updater: (current: readonly Attachment[]) => readonly Attachment[],
  ): void => {
    setPendingAttachments((current) => ({
      ...current,
      [key]: updater(current[key] ?? []),
    }));
  };

  const beginAttachmentUpload = (key: string): AttachmentUploadReservation | null => {
    const reservations = attachmentUploadReservations.current;
    if (reservations.has(key)) return null;
    const reservation = { generation: attachmentUploadGeneration.current };
    reservations.set(key, reservation);
    setAttachingComposerKeys(new Set(reservations.keys()));
    return reservation;
  };

  const finishAttachmentUpload = (key: string, reservation: AttachmentUploadReservation): void => {
    const reservations = attachmentUploadReservations.current;
    if (reservations.get(key) !== reservation) return;
    reservations.delete(key);
    setAttachingComposerKeys(new Set(reservations.keys()));
  };

  const attachToComposer = async (key: string): Promise<void> => {
    const conversationId = runtimeState.selectedConversationId;
    if (conversationId === null) return;
    const current = pendingAttachments[key] ?? [];
    const remainingFiles = ATTACHMENTS_PER_MESSAGE_MAX - current.length;
    const setAttachmentError = (message: string): void => {
      if (key === conversationId) setComposerError(message);
      else setThreadComposerError(message);
    };
    if (remainingFiles <= 0) {
      setAttachmentError(`You can attach up to ${String(ATTACHMENTS_PER_MESSAGE_MAX)} files`);
      return;
    }
    const reservation = beginAttachmentUpload(key);
    if (reservation === null) return;
    try {
      const result = await withAttachmentUploadTimeout(
        runtime.attachFiles(conversationId, remainingFiles),
      );
      if (reservation.generation !== attachmentUploadGeneration.current) return;
      if (result.status === "cancelled") return;
      if (result.status === "completed" || result.status === "partial") {
        replacePendingAttachments(key, (pending) => {
          const existingIds = new Set(pending.map((attachment) => attachment.id));
          const available = Math.max(ATTACHMENTS_PER_MESSAGE_MAX - pending.length, 0);
          return [
            ...pending,
            ...result.attachments
              .filter((attachment) => !existingIds.has(attachment.id))
              .slice(0, available),
          ];
        });
      }
      if (result.status === "completed") {
        setComposerError("");
        setThreadComposerError("");
      } else if (result.status === "partial") {
        setAttachmentError(result.message);
      } else if (result.reason === "selection_limit") {
        setAttachmentError(
          `You can select up to ${String(remainingFiles)} ${remainingFiles === 1 ? "file" : "files"}`,
        );
      } else {
        setAttachmentError(result.message);
      }
    } catch (error) {
      if (reservation.generation !== attachmentUploadGeneration.current) return;
      const message = ipcErrorMessage(error, "Could not attach the file");
      setAttachmentError(message);
    } finally {
      finishAttachmentUpload(key, reservation);
    }
  };

  const send = async (): Promise<void> => {
    const submittedDraft = draft;
    const conversationId = runtimeState.selectedConversationId;
    const attachments = conversationId === null ? [] : (pendingAttachments[conversationId] ?? []);
    const body = submittedDraft.trim() || attachmentOnlyMessageBody(attachments);
    if (
      body === "" ||
      conversationId === null ||
      attachmentUploadReservations.current.has(conversationId) ||
      bootstrap === null
    ) {
      return;
    }
    const mentionedUserIds = mentionedMemberIds(
      body,
      bootstrap.members,
      selectedSummary?.participantIds ?? [],
    );
    try {
      if (editingClientMessageId === null) {
        await runtime.sendMessage(
          conversationId,
          body,
          mentionedUserIds,
          null,
          attachments.map((attachment) => attachment.id),
        );
      } else {
        await runtime.replaceFailedMessage(editingClientMessageId, body, mentionedUserIds);
        setEditingClientMessageId(null);
      }
      clearDraft(submittedDraft);
      runtime.setTyping(conversationId, false);
      replacePendingAttachments(conversationId, () => []);
      setComposerError("");
    } catch (error) {
      setComposerError(ipcErrorMessage(error, "Could not queue the message"));
    }
  };

  const createTaskFromMessage = async (message: Message): Promise<void> => {
    const firstLine = message.body.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
    const title = (firstLine === "" ? "Follow up on this message" : firstLine).slice(0, 240);
    try {
      await runtime.createTask({
        conversationId: message.conversationId,
        title,
        sourceMessageId: message.id,
        assigneeId: selectedIsPersonal ? (bootstrap?.currentUser.user.id ?? null) : null,
      });
      setPaneView("tasks");
      setComposerError("");
    } catch (error) {
      setComposerError(ipcErrorMessage(error, "Could not create a task from this message"));
    }
  };

  const openTaskSource = (task: Task): void => {
    runPreferencesNavigation(() => {
      setDestination("workspace");
      setPaneView("chat");
      runtime.openTaskSource(task);
    });
  };

  const sendThreadReply = async (): Promise<void> => {
    const submittedDraft = threadDraft;
    const conversationId = runtimeState.selectedConversationId;
    const threadRootId = runtimeState.selectedThreadRootId;
    const key =
      conversationId === null || threadRootId === null ? null : `${conversationId}:${threadRootId}`;
    const attachments = key === null ? [] : (pendingAttachments[key] ?? []);
    const body = submittedDraft.trim() || attachmentOnlyMessageBody(attachments);
    if (
      body === "" ||
      conversationId === null ||
      threadRootId === null ||
      (key !== null && attachmentUploadReservations.current.has(key)) ||
      bootstrap === null
    ) {
      return;
    }
    const mentionedUserIds = mentionedMemberIds(
      body,
      bootstrap.members,
      selectedSummary?.participantIds ?? [],
    );
    try {
      if (threadEditingClientMessageId === null) {
        await runtime.sendMessage(
          conversationId,
          body,
          mentionedUserIds,
          threadRootId,
          attachments.map((attachment) => attachment.id),
        );
      } else {
        await runtime.replaceFailedMessage(threadEditingClientMessageId, body, mentionedUserIds);
        setThreadEditingClientMessageId(null);
      }
      clearThreadDraft(submittedDraft);
      runtime.setTyping(conversationId, false);
      if (key !== null) replacePendingAttachments(key, () => []);
      setThreadComposerError("");
    } catch (error) {
      setThreadComposerError(ipcErrorMessage(error, "Could not queue the reply"));
    }
  };

  const openAttachmentSource = (attachment: Attachment): void => {
    runPreferencesNavigation(() => {
      setDestination("workspace");
      setPaneView("chat");
      runtime.openAttachmentSource(attachment);
    });
  };

  const createChannel = useCallback(
    async (
      name: string,
      slug: string,
      topic: string | null,
      access: ChannelAccess,
      channelMode: ChannelMode,
    ): Promise<boolean> => {
      const allowed = requestPreferencesNavigation();
      if (!(typeof allowed === "boolean" ? allowed : await allowed)) return false;
      setDestination("workspace");
      await runtime.createChannel(name, slug, topic, access, channelMode);
      return true;
    },
    [requestPreferencesNavigation, runtime],
  );

  const loadChannelMembers = useCallback(
    (conversationId: string) => runtime.getChannelMembers(conversationId),
    [runtime],
  );

  const upsertChannelMember = useCallback(
    (conversationId: string, userId: string, role: "owner" | "member") =>
      runtime.upsertChannelMember(conversationId, userId, role),
    [runtime],
  );

  const removeChannelMember = useCallback(
    (conversationId: string, userId: string) => runtime.removeChannelMember(conversationId, userId),
    [runtime],
  );

  const startDirectMessage = useCallback(
    async (memberId: string) => {
      try {
        const allowed = requestPreferencesNavigation();
        if (!(typeof allowed === "boolean" ? allowed : await allowed)) return;
        setDestination("workspace");
        await runtime.createDirectConversation(memberId);
      } catch (error) {
        setComposerError(ipcErrorMessage(error, "Could not start the direct message"));
      }
    },
    [requestPreferencesNavigation, runtime],
  );

  const messageDirectoryMember = useCallback(
    (memberId: string) => {
      setPeopleSource(null);
      void startDirectMessage(memberId);
    },
    [startDirectMessage],
  );

  const rebuildLocalCache = (signedIn: SignedInSession): Promise<void> =>
    startWorkspaceSession(signedIn, { resetLocalCache: true });

  const signOut = async (): Promise<void> => {
    if (
      runtimeState.outbox.length > 0 &&
      !window.confirm("Pending messages have not been delivered. Sign out and discard them?")
    ) {
      return;
    }
    if (!(await requestPreferencesNavigation())) return;
    setSigningOut(true);
    try {
      await runtime.stop();
      await runtime.resetLocalCache();
      await client.signOut();
    } finally {
      setSigningOut(false);
    }
  };

  if (session === null) return <main className="signin-shell" aria-busy="true" />;
  if (session.status === "signed-out") {
    return <SignIn client={client} theme={theme} sessionMessage={session.message} />;
  }
  const authenticatedSession = recoverableAuthenticatedSession(session);
  if (session.status === "session-unavailable" && authenticatedSession === null) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <h1>Chat server unavailable</h1>
          <p>{session.message}</p>
          <button type="button" onClick={() => void retrySession()}>
            Try again
          </button>
          <ThemeSelector theme={theme} />
          <ClientVersion client={client} />
        </section>
      </main>
    );
  }
  if (authenticatedSession === null) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <h1>Member sign-in required</h1>
          <p>M2 conversations require an invited magic-link identity.</p>
          <button type="button" onClick={() => void client.signOut()}>
            Continue to member sign-in
          </button>
          <ThemeSelector theme={theme} />
          <ClientVersion client={client} />
        </section>
      </main>
    );
  }
  if (bootstrap === null) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <h1>
            {runtimeState.error === null ? "Loading your workspace…" : "Workspace unavailable"}
          </h1>
          <p>
            {runtimeState.error ?? "Restoring encrypted history and checking for new messages."}
          </p>
          {runtimeState.error !== null && (
            <div className="message-actions">
              <button
                type="button"
                onClick={() =>
                  void (session.status === "session-unavailable"
                    ? retrySession()
                    : startWorkspaceSession(authenticatedSession))
                }
              >
                Retry
              </button>
              {session.status === "signed-in" && (
                <button type="button" onClick={() => void rebuildLocalCache(session)}>
                  Reset local cache
                </button>
              )}
            </div>
          )}
          <ThemeSelector theme={theme} />
          <ClientVersion client={client} />
        </section>
      </main>
    );
  }

  const allChannels = bootstrap.conversations.filter(
    (summary) => summary.conversation.kind === "channel",
  );
  // Built-in channels are server-owned and get their own sidebar section, so they are kept out of
  // the member channel list rather than sorted among it.
  const builtInChannels = allChannels.filter((summary) =>
    isBuiltInConversation(summary.conversation),
  );
  const channels = allChannels.filter((summary) => !isBuiltInConversation(summary.conversation));
  const directMessages = bootstrap.conversations.filter(
    (summary) =>
      summary.conversation.kind === "direct_message" ||
      summary.conversation.kind === "group_direct_message",
  );
  const channelReferences: ChannelReferenceTarget[] = channels.flatMap((summary) =>
    summary.conversation.slug === null
      ? []
      : [{ conversationId: summary.conversation.id, slug: summary.conversation.slug }],
  );
  const timelineContext: MessageTimelineContext = {
    members: bootstrap.members,
    currentUser: bootstrap.currentUser.user,
    reactions: reactionsByMessage,
    attachments: attachmentsByMessage,
    archived: selectedSummary?.conversation.isArchived ?? true,
    timestampFormat: preferences.timestampFormat,
    channelReferences,
    onOpenChannel: selectConversation,
    actions: runtime,
  };
  const selectedTimelineLoaded = runtimeState.collections.some(
    (collection) =>
      collection.loaded &&
      collection.identity.kind === "timeline" &&
      collection.identity.conversationId === runtimeState.selectedConversationId,
  );
  const currentUserId = bootstrap.currentUser.user.id;
  const selectedCollection: CollectionIdentity | null =
    runtimeState.selectedConversationId === null
      ? null
      : paneView === "tasks" && selectedIsPersonal
        ? { kind: "my_tasks" }
        : {
            kind: paneView === "chat" ? "timeline" : paneView,
            conversationId: runtimeState.selectedConversationId,
          };
  const selectedRecovery =
    selectedCollection === null
      ? undefined
      : collectionRecovery(runtimeState.recovery, selectedCollection);
  const retrySelectedCollection = (): void => {
    const id = runtimeState.selectedConversationId;
    if (id === null) return;
    const loading =
      paneView === "files"
        ? runtime.loadConversationFiles(id)
        : paneView === "tasks"
          ? selectedIsPersonal
            ? runtime.loadMyTasks()
            : runtime.loadConversationTasks(id)
          : runtime.loadOlder(id);
    void loading.catch(() => undefined);
  };
  const typingIndicator = (
    <WorkspaceTypingIndicator
      runtime={runtime}
      conversationId={runtimeState.selectedConversationId}
      members={bootstrap.members}
      currentUserId={currentUserId}
    />
  );
  const unreadItems = listUnreadConversations(bootstrap.conversations, (summary) =>
    runtime.conversationName(summary),
  );
  const unreadTotals = unreadBadgeTotals(unreadItems);

  return (
    <main
      className={
        destination !== "workspace" || selectedThreadRootId === null ? "shell" : "shell thread-open"
      }
      data-testid="workspace-ready"
    >
      {compact && <CompactHotzone chrome={chrome} />}
      <aside
        id="workspace-rail"
        className="workspace-rail"
        aria-label="Workspace"
        {...chrome.chromeProps}
      >
        <BrandMark className="workspace-mark" label="Hype Comms" />
      </aside>

      <aside
        id="workspace-sidebar"
        className="sidebar"
        aria-label="Workspace navigation"
        {...chrome.chromeProps}
      >
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>{bootstrap.workspace.name}</h1>
          </div>
          <div className="workspace-header-actions">
            <button
              ref={peopleTrigger}
              className="quiet-button"
              type="button"
              onClick={() => setPeopleSource("workspace")}
            >
              People
            </button>
            <button className="quiet-button" type="button" onClick={() => void signOut()}>
              {signingOut ? "…" : "Sign out"}
            </button>
          </div>
        </header>

        <ConversationSwitcher
          conversations={bootstrap.conversations.map((summary) => ({
            id: summary.conversation.id,
            name: runtime.conversationName(summary),
            kind: summary.conversation.kind,
            isArchived: summary.conversation.isArchived,
            access: summary.conversation.access,
            channelMode: summary.conversation.channelMode,
          }))}
          selectedConversationId={
            destination === "workspace" ? runtimeState.selectedConversationId : null
          }
          platform={client.platform}
          onSelect={(conversationId) =>
            selectConversation(conversationId, () => {
              // Picking a destination means "show me the channel": a pointer resting on the
              // overlay would otherwise hold it open over the conversation it just selected.
              chrome.collapse();
            })
          }
          onOpenChange={chrome.onPopoverOpenChange}
        />

        <WorkspaceSearch
          members={bootstrap.members}
          conversationName={(conversationId) => {
            const summary = bootstrap.conversations.find(
              (candidate) => candidate.conversation.id === conversationId,
            );
            return summary === undefined
              ? "Unavailable conversation"
              : runtime.conversationName(summary);
          }}
          search={(query, after) => runtime.searchMessages(query, after)}
          openResult={async (result) => {
            const allowed = requestPreferencesNavigation();
            if (!(typeof allowed === "boolean" ? allowed : await allowed)) return false;
            setDestination("workspace");
            await runtime.openSearchResult(result);
            chrome.collapse();
            return true;
          }}
          onOpenChange={chrome.onPopoverOpenChange}
        />

        <nav aria-label="Conversations">
          <div className="nav-heading">
            <span>Catch up</span>
          </div>
          <button
            className={
              destination === "unreads"
                ? "conversation unreads-destination active"
                : "conversation unreads-destination"
            }
            type="button"
            aria-current={destination === "unreads" ? "page" : undefined}
            onClick={openUnreads}
          >
            <span className="conversation-label">
              <UnreadsIcon />
              <span className="conversation-label-text">Unreads</span>
            </span>
            <ConversationBadge
              unreadCount={unreadTotals.unreadCount}
              mentionCount={unreadTotals.mentionCount}
            />
          </button>

          <div className="nav-heading">
            <span>AI</span>
          </div>
          <button
            className={
              destination === "ai"
                ? "conversation ai-channel-destination active"
                : "conversation ai-channel-destination"
            }
            type="button"
            aria-current={destination === "ai" ? "page" : undefined}
            onClick={openAiChannel}
          >
            <span className="conversation-label">
              <AiChannelIcon />
              <span className="conversation-label-text">AI Channel</span>
            </span>
            <span className="ai-channel-local-badge">Local</span>
          </button>

          {bootstrap.currentUser.role === "owner" && (
            <>
              <div className="nav-heading">
                <span>Admin</span>
              </div>
              <button
                className={
                  destination === "admin"
                    ? "conversation communication-paths-destination active"
                    : "conversation communication-paths-destination"
                }
                type="button"
                aria-current={destination === "admin" ? "page" : undefined}
                onClick={openCommunicationPaths}
              >
                <span className="conversation-label">
                  <CommunicationPathsIcon />
                  <span className="conversation-label-text">Communication paths</span>
                </span>
              </button>
              <button
                className={
                  destination === "agent-enrollments"
                    ? "conversation agent-requests-destination active"
                    : "conversation agent-requests-destination"
                }
                type="button"
                aria-current={destination === "agent-enrollments" ? "page" : undefined}
                onClick={openAgentEnrollments}
              >
                <span className="conversation-label">
                  <AgentRequestsIcon />
                  <span className="conversation-label-text">Agent requests</span>
                </span>
              </button>
            </>
          )}

          {builtInChannels.length > 0 && (
            <>
              <div className="nav-heading">
                <span>Built-in</span>
              </div>
              {builtInChannels.map((summary) => (
                <button
                  className={
                    destination === "workspace" &&
                    summary.conversation.id === runtimeState.selectedConversationId
                      ? "conversation active"
                      : "conversation"
                  }
                  type="button"
                  key={summary.conversation.id}
                  onClick={() => selectConversation(summary.conversation.id)}
                >
                  <span
                    className="conversation-label conversation-label-channel"
                    title={summary.conversation.name ?? undefined}
                  >
                    <ChannelIcon
                      access={summary.conversation.access}
                      channelMode={summary.conversation.channelMode}
                    />
                    <span className="conversation-label-text">{summary.conversation.name}</span>
                  </span>
                  <span className="built-in-channel-badge">Built-in</span>
                  <ConversationBadge
                    unreadCount={summary.unreadCount}
                    mentionCount={summary.mentionCount}
                  />
                </button>
              ))}
            </>
          )}

          <div className="nav-heading">
            <span>Channels</span>
            <ChannelCreatePopover
              canCreateAnnouncements={
                bootstrap.featureFlags.announcementChannels &&
                bootstrap.currentUser.role === "owner"
              }
              canCreateHumansOnly={bootstrap.featureFlags.humansOnlyChannels}
              onCreate={createChannel}
              onOpenChange={chrome.onPopoverOpenChange}
            />
          </div>
          {channels.map((summary) => (
            <button
              className={
                destination === "workspace" &&
                summary.conversation.id === runtimeState.selectedConversationId
                  ? "conversation active"
                  : "conversation"
              }
              type="button"
              key={summary.conversation.id}
              onClick={() => selectConversation(summary.conversation.id)}
            >
              <span
                className="conversation-label conversation-label-channel"
                title={`${summary.conversation.name}${summary.conversation.isArchived ? " (archived)" : ""}`}
              >
                <ChannelIcon
                  access={summary.conversation.access}
                  channelMode={summary.conversation.channelMode}
                />
                <span className="conversation-label-text">
                  {summary.conversation.name}
                  {summary.conversation.isArchived ? " (archived)" : ""}
                </span>
              </span>
              <ConversationBadge
                unreadCount={summary.unreadCount}
                mentionCount={summary.mentionCount}
              />
            </button>
          ))}

          <div className="nav-heading">
            <span>Direct messages</span>
          </div>
          {directMessages.map((summary) => {
            const participantId =
              summary.participantIds.find((id) => id !== currentUserId) ?? currentUserId;
            return (
              <button
                className={
                  destination === "workspace" &&
                  summary.conversation.id === runtimeState.selectedConversationId
                    ? "conversation active"
                    : "conversation"
                }
                type="button"
                key={summary.conversation.id}
                onClick={() => selectConversation(summary.conversation.id)}
              >
                <span
                  className="conversation-label conversation-label-direct-message"
                  title={runtime.conversationName(summary)}
                >
                  {summary.conversation.kind === "group_direct_message" ? (
                    <GroupDirectMessageIcon />
                  ) : (
                    <>
                      <DirectMessageIcon />
                      <PresenceIndicator
                        state={runtimeState.presenceByUser[participantId] ?? "offline"}
                      />
                    </>
                  )}
                  <span className="conversation-label-text">
                    {runtime.conversationName(summary)}
                  </span>
                </span>
                <ConversationBadge
                  unreadCount={summary.unreadCount}
                  mentionCount={summary.mentionCount}
                />
              </button>
            );
          })}
        </nav>

        <footer className="sidebar-footer">
          <button
            className={
              destination === "preferences" ? "preferences-trigger active" : "preferences-trigger"
            }
            type="button"
            aria-current={destination === "preferences" ? "page" : undefined}
            onClick={openPreferences}
          >
            Preferences
          </button>
          <UpdateControl client={client} beforeRestart={requestPreferencesNavigation} />
          <ClientVersion client={client} />
        </footer>
      </aside>

      {aiChannelVisited && <AiChannel transport={client} active={destination === "ai"} />}
      <UnreadsView
        items={unreadItems}
        active={destination === "unreads"}
        onOpen={selectConversation}
      />
      <PreferencesPage
        key={`preferences:${bootstrap.currentUser.user.id}:${bootstrap.currentUser.workspaceId}`}
        ref={preferencesPage}
        active={destination === "preferences"}
        theme={theme}
        compactMode={compactMode}
        devicePreferences={devicePreferences}
        fencedBlockquotes={fencedBlockquotes}
        sidebarPosition={sidebarPosition}
        notifications={notificationTransport ?? undefined}
        platform={client.platform}
        currentUser={bootstrap.currentUser.user}
        onUpdateProfile={(title) => runtime.updateProfileTitle(title)}
      />
      {bootstrap.currentUser.role === "owner" && (
        <>
          <CommunicationPathsView
            // Keyed by the authenticated identity so the cached aggregate can never survive a
            // session change into another workspace, even across a direct signed-in transition.
            key={`communication-paths:${bootstrap.currentUser.user.id}:${bootstrap.currentUser.workspaceId}`}
            client={client}
            members={bootstrap.members}
            active={destination === "admin"}
          />
          <AgentEnrollmentsView
            key={`agent-enrollments:${bootstrap.currentUser.user.id}:${bootstrap.currentUser.workspaceId}`}
            client={client}
            members={bootstrap.members}
            conversations={bootstrap.conversations}
            active={destination === "agent-enrollments"}
          />
        </>
      )}
      <section className="conversation-pane" hidden={destination !== "workspace"}>
        <header className="conversation-header">
          <div>
            <h2>
              {selectedSummary === undefined
                ? "Choose a conversation"
                : runtime.conversationName(selectedSummary)}
            </h2>
            {selectedSummary?.conversation.topic !== null &&
              selectedSummary?.conversation.topic !== undefined && (
                <p className="conversation-topic" title={selectedSummary.conversation.topic}>
                  {selectedSummary.conversation.topic}
                </p>
              )}
            {selectedIsAnnouncement && (
              <p className="announcement-participation">
                {selectedIsBuiltIn
                  ? "Hype Comms posts release notes here. Everyone can reply in threads and react."
                  : "Workspace owners post bulletins. Members can reply in threads and react."}
              </p>
            )}
            <ConversationHealth
              connection={runtimeState.connection}
              stale={runtimeState.stale}
              {...(selectedRecovery === undefined ? {} : { collectionRecovery: selectedRecovery })}
              onRetryCollection={retrySelectedCollection}
              cacheMode={runtimeState.cacheMode}
              notice={workspaceNotice}
              onRetry={() =>
                void (session.status === "session-unavailable"
                  ? retrySession()
                  : startWorkspaceSession(authenticatedSession))
              }
              {...(session.status === "signed-in"
                ? { onResetCache: () => void rebuildLocalCache(session) }
                : {})}
              onCheckForUpdates={client.checkForUpdates}
            />
          </div>
          {selectedSummary !== undefined && (
            <div className="conversation-header-actions">
              <div className="pane-toggle" aria-label="Conversation view">
                <button
                  type="button"
                  className={paneView === "chat" ? "active" : ""}
                  onClick={() => setPaneView("chat")}
                >
                  Chat
                </button>
                {tasksAvailable && (
                  <button
                    type="button"
                    className={paneView === "tasks" ? "active" : ""}
                    onClick={() => setPaneView("tasks")}
                  >
                    Tasks
                  </button>
                )}
                <button
                  type="button"
                  className={paneView === "files" ? "active" : ""}
                  onClick={() => setPaneView("files")}
                >
                  Files
                </button>
              </div>
              {selectedSummary.conversation.kind === "channel" && (
                <>
                  <button
                    ref={channelMembersTrigger}
                    className="quiet-button"
                    type="button"
                    onClick={() => setPeopleSource("channel")}
                  >
                    {selectedSummary.conversation.access === "members"
                      ? `${String(selectedSummary.participantIds.length)} members`
                      : selectedSummary.conversation.access === "humans"
                        ? "Humans only"
                        : "Everyone"}
                  </button>
                  {selectedSummary.conversation.slug !== "general" &&
                    !selectedIsBuiltIn &&
                    !selectedSummary.conversation.isArchived &&
                    bootstrap.currentUser.role === "owner" && (
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={() => void runtime.archiveChannel(selectedSummary.conversation.id)}
                      >
                        Archive
                      </button>
                    )}
                </>
              )}
            </div>
          )}
        </header>

        {paneView === "files" && selectedSummary !== undefined ? (
          <>
            <FilesView
              conversationName={runtime.conversationName(selectedSummary)}
              files={runtimeState.conversationFiles}
              members={bootstrap.members}
              busy={runtimeState.conversationFilesBusy}
              error={runtimeState.conversationFilesError}
              onOpen={(attachmentId) => runtime.openFile(attachmentId)}
              onOpenSource={openAttachmentSource}
            />
            {selectedSummary.conversation.isArchived === true ? (
              <ArchivedConversationNotice />
            ) : selectedIsAnnouncement && !canPublishBulletins ? (
              <AnnouncementPostingNotice builtIn={selectedIsBuiltIn} />
            ) : (
              <MessageComposer
                contextKey={selectedSummary.conversation.id}
                conversationName={runtime.conversationName(selectedSummary)}
                draft={draft}
                pendingAttachments={composerAttachments}
                disabled={false}
                attachDisabled={composerAttachments.length >= ATTACHMENTS_PER_MESSAGE_MAX}
                attachmentUploadInProgress={composerAttachmentUploadInProgress}
                error={composerError}
                inputLabel={selectedIsAnnouncement ? "Bulletin" : "Message"}
                inputRef={attachComposerInput}
                platform={client.platform}
                placeholder={selectedIsAnnouncement ? "Write a bulletin…" : undefined}
                submitLabel={selectedIsAnnouncement ? "Post bulletin" : "Send"}
                typingIndicator={typingIndicator}
                sendMessageShortcut={preferences.sendMessageShortcut}
                spellCheck={preferences.spellCheck}
                onDraftChange={updateMainDraft}
                onAttach={() => attachToComposer(selectedSummary.conversation.id)}
                onRemoveAttachment={(attachmentId) =>
                  replacePendingAttachments(selectedSummary.conversation.id, (current) =>
                    current.filter((attachment) => attachment.id !== attachmentId),
                  )
                }
                onSubmit={send}
              />
            )}
          </>
        ) : paneView === "tasks" && tasksAvailable && selectedSummary !== undefined ? (
          <TasksView
            conversationId={selectedSummary.conversation.id}
            personal={selectedIsPersonal === true}
            archived={selectedSummary.conversation.isArchived}
            currentUserId={currentUserId}
            members={bootstrap.members}
            assignableMembers={(conversationId) => {
              const summary = bootstrap.conversations.find(
                (candidate) => candidate.conversation.id === conversationId,
              );
              if (summary === undefined) return [];
              const participantIds = new Set(summary.participantIds);
              return bootstrap.members.filter((member) => participantIds.has(member.id));
            }}
            tasks={runtimeState.tasks}
            busy={runtimeState.tasksBusy}
            error={runtimeState.taskError}
            conversationName={(conversationId) => {
              const summary = bootstrap.conversations.find(
                (candidate) => candidate.conversation.id === conversationId,
              );
              return summary === undefined ? "Unavailable" : runtime.conversationName(summary);
            }}
            isConversationArchived={(conversationId) =>
              bootstrap.conversations.find(
                (candidate) => candidate.conversation.id === conversationId,
              )?.conversation.isArchived ?? true
            }
            onCreate={(input) =>
              runtime.createTask({ conversationId: selectedSummary.conversation.id, ...input })
            }
            onUpdate={(taskId, input) => runtime.updateTask(taskId, input)}
            onMove={(taskId, status, beforeTaskId) =>
              runtime.moveTask(taskId, status, beforeTaskId)
            }
            onOpenSource={openTaskSource}
          />
        ) : (
          <>
            <div
              className="message-list"
              ref={mainPane.list}
              aria-live="polite"
              onScroll={mainPane.handleScroll}
            >
              {runtimeState.selectedConversationId !== null &&
                selectedTimelineLoaded &&
                runtime.hasOlder(runtimeState.selectedConversationId) && (
                  <button
                    className="load-older"
                    type="button"
                    onClick={() => {
                      const conversationId = runtimeState.selectedConversationId;
                      if (conversationId !== null)
                        void runtime.loadOlder(conversationId).catch(() => undefined);
                    }}
                  >
                    Load older messages
                  </button>
                )}
              {messages.length === 0 &&
                pending.length === 0 &&
                (selectedTimelineLoaded ? (
                  <ConversationEmptyState
                    conversationName={
                      selectedSummary === undefined
                        ? null
                        : runtime.conversationName(selectedSummary)
                    }
                    kind={selectedSummary?.conversation.kind ?? null}
                    personal={selectedIsPersonal === true}
                    archived={selectedSummary?.conversation.isArchived ?? false}
                    channelMode={selectedSummary?.conversation.channelMode ?? null}
                  />
                ) : (
                  <p className="thread-loading" role="status">
                    {selectedRecovery?.status === "blocked"
                      ? "Messages could not be loaded."
                      : "Loading messages…"}
                  </p>
                ))}
              <MessageTimeline
                context={timelineContext}
                messages={messages}
                pending={pending}
                groupConsecutive={preferences.groupConsecutiveMessages}
                highlightedId={runtimeState.focusedMessageId}
                editingId={editingClientMessageId}
                onEditPending={(item) => {
                  setDraft(item.operation.message.body);
                  setEditingClientMessageId(item.operation.message.clientMessageId);
                }}
                unread={
                  runtimeState.selectedConversationId === null
                    ? undefined
                    : {
                        conversationId: runtimeState.selectedConversationId,
                        messageId: unreadDividerMessageId,
                      }
                }
                onCreateTask={tasksAvailable ? createTaskFromMessage : undefined}
                replyFor={(message) => ({
                  count: Math.max(
                    threadSummaryByRoot.get(message.id)?.replyCount ?? 0,
                    loadedReplyCountByRoot.get(message.id) ?? 0,
                  ),
                  open:
                    runtimeState.threadsSupported &&
                    message.threadRootId === null &&
                    (!(selectedSummary?.conversation.isArchived ?? true) ||
                      threadSummaryByRoot.has(message.id) ||
                      loadedReplyCountByRoot.has(message.id) ||
                      pendingThreadRootIds.has(message.id))
                      ? () => void runtime.openThread(message.id)
                      : undefined,
                })}
              />
            </div>

            {selectedSummary?.conversation.isArchived === true ? (
              <ArchivedConversationNotice />
            ) : selectedIsAnnouncement && !canPublishBulletins ? (
              <AnnouncementPostingNotice builtIn={selectedIsBuiltIn} />
            ) : (
              <MessageComposer
                contextKey={runtimeState.selectedConversationId ?? undefined}
                conversationName={
                  selectedSummary === undefined ? null : runtime.conversationName(selectedSummary)
                }
                draft={draft}
                pendingAttachments={composerAttachments}
                disabled={selectedSummary === undefined}
                attachDisabled={composerAttachments.length >= ATTACHMENTS_PER_MESSAGE_MAX}
                attachmentUploadInProgress={composerAttachmentUploadInProgress}
                error={composerError}
                inputLabel={selectedIsAnnouncement ? "Bulletin" : "Message"}
                inputRef={attachComposerInput}
                members={selectedConversationMembers}
                currentUserId={currentUserId}
                platform={client.platform}
                placeholder={selectedIsAnnouncement ? "Write a bulletin…" : undefined}
                submitLabel={selectedIsAnnouncement ? "Post bulletin" : "Send"}
                typingIndicator={typingIndicator}
                sendMessageShortcut={preferences.sendMessageShortcut}
                spellCheck={preferences.spellCheck}
                onDraftChange={updateMainDraft}
                onAttach={
                  selectedSummary === undefined
                    ? undefined
                    : () => attachToComposer(selectedSummary.conversation.id)
                }
                onRemoveAttachment={(attachmentId) => {
                  if (runtimeState.selectedConversationId === null) return;
                  replacePendingAttachments(runtimeState.selectedConversationId, (current) =>
                    current.filter((attachment) => attachment.id !== attachmentId),
                  );
                }}
                onSubmit={send}
              />
            )}
          </>
        )}
      </section>
      {destination === "workspace" && selectedThreadRootId !== null && (
        <aside className="thread-pane" aria-label="Thread">
          <header className="thread-header">
            <div>
              <h2>Thread</h2>
              <p>
                {threadReplyCount === 0
                  ? "No replies yet"
                  : `${String(threadReplyCount)} ${threadReplyCount === 1 ? "reply" : "replies"}`}
              </p>
            </div>
            <button
              className="thread-close"
              type="button"
              aria-label="Close thread"
              onClick={() => {
                runtime.closeThread();
                // A real click focuses this button first, and its focusin expires the pending
                // conversation intent; the pane unmount would then strand focus on <body>.
                // Hand it to the composer directly instead.
                placeAppFocus(composerInput.current);
              }}
            >
              ×
            </button>
          </header>

          <div
            className="thread-message-list"
            ref={threadPane.list}
            aria-live="polite"
            onScroll={threadPane.handleScroll}
          >
            {runtimeState.threadError !== null && (
              <p className="thread-error" role="alert">
                {runtimeState.threadError}{" "}
                <button type="button" onClick={() => void runtime.openThread(selectedThreadRootId)}>
                  Retry
                </button>
              </p>
            )}
            {threadRoot === undefined ? (
              <div className="thread-loading" aria-busy={runtimeState.threadLoading}>
                {runtimeState.threadLoading ? "Loading thread…" : "Thread unavailable"}
              </div>
            ) : (
              <>
                <WorkspaceMessageRow
                  context={timelineContext}
                  message={threadRoot}
                  highlightedId={runtimeState.focusedThreadMessageId}
                  domIdPrefix="thread-message"
                />
                <div className="thread-replies-heading" role="separator">
                  <span>
                    {threadReplyCount === 0
                      ? "Replies"
                      : `${String(threadReplyCount)} ${threadReplyCount === 1 ? "reply" : "replies"}`}
                  </span>
                </div>
                {runtime.hasOlderThread(selectedThreadRootId) && (
                  <button
                    className="load-older"
                    type="button"
                    disabled={runtimeState.threadLoading}
                    onClick={() => void runtime.loadOlderThread(selectedThreadRootId)}
                  >
                    Load older replies
                  </button>
                )}
                <MessageTimeline
                  context={timelineContext}
                  messages={threadReplies}
                  pending={threadPending}
                  groupConsecutive={preferences.groupConsecutiveMessages}
                  highlightedId={runtimeState.focusedThreadMessageId}
                  editingId={threadEditingClientMessageId}
                  domIdPrefix="thread-message"
                  pendingTimestampFallback={threadRoot.createdAt}
                  onEditPending={(item) => {
                    setThreadDraft(item.operation.message.body);
                    setThreadEditingClientMessageId(item.operation.message.clientMessageId);
                    threadComposer.current?.focus();
                  }}
                />
                {threadReplies.length === 0 &&
                  threadPending.length === 0 &&
                  !runtimeState.threadLoading && (
                    <p className="thread-empty">Start the thread with a reply.</p>
                  )}
                {runtimeState.threadLoading && <p className="thread-loading">Loading replies…</p>}
              </>
            )}
          </div>

          {selectedSummary?.conversation.isArchived === true ? (
            <ArchivedConversationNotice thread />
          ) : (
            <MessageComposer
              contextKey={`${String(runtimeState.selectedConversationId)}:${selectedThreadRootId}`}
              conversationName={null}
              draft={threadDraft}
              pendingAttachments={threadComposerAttachments}
              disabled={threadRoot === undefined}
              attachDisabled={threadComposerAttachments.length >= ATTACHMENTS_PER_MESSAGE_MAX}
              attachmentUploadInProgress={threadAttachmentUploadInProgress}
              error={threadComposerError}
              inputId="thread-message-composer"
              inputLabel="Reply"
              inputRef={attachThreadComposerInput}
              members={selectedConversationMembers}
              currentUserId={currentUserId}
              platform={client.platform}
              placeholder="Reply in thread"
              submitLabel="Reply"
              variantClassName="thread-composer"
              typingIndicator={typingIndicator}
              sendMessageShortcut={preferences.sendMessageShortcut}
              spellCheck={preferences.spellCheck}
              onDraftChange={updateThreadDraft}
              onAttach={
                threadComposerKey === null ? undefined : () => attachToComposer(threadComposerKey)
              }
              onRemoveAttachment={(attachmentId) => {
                if (threadComposerKey === null) return;
                replacePendingAttachments(threadComposerKey, (current) =>
                  current.filter((attachment) => attachment.id !== attachmentId),
                );
              }}
              onSubmit={sendThreadReply}
            />
          )}
        </aside>
      )}
      {peopleSource === "workspace" && (
        <ChannelMembersDialog
          source="workspace"
          currentUserId={currentUserId}
          workspaceMembers={bootstrap.members}
          presenceByUser={runtimeState.presenceByUser}
          triggerRef={peopleTrigger}
          onClose={() => setPeopleSource(null)}
          onMessage={messageDirectoryMember}
          onOpenChange={chrome.onPopoverOpenChange}
        />
      )}
      {peopleSource === "channel" && selectedSummary?.conversation.kind === "channel" && (
        <ChannelMembersDialog
          source="channel"
          channelName={
            selectedSummary.conversation.name ?? selectedSummary.conversation.slug ?? "channel"
          }
          channelMode={selectedSummary.conversation.channelMode}
          conversationId={selectedSummary.conversation.id}
          currentUserId={currentUserId}
          workspaceMembers={bootstrap.members}
          presenceByUser={runtimeState.presenceByUser}
          triggerRef={channelMembersTrigger}
          onClose={() => setPeopleSource(null)}
          onMessage={messageDirectoryMember}
          onOpenChange={chrome.onPopoverOpenChange}
          load={loadChannelMembers}
          upsert={upsertChannelMember}
          remove={removeChannelMember}
        />
      )}
    </main>
  );
}
