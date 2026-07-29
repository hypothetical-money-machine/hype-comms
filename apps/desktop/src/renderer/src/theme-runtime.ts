import type { ThemePreference, ThemeState } from "@hmm-chat/contracts";

import type { ThemeTransport } from "../../shared/desktop-api";
import { getThemeDefinition, themeCssVariable, THEME_TOKEN_NAMES } from "../../shared/theme";

type ThemeListener = (state: ThemeState) => void;

export function applyTheme(root: HTMLElement, state: ThemeState): void {
  const theme = getThemeDefinition(state.resolvedThemeId);

  root.dataset.theme = theme.id;
  root.dataset.themePreference = state.preference;
  root.style.colorScheme = theme.colorScheme;
  for (const token of THEME_TOKEN_NAMES) {
    root.style.setProperty(themeCssVariable(token), theme.tokens[token]);
  }
}

/**
 * Keeps the document theme synchronized with the main process while protecting startup from the
 * get/subscribe race. Main's validated startup snapshot is applied synchronously before React
 * mounts, preserving the identity of named themes that share a native color scheme.
 */
export class ThemeRuntime {
  readonly #client: ThemeTransport;
  readonly #root: HTMLElement;
  readonly #listeners = new Set<ThemeListener>();
  #state: ThemeState;
  #startPromise: Promise<void> | null = null;
  #stopThemeListener: (() => void) | null = null;
  #receivedLiveState = false;

  constructor(client: ThemeTransport, root: HTMLElement) {
    this.#client = client;
    this.#root = root;
    this.#state = client.initialThemeState;
    applyTheme(this.#root, this.#state);
  }

  get state(): ThemeState {
    return this.#state;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#hydrate();
    return this.#startPromise;
  }

  async #hydrate(): Promise<void> {
    try {
      this.#stopThemeListener = this.#client.onThemeStateChanged((state) => {
        this.#receivedLiveState = true;
        this.#accept(state);
      });
      const initialState = await this.#client.getThemeState();
      if (!this.#receivedLiveState) {
        this.#accept(initialState);
      }
    } catch {
      // The synchronous validated startup state keeps the app usable if appearance IPC fails.
    }
  }

  subscribe(listener: ThemeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async setPreference(preference: ThemePreference): Promise<ThemeState> {
    const state = await this.#client.setThemePreference(preference);
    this.#accept(state);
    return state;
  }

  dispose(): void {
    this.#stopThemeListener?.();
    this.#stopThemeListener = null;
    this.#listeners.clear();
  }

  #accept(state: ThemeState): void {
    const unchanged =
      state.preference === this.#state.preference &&
      state.resolvedThemeId === this.#state.resolvedThemeId &&
      state.resolvedColorScheme === this.#state.resolvedColorScheme;
    if (unchanged) return;
    this.#state = state;
    applyTheme(this.#root, state);
    for (const listener of this.#listeners) listener(state);
  }
}
