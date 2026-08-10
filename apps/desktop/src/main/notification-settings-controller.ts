import {
  notificationPreferenceSchema,
  notificationStateSchema,
  type NotificationNativeSupport,
  type NotificationOsPermission,
  type NotificationPreference,
  type NotificationState,
} from "@hmm-chat/contracts";

export interface NotificationPreferencePersistence {
  load(): Promise<NotificationPreference>;
  save(preference: NotificationPreference): Promise<void>;
}

export interface NotificationCapabilitySource {
  read():
    | Promise<{
        readonly nativeSupport: NotificationNativeSupport;
        readonly osPermission: NotificationOsPermission;
      }>
    | {
        readonly nativeSupport: NotificationNativeSupport;
        readonly osPermission: NotificationOsPermission;
      };
}

/** Durable device intent plus refresh-only native capability state. */
export class NotificationSettingsController {
  readonly #persistence: NotificationPreferencePersistence;
  readonly #capability: NotificationCapabilitySource;
  readonly #listeners = new Set<(state: NotificationState) => void>();
  #state: NotificationState | null = null;
  #initialization: Promise<NotificationState> | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #preferenceIntentRevision = 0;
  #disposed = false;

  constructor(options: {
    readonly persistence: NotificationPreferencePersistence;
    readonly capability: NotificationCapabilitySource;
  }) {
    this.#persistence = options.persistence;
    this.#capability = options.capability;
  }

  get state(): NotificationState {
    this.#assertReady();
    return this.#state as NotificationState;
  }

  initialize(): Promise<NotificationState> {
    if (this.#disposed) return Promise.reject(new Error("Notification settings are disposed"));
    if (this.#state !== null) return Promise.resolve(this.#state);
    if (this.#initialization !== null) return this.#initialization;
    const request = this.#initialize();
    this.#initialization = request;
    void request.catch(() => {
      if (this.#initialization === request) this.#initialization = null;
    });
    return request;
  }

  subscribe(listener: (state: NotificationState) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setPreference(preference: NotificationPreference): Promise<NotificationState> {
    try {
      const parsed = notificationPreferenceSchema.parse(preference);
      this.#assertReady();
      const revision = ++this.#preferenceIntentRevision;
      this.#applyRestrictivePreferenceIntent(parsed);
      const request = this.#writeTail.then(() => this.#setPreference(parsed, revision));
      this.#writeTail = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async refreshCapability(): Promise<NotificationState> {
    this.#assertReady();
    const capability = await this.#readCapability();
    if (this.#disposed) throw new Error("Notification settings are disposed");
    return this.#commit({ ...this.state, ...capability });
  }

  /** A presenter failure disables further attempts until an explicit capability refresh. */
  markPresenterFailure(): NotificationState {
    this.#assertReady();
    return this.#commit({ ...this.state, nativeSupport: "unsupported" });
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #initialize(): Promise<NotificationState> {
    const [preference, capability] = await Promise.all([
      this.#persistence.load(),
      this.#readCapability(),
    ]);
    if (this.#disposed) throw new Error("Notification settings are disposed");
    this.#state = notificationStateSchema.parse({ ...preference, ...capability });
    return this.#state;
  }

  async #setPreference(
    preference: NotificationPreference,
    revision: number,
  ): Promise<NotificationState> {
    await this.#persistence.save(preference);
    if (this.#disposed) throw new Error("Notification settings are disposed");
    // A later intent owns the in-memory state. Persisting this older request in order is harmless,
    // but publishing it would briefly undo a newer restrictive barrier before its own write lands.
    if (revision !== this.#preferenceIntentRevision) return this.state;
    return this.#commit({ ...this.state, ...preference });
  }

  #applyRestrictivePreferenceIntent(preference: NotificationPreference): void {
    const current = this.state;
    // Opt-outs are effective before the atomic file write begins. Expansions still wait for a
    // successful write, and a failed opt-out intentionally leaves this process in the safer state.
    // This also prevents a queued older enable from publishing over a newer disable intent.
    this.#commit({
      ...current,
      devicePreference:
        preference.devicePreference === "disabled" ? "disabled" : current.devicePreference,
      contentPreviewPreference:
        preference.contentPreviewPreference === "disabled"
          ? "disabled"
          : current.contentPreviewPreference,
    });
  }

  async #readCapability(): Promise<{
    readonly nativeSupport: NotificationNativeSupport;
    readonly osPermission: NotificationOsPermission;
  }> {
    try {
      return await this.#capability.read();
    } catch {
      return { nativeSupport: "unsupported", osPermission: "unknown" };
    }
  }

  #commit(next: NotificationState): NotificationState {
    const parsed = notificationStateSchema.parse(next);
    if (this.#state !== null && JSON.stringify(this.#state) === JSON.stringify(parsed)) {
      return this.#state;
    }
    this.#state = parsed;
    for (const listener of this.#listeners) listener(parsed);
    return parsed;
  }

  #assertReady(): void {
    if (this.#disposed) throw new Error("Notification settings are disposed");
    if (this.#state === null) throw new Error("Notification settings are not initialized");
  }
}
