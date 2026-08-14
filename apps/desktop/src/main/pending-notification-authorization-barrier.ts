import type { NotificationState } from "@hype-comms/contracts";

import type { NotificationSettingsPort } from "./notification-controller";

/**
 * Startup-only delivery gate for a persisted enabled preference whose native authorization is
 * still being requested. Renderer settings continue to expose the real capability state while
 * the notification controller sees a fail-closed permission until the request settles.
 */
export class PendingNotificationAuthorizationBarrier implements NotificationSettingsPort {
  readonly #source: NotificationSettingsPort;
  readonly #listeners = new Set<(state: NotificationState) => void>();
  readonly #stopSourceSubscription: () => void;
  #authorizationPending: boolean;
  #guardUnknownPermission: boolean;
  #disposed = false;

  constructor(options: {
    readonly source: NotificationSettingsPort;
    readonly authorizationPending: boolean;
  }) {
    this.#source = options.source;
    this.#authorizationPending = options.authorizationPending;
    this.#guardUnknownPermission = options.authorizationPending;
    this.#stopSourceSubscription = this.#source.subscribe(() => {
      if (this.#disposed) return;
      this.#resolveUnknownGuardWhenPossible();
      this.#publish();
    });
  }

  get state(): NotificationState {
    const state = this.#source.state;
    if (
      state.devicePreference === "enabled" &&
      state.nativeSupport === "supported" &&
      (this.#authorizationPending ||
        (this.#guardUnknownPermission && state.osPermission === "unknown"))
    ) {
      return { ...state, osPermission: "denied" };
    }
    return state;
  }

  markPresenterFailure(): NotificationState {
    this.#source.markPresenterFailure();
    return this.state;
  }

  subscribe(listener: (state: NotificationState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Releases the in-flight gate, retaining a fail-closed guard if capability is still unknown. */
  settleAuthorization(): void {
    if (this.#disposed || !this.#authorizationPending) return;
    this.#authorizationPending = false;
    this.#resolveUnknownGuardWhenPossible();
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    // Mark disposed before unsubscribing so even an in-flight source callback cannot read a source
    // that the application tears down immediately after this barrier.
    this.#disposed = true;
    this.#stopSourceSubscription();
    this.#listeners.clear();
  }

  #resolveUnknownGuardWhenPossible(): void {
    if (this.#disposed || this.#authorizationPending || !this.#guardUnknownPermission) return;
    const state = this.#source.state;
    if (state.osPermission !== "unknown") this.#guardUnknownPermission = false;
  }

  #publish(): void {
    if (this.#disposed) return;
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
}

/** Starts the upgrade without making session restoration wait for human interaction. */
export async function settlePendingNotificationAuthorization(options: {
  readonly request: () => Promise<unknown>;
  readonly barrier: PendingNotificationAuthorizationBarrier;
  readonly onFailure: (error: unknown) => void;
}): Promise<void> {
  try {
    await options.request();
  } catch (error) {
    options.onFailure(error);
  } finally {
    options.barrier.settleAuthorization();
  }
}
