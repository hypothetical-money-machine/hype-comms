import type { CompactModeTransport } from "../../shared/desktop-api";

type CompactModeListener = (enabled: boolean) => void;

export function applyCompactMode(root: HTMLElement, enabled: boolean): void {
  if (enabled) {
    root.dataset.compact = "true";
  } else {
    delete root.dataset.compact;
  }
}

/**
 * Keeps the document compact-mode attribute synchronized with the main process while protecting
 * startup from the get/subscribe race. Main's validated startup snapshot is applied synchronously
 * before React mounts, so the workspace rail and sidebar never flash into view.
 */
export class CompactModeRuntime {
  readonly #client: CompactModeTransport;
  readonly #root: HTMLElement;
  readonly #listeners = new Set<CompactModeListener>();
  #enabled: boolean;
  #pendingEnabled: boolean | null = null;
  #startPromise: Promise<void> | null = null;
  #stopCompactModeListener: (() => void) | null = null;
  #receivedLiveState = false;

  constructor(client: CompactModeTransport, root: HTMLElement) {
    this.#client = client;
    this.#root = root;
    this.#enabled = client.initialCompactMode;
    applyCompactMode(this.#root, this.#enabled);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#hydrate();
    return this.#startPromise;
  }

  async #hydrate(): Promise<void> {
    try {
      this.#stopCompactModeListener = this.#client.onCompactModeChanged((enabled) => {
        this.#receivedLiveState = true;
        this.#accept(enabled);
      });
      const initialEnabled = await this.#client.getCompactMode();
      if (!this.#receivedLiveState) {
        this.#accept(initialEnabled);
      }
    } catch {
      // The synchronous validated startup state keeps the app usable if compact-mode IPC fails.
    }
  }

  subscribe(listener: CompactModeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    this.#pendingEnabled = enabled;
    try {
      const result = await this.#client.setCompactMode(enabled);
      this.#accept(result);
      return result;
    } finally {
      if (this.#pendingEnabled === enabled) {
        this.#pendingEnabled = null;
      }
    }
  }

  /**
   * Toggles from the most recently requested value, not the confirmed one, so rapid repeated
   * presses alternate instead of resending the same target while a save is still in flight.
   */
  toggle(): Promise<boolean> {
    return this.setEnabled(!(this.#pendingEnabled ?? this.#enabled));
  }

  dispose(): void {
    this.#stopCompactModeListener?.();
    this.#stopCompactModeListener = null;
    this.#listeners.clear();
  }

  #accept(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    applyCompactMode(this.#root, enabled);
    for (const listener of this.#listeners) listener(enabled);
  }
}
