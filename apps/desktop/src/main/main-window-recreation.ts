export class MainWindowRecreationCoordinator {
  #inFlight: Promise<void> | null = null;

  run(operation: () => void | Promise<void>): Promise<void> {
    const current = this.#inFlight;
    if (current !== null) return current;

    // Install the shared promise before invoking the operation. A synchronous window factory can
    // publish a half-loaded window before its first await, and a concurrent caller must still wait
    // for that same load rather than treating the half-built window as ready.
    const next = Promise.resolve().then(operation);
    this.#inFlight = next;
    void next.then(
      () => {
        if (this.#inFlight === next) this.#inFlight = null;
      },
      () => {
        if (this.#inFlight === next) this.#inFlight = null;
      },
    );
    return next;
  }
}

export interface MainWindowLifecycleState<Window> {
  readonly currentWindow: () => Window | null;
  readonly setCurrentWindow: (window: Window | null) => void;
  readonly setRendererReady: (ready: boolean) => void;
  readonly advanceRendererSessionGeneration: () => void;
  readonly invalidateRendererBinding: (webContentsId: number) => void;
}

/**
 * Per-window lifecycle guard. Stale Electron callbacks always invalidate their own webContents
 * binding, but they cannot clear or advance global state belonging to a newer main window.
 */
export class MainWindowLifecycle<Window> {
  readonly #window: Window;
  readonly #webContentsId: number;
  readonly #state: MainWindowLifecycleState<Window>;
  #rendererInvalidated = true;

  constructor(options: {
    readonly window: Window;
    readonly webContentsId: number;
    readonly state: MainWindowLifecycleState<Window>;
  }) {
    this.#window = options.window;
    this.#webContentsId = options.webContentsId;
    this.#state = options.state;
  }

  rendererDidFinishLoad(onReady: () => void): boolean {
    if (this.#state.currentWindow() !== this.#window) {
      this.#state.invalidateRendererBinding(this.#webContentsId);
      return false;
    }
    this.#rendererInvalidated = false;
    this.#state.setRendererReady(true);
    onReady();
    return true;
  }

  invalidateRenderer(): boolean {
    const wasActive = !this.#rendererInvalidated;
    this.#rendererInvalidated = true;
    this.#state.invalidateRendererBinding(this.#webContentsId);
    if (!wasActive || this.#state.currentWindow() !== this.#window) return false;

    this.#state.setRendererReady(false);
    this.#state.advanceRendererSessionGeneration();
    return true;
  }

  windowClosed(): void {
    this.invalidateRenderer();
    if (this.#state.currentWindow() !== this.#window) return;
    this.#state.setRendererReady(false);
    this.#state.setCurrentWindow(null);
  }

  loadFailed(): void {
    this.invalidateRenderer();
    if (this.#state.currentWindow() !== this.#window) return;
    this.#state.setRendererReady(false);
    this.#state.setCurrentWindow(null);
  }
}
