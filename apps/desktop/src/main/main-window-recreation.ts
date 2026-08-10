export class MainWindowRecreationCoordinator {
  #inFlight: Promise<void> | null = null;
  #trailing: {
    readonly operation: () => void | Promise<void>;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  } | null = null;

  run(operation: () => void | Promise<void>): Promise<void> {
    const current = this.#inFlight;
    if (current === null) return this.#start(operation);

    // One later health check is enough to observe every state change that occurred while the
    // current operation was pending. Activations and notification clicks beyond that share the
    // same trailing check instead of retaining an unbounded promise-and-closure chain.
    if (this.#trailing !== null) return this.#trailing.promise;

    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    this.#trailing = { operation, promise, resolve, reject };
    return promise;
  }

  #start(operation: () => void | Promise<void>): Promise<void> {
    // Install the promise before invoking the operation. A synchronous window factory can publish
    // a half-loaded window before its first await, and a concurrent caller must not treat that
    // window as ready.
    const next = Promise.resolve().then(operation);
    this.#inFlight = next;
    void next.then(
      () => this.#settled(next),
      () => this.#settled(next),
    );
    return next;
  }

  #settled(settled: Promise<void>): void {
    if (this.#inFlight !== settled) return;
    this.#inFlight = null;
    const trailing = this.#trailing;
    if (trailing === null) return;

    this.#trailing = null;
    const next = this.#start(trailing.operation);
    void next.then(trailing.resolve, trailing.reject);
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
