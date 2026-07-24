import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { DogfoodMessage, DogfoodSessionState } from "@hmm-chat/contracts";

import type { DesktopApi, ServerStatus } from "../../shared/desktop-api";

interface AppProps {
  readonly client: DesktopApi;
}

function mergeMessages(
  current: readonly DogfoodMessage[],
  incoming: readonly DogfoodMessage[],
): DogfoodMessage[] {
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
}: {
  readonly client: DesktopApi;
  readonly onSignedIn: (state: DogfoodSessionState) => void;
}) {
  const [name, setName] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
    setError(null);
    try {
      onSignedIn(await client.signIn({ name: name.trim(), accessCode }));
    } catch (caught) {
      setError(errorMessage(caught, "Sign-in failed"));
      setAccessCode("");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = name.trim().length > 0 && accessCode.length > 0 && !submitting;

  return (
    <main className="signin-shell">
      <form className="signin-card" onSubmit={(event) => void submit(event)}>
        <div className="workspace-mark" aria-hidden="true">
          H
        </div>
        <h1>HMM Chat</h1>
        <p className="signin-lede">Enter the workspace access code to join #welcome.</p>

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

        {error !== null && (
          <p className="signin-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={!canSubmit}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export function App({ client }: AppProps) {
  const [version, setVersion] = useState<string>("…");
  const [status, setStatus] = useState<string>("Connecting to #welcome…");
  const [serverStatus, setServerStatus] = useState<ServerStatus>("unreachable");
  const [session, setSession] = useState<DogfoodSessionState | null>(null);
  const [messages, setMessages] = useState<DogfoodMessage[]>([]);
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

  const handleSignedIn = useCallback((next: DogfoodSessionState) => {
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
    return <SignIn client={client} onSignedIn={handleSignedIn} />;
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
            <p>Shared access-code chat. History is kept on the server.</p>
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
