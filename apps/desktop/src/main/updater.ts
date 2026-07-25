import {
  UPDATE_CHECK_ERROR_MESSAGE,
  UPDATE_DOWNLOAD_ERROR_MESSAGE,
  UPDATE_INSTALL_ERROR_MESSAGE,
  updateVersionSchema,
  type UpdateState,
} from "@hmm-chat/contracts";

import { DEFAULT_PRODUCTION_API_ORIGIN } from "../shared/api-origin";

export const INITIAL_UPDATE_CHECK_DELAY_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
/**
 * A download that stops producing progress has no other way out: electron-updater imposes no
 * overall timeout, and while a download is in flight the scheduled checks are suppressed. Without
 * this the app would sit at a frozen percentage until it was restarted.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 5 * 60 * 1_000;
export {
  UPDATE_CHECK_ERROR_MESSAGE,
  UPDATE_DOWNLOAD_ERROR_MESSAGE,
  UPDATE_INSTALL_ERROR_MESSAGE,
} from "@hmm-chat/contracts";

export interface UpdateSourceConfiguration {
  readonly autoDownload: true;
  readonly autoInstallOnAppQuit: true;
  readonly allowDowngrade: false;
  readonly allowPrerelease: false;
}

interface UpdateInfo {
  readonly version: string;
}

interface UpdateProgress {
  readonly percent: number;
}

export interface UpdateSource {
  readonly configure: (configuration: UpdateSourceConfiguration) => void;
  readonly onCheckingForUpdate: (listener: () => void) => () => void;
  readonly onUpdateAvailable: (listener: (info: UpdateInfo) => void) => () => void;
  readonly onUpdateNotAvailable: (listener: () => void) => () => void;
  readonly onDownloadProgress: (listener: (progress: UpdateProgress) => void) => () => void;
  readonly onUpdateDownloaded: (listener: (info: UpdateInfo) => void) => () => void;
  readonly onUpdateCancelled: (listener: () => void) => () => void;
  readonly onError: (listener: (error: unknown) => void) => () => void;
  readonly checkForUpdates: () => Promise<unknown>;
  readonly quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
}

interface UpdateControllerOptions {
  readonly updater: UpdateSource;
  readonly isPackaged: boolean;
  readonly apiOrigin: string;
  readonly platform: NodeJS.Platform;
  readonly appImagePath?: string;
  readonly hasMacDeveloperIdSignature: boolean;
}

function isSupported(options: UpdateControllerOptions): boolean {
  if (!options.isPackaged) {
    return false;
  }

  // A package aimed at another server must never replace itself with the official
  // production-origin build just because both packages can reach the public update feed.
  if (options.apiOrigin !== DEFAULT_PRODUCTION_API_ORIGIN) {
    return false;
  }

  if (options.platform === "linux") {
    return typeof options.appImagePath === "string" && options.appImagePath.trim() !== "";
  }
  if (options.platform === "darwin") {
    return options.hasMacDeveloperIdSignature;
  }

  return options.platform === "win32";
}

function isMacSignatureFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  if (candidate.code === "ERR_UPDATER_INVALID_SIGNATURE") {
    return true;
  }

  if (typeof candidate.message !== "string") {
    return false;
  }

  const message = candidate.message.toLowerCase();
  return (
    message.includes("code signature") ||
    message.includes("not code signed") ||
    message.includes("signature validation") ||
    message.includes("signature verification") ||
    message.includes("improperly signed")
  );
}

/**
 * Owns updater lifecycle and renderer-safe state in the main process.
 *
 * The injected source is intentionally smaller than electron-updater. Tests can drive its event
 * boundary without importing Electron, while production wiring remains in the main entry point.
 */
export class UpdateController {
  readonly #updater: UpdateSource;
  readonly #platform: NodeJS.Platform;
  readonly #listeners = new Set<(state: UpdateState) => void>();
  readonly #unsubscribe: Array<() => void> = [];
  readonly #supported: boolean;
  #initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
  #periodicCheckTimer: ReturnType<typeof setInterval> | null = null;
  #stallTimer: ReturnType<typeof setTimeout> | null = null;
  #checkRequest: Promise<void> | null = null;
  #state: UpdateState;

