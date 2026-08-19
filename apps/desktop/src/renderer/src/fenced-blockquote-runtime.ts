export type FencedBlockquoteMode = "off" | "double-quote" | "greater-than";

export const FENCED_BLOCKQUOTE_MODE_STORAGE_KEY = "hype-comms:fenced-blockquote-mode";

export interface FencedBlockquoteStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

type FencedBlockquoteListener = () => void;

function browserStorage(): FencedBlockquoteStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseMode(value: string | null): FencedBlockquoteMode {
  return value === "double-quote" || value === "greater-than" ? value : "off";
}

/**
 * Owns the renderer-only fenced-blockquote preference. Invalid or unavailable DOM storage falls
 * back to standard Markdown, while changes remain usable for the current renderer session.
 */
export class FencedBlockquoteRuntime {
  readonly #storage: FencedBlockquoteStorage | null;
  readonly #listeners = new Set<FencedBlockquoteListener>();
  #mode: FencedBlockquoteMode;

  constructor(storage: FencedBlockquoteStorage | null = browserStorage()) {
    this.#storage = storage;
    let stored: string | null = null;
    try {
      stored = storage?.getItem(FENCED_BLOCKQUOTE_MODE_STORAGE_KEY) ?? null;
    } catch {
      // Standard Markdown remains the safe default when storage cannot be read.
    }
    this.#mode = parseMode(stored);
  }

  get mode(): FencedBlockquoteMode {
    return this.#mode;
  }

  subscribe(listener: FencedBlockquoteListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setMode(mode: FencedBlockquoteMode): void {
    if (mode === this.#mode) return;
    try {
      this.#storage?.setItem(FENCED_BLOCKQUOTE_MODE_STORAGE_KEY, mode);
    } catch {
      // The selected mode remains active for this session when persistence is unavailable.
    }
    this.#mode = mode;
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#listeners.clear();
  }
}
