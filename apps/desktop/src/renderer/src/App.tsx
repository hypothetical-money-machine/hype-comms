import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  ATTACHMENTS_PER_MESSAGE_MAX,
  type Attachment,
  type AuthCapabilities,
  type ChannelAccess,
  type ChannelMode,
  type ChatSessionState,
  type Message,
  type NotificationContext,
  type Reaction,
  type ReactionEmoji,
  type Task,
  type UpdateState,
  type User,
} from "@hype-comms/contracts";

import type { DesktopApi } from "../../shared/desktop-api";
import { AiChannel } from "./ai-channel";
import { ChannelCreatePopover } from "./channel-create-popover";
import { ChannelMembersDialog } from "./channel-members-dialog";
import type { ChannelReferenceTarget } from "./channel-references";
import { ClientVersion } from "./client-version";
import { CompactHotzone } from "./compact-hotzone";
import type { CompactModeRuntime } from "./compact-mode-runtime";
import { ConversationHealth } from "./conversation-health";
import { ChannelIcon, ConversationBadge, DirectMessageIcon } from "./conversation-indicators";
import {
  AnnouncementPostingNotice,
  ArchivedConversationNotice,
  ConversationEmptyState,
} from "./conversation-states";
import { ConversationSwitcher } from "./conversation-switcher";
import { FilesView } from "./files-view";
import type { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { MemberListResizeHandle } from "./member-list-resize-handle";
import { MessageDateSeparator, shouldShowDateSeparator } from "./message-date-separator";
import { MessageBody } from "./message-body";
import { MessageComposer } from "./message-composer";
import { isMessageContinuation } from "./message-grouping";
import {
  isReadTrackingEligible,
  isTimelineAtBottom,
  lastReadEligibleMessageId,
} from "./message-read-tracking";
import { MessageReactions } from "./message-reactions";
import { createNotificationActivityView } from "./notification-activity";
import {
  NotificationSessionRuntime,
  notificationTransportFrom,
} from "./notification-session-runtime";
import { PreferencesDialog } from "./preferences-dialog";
import type { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { ThemeSelector } from "./theme-selector";
import type { ThemeRuntime } from "./theme-runtime";
import { TasksView } from "./tasks-view";
import { listUnreadConversations, unreadBadgeTotals } from "./unread-conversations";
import { UnreadDivider, useUnreadDividerMessageId } from "./unread-divider";
import { UnreadsIcon, UnreadsView } from "./unreads-view";
import { useBackgroundUnreadSignal } from "./use-background-unread-signal";
import { isCompactModeShortcut, useCompactChrome } from "./use-compact-chrome";
import { useCompactModeEnabled } from "./use-compact-mode-enabled";
import { useConversationDrafts } from "./use-conversation-drafts";
import { WorkspaceSearch } from "./workspace-search";
import type { OutboxItem } from "./workspace-cache";
import {
  cacheFallbackNotice,
  WorkspaceRuntime,
  type WorkspaceRuntimeState,
} from "./workspace-runtime";

type SignedInSession = Extract<ChatSessionState, { status: "signed-in"; method: "email" }>;
type WorkspaceDestination = "workspace" | "ai" | "unreads";

interface AppProps {
  readonly client: DesktopApi;
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly fencedBlockquotes: FencedBlockquoteRuntime;
  readonly sidebarPosition: SidebarPositionRuntime;
}

type UpdateClient = Pick<
  DesktopApi,
  "getUpdateState" | "checkForUpdates" | "restartToInstallUpdate" | "onUpdateStateChanged"
>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function messageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function mentionedMemberIds(
  body: string,
  members: readonly User[],
  participantIds: readonly string[],
): readonly string[] {
  const visibleMemberIds = new Set(participantIds);
  return members
    .filter((member) => {
      if (!visibleMemberIds.has(member.id)) return false;
      const escaped = member.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(body);
    })
    .map((member) => member.id);
}

export function visibleTimelineMessages(
  messages: readonly Message[],
  conversationId: string | null,
  threadsSupported: boolean,
): readonly Message[] {
  return messages.filter(
    (message) =>
      message.conversationId === conversationId &&
      (!threadsSupported || message.threadRootId === null),
  );
}

export function UpdateControl({ client }: { readonly client: UpdateClient }) {
  const [update, setUpdate] = useState<UpdateState | null>(null);

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
        <button type="button" onClick={() => void client.restartToInstallUpdate()}>
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

function SignIn({
  client,
  theme,
  sessionMessage,
}: {
  client: DesktopApi;
  theme: ThemeRuntime;
  sessionMessage?: string;
}) {
  const [email, setEmail] = useState("");
  const [capabilities, setCapabilities] = useState<AuthCapabilities>({
    authKit: false,
    magicLink: true,
  });
  const [authKitStarting, setAuthKitStarting] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [status, setStatus] = useState(sessionMessage ?? "");

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

  const startAuthKit = async (): Promise<void> => {
    if (authKitStarting || requesting || client.startAuthKitSignIn === undefined) return;
    setAuthKitStarting(true);
    setStatus("");
    try {
      await client.startAuthKitSignIn();
      setStatus("Finish signing in in the browser. You can return here when it completes.");
    } catch (error) {
      setStatus(errorMessage(error, "Could not start WorkOS sign-in"));
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
      setStatus(errorMessage(error, "Could not request a sign-in link"));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <p className="eyebrow">Hypothetical Money Machine</p>
        <h1>Private workspace chat</h1>
        <p className="signin-lede">Sign in with the email address invited to this workspace.</p>
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
        {status !== "" && <p className="signin-status">{status}</p>}

        <ThemeSelector theme={theme} />
        <UpdateControl client={client} />
        <ClientVersion client={client} />
      </section>
    </main>
  );
}

function Avatar({ user }: { user: User | undefined }) {
  return (
    <span className="avatar" aria-hidden="true">
      {(user?.displayName ?? "?").slice(0, 1).toUpperCase()}
    </span>
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

const PARTICIPANT_COLOR_COUNT = 8;

export function participantColorIndex(userId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % PARTICIPANT_COLOR_COUNT;
}

export function MessageRow({
  message,
  members,
  reactions,
  attachments = [],
  currentUserId,
  reactionsDisabled,
  onAddReaction,
  onRemoveReaction,
  onOpenAttachment,
  onCreateTask,
  highlighted,
  continuation,
  onOpenThread,
  replyCount = 0,
  domIdPrefix = "message",
  channelReferences,
  onOpenChannel,
}: {
  readonly message: Message;
  readonly members: readonly User[];
  readonly reactions: readonly Reaction[];
  readonly attachments?: readonly Attachment[];
  readonly currentUserId: string;
  readonly reactionsDisabled: boolean;
  readonly onAddReaction: (emoji: ReactionEmoji) => Promise<void>;
  readonly onRemoveReaction: (emoji: ReactionEmoji) => Promise<void>;
  readonly onOpenAttachment?: (attachmentId: string) => Promise<void>;
  readonly onCreateTask?: () => Promise<void>;
  readonly highlighted: boolean;
  readonly continuation: boolean;
  readonly onOpenThread?: () => void;
  readonly replyCount?: number;
  readonly domIdPrefix?: string;
  readonly channelReferences?: readonly ChannelReferenceTarget[];
  readonly onOpenChannel?: (conversationId: string) => void;
}) {
  const author = members.find((member) => member.id === message.authorId);
  const participantId = message.authorId ?? "former-member";
  const threadActionLabel =
    replyCount === 0
      ? "Reply in thread"
      : `Open thread with ${String(replyCount)} ${replyCount === 1 ? "reply" : "replies"}`;
  return (
    <article
      className={`message participant-color-${String(participantColorIndex(participantId))}${continuation ? " message-continuation" : ""}${
        highlighted ? " search-target" : ""
      }`}
      id={`${domIdPrefix}-${message.id}`}
      data-message-id={message.id}
      data-message-sequence={message.conversationSequence}
    >
      {continuation ? (
        <time className="message-continuation-time" dateTime={message.createdAt} aria-hidden="true">
          {messageTime(message.createdAt)}
        </time>
      ) : (
        <Avatar user={author} />
      )}
      <div>
        <header className={continuation ? "sr-only" : undefined}>
          <strong>{author?.displayName ?? "Former member"}</strong>
          <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
        </header>
        <MessageBody
          body={message.body}
          channels={channelReferences}
          onOpenChannel={onOpenChannel}
        />
        {attachments.length > 0 && (
          <ul className="message-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  type="button"
                  className="message-attachment"
                  onClick={() => void onOpenAttachment?.(attachment.id)}
                >
                  <span>{attachment.fileName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <MessageReactions
          reactions={reactions}
          members={members}
          currentUserId={currentUserId}
          disabled={reactionsDisabled}
          onAdd={onAddReaction}
          onRemove={onRemoveReaction}
          leadingActions={
            onOpenThread === undefined ? undefined : (
              <button
                className="message-reply-action"
                type="button"
                aria-label={threadActionLabel}
                title={threadActionLabel}
                onClick={onOpenThread}
              >
                <svg aria-hidden="true" viewBox="0 0 20 20">
                  <path d="M4 4.5h12v8H9l-4 3v-3H4z" />
                  <path d="M7 8.5h6" />
                </svg>
                {replyCount > 0 && <span aria-hidden="true">{replyCount}</span>}
              </button>
            )
          }
          trailingActions={
            onCreateTask === undefined ? undefined : (
              <button
                className="message-task-action"
                type="button"
                onClick={() => void onCreateTask()}
              >
                + Task
              </button>
            )
          }
        />
      </div>
    </article>
  );
}

export function PendingMessageRow({
  item,
  currentUser,
  continuation,
  editing,
  onEdit,
  onRetry,
  onDiscard,
  mutationsDisabled = false,
  channelReferences,
  onOpenChannel,
}: {
  readonly item: OutboxItem;
  readonly currentUser: User;
  readonly continuation: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
  readonly mutationsDisabled?: boolean;
  readonly channelReferences?: readonly ChannelReferenceTarget[];
  readonly onOpenChannel?: (conversationId: string) => void;
}) {
  const pendingStatus = editing ? "editing" : item.status.replaceAll("_", " ");
  return (
    <article
      className={`message participant-color-${String(participantColorIndex(currentUser.id))} pending-message${continuation ? " message-continuation" : ""}`}
    >
      {continuation ? (
        <time className="message-continuation-time" dateTime={item.createdAt} aria-hidden="true">
          {messageTime(item.createdAt)}
        </time>
      ) : (
        <Avatar user={currentUser} />
      )}
      <div>
        <header className={continuation ? "sr-only" : undefined}>
          <strong>{currentUser.displayName}</strong>
          <span>{pendingStatus}</span>
        </header>
        <MessageBody
          body={item.operation.message.body}
          channels={channelReferences}
          onOpenChannel={onOpenChannel}
          suffix={
            continuation ? <span className="pending-status"> · {pendingStatus}</span> : undefined
          }
        />
        {item.status === "permanent_failure" && (
          <div className="message-actions">
            <button type="button" disabled={mutationsDisabled} onClick={onEdit}>
              Edit
            </button>
            <button type="button" disabled={mutationsDisabled} onClick={onRetry}>
              Retry
            </button>
            <button type="button" onClick={onDiscard}>
              Discard
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function isTextEntryControl(element: Element): boolean {
  return element.matches('input, textarea, [contenteditable]:not([contenteditable="false"])');
}

// A focus intent that has not landed within this window is dropped rather than retried: a
// blocker cleared by a background event (snapshot reload trimming the thread, a reconnect
// re-enabling the composer) minutes after the navigation must not move focus.
const FOCUS_INTENT_TTL_MS = 15_000;

export function App({ client, theme, compactMode, fencedBlockquotes, sidebarPosition }: AppProps) {
  const runtime = useMemo(() => new WorkspaceRuntime(client), [client]);
  const isHeadless = client.isHeadless === true;
  const [runtimeState, setRuntimeState] = useState<WorkspaceRuntimeState>(runtime.state);
  const [session, setSession] = useState<ChatSessionState | null>(null);
  const { draft, setDraft, clearDraft, resetDrafts } = useConversationDrafts(
    runtimeState.selectedConversationId,
  );
  const [threadDrafts, setThreadDrafts] = useState<Readonly<Record<string, string>>>({});
  const [editingClientMessageId, setEditingClientMessageId] = useState<string | null>(null);
  const [threadEditingClientMessageId, setThreadEditingClientMessageId] = useState<string | null>(
    null,
  );
  const [composerError, setComposerError] = useState("");
  const [threadComposerError, setThreadComposerError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [showChannelMembers, setShowChannelMembers] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const preferencesTrigger = useRef<HTMLButtonElement>(null);
  const [paneView, setPaneView] = useState<"chat" | "tasks" | "files">("chat");
  const [pendingAttachments, setPendingAttachments] = useState<
    Readonly<Record<string, readonly Attachment[]>>
  >({});
  const [destination, setDestination] = useState<WorkspaceDestination>("workspace");
  const [aiChannelVisited, setAiChannelVisited] = useState(false);
  const [notificationContext, setNotificationContext] = useState<NotificationContext | null>(null);
  const notificationBindingGeneration = useRef(0);
  const notificationTransport = useMemo(() => notificationTransportFrom(client), [client]);
  const notificationSession = useMemo(() => {
    if (notificationTransport === null) return null;
    return new NotificationSessionRuntime(notificationTransport, {
      handleNotificationAction: async (action, context) => {
        // Close dialogs before the navigation commits: their close handlers restore focus to
        // their triggers, and that focusin must land before the navigation records its focus
        // intents — after, it would expire them.
        setShowChannelMembers(false);
        setShowPreferences(false);
        const result = await runtime.handleNotificationAction(action, context);
        if (result === "discarded") return;
        setDestination("workspace");
        setPaneView("chat");
      },
    });
  }, [notificationTransport, runtime]);
  const messageList = useRef<HTMLDivElement>(null);
  const timelineConversationId = useRef<string | null>(null);
  const stickToTimelineBottom = useRef(true);
  const [timelineAtLiveTail, setTimelineAtLiveTail] = useState(false);
  const readTrackingFrame = useRef<number | null>(null);
  const readTrackingConversationId = useRef<string | null>(null);
  const messageVisibilityMemory = useRef({
    observedStarts: new Set<string>(),
    observedEnds: new Set<string>(),
  });
  const threadList = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const threadComposer = useRef<HTMLTextAreaElement>(null);
  const stickToThreadBottom = useRef(true);
  const [threadAtLiveTail, setThreadAtLiveTail] = useState(false);
  const threadReadTrackingFrame = useRef<number | null>(null);
  const threadReadTrackingRootId = useRef<string | null>(null);
  const threadMessageVisibilityMemory = useRef({
    observedStarts: new Set<string>(),
    observedEnds: new Set<string>(),
  });
  const threadScrollState = useRef<{
    readonly rootId: string | null;
    readonly newestReplyId: string | null;
    readonly pendingCount: number;
  }>({ rootId: null, newestReplyId: null, pendingCount: 0 });
  const compact = useCompactModeEnabled(compactMode);
  const chrome = useCompactChrome(compact);

  const selectConversation = useCallback(
    (conversationId: string): void => {
      setDestination("workspace");
      runtime.selectConversation(conversationId);
    },
    [runtime],
  );

  const openAiChannel = useCallback((): void => {
    setAiChannelVisited(true);
    setDestination("ai");
    setPaneView("chat");
    setShowChannelMembers(false);
    setShowPreferences(false);
    runtime.closeThread();
  }, [runtime]);

  const openUnreads = useCallback((): void => {
    setDestination("unreads");
    setPaneView("chat");
    setShowChannelMembers(false);
    setShowPreferences(false);
    runtime.closeThread();
    chrome.collapse();
  }, [chrome, runtime]);

  useEffect(() => runtime.subscribe(setRuntimeState), [runtime]);

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
      next: SignedInSession,
      options: {
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
        await runtime.start(next);
        if (bindingGeneration !== notificationBindingGeneration.current) return;

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
      setSession(next);
      if (next.status === "signed-in" && next.method === "email") {
        void startWorkspaceSession(next);
        return;
      }

      notificationBindingGeneration.current += 1;
      notificationSession?.invalidate();
      setNotificationContext(null);
      if (next.status === "signed-out") {
        setDestination("workspace");
        setAiChannelVisited(false);
        resetDrafts();
        setThreadDrafts({});
        setEditingClientMessageId(null);
        setThreadEditingClientMessageId(null);
        setComposerError("");
        setThreadComposerError("");
        void runtime.stop();
      }
    },
    [notificationSession, resetDrafts, runtime, startWorkspaceSession],
  );

  const retrySession = useCallback(async (): Promise<void> => {
    try {
      applySession(await client.getSessionState());
    } catch {
      // Main reports an unreachable server as a preserved session, so there is nothing to add.
    }
  }, [applySession, client]);

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
  // Every runtime error used to be readable only before a bootstrap existed, which hid realtime
  // and sync failures for the entire life of a session.
  const workspaceNotice =
    runtimeState.error ?? cacheFallbackNotice(runtimeState.cacheFallbackReason);
  const selectedSummary = bootstrap?.conversations.find(
    (summary) => summary.conversation.id === runtimeState.selectedConversationId,
  );
  const selectedIsPersonal =
    selectedSummary?.conversation.kind === "direct_message" &&
    selectedSummary.participantIds.length === 1 &&
    selectedSummary.participantIds[0] === bootstrap?.currentUser.user.id;
  const selectedIsAnnouncement = selectedSummary?.conversation.channelMode === "announcement";
  const tasksAvailable =
    (selectedSummary?.conversation.kind === "channel" && !selectedIsAnnouncement) ||
    selectedIsPersonal === true;
  const canPublishBulletins = selectedIsAnnouncement && bootstrap?.currentUser.role === "owner";
  const conversationMessages = runtimeState.messages.filter(
    (message) => message.conversationId === runtimeState.selectedConversationId,
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
  const threadDraft =
    selectedThreadRootId === null ? "" : (threadDrafts[selectedThreadRootId] ?? "");
  const selectedThreadSummary =
    selectedThreadRootId === null ? undefined : threadSummaryByRoot.get(selectedThreadRootId);
  const threadReplyCount = Math.max(selectedThreadSummary?.replyCount ?? 0, threadReplies.length);
  const editingItem =
    editingClientMessageId === null
      ? undefined
      : runtimeState.outbox.find(
          (item) => item.operation.message.clientMessageId === editingClientMessageId,
        );
  const threadEditingItem =
    threadEditingClientMessageId === null
      ? undefined
      : runtimeState.outbox.find(
          (item) => item.operation.message.clientMessageId === threadEditingClientMessageId,
        );

  useEffect(() => {
    setShowChannelMembers(false);
    setPaneView("chat");
    setTimelineAtLiveTail(false);
    setThreadAtLiveTail(false);
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

  useEffect(() => {
    if (editingClientMessageId === null) return;
    if (
      editingItem === undefined ||
      editingItem.status !== "permanent_failure" ||
      editingItem.operation.conversationId !== runtimeState.selectedConversationId ||
      editingItem.operation.message.threadRootId !== null
    ) {
      setEditingClientMessageId(null);
    }
  }, [editingClientMessageId, editingItem, runtimeState.selectedConversationId]);

  const markVisibleMessagesRead = useCallback((): void => {
    const conversationId = runtimeState.selectedConversationId;
    const list = messageList.current;
    if (
      destination !== "workspace" ||
      conversationId === null ||
      list === null ||
      !isReadTrackingEligible(isHeadless, document.visibilityState, document.hasFocus())
    ) {
      return;
    }
    if (readTrackingConversationId.current !== conversationId) {
      readTrackingConversationId.current = conversationId;
      messageVisibilityMemory.current.observedStarts.clear();
      messageVisibilityMemory.current.observedEnds.clear();
    }
    const messageId = lastReadEligibleMessageId(
      list,
      messageVisibilityMemory.current,
      selectedSummary?.readCursor?.lastReadConversationSequence ?? null,
    );
    if (messageId !== null) runtime.markConversationReadThrough(conversationId, messageId);
  }, [
    destination,
    isHeadless,
    runtime,
    runtimeState.selectedConversationId,
    selectedSummary?.readCursor,
  ]);

  const scheduleReadTracking = useCallback((): void => {
    if (readTrackingFrame.current !== null) return;
    readTrackingFrame.current = window.requestAnimationFrame(() => {
      readTrackingFrame.current = null;
      markVisibleMessagesRead();
    });
  }, [markVisibleMessagesRead]);

  const handleTimelineScroll = useCallback((): void => {
    const list = messageList.current;
    if (list !== null) {
      const atLiveTail = isTimelineAtBottom(list);
      stickToTimelineBottom.current = atLiveTail;
      setTimelineAtLiveTail(atLiveTail);
    }
    scheduleReadTracking();
  }, [scheduleReadTracking]);

  const markVisibleThreadMessagesRead = useCallback((): void => {
    const conversationId = runtimeState.selectedConversationId;
    const threadRootId = runtimeState.selectedThreadRootId;
    const list = threadList.current;
    if (
      destination !== "workspace" ||
      conversationId === null ||
      threadRootId === null ||
      list === null ||
      !isReadTrackingEligible(isHeadless, document.visibilityState, document.hasFocus())
    ) {
      return;
    }
    const trackingKey = `${conversationId}:${threadRootId}`;
    if (threadReadTrackingRootId.current !== trackingKey) {
      threadReadTrackingRootId.current = trackingKey;
      threadMessageVisibilityMemory.current.observedStarts.clear();
      threadMessageVisibilityMemory.current.observedEnds.clear();
    }
    const messageId = lastReadEligibleMessageId(
      list,
      threadMessageVisibilityMemory.current,
      selectedSummary?.readCursor?.lastReadConversationSequence ?? null,
    );
    if (messageId !== null) runtime.markConversationReadThrough(conversationId, messageId);
  }, [
    destination,
    isHeadless,
    runtime,
    runtimeState.selectedConversationId,
    runtimeState.selectedThreadRootId,
    selectedSummary?.readCursor,
  ]);

  const scheduleThreadReadTracking = useCallback((): void => {
    if (threadReadTrackingFrame.current !== null) return;
    threadReadTrackingFrame.current = window.requestAnimationFrame(() => {
      threadReadTrackingFrame.current = null;
      markVisibleThreadMessagesRead();
    });
  }, [markVisibleThreadMessagesRead]);

  const handleThreadScroll = useCallback((): void => {
    const list = threadList.current;
    if (list !== null) {
      const atLiveTail = isTimelineAtBottom(list);
      stickToThreadBottom.current = atLiveTail;
      setThreadAtLiveTail(atLiveTail);
    }
    scheduleThreadReadTracking();
  }, [scheduleThreadReadTracking]);

  useEffect(() => {
    const handleFocus = (): void => {
      scheduleReadTracking();
      scheduleThreadReadTracking();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [scheduleReadTracking, scheduleThreadReadTracking]);

  useEffect(
    () => () => {
      if (readTrackingFrame.current !== null) {
        window.cancelAnimationFrame(readTrackingFrame.current);
        readTrackingFrame.current = null;
      }
      if (threadReadTrackingFrame.current !== null) {
        window.cancelAnimationFrame(threadReadTrackingFrame.current);
        threadReadTrackingFrame.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (threadEditingClientMessageId === null) return;
    if (
      threadEditingItem === undefined ||
      threadEditingItem.status !== "permanent_failure" ||
      threadEditingItem.operation.message.threadRootId !== selectedThreadRootId
    ) {
      setThreadEditingClientMessageId(null);
    }
  }, [selectedThreadRootId, threadEditingClientMessageId, threadEditingItem]);

  useEffect(() => setThreadComposerError(""), [selectedThreadRootId]);

  useEffect(() => setThreadAtLiveTail(false), [selectedThreadRootId]);

  useEffect(() => {
    if (selectedThreadRootId !== null) return;
    threadReadTrackingRootId.current = null;
    threadMessageVisibilityMemory.current.observedStarts.clear();
    threadMessageVisibilityMemory.current.observedEnds.clear();
  }, [selectedThreadRootId]);

  useEffect(() => {
    const list = messageList.current;
    const conversationId = runtimeState.selectedConversationId;
    if (destination !== "workspace") {
      // Returning from AI must be treated like entering the timeline again so missed messages
      // land at the unread divider instead of inheriting the hidden pane's at-bottom state.
      timelineConversationId.current = null;
      stickToTimelineBottom.current = false;
      setTimelineAtLiveTail(false);
      return;
    }
    if (list === null || conversationId === null) return;
    if (timelineConversationId.current !== conversationId) {
      timelineConversationId.current = conversationId;
      const divider = document.getElementById(`unread-${conversationId}`);
      list.scrollTop =
        divider === null
          ? list.scrollHeight
          : Math.max(0, divider.offsetTop - list.clientHeight / 2);
    } else if (stickToTimelineBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
    const atLiveTail = isTimelineAtBottom(list);
    stickToTimelineBottom.current = atLiveTail;
    setTimelineAtLiveTail(atLiveTail);
    scheduleReadTracking();
  }, [
    destination,
    messages.length,
    pending.length,
    runtimeState.selectedConversationId,
    scheduleReadTracking,
    unreadDividerMessageId,
  ]);

  useEffect(() => {
    const previous = threadScrollState.current;
    const next = {
      rootId: selectedThreadRootId,
      newestReplyId: threadReplies.at(-1)?.id ?? null,
      pendingCount: threadPending.length,
    };
    threadScrollState.current = next;
    const rootChanged = previous.rootId !== next.rootId;
    const replyChanged = previous.newestReplyId !== next.newestReplyId;
    const pendingGrew = previous.pendingCount < next.pendingCount;
    const shouldScrollToLatest =
      rootChanged || pendingGrew || (replyChanged && stickToThreadBottom.current);
    const list = threadList.current;
    if (list !== null && shouldScrollToLatest) {
      list.scrollTop = list.scrollHeight;
      const atLiveTail = isTimelineAtBottom(list);
      stickToThreadBottom.current = atLiveTail;
      setThreadAtLiveTail(atLiveTail);
    }
    scheduleThreadReadTracking();
  }, [scheduleThreadReadTracking, selectedThreadRootId, threadPending.length, threadReplies]);

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

  useEffect(() => {
    const focusedMessageId = runtimeState.focusedMessageId;
    if (focusedMessageId === null) return;
    document.getElementById(`message-${focusedMessageId}`)?.scrollIntoView({ block: "center" });
  }, [messages.length, runtimeState.focusedMessageId, runtimeState.selectedConversationId]);

  useEffect(() => {
    const focusedMessageId = runtimeState.focusedThreadMessageId;
    if (focusedMessageId === null) return;
    document.getElementById(`thread-message-${focusedMessageId}`)?.scrollIntoView({
      block: "center",
    });
    scheduleThreadReadTracking();
  }, [
    runtimeState.focusedThreadMessageId,
    scheduleThreadReadTracking,
    selectedThreadRootId,
    threadReplies.length,
  ]);

  // Composer focus policy. A navigation records a focus intent — main composer on a conversation
  // change, thread composer on a deep-linked reply — and the intent is consumed only when focus
  // actually lands on that textarea. Until then it survives the moments when focus cannot land
  // (composer unmounted behind the Tasks pane or an archived notice, summary not loaded, thread
  // pane or aria-modal dialog owning focus, workspace pane hidden behind the AI pane) and is
  // retried when one of those blockers clears.
  //
  // Every programmatic landing goes through placeAppFocus, which marks the focus as app-placed.
  // Any focusin the app did not initiate — a click, a Tab, a dialog restoring its trigger —
  // clears that mark and expires every pending intent: an intent may only complete while the
  // user has not chosen a focus of their own since it was recorded. That expiry is what keeps a
  // deferred intent from firing at some unrelated later retry point and stealing focus.
  const focusPlacedByApp = useRef(false);
  const suppressFocusIntentClear = useRef(0);
  const pendingComposerFocusKey = useRef<string | null>(null);
  const pendingComposerFocusAt = useRef(0);
  const pendingThreadFocus = useRef(false);
  const pendingThreadFocusAt = useRef(0);

  const placeAppFocus = useCallback((element: HTMLElement | null): boolean => {
    if (element === null) return false;
    suppressFocusIntentClear.current += 1;
    try {
      element.focus();
    } finally {
      suppressFocusIntentClear.current -= 1;
    }
    const landed = document.activeElement === element;
    if (landed) focusPlacedByApp.current = true;
    return landed;
  }, []);

  useEffect(() => {
    const onFocusIn = (): void => {
      if (suppressFocusIntentClear.current > 0) return;
      focusPlacedByApp.current = false;
      pendingComposerFocusKey.current = null;
      pendingThreadFocus.current = false;
    };
    // Focus falling to <body> (element removed or hidden, or a drag-select on a non-focusable
    // area) fires no focusin, so the app-placed mark is cleared here: whatever holds focus
    // afterwards was not placed by the app.
    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget === null) focusPlacedByApp.current = false;
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const composerFocusKey = destination === "workspace" ? runtimeState.selectedConversationId : null;
  const composerUnavailable = selectedSummary === undefined;
  const threadOpen = selectedThreadRootId !== null;

  const attemptComposerFocus = useCallback((): void => {
    const pending = pendingComposerFocusKey.current;
    if (pending === null) return;
    if (
      pending !== composerFocusKey ||
      Date.now() - pendingComposerFocusAt.current > FOCUS_INTENT_TTL_MS
    ) {
      // The pane hid, the selection moved on, or the blocker took too long to clear.
      pendingComposerFocusKey.current = null;
      return;
    }
    if (composerUnavailable || threadOpen) return;
    const active = document.activeElement;
    // Deferring while focus sits inside an aria-modal dialog keeps focus traps (workspace
    // search, preferences) intact when a selection commit lands before the dialog closes; the
    // dialog's close handler below completes or expires the intent.
    if (active?.closest('[aria-modal="true"]') != null) return;
    const input = composerInput.current;
    if (input === null) return;
    if (active === input) {
      pendingComposerFocusKey.current = null;
      return;
    }
    // Never move the caret out of a text control the user chose — a background selection change
    // must not interrupt typing. The intent stays pending and expires on the user's next focusin.
    if (!focusPlacedByApp.current && active !== null && active !== document.body) {
      if (isTextEntryControl(active) && active.closest("[hidden]") === null) return;
    }
    if (placeAppFocus(input)) pendingComposerFocusKey.current = null;
  }, [composerFocusKey, composerUnavailable, placeAppFocus, threadOpen]);

  // Retry point: the composer mounts one render after a conversation change when the Tasks pane
  // or an archived/announcement notice occupied its slot during the switch. The callback's
  // identity tracks attemptComposerFocus's deps, so a (re)attach always closes over the values
  // of the commit it runs in — a mount that arrives together with a thread opening sees
  // threadOpen true, not a stale snapshot from the last passive effect.
  const attachComposerInput = useCallback(
    (element: HTMLTextAreaElement | null): void => {
      composerInput.current = element;
      if (element !== null) attemptComposerFocus();
    },
    [attemptComposerFocus],
  );

  // Retry point: a sidebar dialog (workspace search, preferences) closed. A search jump closes
  // by unmounting its focused innards, stranding focus on <body>; an Escape/close restores the
  // trigger's focus instead. A restored close ends the deferral without a landing, so pending
  // intents expire rather than firing at some later retry point.
  //
  // Dialog components hold this callback in effect deps (useOpenChangeNotifier), and that
  // effect's cleanup reports a close — so an identity change while a dialog is open would fire
  // a spurious close notification. The callback therefore stays referentially stable and reads
  // per-render values through a ref refreshed each commit.
  const workspaceFocusContext = useRef({ destination, threadOpen });
  useEffect(() => {
    workspaceFocusContext.current = { destination, threadOpen };
  });
  const onWorkspaceDialogOpenChange = useCallback(
    (open: boolean): void => {
      chrome.onPopoverOpenChange(open);
      if (open) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body) {
        pendingComposerFocusKey.current = null;
        pendingThreadFocus.current = false;
        return;
      }
      // Another dialog may still own the screen (a click on its non-focusable chrome can strand
      // focus on <body> while it shows); never focus a composer behind it.
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      // The AI pane manages its own focus; the workspace composers sit inside the [hidden]
      // conversation pane there, so focusing them would be a no-op in a real browser.
      if (workspaceFocusContext.current.destination !== "workspace") return;
      if (workspaceFocusContext.current.threadOpen) {
        // Only a landed focus consumes the intent: the thread composer is disabled until its
        // root loads, and a failed landing must leave the intent for the mount/enable retries.
        if (placeAppFocus(threadComposer.current)) pendingThreadFocus.current = false;
        return;
      }
      if (placeAppFocus(composerInput.current)) pendingComposerFocusKey.current = null;
    },
    [chrome, placeAppFocus],
  );

  // Record a main-composer intent on a real key change. Folding `destination` into the key means
  // arriving from the AI pane (and the initial workspace load) focuses the composer via the
  // null-to-id transition, while snapshot refreshes, disabled flips, and remounts — where the key
  // is unchanged — record nothing. Every dep change is also a retry point: the summary finished
  // loading, the thread pane closed, the pane became visible.
  const lastComposerFocusKey = useRef(composerFocusKey);
  useEffect(() => {
    if (composerFocusKey !== lastComposerFocusKey.current) {
      lastComposerFocusKey.current = composerFocusKey;
      if (composerFocusKey !== null) {
        pendingComposerFocusKey.current = composerFocusKey;
        pendingComposerFocusAt.current = Date.now();
      }
    }
    attemptComposerFocus();
  }, [attemptComposerFocus, composerFocusKey]);

  const threadComposerUnavailable = threadRoot === undefined;
  const attemptThreadComposerFocus = useCallback((): void => {
    if (!pendingThreadFocus.current) return;
    if (Date.now() - pendingThreadFocusAt.current > FOCUS_INTENT_TTL_MS) {
      pendingThreadFocus.current = false;
      return;
    }
    if (destination !== "workspace" || threadComposerUnavailable) return;
    const active = document.activeElement;
    if (active?.closest('[aria-modal="true"]') != null) return;
    if (!focusPlacedByApp.current && active !== null && active !== document.body) {
      const userTextEntry =
        isTextEntryControl(active) &&
        active !== composerInput.current &&
        active.closest("[hidden]") === null;
      if (userTextEntry) return;
    }
    if (placeAppFocus(threadComposer.current)) pendingThreadFocus.current = false;
  }, [destination, placeAppFocus, threadComposerUnavailable]);

  // Retry point: the thread composer mounts only once the thread root has loaded — a commit
  // after the one that recorded the intent, and one no effect dep distinguishes.
  const attachThreadComposerInput = useCallback(
    (element: HTMLTextAreaElement | null): void => {
      threadComposer.current = element;
      if (element !== null) attemptThreadComposerFocus();
    },
    [attemptThreadComposerFocus],
  );

  // The thread composer takes focus when a thread opens without a deep-linked reply, and via a
  // retryable intent when a reply is deep-linked (search jump, notification click). The intent
  // survives the workspace pane being hidden — the thread state commits before
  // setDestination("workspace") when a notification arrives on the AI pane — and takes focus
  // from wherever the arrival stranded it: <body>, an app-parked spot, a subtree the pane switch
  // just hid (real browsers blur it only after a later focus fixup), or the channel composer,
  // where a typed reply would post to the whole channel. It defers to an open aria-modal dialog
  // (the dialog's close handler lands it) and to any other text control the user is typing in.
  const lastAutoFocusedThreadRoot = useRef<string | null>(null);
  const lastDeepLinkedThreadMessage = useRef<string | null>(null);
  useEffect(() => {
    if (selectedThreadRootId === null) {
      lastAutoFocusedThreadRoot.current = null;
      lastDeepLinkedThreadMessage.current = null;
      pendingThreadFocus.current = false;
      return;
    }
    const deepLinked = runtimeState.focusedThreadMessageId;
    if (deepLinked !== null && deepLinked !== lastDeepLinkedThreadMessage.current) {
      lastDeepLinkedThreadMessage.current = deepLinked;
      pendingThreadFocus.current = true;
      pendingThreadFocusAt.current = Date.now();
    }
    if (destination !== "workspace") return;
    if (deepLinked === null) {
      if (lastAutoFocusedThreadRoot.current !== selectedThreadRootId) {
        lastAutoFocusedThreadRoot.current = selectedThreadRootId;
        placeAppFocus(threadComposer.current);
      }
      return;
    }
    attemptThreadComposerFocus();
  }, [
    attemptThreadComposerFocus,
    destination,
    placeAppFocus,
    runtimeState.focusedThreadMessageId,
    selectedThreadRootId,
  ]);

  const composerAttachments =
    runtimeState.selectedConversationId === null
      ? []
      : (pendingAttachments[runtimeState.selectedConversationId] ?? []);
  const threadComposerKey =
    runtimeState.selectedConversationId === null || selectedThreadRootId === null
      ? null
      : `${runtimeState.selectedConversationId}:${selectedThreadRootId}`;
  const threadComposerAttachments =
    threadComposerKey === null ? [] : (pendingAttachments[threadComposerKey] ?? []);

  const replacePendingAttachments = (
    key: string,
    updater: (current: readonly Attachment[]) => readonly Attachment[],
  ): void => {
    setPendingAttachments((current) => ({
      ...current,
      [key]: updater(current[key] ?? []),
    }));
  };

  const attachToComposer = async (key: string): Promise<void> => {
    const conversationId = runtimeState.selectedConversationId;
    if (conversationId === null) return;
    const current = pendingAttachments[key] ?? [];
    if (current.length >= ATTACHMENTS_PER_MESSAGE_MAX) {
      setComposerError(`You can attach up to ${String(ATTACHMENTS_PER_MESSAGE_MAX)} files`);
      return;
    }
    try {
      const attachment = await runtime.attachFile(conversationId);
      if (attachment === null) return;
      replacePendingAttachments(key, (pending) =>
        pending.some((existing) => existing.id === attachment.id)
          ? pending
          : [...pending, attachment].slice(0, ATTACHMENTS_PER_MESSAGE_MAX),
      );
      setComposerError("");
      setThreadComposerError("");
    } catch (error) {
      const message = errorMessage(error, "Could not attach the file");
      if (key === conversationId) setComposerError(message);
      else setThreadComposerError(message);
    }
  };

  const send = async (): Promise<void> => {
    const submittedDraft = draft;
    const conversationId = runtimeState.selectedConversationId;
    const attachments = conversationId === null ? [] : (pendingAttachments[conversationId] ?? []);
    const body = submittedDraft.trim() || attachments[0]?.fileName || "";
    if (body === "" || conversationId === null || bootstrap === null) return;
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
      replacePendingAttachments(conversationId, () => []);
      setComposerError("");
    } catch (error) {
      setComposerError(errorMessage(error, "Could not queue the message"));
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
      setComposerError(errorMessage(error, "Could not create a task from this message"));
    }
  };

  const openTaskSource = (task: Task): void => {
    setDestination("workspace");
    setPaneView("chat");
    runtime.openTaskSource(task);
  };

  const sendThreadReply = async (): Promise<void> => {
    const submittedDraft = threadDraft;
    const conversationId = runtimeState.selectedConversationId;
    const threadRootId = runtimeState.selectedThreadRootId;
    const key =
      conversationId === null || threadRootId === null ? null : `${conversationId}:${threadRootId}`;
    const attachments = key === null ? [] : (pendingAttachments[key] ?? []);
    const body = submittedDraft.trim() || attachments[0]?.fileName || "";
    if (body === "" || conversationId === null || threadRootId === null || bootstrap === null) {
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
      setThreadDrafts((current) => {
        if (current[threadRootId] !== submittedDraft) return current;
        const next = { ...current };
        delete next[threadRootId];
        return next;
      });
      if (key !== null) replacePendingAttachments(key, () => []);
      setThreadComposerError("");
    } catch (error) {
      setThreadComposerError(errorMessage(error, "Could not queue the reply"));
    }
  };

  const openAttachmentSource = (attachment: Attachment): void => {
    setDestination("workspace");
    setPaneView("chat");
    runtime.openAttachmentSource(attachment);
  };

  const createChannel = useCallback(
    async (
      name: string,
      slug: string,
      topic: string | null,
      access: ChannelAccess,
      channelMode: ChannelMode,
    ): Promise<void> => {
      setDestination("workspace");
      await runtime.createChannel(name, slug, topic, access, channelMode);
    },
    [runtime],
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
        setDestination("workspace");
        await runtime.createDirectConversation(memberId);
      } catch (error) {
        setComposerError(errorMessage(error, "Could not start the direct message"));
      }
    },
    [runtime],
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
  if (session.status === "session-unavailable") {
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
  if (session.method !== "email") {
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
              <button type="button" onClick={() => void startWorkspaceSession(session)}>
                Retry
              </button>
              <button type="button" onClick={() => void rebuildLocalCache(session)}>
                Reset local cache
              </button>
            </div>
          )}
          <ThemeSelector theme={theme} />
          <ClientVersion client={client} />
        </section>
      </main>
    );
  }

  const channels = bootstrap.conversations.filter(
    (summary) => summary.conversation.kind === "channel",
  );
  const directMessages = bootstrap.conversations.filter(
    (summary) => summary.conversation.kind === "direct_message",
  );
  const channelReferences: ChannelReferenceTarget[] = channels.flatMap((summary) =>
    summary.conversation.slug === null
      ? []
      : [{ conversationId: summary.conversation.id, slug: summary.conversation.slug }],
  );
  const currentUserId = bootstrap.currentUser.user.id;
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
        <div className="workspace-mark">H</div>
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
          <button className="quiet-button" type="button" onClick={() => void signOut()}>
            {signingOut ? "…" : "Sign out"}
          </button>
        </header>

        <ConversationSwitcher
          conversations={bootstrap.conversations.map((summary) => ({
            id: summary.conversation.id,
            name: runtime.conversationName(summary),
            kind: summary.conversation.kind,
            isArchived: summary.conversation.isArchived,
            channelMode: summary.conversation.channelMode,
          }))}
          selectedConversationId={
            destination === "workspace" ? runtimeState.selectedConversationId : null
          }
          platform={client.platform}
          onSelect={(conversationId) => {
            selectConversation(conversationId);
            // Picking a destination means "show me the channel": a pointer resting on the
            // overlay would otherwise hold it open over the conversation it just selected.
            chrome.collapse();
          }}
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
            setDestination("workspace");
            await runtime.openSearchResult(result);
            chrome.collapse();
          }}
          onOpenChange={onWorkspaceDialogOpenChange}
        />

        <div className="sidebar-split">
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

            <div className="nav-heading">
              <span>Channels</span>
              <ChannelCreatePopover
                canCreateAnnouncements={
                  bootstrap.featureFlags.announcementChannels &&
                  bootstrap.currentUser.role === "owner"
                }
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
            {directMessages.map((summary) => (
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
                  <DirectMessageIcon />
                  <span className="conversation-label-text">
                    {runtime.conversationName(summary)}
                  </span>
                </span>
                <ConversationBadge
                  unreadCount={summary.unreadCount}
                  mentionCount={summary.mentionCount}
                />
              </button>
            ))}
          </nav>

          <MemberListResizeHandle />

          <section id="workspace-members" className="member-list" aria-label="Members">
            <p className="nav-heading">Members</p>
            {bootstrap.members.map((member) => (
              <button
                type="button"
                key={member.id}
                onClick={() => void startDirectMessage(member.id)}
              >
                <Avatar user={member} />
                <span>
                  {member.displayName}
                  {member.id === currentUserId ? " (you)" : ""}
                </span>
              </button>
            ))}
          </section>
        </div>

        <footer className="sidebar-footer">
          <button
            ref={preferencesTrigger}
            className="preferences-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={showPreferences}
            aria-controls="preferences-dialog"
            onClick={() => setShowPreferences(true)}
          >
            Preferences
          </button>
          <UpdateControl client={client} />
          <ClientVersion client={client} />
        </footer>
      </aside>

      {aiChannelVisited && <AiChannel transport={client} active={destination === "ai"} />}
      <UnreadsView
        items={unreadItems}
        active={destination === "unreads"}
        onOpen={selectConversation}
      />
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
                Workspace owners post bulletins. Members can reply in threads and react.
              </p>
            )}
            <ConversationHealth
              connection={runtimeState.connection}
              stale={runtimeState.stale}
              cacheMode={runtimeState.cacheMode}
              notice={workspaceNotice}
              onRetry={() => void startWorkspaceSession(session)}
              onResetCache={() => void rebuildLocalCache(session)}
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
                    className="quiet-button"
                    type="button"
                    onClick={() => setShowChannelMembers(true)}
                  >
                    {selectedSummary.conversation.access === "members"
                      ? `${String(selectedSummary.participantIds.length)} members`
                      : "Everyone"}
                  </button>
                  {selectedSummary.conversation.slug !== "general" &&
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
              <AnnouncementPostingNotice />
            ) : (
              <MessageComposer
                conversationName={runtime.conversationName(selectedSummary)}
                draft={draft}
                pendingAttachments={composerAttachments}
                disabled={false}
                attachDisabled={composerAttachments.length >= ATTACHMENTS_PER_MESSAGE_MAX}
                error={composerError}
                inputLabel={selectedIsAnnouncement ? "Bulletin" : "Message"}
                inputRef={attachComposerInput}
                placeholder={selectedIsAnnouncement ? "Write a bulletin…" : undefined}
                submitLabel={selectedIsAnnouncement ? "Post bulletin" : "Send"}
                onDraftChange={setDraft}
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
              ref={messageList}
              aria-live="polite"
              onScroll={handleTimelineScroll}
            >
              {runtimeState.selectedConversationId !== null &&
                runtime.hasOlder(runtimeState.selectedConversationId) && (
                  <button
                    className="load-older"
                    type="button"
                    onClick={() => {
                      const conversationId = runtimeState.selectedConversationId;
                      if (conversationId !== null) void runtime.loadOlder(conversationId);
                    }}
                  >
                    Load older messages
                  </button>
                )}
              {messages.length === 0 && pending.length === 0 ? (
                <ConversationEmptyState
                  conversationName={
                    selectedSummary === undefined ? null : runtime.conversationName(selectedSummary)
                  }
                  kind={selectedSummary?.conversation.kind ?? null}
                  personal={selectedIsPersonal === true}
                  archived={selectedSummary?.conversation.isArchived ?? false}
                  channelMode={selectedSummary?.conversation.channelMode ?? null}
                />
              ) : (
                messages.map((message, index) => (
                  <Fragment key={message.id}>
                    {shouldShowDateSeparator(
                      message.createdAt,
                      messages[index - 1]?.createdAt ?? null,
                    ) && <MessageDateSeparator value={message.createdAt} />}
                    {message.id === unreadDividerMessageId &&
                      runtimeState.selectedConversationId !== null && (
                        <UnreadDivider conversationId={runtimeState.selectedConversationId} />
                      )}
                    <MessageRow
                      message={message}
                      members={bootstrap.members}
                      reactions={reactionsByMessage.get(message.id) ?? []}
                      attachments={attachmentsByMessage.get(message.id) ?? []}
                      currentUserId={currentUserId}
                      onOpenAttachment={(attachmentId) => runtime.openFile(attachmentId)}
                      reactionsDisabled={selectedSummary?.conversation.isArchived ?? true}
                      onAddReaction={(emoji) => runtime.addReaction(message.id, emoji)}
                      onRemoveReaction={(emoji) => runtime.removeReaction(message.id, emoji)}
                      onCreateTask={
                        tasksAvailable ? () => createTaskFromMessage(message) : undefined
                      }
                      highlighted={message.id === runtimeState.focusedMessageId}
                      continuation={isMessageContinuation(message, messages[index - 1] ?? null)}
                      channelReferences={channelReferences}
                      onOpenChannel={selectConversation}
                      replyCount={Math.max(
                        threadSummaryByRoot.get(message.id)?.replyCount ?? 0,
                        loadedReplyCountByRoot.get(message.id) ?? 0,
                      )}
                      onOpenThread={
                        runtimeState.threadsSupported &&
                        message.threadRootId === null &&
                        (!(selectedSummary?.conversation.isArchived ?? true) ||
                          threadSummaryByRoot.has(message.id) ||
                          loadedReplyCountByRoot.has(message.id) ||
                          pendingThreadRootIds.has(message.id))
                          ? () => void runtime.openThread(message.id)
                          : undefined
                      }
                    />
                  </Fragment>
                ))
              )}
              {pending.map((item, index) => {
                const previousTimestamp =
                  pending[index - 1]?.createdAt ?? messages.at(-1)?.createdAt ?? null;
                const continuation = isMessageContinuation(
                  {
                    authorId: currentUserId,
                    createdAt: item.createdAt,
                    conversationSequence: null,
                  },
                  index > 0
                    ? {
                        authorId: currentUserId,
                        createdAt: pending[index - 1]?.createdAt ?? item.createdAt,
                        conversationSequence: null,
                      }
                    : (messages.at(-1) ?? null),
                );
                return (
                  <Fragment key={item.operation.message.clientMessageId}>
                    {shouldShowDateSeparator(item.createdAt, previousTimestamp) && (
                      <MessageDateSeparator value={item.createdAt} />
                    )}
                    <PendingMessageRow
                      item={item}
                      currentUser={bootstrap.currentUser.user}
                      continuation={continuation}
                      editing={editingClientMessageId === item.operation.message.clientMessageId}
                      mutationsDisabled={selectedSummary?.conversation.isArchived ?? true}
                      onEdit={() => {
                        setDraft(item.operation.message.body);
                        setEditingClientMessageId(item.operation.message.clientMessageId);
                      }}
                      onRetry={() =>
                        void runtime.retryMessage(item.operation.message.clientMessageId)
                      }
                      onDiscard={() =>
                        void runtime.discardMessage(item.operation.message.clientMessageId)
                      }
                      channelReferences={channelReferences}
                      onOpenChannel={selectConversation}
                    />
                  </Fragment>
                );
              })}
            </div>

            {selectedSummary?.conversation.isArchived === true ? (
              <ArchivedConversationNotice />
            ) : selectedIsAnnouncement && !canPublishBulletins ? (
              <AnnouncementPostingNotice />
            ) : (
              <MessageComposer
                conversationName={
                  selectedSummary === undefined ? null : runtime.conversationName(selectedSummary)
                }
                draft={draft}
                pendingAttachments={composerAttachments}
                disabled={selectedSummary === undefined}
                attachDisabled={composerAttachments.length >= ATTACHMENTS_PER_MESSAGE_MAX}
                error={composerError}
                inputLabel={selectedIsAnnouncement ? "Bulletin" : "Message"}
                inputRef={attachComposerInput}
                placeholder={selectedIsAnnouncement ? "Write a bulletin…" : undefined}
                submitLabel={selectedIsAnnouncement ? "Post bulletin" : "Send"}
                onDraftChange={setDraft}
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
            ref={threadList}
            aria-live="polite"
            onScroll={handleThreadScroll}
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
                <MessageRow
                  message={threadRoot}
                  members={bootstrap.members}
                  reactions={reactionsByMessage.get(threadRoot.id) ?? []}
                  attachments={attachmentsByMessage.get(threadRoot.id) ?? []}
                  currentUserId={currentUserId}
                  onOpenAttachment={(attachmentId) => runtime.openFile(attachmentId)}
                  reactionsDisabled={selectedSummary?.conversation.isArchived ?? true}
                  onAddReaction={(emoji) => runtime.addReaction(threadRoot.id, emoji)}
                  onRemoveReaction={(emoji) => runtime.removeReaction(threadRoot.id, emoji)}
                  highlighted={threadRoot.id === runtimeState.focusedThreadMessageId}
                  continuation={false}
                  domIdPrefix="thread-message"
                  channelReferences={channelReferences}
                  onOpenChannel={selectConversation}
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
                {threadReplies.map((message, index) => (
                  <Fragment key={message.id}>
                    {shouldShowDateSeparator(
                      message.createdAt,
                      threadReplies[index - 1]?.createdAt ?? null,
                    ) && <MessageDateSeparator value={message.createdAt} />}
                    <MessageRow
                      message={message}
                      members={bootstrap.members}
                      reactions={reactionsByMessage.get(message.id) ?? []}
                      attachments={attachmentsByMessage.get(message.id) ?? []}
                      currentUserId={currentUserId}
                      onOpenAttachment={(attachmentId) => runtime.openFile(attachmentId)}
                      reactionsDisabled={selectedSummary?.conversation.isArchived ?? true}
                      onAddReaction={(emoji) => runtime.addReaction(message.id, emoji)}
                      onRemoveReaction={(emoji) => runtime.removeReaction(message.id, emoji)}
                      highlighted={message.id === runtimeState.focusedThreadMessageId}
                      continuation={isMessageContinuation(
                        message,
                        threadReplies[index - 1] ?? null,
                      )}
                      domIdPrefix="thread-message"
                      channelReferences={channelReferences}
                      onOpenChannel={selectConversation}
                    />
                  </Fragment>
                ))}
                {threadReplies.length === 0 && threadPending.length === 0 && (
                  <p className="thread-empty">Start the thread with a reply.</p>
                )}
                {threadPending.map((item, index) => {
                  const previousTimestamp =
                    threadPending[index - 1]?.createdAt ??
                    threadReplies.at(-1)?.createdAt ??
                    threadRoot.createdAt;
                  const continuation = isMessageContinuation(
                    {
                      authorId: currentUserId,
                      createdAt: item.createdAt,
                      conversationSequence: null,
                    },
                    index > 0
                      ? {
                          authorId: currentUserId,
                          createdAt: threadPending[index - 1]?.createdAt ?? item.createdAt,
                          conversationSequence: null,
                        }
                      : (threadReplies.at(-1) ?? null),
                  );
                  return (
                    <Fragment key={item.operation.message.clientMessageId}>
                      {shouldShowDateSeparator(item.createdAt, previousTimestamp) && (
                        <MessageDateSeparator value={item.createdAt} />
                      )}
                      <PendingMessageRow
                        item={item}
                        currentUser={bootstrap.currentUser.user}
                        continuation={continuation}
                        editing={
                          threadEditingClientMessageId === item.operation.message.clientMessageId
                        }
                        mutationsDisabled={selectedSummary?.conversation.isArchived ?? true}
                        onEdit={() => {
                          setThreadDrafts((current) => ({
                            ...current,
                            [selectedThreadRootId]: item.operation.message.body,
                          }));
                          setThreadEditingClientMessageId(item.operation.message.clientMessageId);
                          threadComposer.current?.focus();
                        }}
                        onRetry={() =>
                          void runtime.retryMessage(item.operation.message.clientMessageId)
                        }
                        onDiscard={() =>
                          void runtime.discardMessage(item.operation.message.clientMessageId)
                        }
                        channelReferences={channelReferences}
                        onOpenChannel={selectConversation}
                      />
                    </Fragment>
                  );
                })}
                {runtimeState.threadLoading && <p className="thread-loading">Loading replies…</p>}
              </>
            )}
          </div>

          {selectedSummary?.conversation.isArchived === true ? (
            <ArchivedConversationNotice thread />
          ) : (
            <MessageComposer
              conversationName={null}
              draft={threadDraft}
              pendingAttachments={threadComposerAttachments}
              disabled={threadRoot === undefined}
              attachDisabled={threadComposerAttachments.length >= ATTACHMENTS_PER_MESSAGE_MAX}
              error={threadComposerError}
              inputId="thread-message-composer"
              inputLabel="Reply"
              inputRef={attachThreadComposerInput}
              placeholder="Reply in thread"
              submitLabel="Reply"
              variantClassName="thread-composer"
              onDraftChange={(value) =>
                setThreadDrafts((current) => ({
                  ...current,
                  [selectedThreadRootId]: value,
                }))
              }
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
      {showChannelMembers && selectedSummary?.conversation.kind === "channel" && (
        <ChannelMembersDialog
          channelName={
            selectedSummary.conversation.name ?? selectedSummary.conversation.slug ?? "channel"
          }
          conversationId={selectedSummary.conversation.id}
          workspaceMembers={bootstrap.members}
          onClose={() => setShowChannelMembers(false)}
          load={loadChannelMembers}
          upsert={upsertChannelMember}
          remove={removeChannelMember}
        />
      )}
      <PreferencesDialog
        open={showPreferences}
        theme={theme}
        compactMode={compactMode}
        fencedBlockquotes={fencedBlockquotes}
        sidebarPosition={sidebarPosition}
        notifications={notificationTransport ?? undefined}
        platform={client.platform}
        triggerRef={preferencesTrigger}
        onClose={() => setShowPreferences(false)}
        onOpenChange={onWorkspaceDialogOpenChange}
      />
    </main>
  );
}
