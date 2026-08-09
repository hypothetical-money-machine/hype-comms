export interface CompactModePersistence {
  load(): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
}

export class CompactModeController {
  readonly #persistence: CompactModePersistence;
  readonly #reportListenerError: (error: unknown) => void;
  readonly #listeners = new Set<(enabled: boolean) => void>();
  #enabled: boolean | null = null;
  #initialization: Promise<boolean> | null = null;
  #setTail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: {
    readonly persistence: CompactModePersistence;
    readonly reportListenerError?: (error: unknown) => void;
  }) {
    this.#persistence = options.persistence;
    this.#reportListenerError =
      options.reportListenerError ??
      ((error) => {
        console.error("Compact mode state listener failed", error);
      });
  }

  get enabled(): boolean {
    if (this.#enabled === null) {
      throw new Error("CompactModeController must be initialized before its state is read");
    }
    return this.#enabled;
  }

  initialize(): Promise<boolean> {
    if (this.#disposed) {
      return Promise.reject(new Error("CompactModeController has been disposed"));
    }
    if (this.#enabled !== null) {
      return Promise.resolve(this.#enabled);
    }
    if (this.#initialization !== null) {
      return this.#initialization;
    }

    const initialization = this.#initialize();
    this.#initialization = initialization;
    void initialization.catch(() => {
      if (this.#initialization === initialization) {
        this.#initialization = null;
      }
    });
    return initialization;
  }

  subscribe(listener: (enabled: boolean) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    try {
      this.#assertReady();
      const request = this.#setTail.then(() => this.#setEnabled(enabled));
      this.#setTail = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #initialize(): Promise<boolean> {
    const enabled = await this.#persistence.load();
    if (this.#disposed) {
      throw new Error("CompactModeController has been disposed");
    }

    this.#enabled = enabled;
    return this.#enabled;
  }

  async #setEnabled(enabled: boolean): Promise<boolean> {
    // A toggle queued behind an in-flight save must still reach disk when before-quit disposes
    // the controller mid-flight, so only un-initialized use is rejected on entry — the disposed
    // check happens after the write.
    if (this.#enabled === null) {
      throw new Error("CompactModeController must be initialized before use");
    }
    const previous = this.#enabled;
    if (enabled === previous) {
      return previous;
    }

    await this.#persistence.save(enabled);
    // Unlike ThemeController there is no second event source, so committing is just
    // assign-and-notify; the unchanged case already returned above. Commit even when disposed:
    // the next queued toggle's no-op comparison must see what actually reached disk.
    this.#enabled = enabled;
    if (this.#disposed) {
      throw new Error("CompactModeController has been disposed");
    }

    for (const listener of this.#listeners) {
      try {
        listener(enabled);
      } catch (error) {
        try {
          this.#reportListenerError(error);
        } catch {
          // Error reporting cannot change an already committed preference or block other listeners.
        }
      }
    }
    return enabled;
  }

  #assertReady(): void {
    if (this.#disposed) {
      throw new Error("CompactModeController has been disposed");
    }
    if (this.#enabled === null) {
      throw new Error("CompactModeController must be initialized before use");
    }
  }
}
