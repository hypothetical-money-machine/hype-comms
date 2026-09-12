import type { ChatSessionState } from "@hype-comms/contracts";
import type { ChatSession } from "./chat-session";
import type { WorkspaceSessionOwner } from "./workspace-session-owner";

/** Publishes identity only after its resources are ready; owns the auth-state subscription. */
export class DesktopSessionLifecycle<Resources extends object> {
  #revision = 0;
  #authenticationRevision = 0;
  #authenticating = false;
  #state: ChatSessionState | null = null;
  #ready: Promise<void> = Promise.resolve();
  #disposal: Promise<void> | null = null;
  readonly #unsubscribe: () => void;

  constructor(
    readonly options: {
      source: Pick<ChatSession, "state" | "subscribe">;
      sessions: WorkspaceSessionOwner<Resources>;
      publish: (state: ChatSessionState) => void;
      reportFailure: (error: unknown) => void;
    },
  ) {
    this.#unsubscribe = options.source.subscribe(() => {
      if (!this.#authenticating) void this.refresh();
    });
    void this.refresh();
  }

  get publishedState(): ChatSessionState | null {
    return this.#state;
  }

  refresh(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    const state = this.options.source.state;
    const revision = ++this.#revision;
    this.#state = null;
    const ready = this.options.sessions.replace(
      state.status === "signed-in"
        ? { userId: state.userId, workspaceId: state.workspaceId }
        : null,
    );
    return this.#track(
      ready.then(() => {
        if (revision !== this.#revision) return;
        this.#state = state;
        try {
          this.options.publish(state);
        } catch (error) {
          if (revision === this.#revision) this.#state = null;
          throw error;
        }
      }),
    );
  }

  /** Cancel old requests before changing credentials, including a same-account replacement. */
  retire(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#revision += 1;
    this.#state = null;
    return this.#track(this.options.sessions.replace(null));
  }

  replaceAuthentication<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (this.#disposal !== null) return Promise.reject(new Error("Desktop session is disposed"));
    const revision = ++this.#authenticationRevision;
    this.#authenticating = true;
    const assertCurrent = () => {
      if (revision !== this.#authenticationRevision || this.#disposal !== null) {
        throw new DOMException("Authentication was superseded", "AbortError");
      }
    };
    const operationResult = this.retire()
      .then(async () => {
        assertCurrent();
        const result = await operation(assertCurrent);
        assertCurrent();
        return result;
      })
      .finally(async () => {
        if (revision !== this.#authenticationRevision || this.#disposal !== null) return;
        this.#authenticating = false;
        await this.refresh();
      });
    this.#track(operationResult.then(() => undefined));
    return operationResult;
  }

  /** Guards local operations too, including offline Claude and asynchronous native dialogs. */
  async run<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    const revision = this.#revision;
    const assertCurrent = () => {
      if (this.#state === null || revision !== this.#revision || this.#disposal !== null) {
        throw new DOMException("Desktop session was replaced", "AbortError");
      }
    };
    assertCurrent();
    const result = await operation(assertCurrent);
    assertCurrent();
    return result;
  }

  async readState(): Promise<ChatSessionState> {
    for (;;) {
      const ready = this.#ready;
      try {
        await ready;
      } catch (error) {
        if (ready === this.#ready) throw error;
      }
      if (ready !== this.#ready) continue;
      if (this.#state === null) throw new Error("Desktop session is changing");
      return this.#state;
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#unsubscribe();
    this.#revision += 1;
    this.#state = null;
    this.#disposal = this.options.sessions.dispose();
    return this.#track(this.#disposal);
  }

  #track(ready: Promise<void>): Promise<void> {
    this.#ready = ready;
    void ready.catch((error: unknown) => {
      try {
        this.options.reportFailure(error);
      } catch {
        /* Diagnostics must not create an unhandled rejection. */
      }
    });
    return ready;
  }
}
