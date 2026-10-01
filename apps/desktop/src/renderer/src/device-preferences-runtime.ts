import type { DevicePreferences, DevicePreferencesPatch } from "@hype-comms/contracts";

import { devicePreferencesEqual } from "../../shared/device-preferences";
import type { DevicePreferencesTransport } from "../../shared/desktop-api";

type DevicePreferencesListener = () => void;

function setOptionalDataAttribute(
  root: HTMLElement,
  name: keyof DOMStringMap,
  value: string | null,
): void {
  if (value === null) {
    delete root.dataset[name];
  } else {
    root.dataset[name] = value;
  }
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Absent in non-browser test environments, so a missing matchMedia degrades to "no preference". */
function matchReducedMotion(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

/**
 * Resolves "system" against the OS setting here rather than in CSS, so the stylesheet carries one
 * rule keyed on a concrete value instead of a second copy of it behind a media query.
 */
function resolveMotionPreference(
  preference: DevicePreferences["motionPreference"],
  systemPrefersReducedMotion: boolean,
): "reduced" | null {
  if (preference === "reduced") return "reduced";
  return preference === "system" && systemPrefersReducedMotion ? "reduced" : null;
}

/** Applies presentation preferences before React mounts without changing default rendering. */
export function applyDevicePreferences(
  root: HTMLElement,
  state: DevicePreferences,
  systemPrefersReducedMotion = false,
): void {
  setOptionalDataAttribute(
    root,
    "sidebarWidth",
    state.sidebarWidth === "default" ? null : state.sidebarWidth,
  );
  setOptionalDataAttribute(
    root,
    "messageTextSize",
    state.messageTextSize === "default" ? null : state.messageTextSize,
  );
  setOptionalDataAttribute(
    root,
    "alwaysShowGroupedMessageTimes",
    state.alwaysShowGroupedMessageTimes ? "true" : null,
  );
  setOptionalDataAttribute(root, "showProfileTitles", state.showProfileTitles ? null : "false");
  setOptionalDataAttribute(
    root,
    "motionPreference",
    resolveMotionPreference(state.motionPreference, systemPrefersReducedMotion),
  );
}

/**
 * Keeps device preferences synchronized with main while protecting startup from the
 * get/subscribe race. Main's validated startup snapshot is applied synchronously before React
 * mounts, so presentation preferences do not flash back to their defaults during hydration.
 */
export class DevicePreferencesRuntime {
  readonly #client: DevicePreferencesTransport;
  readonly #root: HTMLElement;
  readonly #listeners = new Set<DevicePreferencesListener>();
  readonly #motionQuery: MediaQueryList | null;
  readonly #onMotionQueryChange = () => {
    applyDevicePreferences(this.#root, this.#state, this.#motionQuery?.matches === true);
  };
  #state: DevicePreferences;
  #startPromise: Promise<void> | null = null;
  #stopDevicePreferencesListener: (() => void) | null = null;
  #receivedLiveState = false;

  constructor(client: DevicePreferencesTransport, root: HTMLElement) {
    this.#client = client;
    this.#root = root;
    this.#state = client.initialDevicePreferences;
    this.#motionQuery = matchReducedMotion();
    this.#motionQuery?.addEventListener("change", this.#onMotionQueryChange);
    applyDevicePreferences(this.#root, this.#state, this.#motionQuery?.matches === true);
  }

  get state(): DevicePreferences {
    return this.#state;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#hydrate();
    return this.#startPromise;
  }

  async #hydrate(): Promise<void> {
    try {
      this.#stopDevicePreferencesListener = this.#client.onDevicePreferencesChanged((state) => {
        this.#receivedLiveState = true;
        this.#accept(state);
      });
      const initialState = await this.#client.getDevicePreferences();
      if (!this.#receivedLiveState) {
        this.#accept(initialState);
      }
    } catch {
      // The synchronous validated startup state keeps the app usable if preference IPC fails.
    }
  }

  subscribe(listener: DevicePreferencesListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async update(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    const state = await this.#client.updateDevicePreferences(patch);
    this.#accept(state);
    return state;
  }

  dispose(): void {
    this.#stopDevicePreferencesListener?.();
    this.#stopDevicePreferencesListener = null;
    this.#motionQuery?.removeEventListener("change", this.#onMotionQueryChange);
    this.#listeners.clear();
  }

  #accept(state: DevicePreferences): void {
    if (devicePreferencesEqual(state, this.#state)) return;
    this.#state = state;
    applyDevicePreferences(this.#root, state, this.#motionQuery?.matches === true);
    for (const listener of this.#listeners) listener();
  }
}
