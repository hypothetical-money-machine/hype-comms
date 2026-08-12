import {
  themeDesignSchema,
  themePreferenceSchema,
  type ResolvedColorScheme,
  type ThemeDesign,
  type ThemePreference,
  type ThemeState,
} from "@hype-comms/contracts";

import { getThemeDefinition, parseBuiltInThemeState, SYSTEM_THEME_IDS } from "../shared/theme";
import { reportMainProcessError } from "./main-process-log";

export interface NativeThemeAdapter {
  themeSource: "system" | ResolvedColorScheme;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  off(event: "updated", listener: () => void): unknown;
}

export interface ThemePreferencePersistence {
  load(): Promise<ThemeDesign>;
  save(design: ThemeDesign): Promise<void>;
}

function canonicalThemeState(design: ThemeDesign, shouldUseDarkColors: boolean): ThemeState {
  const resolvedThemeId =
    design.preference === "system"
      ? SYSTEM_THEME_IDS[shouldUseDarkColors ? "dark" : "light"]
      : getThemeDefinition(design.preference).id;
  const definition = getThemeDefinition(resolvedThemeId);

  return Object.freeze(
    parseBuiltInThemeState({
      preference: design.preference,
      resolvedThemeId,
      resolvedColorScheme: definition.colorScheme,
      accentColor: design.accentColor,
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
    left.resolvedColorScheme === right.resolvedColorScheme &&
    (left.accentColor ?? null) === (right.accentColor ?? null)
  );
}

function designFromState(state: ThemeState): ThemeDesign {
  return Object.freeze({
    preference: state.preference,
    accentColor: state.accentColor ?? null,
  });
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
      canonicalThemeState(designFromState(this.#state), this.#nativeTheme.shouldUseDarkColors),
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
        reportMainProcessError("Theme state listener failed", error);
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
      return this.#enqueueSet(() =>
        this.#setDesign({
          preference: parsedPreference,
          accentColor: this.state.accentColor ?? null,
        }),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  setDesign(design: ThemeDesign): Promise<ThemeState> {
    try {
      this.#assertReady();
      if (!this.#acceptingChanges) {
        throw new Error("ThemeController is shutting down");
      }
      const parsedDesign = themeDesignSchema.parse(design);
      if (parsedDesign.preference !== "system") {
        getThemeDefinition(parsedDesign.preference);
      }
      return this.#enqueueSet(() => this.#setDesign(parsedDesign));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Resolves the operating-system foundation without changing the saved design or canonical app
   * state. Electron applies an explicit theme source to both `shouldUseDarkColors` and renderer
   * media queries, so main must briefly remove that override to read the actual system choice.
   */
  resolveSystemState(): Promise<ThemeState> {
    try {
      this.#assertReady();
      if (!this.#acceptingChanges) {
        throw new Error("ThemeController is shutting down");
      }
      return this.#enqueueSet(() => this.#resolveSystemState());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #enqueueSet(operation: () => ThemeState | Promise<ThemeState>): Promise<ThemeState> {
    const request = this.#setTail.then(operation);
    this.#setTail = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
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
    const design = themeDesignSchema.parse(await this.#persistence.load());
    if (this.#disposed) {
      throw new Error("ThemeController has been disposed");
    }
    if (design.preference !== "system") {
      getThemeDefinition(design.preference);
    }

    this.#suppressNativeUpdates = true;
    try {
      this.#nativeTheme.themeSource = nativeThemeSourceForPreference(design.preference);
    } finally {
      this.#suppressNativeUpdates = false;
    }
    this.#nativeTheme.on("updated", this.#handleNativeThemeUpdated);
    this.#nativeThemeSubscribed = true;
    this.#state = canonicalThemeState(design, this.#nativeTheme.shouldUseDarkColors);
    return this.#state;
  }

  async #setDesign(design: ThemeDesign): Promise<ThemeState> {
    this.#assertReady();
    const previous = this.state;
    const previousDesign = designFromState(previous);
    if (
      design.preference === previousDesign.preference &&
      design.accentColor === previousDesign.accentColor
    ) {
      return previous;
    }

    if (design.preference !== previous.preference) {
      let failed = false;
      let failure: unknown;
      this.#suppressNativeUpdates = true;
      try {
        this.#nativeTheme.themeSource = nativeThemeSourceForPreference(design.preference);
        await this.#persistence.save(design);
        if (this.#disposed) {
          throw new Error("ThemeController has been disposed");
        }
      } catch (error) {
        failed = true;
        failure = error;
        try {
          this.#nativeTheme.themeSource = nativeThemeSourceForPreference(previous.preference);
        } catch (restoreError) {
          failure = new AggregateError(
            [error, restoreError],
            "Theme change failed and the native appearance could not be restored",
          );
        }
      } finally {
        this.#suppressNativeUpdates = false;
      }
      if (failed) {
        if (!this.#disposed && previous.preference === "system") {
          this.#setState(
            canonicalThemeState(previousDesign, this.#nativeTheme.shouldUseDarkColors),
          );
        }
        throw failure;
      }
    } else {
      await this.#persistence.save(design);
      if (this.#disposed) {
        throw new Error("ThemeController has been disposed");
      }
    }

    return this.#setState(canonicalThemeState(design, this.#nativeTheme.shouldUseDarkColors));
  }

  #resolveSystemState(): ThemeState {
    this.#assertReady();
    const current = this.state;
    if (current.preference === "system") {
      return current;
    }

    const expectedSource = nativeThemeSourceForPreference(current.preference);
    let shouldRestoreSource = false;
    let shouldUseDarkColors = false;
    let failure: unknown;
    this.#suppressNativeUpdates = true;
    try {
      // A setter can fail after partially changing a native adapter, so restoration is required
      // from the moment the probe is attempted, not only after it returns successfully.
      shouldRestoreSource = true;
      this.#nativeTheme.themeSource = "system";
      shouldUseDarkColors = this.#nativeTheme.shouldUseDarkColors;
    } catch (error) {
      failure = error;
    } finally {
      if (shouldRestoreSource) {
        try {
          // Derive this from canonical state rather than the adapter's observed source. If an
          // earlier restoration failed and left nativeTheme on System, a retry must repair it.
          this.#nativeTheme.themeSource = expectedSource;
        } catch (restoreError) {
          failure =
            failure === undefined
              ? restoreError
              : new AggregateError(
                  [failure, restoreError],
                  "System appearance resolution failed and the native appearance could not be restored",
                );
        }
      }
      this.#suppressNativeUpdates = false;
    }

    if (failure !== undefined) {
      throw failure;
    }
    this.#assertReady();
    return canonicalThemeState(
      {
        preference: "system",
        accentColor: current.accentColor ?? null,
      },
      shouldUseDarkColors,
    );
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
