import {
  UPDATE_CHECK_ERROR_MESSAGE,
  UPDATE_DOWNLOAD_ERROR_MESSAGE,
  UPDATE_INSTALL_ERROR_MESSAGE,
  updateVersionSchema,
  type UpdateState,
} from "@hype-comms/contracts";

import { OFFICIAL_PRODUCTION_API_ORIGIN } from "../shared/api-origin";

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
} from "@hype-comms/contracts";

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

export interface UpdateCancellationToken {
  readonly cancel: () => void;
}

export interface UpdateCheckResult {
  readonly downloadPromise?: Promise<unknown> | null;
  readonly cancellationToken?: UpdateCancellationToken;
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
  readonly checkForUpdates: () => Promise<UpdateCheckResult | null>;
  readonly quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
}

interface ActiveDownload {
  readonly request: Promise<void>;
  readonly cancellationToken: UpdateCancellationToken | null;
  cancelled: boolean;
}

interface UpdateControllerOptions {
  readonly updater: UpdateSource;
  readonly updatesAllowed: boolean;
  readonly isProductionBuild: boolean;
  readonly isPackaged: boolean;
  readonly apiOrigin: string;
  readonly platform: NodeJS.Platform;
  readonly appImagePath?: string;
  readonly hasMacDeveloperIdSignature: boolean;
}

function isSupported(options: UpdateControllerOptions): boolean {
  if (!options.updatesAllowed) {
    return false;
  }

  if (!options.isProductionBuild) {
    return false;
  }

  if (!options.isPackaged) {
    return false;
  }

  // A package aimed at another server must never replace itself with the official
  // production-origin build just because both packages can reach the public update feed.
  if (options.apiOrigin !== OFFICIAL_PRODUCTION_API_ORIGIN) {
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
  #activeDownload: ActiveDownload | null = null;
  #installRequested = false;
  #disposed = false;
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
    if (this.#disposed) {
      return;
    }
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
        this.#cancelActiveDownload();
      }
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  }

  #clearStallTimer(): void {
    if (this.#stallTimer !== null) {
      clearTimeout(this.#stallTimer);
      this.#stallTimer = null;
    }
  }

  #isCancellingDownload(): boolean {
    return this.#activeDownload?.cancelled === true;
  }

  #cancelActiveDownload(): void {
    const activeDownload = this.#activeDownload;
    if (activeDownload === null || activeDownload.cancelled) {
      return;
    }

    activeDownload.cancelled = true;
    try {
      activeDownload.cancellationToken?.cancel();
    } catch {
      // The controller is already moving to a curated error state; cancellation is best-effort.
    }
  }

  #trackDownload(result: UpdateCheckResult | null): void {
    const downloadPromise = result?.downloadPromise;
    if (downloadPromise === undefined || downloadPromise === null) {
      return;
    }

    let activeDownload: ActiveDownload | null = null;
    const request = downloadPromise
      .then(
        () => undefined,
        (error: unknown) => {
          // electron-updater emits an error event and then rejects this nested promise. Owning the
          // rejection here prevents Node from treating a handled updater failure as unhandled.
          if (activeDownload?.cancelled !== true) {
            this.#handleFailure(error, "download");
          }
        },
      )
      .then(() => {
        if (activeDownload !== null && this.#activeDownload === activeDownload) {
          this.#activeDownload = null;
        }
      });
    activeDownload = {
      request,
      cancellationToken: result?.cancellationToken ?? null,
      cancelled: false,
    };
    this.#activeDownload = activeDownload;
  }

  #subscribeToUpdater(): void {
    this.#unsubscribe.push(
      this.#updater.onCheckingForUpdate(() => {
        if (this.#isCancellingDownload()) return;
        this.#installRequested = false;
        this.#setState({ status: "checking" });
      }),
      this.#updater.onUpdateAvailable((info) => {
        if (this.#isCancellingDownload()) return;
        if (updateVersionSchema.safeParse(info.version).success) {
          this.#setState({ status: "available" });
        } else {
          this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
        }
      }),
      this.#updater.onUpdateNotAvailable(() => {
        if (this.#isCancellingDownload()) return;
        this.#setState({ status: "idle" });
      }),
      this.#updater.onDownloadProgress((progress) => {
        if (this.#isCancellingDownload()) return;
        const percentage = Number.isFinite(progress.percent)
          ? Math.min(100, Math.max(0, Math.round(progress.percent)))
          : 0;
        this.#setState({ status: "downloading", percentage });
      }),
      this.#updater.onUpdateDownloaded((info) => {
        if (this.#isCancellingDownload()) return;
        const version = updateVersionSchema.safeParse(info.version);
        if (version.success) {
          this.#installRequested = false;
          this.#setState({ status: "ready", version: version.data });
        } else {
          this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
        }
      }),
      this.#updater.onUpdateCancelled(() => {
        if (this.#isCancellingDownload()) return;
        this.#setState({ status: "error", message: UPDATE_DOWNLOAD_ERROR_MESSAGE });
      }),
      this.#updater.onError((error) => {
        if (this.#isCancellingDownload()) return;
        this.#handleFailure(error);
      }),
    );
  }

  #handleFailure(error: unknown, phase?: "download"): void {
    if (this.#disposed || this.#state.status === "unsupported" || this.#state.status === "error") {
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

    const message = this.#installRequested
      ? UPDATE_INSTALL_ERROR_MESSAGE
      : phase === "download" ||
          this.#state.status === "available" ||
          this.#state.status === "downloading" ||
          this.#state.status === "ready"
        ? UPDATE_DOWNLOAD_ERROR_MESSAGE
        : UPDATE_CHECK_ERROR_MESSAGE;
    this.#installRequested = false;
    this.#setState({ status: "error", message });
  }

  async checkNow(): Promise<void> {
    if (!this.#supported || this.#disposed) {
      return;
    }

    const activeDownload = this.#activeDownload;
    if (activeDownload !== null) {
      if (this.#state.status !== "error") {
        return;
      }
      // A retry must not race electron-updater's still-live downloadPromise. Cancellation settles
      // that promise, after which electron-updater can safely create a fresh request.
      await activeDownload.request;
    }

    if (
      this.#disposed ||
      this.#checkRequest !== null ||
      this.#activeDownload !== null ||
      this.#state.status === "unsupported" ||
      this.#state.status === "available" ||
      this.#state.status === "downloading" ||
      this.#state.status === "ready"
    ) {
      return;
    }

    this.#installRequested = false;
    this.#setState({ status: "checking" });

    let request: Promise<UpdateCheckResult | null>;
    try {
      request = this.#updater.checkForUpdates();
    } catch (error) {
      this.#handleFailure(error);
      return;
    }

    const checkRequest = request
      .then((result) => {
        this.#trackDownload(result);
        if (this.#disposed) {
          this.#cancelActiveDownload();
          return;
        }
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

    this.#installRequested = true;
    try {
      this.#updater.quitAndInstall(true, true);
    } catch {
      this.#installRequested = false;
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
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#stopChecking();
    this.#clearStallTimer();
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#cancelActiveDownload();
  }
}
