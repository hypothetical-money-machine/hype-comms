export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface BeforeQuitCoordinatorActions {
  readonly cleanup: () => void;
  readonly teardown: () => Promise<void>;
  readonly reportCleanupFailure: (error: unknown) => void;
  readonly reportTeardownFailure: (error: unknown) => void;
  readonly quit: () => void;
}

/**
 * Gives asynchronous process teardown one chance to settle before Electron exits. The resumed
 * `quit()` emits `before-quit` again, so that second event must pass through instead of recursively
 * starting another teardown.
 */
export class BeforeQuitCoordinator {
  readonly #actions: BeforeQuitCoordinatorActions;
  #state: "idle" | "tearing-down" | "ready-to-quit" = "idle";

  constructor(actions: BeforeQuitCoordinatorActions) {
    this.#actions = actions;
  }

  handle(event: BeforeQuitEvent): void {
    if (this.#state === "ready-to-quit") return;
    event.preventDefault();
    if (this.#state === "tearing-down") return;

    this.#state = "tearing-down";
    void this.#teardownAndResumeQuit();
  }

  async #teardownAndResumeQuit(): Promise<void> {
    try {
      try {
        this.#actions.cleanup();
      } catch (error) {
        this.#reportSafely(this.#actions.reportCleanupFailure, error);
      }
    } finally {
      try {
        await this.#actions.teardown();
      } catch (error) {
        this.#reportSafely(this.#actions.reportTeardownFailure, error);
      }
      this.#state = "ready-to-quit";
      this.#actions.quit();
    }
  }

  #reportSafely(report: (error: unknown) => void, error: unknown): void {
    try {
      report(error);
    } catch {
      // Reporting is diagnostic and must not bypass the teardown fence or block application exit.
    }
  }
}

export interface LastWindowClosedActions {
  readonly platform: NodeJS.Platform;
  readonly windowlessRealtimeEnabled: boolean;
  readonly continueRealtimeWithoutRenderer: () => void;
  readonly stopRealtime: () => void;
  readonly quit: () => void;
}

/**
 * Keeps notification observation alive on macOS only when its explicit transport contract is
 * enabled. Default-off builds retain the stop fallback, while every other desktop platform
 * preserves the existing quit-on-last-window behavior.
 */
export function handleLastWindowClosed(actions: LastWindowClosedActions): void {
  if (actions.platform === "darwin" && actions.windowlessRealtimeEnabled) {
    actions.continueRealtimeWithoutRenderer();
  } else {
    actions.stopRealtime();
  }
  if (actions.platform !== "darwin") {
    actions.quit();
  }
}
