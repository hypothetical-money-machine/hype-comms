export type SidebarPosition = "left" | "right";

export const SIDEBAR_POSITION_STORAGE_KEY = "hype-comms:sidebar-position";

export interface SidebarPositionStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

type SidebarPositionListener = () => void;

function browserStorage(): SidebarPositionStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readPosition(storage: SidebarPositionStorage | null): SidebarPosition {
  try {
    return storage?.getItem(SIDEBAR_POSITION_STORAGE_KEY) === "right" ? "right" : "left";
  } catch {
    return "left";
  }
}

export function applySidebarPosition(root: HTMLElement, position: SidebarPosition): void {
  root.dataset.sidebarPosition = position;
}

/**
 * Owns the renderer-only navigation placement preference. DOM storage is deliberately best-effort:
 * hardened renderers still let the user move the sidebar for the current session, while ordinary
 * desktop profiles restore the choice synchronously before React mounts.
 */
export class SidebarPositionRuntime {
  readonly #root: HTMLElement;
  readonly #storage: SidebarPositionStorage | null;
  readonly #listeners = new Set<SidebarPositionListener>();
  #position: SidebarPosition;

  constructor(root: HTMLElement, storage: SidebarPositionStorage | null = browserStorage()) {
    this.#root = root;
    this.#storage = storage;
    this.#position = readPosition(storage);
    applySidebarPosition(this.#root, this.#position);
  }

  get position(): SidebarPosition {
    return this.#position;
  }

  subscribe(listener: SidebarPositionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setPosition(position: SidebarPosition): void {
    if (position === this.#position) return;
    try {
      this.#storage?.setItem(SIDEBAR_POSITION_STORAGE_KEY, position);
    } catch {
      // Placement remains usable for this session when DOM storage is unavailable.
    }
    this.#position = position;
    applySidebarPosition(this.#root, position);
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#listeners.clear();
  }
}
