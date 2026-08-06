import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  ChannelAccess,
  ChatSessionState,
  Message,
  Reaction,
  ReactionEmoji,
  Task,
  UpdateState,
  User,
} from "@hmm-chat/contracts";

import type { DesktopApi } from "../../shared/desktop-api";
import { ChannelCreatePopover } from "./channel-create-popover";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { ClientVersion } from "./client-version";
import { ConversationSwitcher } from "./conversation-switcher";
import { MessageDateSeparator, shouldShowDateSeparator } from "./message-date-separator";
import { isMessageContinuation } from "./message-grouping";
import { MessageReactions } from "./message-reactions";
import { ThemeSelector } from "./theme-selector";
import type { ThemeRuntime } from "./theme-runtime";
import { TasksView } from "./tasks-view";
import { WorkspaceSearch } from "./workspace-search";
import {
  cacheFallbackNotice,
  WorkspaceRuntime,
  type WorkspaceRuntimeState,
} from "./workspace-runtime";

type SignedInSession = Extract<ChatSessionState, { status: "signed-in"; method: "email" }>;

interface AppProps {
  readonly client: DesktopApi;
  readonly theme: ThemeRuntime;
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
  const [requesting, setRequesting] = useState(false);
  const [status, setStatus] = useState(sessionMessage ?? "");

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (requesting || email.trim() === "") return;
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
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
          />
          <button type="submit" disabled={requesting || email.trim() === ""}>
            {requesting ? "Requesting link…" : "Email me a sign-in link"}
          </button>
        </form>
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

function MessageRow({
  message,
  members,
  reactions,
  currentUserId,
  reactionsDisabled,
  onAddReaction,
  onRemoveReaction,
  onCreateTask,
  highlighted,
  continuation,
}: {
  readonly message: Message;
  readonly members: readonly User[];
  readonly reactions: readonly Reaction[];
  readonly currentUserId: string;
  readonly reactionsDisabled: boolean;
  readonly onAddReaction: (emoji: ReactionEmoji) => Promise<void>;
  readonly onRemoveReaction: (emoji: ReactionEmoji) => Promise<void>;
  readonly onCreateTask?: () => Promise<void>;
  readonly highlighted: boolean;
  readonly continuation: boolean;
}) {
  const author = members.find((member) => member.id === message.authorId);
  return (
    <article
      className={`message${continuation ? " message-continuation" : ""}${
        highlighted ? " search-target" : ""
      }`}
      id={`message-${message.id}`}
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
        <p>{message.body}</p>
        <MessageReactions
          reactions={reactions}
          members={members}
          currentUserId={currentUserId}
          disabled={reactionsDisabled}
          onAdd={onAddReaction}
          onRemove={onRemoveReaction}
        />
        {onCreateTask !== undefined && (
          <button className="message-task-action" type="button" onClick={() => void onCreateTask()}>
            + Task
          </button>
        )}
      </div>
    </article>
  );
}

export function App({ client, theme }: AppProps) {
  const runtime = useMemo(() => new WorkspaceRuntime(client), [client]);
  const [runtimeState, setRuntimeState] = useState<WorkspaceRuntimeState>(runtime.state);
  const [session, setSession] = useState<ChatSessionState | null>(null);
  const [draft, setDraft] = useState("");
  const [editingClientMessageId, setEditingClientMessageId] = useState<string | null>(null);
  const [composerError, setComposerError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [showChannelMembers, setShowChannelMembers] = useState(false);
  const [paneView, setPaneView] = useState<"chat" | "tasks">("chat");
  const messageList = useRef<HTMLDivElement>(null);

  useEffect(() => runtime.subscribe(setRuntimeState), [runtime]);

  const applySession = useCallback(
    (next: ChatSessionState) => {
      setSession(next);
      if (next.status === "signed-in" && next.method === "email") {
        void runtime.start(next);
      } else if (next.status === "signed-out") {
        void runtime.stop();
      }
    },
    [runtime],
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
      void runtime.stop();
    };
  }, [applySession, client, runtime]);

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
  const tasksAvailable =
    selectedSummary?.conversation.kind === "channel" || selectedIsPersonal === true;
  const messages = runtimeState.messages.filter(
    (message) => message.conversationId === runtimeState.selectedConversationId,
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
  const pending = runtimeState.outbox.filter(
    (item) => item.operation.conversationId === runtimeState.selectedConversationId,
  );
  const editingItem =
    editingClientMessageId === null
      ? undefined
      : runtimeState.outbox.find(
          (item) => item.operation.message.clientMessageId === editingClientMessageId,
        );

  useEffect(() => {
    setShowChannelMembers(false);
    setPaneView("chat");
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
    if (editingClientMessageId === null) return;
    if (
      editingItem === undefined ||
      editingItem.status !== "permanent_failure" ||
      editingItem.operation.conversationId !== runtimeState.selectedConversationId
    ) {
      setEditingClientMessageId(null);
    }
  }, [editingClientMessageId, editingItem, runtimeState.selectedConversationId]);

  useEffect(() => {
    const list = messageList.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages.length, pending.length, runtimeState.selectedConversationId]);

  useEffect(() => {
    const focusedMessageId = runtimeState.focusedMessageId;
    if (focusedMessageId === null) return;
    document.getElementById(`message-${focusedMessageId}`)?.scrollIntoView({ block: "center" });
  }, [messages.length, runtimeState.focusedMessageId, runtimeState.selectedConversationId]);

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const body = draft.trim();
    const conversationId = runtimeState.selectedConversationId;
    if (body === "" || conversationId === null || bootstrap === null) return;
    const visibleMemberIds = new Set(selectedSummary?.participantIds ?? []);
    const mentionedUserIds = bootstrap.members
      .filter((member) => {
        if (!visibleMemberIds.has(member.id)) return false;
        const escaped = member.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(body);
      })
      .map((member) => member.id);
    try {
      if (editingClientMessageId === null) {
        await runtime.sendMessage(conversationId, body, mentionedUserIds);
      } else {
        await runtime.replaceFailedMessage(editingClientMessageId, body, mentionedUserIds);
        setEditingClientMessageId(null);
      }
      setDraft("");
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
    setPaneView("chat");
    runtime.openTaskSource(task);
  };

  const createChannel = useCallback(
    async (name: string, slug: string, access: ChannelAccess): Promise<void> => {
      await runtime.createChannel(name, slug, access);
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
        await runtime.createDirectConversation(memberId);
      } catch (error) {
        setComposerError(errorMessage(error, "Could not start the direct message"));
      }
    },
    [runtime],
  );

