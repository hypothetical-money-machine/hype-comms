import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  ChannelAccess,
  ChatSessionState,
  Message,
  UpdateState,
  User,
} from "@hmm-chat/contracts";

import type { DesktopApi } from "../../shared/desktop-api";
import { ChannelCreatePopover } from "./channel-create-popover";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { MessageDateSeparator, shouldShowDateSeparator } from "./message-date-separator";
import {
  cacheFallbackNotice,
  WorkspaceRuntime,
  type WorkspaceRuntimeState,
} from "./workspace-runtime";

type SignedInSession = Extract<ChatSessionState, { status: "signed-in"; method: "email" }>;

interface AppProps {
  readonly client: DesktopApi;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function messageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function UpdateControl({ client }: { readonly client: DesktopApi }) {
  const [update, setUpdate] = useState<UpdateState | null>(null);

  useEffect(() => {
    let active = true;
    const stopUpdateListener = client.onUpdateStateChanged(setUpdate);
    void client
      .getUpdateState()
      .then((state) => {
        if (active) setUpdate(state);
      })
      .catch(() => {
        if (active) setUpdate({ status: "unsupported" });
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

function SignIn({ client, sessionMessage }: { client: DesktopApi; sessionMessage?: string }) {
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
          ? "Check your email, then open the HMM Chat sign-in link."
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

        <UpdateControl client={client} />
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
}: {
  readonly message: Message;
  readonly members: readonly User[];
}) {
  const author = members.find((member) => member.id === message.authorId);
  return (
    <article className="message">
      <Avatar user={author} />
      <div>
        <header>
          <strong>{author?.displayName ?? "Former member"}</strong>
          <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
        </header>
        <p>{message.body}</p>
      </div>
    </article>
  );
}

export function App({ client }: AppProps) {
  const runtime = useMemo(() => new WorkspaceRuntime(client), [client]);
  const [runtimeState, setRuntimeState] = useState<WorkspaceRuntimeState>(runtime.state);
  const [session, setSession] = useState<ChatSessionState | null>(null);
  const [draft, setDraft] = useState("");
  const [composerError, setComposerError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [showChannelMembers, setShowChannelMembers] = useState(false);
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
  const messages = runtimeState.messages.filter(
    (message) => message.conversationId === runtimeState.selectedConversationId,
  );
  const pending = runtimeState.outbox.filter(
    (item) => item.operation.conversationId === runtimeState.selectedConversationId,
  );

  useEffect(() => setShowChannelMembers(false), [runtimeState.selectedConversationId]);

  useEffect(() => {
    const list = messageList.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages.length, pending.length, runtimeState.selectedConversationId]);

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
      await runtime.sendMessage(conversationId, body, mentionedUserIds);
      setDraft("");
      setComposerError("");
    } catch (error) {
      setComposerError(errorMessage(error, "Could not queue the message"));
    }
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
    return <SignIn client={client} sessionMessage={session.message} />;
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
          {bootstrap.members
            .filter((member) => member.id !== currentUserId)
            .map((member) => (
              <button
                type="button"
                key={member.id}
                onClick={() => void startDirectMessage(member.id)}
              >
                <Avatar user={member} />
                <span>{member.displayName}</span>
              </button>
            ))}
        </section>

        <UpdateControl client={client} />
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
          {selectedSummary?.conversation.kind === "channel" && (
            <div className="conversation-header-actions">
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
            </div>
          )}
        </header>

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
                <MessageRow message={message} members={bootstrap.members} />
              </Fragment>
            ))
          )}
          {pending.map((item, index) => {
            const previousTimestamp =
              pending[index - 1]?.createdAt ?? messages.at(-1)?.createdAt ?? null;
            return (
              <Fragment key={item.operation.message.clientMessageId}>
                {shouldShowDateSeparator(item.createdAt, previousTimestamp) && (
                  <MessageDateSeparator value={item.createdAt} />
                )}
                <article className="message pending-message">
                  <Avatar user={bootstrap.currentUser.user} />
                  <div>
                    <header>
                      <strong>{bootstrap.currentUser.user.displayName}</strong>
                      <span>{item.status.replaceAll("_", " ")}</span>
                    </header>
                    <p>{item.operation.message.body}</p>
                    {item.status === "permanent_failure" && (
                      <div className="message-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(item.operation.message.body);
                            void runtime.discardMessage(item.operation.message.clientMessageId);
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
