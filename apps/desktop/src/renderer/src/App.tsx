import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { DevelopmentIdentity, DevelopmentWelcomeMessage } from "@hmm-chat/contracts";

import type { DesktopApi, ServerStatus } from "../../shared/desktop-api";

interface AppProps {
  readonly client: DesktopApi;
}

function mergeMessages(
  current: readonly DevelopmentWelcomeMessage[],
  incoming: readonly DevelopmentWelcomeMessage[],
): DevelopmentWelcomeMessage[] {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function messageTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function App({ client }: AppProps) {
  const [version, setVersion] = useState<string>("…");
  const [status, setStatus] = useState<string>("Connecting to #welcome…");
  const [serverStatus, setServerStatus] = useState<ServerStatus>("unreachable");
  const [identity, setIdentity] = useState<DevelopmentIdentity | null>(null);
  const [messages, setMessages] = useState<DevelopmentWelcomeMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messageList = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let historyRetry: ReturnType<typeof setTimeout> | undefined;
    const stopWelcomeListener = client.onWelcomeMessage((message) => {
      setMessages((current) => mergeMessages(current, [message]));
      setServerStatus("reachable");
    });
    const stopNotificationListener = client.onNotificationAction((action) => {
      setStatus(`Open channel ${action.channelId}`);
    });

    void client.getAppVersion().then((appVersion) => {
      if (active) setVersion(appVersion);
    });
    void client.getServerStatus().then((nextServerStatus) => {
      if (active) setServerStatus(nextServerStatus);
    });
    void client.getIdentity().then((nextIdentity) => {
      if (active) setIdentity(nextIdentity);
    });
    const loadHistory = (): void => {
      void client
        .getWelcomeMessages()
        .then((history) => {
          if (active) {
            setMessages((current) => mergeMessages(history, current));
            setServerStatus("reachable");
            setStatus("#welcome is live");
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setServerStatus("unreachable");
            setStatus(error instanceof Error ? error.message : "Could not load #welcome");
            historyRetry = setTimeout(loadHistory, 1_000);
          }
        });
    };
    loadHistory();

    return () => {
      active = false;
      if (historyRetry !== undefined) clearTimeout(historyRetry);
      stopWelcomeListener();
      stopNotificationListener();
    };
  }, [client]);

  useEffect(() => {
    const list = messageList.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (identity !== null && !sending) {
      messageInput.current?.focus();
    }
  }, [identity, sending]);

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
      setStatus(error instanceof Error ? error.message : "Message failed to send");
    } finally {
      setSending(false);
    }
  };

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
          <strong>{identity?.name ?? "Loading identity…"}</strong>
          <span>{status}</span>
          <span className={`server-status ${serverStatus}`}>
            <span className="status-dot" aria-hidden="true" />
            Server {serverStatus}
          </span>
          <span>
            v{version} · {client.platform}
          </span>
        </footer>
      </section>

      <section className="conversation" aria-label="Conversation">
        <header className="conversation-header">
          <div>
            <h2># welcome</h2>
            <p>Temporary in-memory chat while authentication and persistence are built.</p>
          </div>
        </header>

        <div className="message-list" ref={messageList} aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-mark" aria-hidden="true">
                #
              </div>
              <h2>Welcome to HMM Chat</h2>
              <p>Send the first message. History lasts until the development server restarts.</p>
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
            placeholder={`Message #welcome as ${identity?.name ?? "…"}`}
            disabled={identity === null || sending}
            maxLength={4_000}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={identity === null || sending || draft.trim().length === 0}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