  constructor(options: UpdateControllerOptions) {
    this.#updater = options.updater;
    this.#platform = options.platform;
    this.#supported = isSupported(options);
    this.#state = this.#supported ? { status: "idle" } : { status: "unsupported" };

    if (!this.#supported) {
      return;
    }

    this.#updater.configure({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: false,
      allowPrerelease: false,
    });
    this.#subscribeToUpdater();

    this.#initialCheckTimer = setTimeout(() => {
      void this.checkNow();
    }, INITIAL_UPDATE_CHECK_DELAY_MS);
    this.#periodicCheckTimer = setInterval(() => {
      void this.checkNow();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  get state(): UpdateState {
    return this.#state;
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(state: UpdateState): void {
    this.#state = state;
    // Arming here rather than at each call site means a download can never be left without a way
    // out, including on paths added later.
    if (state.status === "available" || state.status === "downloading") {
      this.#armStallTimer();
    } else {
      this.#clearStallTimer();
    }
    for (const listener of this.#listeners) listener(state);
  }

  #armStallTimer(): void {
    this.#clearStallTimer();
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = null;
      if (this.#state.status === "available" || this.#state.status === "downloading") {
        this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
      }
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  }

  #clearStallTimer(): void {
    if (this.#stallTimer !== null) {
      clearTimeout(this.#stallTimer);
      this.#stallTimer = null;
    }
  }

  #subscribeToUpdater(): void {
    this.#unsubscribe.push(
      this.#updater.onCheckingForUpdate(() => {
        this.#setState({ status: "checking" });
      }),
      this.#updater.onUpdateAvailable((info) => {
        if (updateVersionSchema.safeParse(info.version).success) {
          this.#setState({ status: "available" });
        } else {
          this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
        }
      }),
      this.#updater.onUpdateNotAvailable(() => {
        this.#setState({ status: "idle" });
      }),
      this.#updater.onDownloadProgress((progress) => {
        const percentage = Number.isFinite(progress.percent)
          ? Math.min(100, Math.max(0, Math.round(progress.percent)))
          : 0;
        this.#setState({ status: "downloading", percentage });
      }),
      this.#updater.onUpdateDownloaded((info) => {
        const version = updateVersionSchema.safeParse(info.version);
        if (version.success) {
          this.#setState({ status: "ready", version: version.data });
        } else {
          this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
        }
      }),
      this.#updater.onUpdateCancelled(() => {
        this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
      }),
      this.#updater.onError((error) => {
        this.#handleFailure(error);
      }),
    );
  }

  #handleFailure(error: unknown): void {
    if (this.#state.status === "unsupported" || this.#state.status === "error") {
      return;
    }
    if (this.#platform === "darwin" && isMacSignatureFailure(error)) {
      // Squirrel.Mac cannot apply an update it cannot match to the running app's signature, and
      // that will not change while this build is running. Stop checking rather than rediscovering
      // it every interval, re-downloading the update, and settling on an error the user cannot act
      // on.
      this.#stopChecking();
      this.#setState({ status: "unsupported" });
      return;
    }

    const message =
      this.#state.status === "available" ||
      this.#state.status === "downloading" ||
      this.#state.status === "ready"
        ? UPDATE_DOWNLOAD_ERROR_MESSAGE
        : UPDATE_CHECK_ERROR_MESSAGE;
    this.#setState({ status: "error", message });
  }

  async checkNow(): Promise<void> {
    if (
      !this.#supported ||
      this.#checkRequest !== null ||
      this.#state.status === "unsupported" ||
      this.#state.status === "available" ||
      this.#state.status === "downloading" ||
      this.#state.status === "ready"
    ) {
      return;
    }

    this.#setState({ status: "checking" });

    let request: Promise<unknown>;
    try {
      request = this.#updater.checkForUpdates();
    } catch (error) {
      this.#handleFailure(error);
      return;
    }

    const checkRequest = request
      .then(() => {
        if (this.#state.status === "checking") {
          this.#setState({ status: "idle" });
        }
      })
      .catch((error: unknown) => {
        this.#handleFailure(error);
      });
    this.#checkRequest = checkRequest;
    await checkRequest;
    if (this.#checkRequest === checkRequest) {
      this.#checkRequest = null;
    }
  }

  quitAndInstall(): void {
    if (this.#state.status !== "ready") {
      return;
    }

    try {
      this.#updater.quitAndInstall(true, true);
    } catch {
      this.#setState({ status: "error", message: UPDATE_INSTALL_ERROR_MESSAGE });
    }
  }

  /** Stops scheduled checks while leaving the updater subscribed and its state readable. */
  #stopChecking(): void {
    if (this.#initialCheckTimer !== null) {
      clearTimeout(this.#initialCheckTimer);
      this.#initialCheckTimer = null;
    }
    if (this.#periodicCheckTimer !== null) {
      clearInterval(this.#periodicCheckTimer);
      this.#periodicCheckTimer = null;
    }
  }

  dispose(): void {
    this.#stopChecking();
    this.#clearStallTimer();
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
  }
}