  const rebuildLocalCache = async (signedIn: SignedInSession): Promise<void> => {
    await runtime.resetLocalCache();
    await runtime.start(signedIn);
  };

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
              <button type="button" onClick={() => void runtime.start(session)}>
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
  const currentUserId = bootstrap.currentUser.user.id;

  return (
    <main className="shell">
      <aside className="workspace-rail" aria-label="Workspace">
        <div className="workspace-mark">H</div>
      </aside>

      <aside className="sidebar">
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
          }))}
          selectedConversationId={runtimeState.selectedConversationId}
          platform={client.platform}
          onSelect={(conversationId) => runtime.selectConversation(conversationId)}
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
          openResult={(result) => runtime.openSearchResult(result)}
        />

        <nav aria-label="Conversations">
          <div className="nav-heading">
            <span>Channels</span>
            <ChannelCreatePopover onCreate={createChannel} />
          </div>
          {channels.map((summary) => (
            <button
              className={
                summary.conversation.id === runtimeState.selectedConversationId
                  ? "conversation active"
                  : "conversation"
              }
              type="button"
              key={summary.conversation.id}
              onClick={() => runtime.selectConversation(summary.conversation.id)}
            >
              <span>
                {summary.conversation.access === "members" ? "🔒 " : "# "}
                {summary.conversation.name}
                {summary.conversation.isArchived ? " (archived)" : ""}
              </span>
              {(summary.unreadCount > 0 || summary.mentionCount > 0) && (
                <span className="badge">{summary.mentionCount || summary.unreadCount}</span>
              )}
            </button>
          ))}

          <div className="nav-heading">
            <span>Direct messages</span>
          </div>
          {directMessages.map((summary) => (
            <button
              className={
                summary.conversation.id === runtimeState.selectedConversationId
                  ? "conversation active"
                  : "conversation"
              }
              type="button"
              key={summary.conversation.id}
              onClick={() => runtime.selectConversation(summary.conversation.id)}
            >
              <span>● {runtime.conversationName(summary)}</span>
              {(summary.unreadCount > 0 || summary.mentionCount > 0) && (
                <span className="badge">{summary.mentionCount || summary.unreadCount}</span>
              )}
            </button>
          ))}
        </nav>

        <section className="member-list" aria-label="Members">
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

        <footer className="sidebar-footer">
          <ThemeSelector theme={theme} />
          <UpdateControl client={client} />
          <ClientVersion client={client} />
        </footer>
      </aside>

      <section className="conversation-pane">
        <header className="conversation-header">
          <div>
            <h2>
              {selectedSummary === undefined
                ? "Choose a conversation"
                : runtime.conversationName(selectedSummary)}
            </h2>
            <p>
              {runtimeState.connection}
              {runtimeState.stale ? " · cached state may be stale" : ""}
              {runtimeState.cacheMode === "memory_only" ? " · memory-only cache" : ""}
            </p>
            {workspaceNotice !== null && (
              <p className="composer-error" role="alert">
                {workspaceNotice}{" "}
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => void runtime.start(session)}
                >
                  Retry
                </button>{" "}
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => void rebuildLocalCache(session)}
                >
                  Reset local cache
                </button>
              </p>
            )}
          </div>
          {selectedSummary !== undefined &&
            (tasksAvailable || selectedSummary.conversation.kind === "channel") && (
              <div className="conversation-header-actions">
                {tasksAvailable && (
                  <div className="pane-toggle" aria-label="Conversation view">
                    <button
                      type="button"
                      className={paneView === "chat" ? "active" : ""}
                      onClick={() => setPaneView("chat")}
                    >
                      Chat
                    </button>
                    <button
                      type="button"
                      className={paneView === "tasks" ? "active" : ""}
                      onClick={() => setPaneView("tasks")}
                    >
                      Tasks
                    </button>
                  </div>
                )}
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
                          onClick={() =>
                            void runtime.archiveChannel(selectedSummary.conversation.id)
                          }
                        >
                          Archive
                        </button>
                      )}
                  </>
                )}
              </div>
            )}
        </header>

        {paneView === "tasks" && tasksAvailable && selectedSummary !== undefined ? (
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
            <div className="message-list" ref={messageList} aria-live="polite">
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
                <div className="empty-state">
                  <h3>No messages yet</h3>
                  <p>Start the conversation.</p>
                </div>
              ) : (
                messages.map((message, index) => (
                  <Fragment key={message.id}>
                    {shouldShowDateSeparator(
                      message.createdAt,
                      messages[index - 1]?.createdAt ?? null,
                    ) && <MessageDateSeparator value={message.createdAt} />}
                    <MessageRow
                      message={message}
                      members={bootstrap.members}
                      reactions={reactionsByMessage.get(message.id) ?? []}
                      currentUserId={currentUserId}
                      reactionsDisabled={selectedSummary?.conversation.isArchived ?? true}
                      onAddReaction={(emoji) => runtime.addReaction(message.id, emoji)}
                      onRemoveReaction={(emoji) => runtime.removeReaction(message.id, emoji)}
                      onCreateTask={
                        tasksAvailable ? () => createTaskFromMessage(message) : undefined
                      }
                      highlighted={message.id === runtimeState.focusedMessageId}
                      continuation={isMessageContinuation(message, messages[index - 1] ?? null)}
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
                const pendingStatus =
                  editingClientMessageId === item.operation.message.clientMessageId
                    ? "editing"
                    : item.status.replaceAll("_", " ");
                return (
                  <Fragment key={item.operation.message.clientMessageId}>
                    {shouldShowDateSeparator(item.createdAt, previousTimestamp) && (
                      <MessageDateSeparator value={item.createdAt} />
                    )}
                    <article
                      className={`message pending-message${
                        continuation ? " message-continuation" : ""
                      }`}
                    >
                      {continuation ? (
                        <time
                          className="message-continuation-time"
                          dateTime={item.createdAt}
                          aria-hidden="true"
                        >
                          {messageTime(item.createdAt)}
                        </time>
                      ) : (
                        <Avatar user={bootstrap.currentUser.user} />
                      )}
                      <div>
                        <header className={continuation ? "sr-only" : undefined}>
                          <strong>{bootstrap.currentUser.user.displayName}</strong>
                          <span>{pendingStatus}</span>
                        </header>
                        <p>
                          {item.operation.message.body}
                          {continuation && (
                            <span className="pending-status"> · {pendingStatus}</span>
                          )}
                        </p>
                        {item.status === "permanent_failure" && (
                          <div className="message-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setDraft(item.operation.message.body);
                                setEditingClientMessageId(item.operation.message.clientMessageId);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void runtime.retryMessage(item.operation.message.clientMessageId)
                              }
                            >
                              Retry
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void runtime.discardMessage(item.operation.message.clientMessageId)
                              }
                            >
                              Discard
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  </Fragment>
                );
              })}
            </div>

            <form className="composer" onSubmit={(event) => void send(event)}>
              <label className="sr-only" htmlFor="message">
                Message
              </label>
              <input
                id="message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  selectedSummary === undefined
                    ? "Choose a conversation"
                    : `Message ${runtime.conversationName(selectedSummary)}`
                }
                disabled={selectedSummary === undefined || selectedSummary.conversation.isArchived}
                maxLength={4_000}
              />
              <button
                type="submit"
                disabled={
                  draft.trim() === "" ||
                  selectedSummary === undefined ||
                  selectedSummary.conversation.isArchived
                }
              >
                Send
              </button>
              {composerError !== "" && <p className="composer-error">{composerError}</p>}
            </form>
          </>
        )}
      </section>
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
    </main>
  );
}
