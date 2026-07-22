import { useEffect, useState } from "react";

import type { DesktopApi, ServerStatus } from "../../shared/desktop-api";

interface AppProps {
  readonly client: DesktopApi;
}

export function App({ client }: AppProps) {
  const [version, setVersion] = useState<string>("…");
  const [status, setStatus] = useState<string>("Desktop shell ready");
  const [serverStatus, setServerStatus] = useState<ServerStatus>("unreachable");

  useEffect(() => {
    let active = true;
    void client.getAppVersion().then((appVersion) => {
      if (active) {
        setVersion(appVersion);
      }
    });
    void client.getServerStatus().then((nextServerStatus) => {
      if (active) {
        setServerStatus(nextServerStatus);
      }
    });

    const stopNotificationListener = client.onNotificationAction((action) => {
      setStatus(`Open channel ${action.channelId}`);
    });

    return () => {
      active = false;
      stopNotificationListener();
    };
  }, [client]);

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
            <p>The desktop foundation is running.</p>
          </div>
        </header>

        <div className="empty-state">
          <div className="empty-mark" aria-hidden="true">
            #
          </div>
          <h2>Welcome to HMM Chat</h2>
          <p>
            Channels, messages, authentication, and presence will connect here as the product
            roadmap lands.
          </p>
        </div>

        <form className="composer" onSubmit={(event) => event.preventDefault()}>
          <label className="sr-only" htmlFor="message">
            Message #welcome
          </label>
          <input id="message" type="text" placeholder="Message #welcome" disabled />
          <button type="submit" disabled aria-label="Send message">
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
