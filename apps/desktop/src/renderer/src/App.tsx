import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { ChatMessage, ChatSessionState } from "@hmm-chat/contracts";

import type { DesktopApi, ServerStatus } from "../../shared/desktop-api";

interface AppProps {
  readonly client: DesktopApi;
}

function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function messageTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function SignIn({
  client,
  onSignedIn,
  sessionMessage,
}: {
  readonly client: DesktopApi;
  readonly onSignedIn: (state: ChatSessionState) => void;
  readonly sessionMessage?: string;
}) {
  const [name, setName] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [accessError, setAccessError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [emailMessage, setEmailMessage] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [requestingLink, setRequestingLink] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void client.getSuggestedName().then((suggested) => {
      if (active && suggested !== "") setName(suggested);
    });
    nameInput.current?.focus();
    return () => {
      active = false;
    };
  }, [client]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setAccessError(null);
    try {
      onSignedIn(await client.signIn({ name: name.trim(), accessCode }));
    } catch (caught) {
      setAccessError(errorMessage(caught, "Sign-in failed"));
      setAccessCode("");
    } finally {
      setSubmitting(false);
    }
  };

  const requestLink = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (requestingLink) return;

    setRequestingLink(true);
    setEmailError(null);
    setEmailMessage(null);
    try {
      const delivery = await client.requestMagicLink(email);
      setEmailMessage(
        delivery.status === "email-sent"
          ? "Check your email for a sign-in link. HMM Chat is waiting—open the link to continue."
          : `${delivery.message}. Open the sign-in link an administrator sent you; HMM Chat is waiting for it.`,
      );
    } catch (caught) {
      setEmailError(errorMessage(caught, "Could not request a sign-in link"));
    } finally {
      setRequestingLink(false);
    }
  };

  const canSubmit = name.trim().length > 0 && accessCode.length > 0 && !submitting;
  const canRequestLink = email.trim().length > 0 && !requestingLink;
  const visibleAccessError = accessError ?? sessionMessage;

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <div className="workspace-mark" aria-hidden="true">
          H
        </div>
        <h1>HMM Chat</h1>
        <p className="signin-lede">Sign in to join #welcome.</p>

        <form className="signin-form" onSubmit={(event) => void submit(event)}>
          <h2>Use the shared access code</h2>

          <label htmlFor="signin-name">Display name</label>
          <input
            ref={nameInput}
            id="signin-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            required
          />

          <label htmlFor="signin-code">Access code</label>
          <input
            id="signin-code"
            type="password"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            maxLength={256}
            autoComplete="off"
            disabled={submitting}
            required
          />

          {visibleAccessError !== null && visibleAccessError !== undefined && (
            <p className="signin-error" role="alert">
              {visibleAccessError}
            </p>
          )}

          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Signing in…" : "Sign in with access code"}
          </button>
        </form>

        <div className="signin-divider" aria-hidden="true">
          <span>or</span>
        </div>

        <form className="signin-form" onSubmit={(event) => void requestLink(event)}>
          <h2>Use your email</h2>
          <p className="signin-help">Request a link, then open it to finish signing in here.</p>

          <label htmlFor="signin-email">Email address</label>
          <input
            id="signin-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={320}
            autoComplete="email"
            disabled={requestingLink}
            required
          />

          {emailMessage !== null && (
            <p className="signin-info" role="status">
              {emailMessage}
            </p>
          )}
          {emailError !== null && (
            <p className="signin-error" role="alert">
              {emailError}
            </p>
          )}

          <button type="submit" disabled={!canRequestLink}>
            {requestingLink ? "Requesting link…" : "Email me a sign-in link"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function App({ client }: AppProps) {
  const [version, setVersion] = useState<string>("…");
  const [status, setStatus] = useState<string>("Connecting to #welcome…");
  const [serverStatus, setServerStatus] = useState<ServerStatus>("unreachable");
  const [session, setSession] = useState<ChatSessionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    const stopSessionListener = client.onSessionChanged((next) => {
      setSession(next);
      if (next.status === "signed-out") setMessages([]);
    });

    void client.getAppVersion().then((appVersion) => {
      if (active) setVersion(appVersion);
    });
    void client.getServerStatus().then((next) => {
      if (active) setServerStatus(next);
    });
    void client
      .getSessionState()
      .then((next) => {
        if (active) setSession(next);
      })
      .catch(() => {
        if (active) setSession({ status: "signed-out" });
      });

    return () => {
      active = false;
      stopSessionListener();
    };
  }, [client]);

  const signedIn = session?.status === "signed-in";

  useEffect(() => {
    if (!signedIn) return () => undefined;

    let active = true;
    let historyRetry: ReturnType<typeof setTimeout> | undefined;
    const stopWelcomeListener = client.onWelcomeMessage((message) => {
      setMessages((current) => mergeMessages(current, [message]));
      setServerStatus("reachable");
    });

    const loadHistory = (): void => {
      void client
        .getWelcomeMessages()
        .then((history) => {
          if (!active) return;
          setMessages((current) => mergeMessages(history, current));
          setServerStatus("reachable");
          setStatus("#welcome is live");
        })
        .catch((error: unknown) => {
          if (!active) return;
          setServerStatus("unreachable");
          setStatus(errorMessage(error, "Could not load #welcome"));
          historyRetry = setTimeout(loadHistory, 2_000);
        });
    };
    loadHistory();

    return () => {
      active = false;
      if (historyRetry !== undefined) clearTimeout(historyRetry);
      stopWelcomeListener();
    };
  }, [client, signedIn]);

  useEffect(() => {
    const list = messageList.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (signedIn && !sending) messageInput.current?.focus();
  }, [signedIn, sending]);

  const handleSignedIn = useCallback((next: ChatSessionState) => {
    setSession(next);
    setStatus("Connecting to #welcome…");
  }, []);

  const sendMessage = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0 || sending) return;

    setSending(true);
    try {
      const message = await client.sendWelcomeMessage(body);
      setMessages((current) => mergeMessages(current, [message]));
      setDraft("");
      setServerStatus("reachable");
      setStatus("#welcome is live");
    } catch (error) {
      setStatus(errorMessage(error, "Message failed to send"));
    } finally {
      setSending(false);
    }
  };

  if (session === null) {
    return <main className="signin-shell" aria-busy="true" />;
  }

  if (session.status === "signed-out") {
    return <SignIn client={client} onSignedIn={handleSignedIn} sessionMessage={session.message} />;
  }

  return (
    <main className="shell">
      <aside className="workspace-rail" aria-label="Workspaces">
        <div className="workspace-mark" aria-hidden="true">
          H
        </div>
      </aside>

      <section className="sidebar" aria-label="Channel navigation">
        <header>
          <p className="eyebrow">Hypothetical Money Machine</p>
          <h1>HMM Chat</h1>
        </header>

        <nav aria-label="Channels">
          <p className="nav-label">Channels</p>
          <button className="channel active" type="button">
            <span aria-hidden="true">#</span> welcome
          </button>
        </nav>

        <footer>
          <strong>{session.name}</strong>
          <span>
            {session.method === "email" ? `Signed in as ${session.email}` : "Using access code"}
          </span>
          <span>{status}</span>
          <span className={`server-status ${serverStatus}`}>
            <span className="status-dot" aria-hidden="true" />
            Server {serverStatus}
          </span>
          <span>
            v{version} · {client.platform}
          </span>
          <button className="signout" type="button" onClick={() => void client.signOut()}>
            Sign out
          </button>
        </footer>
      </section>

      <section className="conversation" aria-label="Conversation">
        <header className="conversation-header">
          <div>
            <h2># welcome</h2>
            <p>Workspace chat. History is kept on the server.</p>
          </div>
        </header>

        <div className="message-list" ref={messageList} aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-mark" aria-hidden="true">
                #
              </div>
              <h2>Welcome to HMM Chat</h2>
              <p>Send the first message.</p>
            </div>
          ) : (
            messages.map((message) => (
              <article className="message" key={message.id}>
                <div className="avatar" aria-hidden="true">
                  {message.authorName.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <header>
                    <strong>{message.authorName}</strong>
                    <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                  </header>
                  <p>{message.body}</p>
                </div>
              </article>
            ))
          )}
        </div>

        <form className="composer" onSubmit={(event) => void sendMessage(event)}>
          <label className="sr-only" htmlFor="message">
            Message #welcome
          </label>
          <input
            ref={messageInput}
            id="message"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Message #welcome as ${session.name}`}
            disabled={sending}
            maxLength={4_000}
            autoComplete="off"
          />
          <button type="submit" disabled={sending || draft.trim().length === 0}>
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
