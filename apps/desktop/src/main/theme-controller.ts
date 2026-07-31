import {
  themePreferenceSchema,
  type ResolvedColorScheme,
  type ThemePreference,
  type ThemeState,
} from "@hmm-chat/contracts";

import { getThemeDefinition, parseBuiltInThemeState, SYSTEM_THEME_IDS } from "../shared/theme";

export interface NativeThemeAdapter {
  themeSource: "system" | ResolvedColorScheme;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  off(event: "updated", listener: () => void): unknown;
}

export interface ThemePreferencePersistence {
  load(): Promise<ThemePreference>;
  save(preference: ThemePreference): Promise<void>;
}

function canonicalThemeState(
  preference: ThemePreference,
  shouldUseDarkColors: boolean,
): ThemeState {
  const resolvedThemeId =
    preference === "system"
      ? SYSTEM_THEME_IDS[shouldUseDarkColors ? "dark" : "light"]
      : getThemeDefinition(preference).id;
  const definition = getThemeDefinition(resolvedThemeId);

  return Object.freeze(
    parseBuiltInThemeState({
      preference,
      resolvedThemeId,
      resolvedColorScheme: definition.colorScheme,
    }),
  );
}

function nativeThemeSourceForPreference(
  preference: ThemePreference,
): "system" | ResolvedColorScheme {
  return preference === "system" ? "system" : getThemeDefinition(preference).colorScheme;
}

function themeStatesEqual(left: ThemeState, right: ThemeState): boolean {
  return (
    left.preference === right.preference &&
    left.resolvedThemeId === right.resolvedThemeId &&
    left.resolvedColorScheme === right.resolvedColorScheme
  );
}

export class ThemeController {
  readonly #nativeTheme: NativeThemeAdapter;
  readonly #persistence: ThemePreferencePersistence;
  readonly #reportListenerError: (error: unknown) => void;
  readonly #listeners = new Set<(state: ThemeState) => void>();
  #state: ThemeState | null = null;
  #initialization: Promise<ThemeState> | null = null;
  #setTail: Promise<void> = Promise.resolve();
  #nativeThemeSubscribed = false;
  #suppressNativeUpdates = false;
  #acceptingChanges = true;
  #disposed = false;

  readonly #handleNativeThemeUpdated = (): void => {
    if (this.#disposed || this.#suppressNativeUpdates || this.#state === null) {
      return;
    }
    this.#setState(
      canonicalThemeState(this.#state.preference, this.#nativeTheme.shouldUseDarkColors),
    );
  };

  constructor(options: {
    readonly nativeTheme: NativeThemeAdapter;
    readonly persistence: ThemePreferencePersistence;
    readonly reportListenerError?: (error: unknown) => void;
  }) {
    this.#nativeTheme = options.nativeTheme;
    this.#persistence = options.persistence;
    this.#reportListenerError =
      options.reportListenerError ??
      ((error) => {
        console.error("Theme state listener failed", error);
      });
  }

  get state(): ThemeState {
    if (this.#state === null) {
      throw new Error("ThemeController must be initialized before its state is read");
    }
    return this.#state;
  }

  initialize(): Promise<ThemeState> {
    if (this.#disposed) {
      return Promise.reject(new Error("ThemeController has been disposed"));
    }
    if (this.#state !== null) {
      return Promise.resolve(this.#state);
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

  subscribe(listener: (state: ThemeState) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setPreference(preference: ThemePreference): Promise<ThemeState> {
    try {
      this.#assertReady();
      if (!this.#acceptingChanges) {
        throw new Error("ThemeController is shutting down");
      }
      const parsedPreference = themePreferenceSchema.parse(preference);
      if (parsedPreference !== "system") {
        getThemeDefinition(parsedPreference);
      }
      const request = this.#setTail.then(() => this.#setPreference(parsedPreference));
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
    this.#acceptingChanges = false;
    this.#disposed = true;
    if (this.#nativeThemeSubscribed) {
      this.#nativeTheme.off("updated", this.#handleNativeThemeUpdated);
      this.#nativeThemeSubscribed = false;
    }
    this.#listeners.clear();
  }

  async #initialize(): Promise<ThemeState> {
    const preference = themePreferenceSchema.parse(await this.#persistence.load());
    if (this.#disposed) {
      throw new Error("ThemeController has been disposed");
    }

    this.#suppressNativeUpdates = true;
    try {
      this.#nativeTheme.themeSource = nativeThemeSourceForPreference(preference);
    } finally {
      this.#suppressNativeUpdates = false;
    }
    this.#nativeTheme.on("updated", this.#handleNativeThemeUpdated);
    this.#nativeThemeSubscribed = true;
    this.#state = canonicalThemeState(preference, this.#nativeTheme.shouldUseDarkColors);
    return this.#state;
  }

  async #setPreference(preference: ThemePreference): Promise<ThemeState> {
    this.#assertReady();
    const previous = this.state;
    if (preference === previous.preference) {
      return previous;
    }

    await this.#persistence.save(preference);
    if (this.#disposed) {
      throw new Error("ThemeController has been disposed");
    }
    this.#suppressNativeUpdates = true;
    try {
      this.#nativeTheme.themeSource = nativeThemeSourceForPreference(preference);
    } catch (error) {
      try {
        this.#nativeTheme.themeSource = nativeThemeSourceForPreference(previous.preference);
      } catch {
        // The canonical state remains unchanged even if the native adapter cannot be restored.
      }
      await this.#persistence.save(previous.preference).catch(() => undefined);
      throw error;
    } finally {
      this.#suppressNativeUpdates = false;
    }

    return this.#setState(canonicalThemeState(preference, this.#nativeTheme.shouldUseDarkColors));
  }

  #setState(state: ThemeState): ThemeState {
    const previous = this.#state;
    if (previous !== null && themeStatesEqual(previous, state)) {
      return previous;
    }
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch (error) {
        try {
          this.#reportListenerError(error);
        } catch {
          // Error reporting cannot change an already committed preference or block other listeners.
        }
      }
    }
    return state;
  }

  #assertReady(): void {
    if (this.#disposed) {
      throw new Error("ThemeController has been disposed");
    }
    if (this.#state === null) {
      throw new Error("ThemeController must be initialized before use");
    }
  }
}
