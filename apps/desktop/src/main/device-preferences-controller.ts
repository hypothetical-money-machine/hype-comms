import {
  devicePreferencesPatchSchema,
  devicePreferencesSchema,
  type DevicePreferences,
  type DevicePreferencesPatch,
} from "@hype-comms/contracts";

import { devicePreferencesEqual } from "../shared/device-preferences";

export interface DevicePreferencesPersistence {
  load(): Promise<DevicePreferences>;
  save(preferences: DevicePreferences): Promise<void>;
}

function canonicalPreferences(value: unknown): DevicePreferences {
  return Object.freeze(devicePreferencesSchema.parse(value));
}

/** Serializes partial updates, persists before publishing, and retains one canonical state. */
export class DevicePreferencesController {
  readonly #persistence: DevicePreferencesPersistence;
  readonly #reportListenerError: (error: unknown) => void;
  readonly #listeners = new Set<(preferences: DevicePreferences) => void>();
  #state: DevicePreferences | null = null;
  #initialization: Promise<DevicePreferences> | null = null;
  #updateTail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: {
    readonly persistence: DevicePreferencesPersistence;
    readonly reportListenerError?: (error: unknown) => void;
  }) {
    this.#persistence = options.persistence;
    this.#reportListenerError =
      options.reportListenerError ??
      ((error) => {
        console.error("Device preferences listener failed", error);
      });
  }

  get state(): DevicePreferences {
    if (this.#state === null) {
      throw new Error("DevicePreferencesController must be initialized before its state is read");
    }
    return this.#state;
  }

  initialize(): Promise<DevicePreferences> {
    if (this.#disposed) {
      return Promise.reject(new Error("DevicePreferencesController has been disposed"));
    }
    if (this.#state !== null) return Promise.resolve(this.#state);
    if (this.#initialization !== null) return this.#initialization;

    const initialization = this.#initialize();
    this.#initialization = initialization;
    void initialization.catch(() => {
      if (this.#initialization === initialization) this.#initialization = null;
    });
    return initialization;
  }

  subscribe(listener: (preferences: DevicePreferences) => void): () => void {
    this.#assertReady();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    try {
      const canonicalPatch = devicePreferencesPatchSchema.parse(patch);
      this.#assertReady();
      const request = this.#updateTail.then(() => this.#update(canonicalPatch));
      this.#updateTail = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #initialize(): Promise<DevicePreferences> {
    const preferences = canonicalPreferences(await this.#persistence.load());
    if (this.#disposed) {
      throw new Error("DevicePreferencesController has been disposed");
    }
    this.#state = preferences;
    return preferences;
  }

  async #update(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    if (this.#state === null) {
      throw new Error("DevicePreferencesController must be initialized before use");
    }
    const previous = this.#state;
    const next = canonicalPreferences({ ...previous, ...patch });
    if (devicePreferencesEqual(previous, next)) return previous;

    await this.#persistence.save(next);
    // A queued update must merge with the value that reached disk even when shutdown started while
    // this write was in flight. No listener is called after disposal.
    this.#state = next;
    if (this.#disposed) {
      throw new Error("DevicePreferencesController has been disposed");
    }

    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch (error) {
        try {
          this.#reportListenerError(error);
        } catch {
          // Reporting cannot change committed preferences or block the remaining listeners.
        }
      }
    }
    return next;
  }

  #assertReady(): void {
    if (this.#disposed) {
      throw new Error("DevicePreferencesController has been disposed");
    }
    if (this.#state === null) {
      throw new Error("DevicePreferencesController must be initialized before use");
    }
  }
}
