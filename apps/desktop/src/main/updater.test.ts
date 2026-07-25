import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PRODUCTION_API_ORIGIN } from "../shared/api-origin";
import {
  DOWNLOAD_STALL_TIMEOUT_MS,
  INITIAL_UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_ERROR_MESSAGE,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_DOWNLOAD_ERROR_MESSAGE,
  UPDATE_INSTALL_ERROR_MESSAGE,
  UpdateController,
  type UpdateSource,
  type UpdateSourceConfiguration,
} from "./updater";

function listen<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

class FakeUpdateSource implements UpdateSource {
  configuration: UpdateSourceConfiguration | null = null;
  checks = 0;
  readonly installArguments: Array<readonly [isSilent: boolean, isForceRunAfter: boolean]> = [];
  installError: Error | null = null;
  checkResult: () => Promise<unknown> = () => Promise.resolve();
  readonly checkingListeners = new Set<() => void>();
  readonly availableListeners = new Set<(info: { readonly version: string }) => void>();
  readonly notAvailableListeners = new Set<() => void>();
  readonly progressListeners = new Set<(progress: { readonly percent: number }) => void>();
  readonly downloadedListeners = new Set<(info: { readonly version: string }) => void>();
  readonly cancelledListeners = new Set<() => void>();
  readonly errorListeners = new Set<(error: unknown) => void>();

  readonly configure = (configuration: UpdateSourceConfiguration): void => {
    this.configuration = configuration;
  };

  readonly onCheckingForUpdate = (listener: () => void): (() => void) =>
    listen(this.checkingListeners, listener);

  readonly onUpdateAvailable = (
    listener: (info: { readonly version: string }) => void,
  ): (() => void) => listen(this.availableListeners, listener);

  readonly onUpdateNotAvailable = (listener: () => void): (() => void) =>
    listen(this.notAvailableListeners, listener);

  readonly onDownloadProgress = (
    listener: (progress: { readonly percent: number }) => void,
  ): (() => void) => listen(this.progressListeners, listener);

  readonly onUpdateDownloaded = (
    listener: (info: { readonly version: string }) => void,
  ): (() => void) => listen(this.downloadedListeners, listener);

  readonly onUpdateCancelled = (listener: () => void): (() => void) =>
    listen(this.cancelledListeners, listener);

  readonly onError = (listener: (error: unknown) => void): (() => void) =>
    listen(this.errorListeners, listener);

  readonly checkForUpdates = (): Promise<unknown> => {
    this.checks += 1;
    return this.checkResult();
  };

  readonly quitAndInstall = (isSilent: boolean, isForceRunAfter: boolean): void => {
    if (this.installError !== null) {
      throw this.installError;
    }
    this.installArguments.push([isSilent, isForceRunAfter]);
  };

  emitAvailable(version: string): void {
    for (const listener of this.availableListeners) listener({ version });
  }

  emitProgress(percent: number): void {
    for (const listener of this.progressListeners) listener({ percent });
  }

  emitDownloaded(version: string): void {
    for (const listener of this.downloadedListeners) listener({ version });
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

interface ControllerOverrides {
  readonly isPackaged?: boolean;
  readonly apiOrigin?: string;
  readonly platform?: NodeJS.Platform;
  readonly appImagePath?: string;
  readonly hasMacDeveloperIdSignature?: boolean;
}

const controllers: UpdateController[] = [];

function createController(
  updater: UpdateSource,
  overrides: ControllerOverrides = {},
): UpdateController {
  const controller = new UpdateController({
    updater,
    isPackaged: overrides.isPackaged ?? true,
    apiOrigin: overrides.apiOrigin ?? DEFAULT_PRODUCTION_API_ORIGIN,
    platform: overrides.platform ?? "win32",
    ...(overrides.appImagePath === undefined ? {} : { appImagePath: overrides.appImagePath }),
    hasMacDeveloperIdSignature: overrides.hasMacDeveloperIdSignature ?? true,
  });
  controllers.push(controller);
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("UpdateController support", () => {
  it.each([
    ["development", { isPackaged: false }],
    ["a non-production API package", { apiOrigin: "https://staging.example" }],
    ["a Linux deb package", { platform: "linux" as const }],
    [
      "an unsigned macOS package",
      { platform: "darwin" as const, hasMacDeveloperIdSignature: false },
    ],
  ])("stays inert for %s", async (_description, overrides) => {
    const updater = new FakeUpdateSource();
    const controller = createController(updater, overrides);

    expect(controller.state).toEqual({ status: "unsupported" });
    expect(updater.configuration).toBeNull();

    await controller.checkNow();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(updater.checks).toBe(0);
  });

  it("supports a packaged Linux AppImage", () => {
    const updater = new FakeUpdateSource();
    const controller = createController(updater, {
      platform: "linux",
      appImagePath: "/tmp/HMM.Chat.AppImage",
    });

    expect(controller.state).toEqual({ status: "idle" });
    expect(updater.configuration).not.toBeNull();
  });
});

describe("UpdateController lifecycle", () => {
  it("configures safe automatic behavior and checks after a delay and periodically", async () => {
    const updater = new FakeUpdateSource();
    const controller = createController(updater);

    expect(controller.state).toEqual({ status: "idle" });
    expect(updater.configuration).toEqual({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: false,
      allowPrerelease: false,
    });

    await vi.advanceTimersByTimeAsync(INITIAL_UPDATE_CHECK_DELAY_MS - 1);
    expect(updater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checks).toBe(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - INITIAL_UPDATE_CHECK_DELAY_MS);
    expect(updater.checks).toBe(2);
  });

  it("publishes validated progress and installs only a ready update", async () => {
    const updater = new FakeUpdateSource();
    let finishCheck: (() => void) | undefined;
    updater.checkResult = () =>
      new Promise<void>((resolve) => {
        finishCheck = resolve;
      });
    const controller = createController(updater);
    const states = [controller.state];
    controller.subscribe((state) => states.push(state));

    controller.quitAndInstall();
    expect(updater.installArguments).toEqual([]);

    const check = controller.checkNow();
    updater.emitAvailable("1.2.3");
    updater.emitProgress(41.6);
    updater.emitProgress(101);
    updater.emitDownloaded("1.2.3");

    expect(states).toContainEqual({ status: "checking" });
    expect(states).toContainEqual({ status: "available" });
    expect(states).toContainEqual({ status: "downloading", percentage: 42 });
    expect(states).toContainEqual({ status: "downloading", percentage: 100 });
    expect(controller.state).toEqual({ status: "ready", version: "1.2.3" });

    controller.quitAndInstall();
    expect(updater.installArguments).toEqual([[true, true]]);
    finishCheck?.();
    await check;
  });

  it("rejects an invalid network version without exposing it", () => {
    const updater = new FakeUpdateSource();
    const controller = createController(updater);
    const unsafeVersion = "../private/update.zip";

    updater.emitDownloaded(unsafeVersion);

    expect(controller.state).toEqual({
      status: "error",
      message: UPDATE_DOWNLOAD_ERROR_MESSAGE,
    });
    expect(JSON.stringify(controller.state)).not.toContain(unsafeVersion);
  });

  it("curates check failures and never rejects them to lifecycle callers", async () => {
    const updater = new FakeUpdateSource();
    const rawMessage =
      "GET https://updates.example/private failed at /Users/morgan/update-cache/file.zip";
    updater.checkResult = () => Promise.reject(new Error(rawMessage));
    const controller = createController(updater);

    await expect(controller.checkNow()).resolves.toBeUndefined();
    expect(controller.state).toEqual({
      status: "error",
      message: UPDATE_CHECK_ERROR_MESSAGE,
    });
    expect(JSON.stringify(controller.state)).not.toContain(rawMessage);
  });

  it("translates a late macOS signing failure to unsupported", () => {
    const updater = new FakeUpdateSource();
    const controller = createController(updater, { platform: "darwin" });

    updater.emitError(new Error("Could not get code signature for running application"));

    expect(controller.state).toEqual({ status: "unsupported" });
  });

  it("stays unsupported after a late macOS signing failure", async () => {
    const updater = new FakeUpdateSource();
    const controller = createController(updater, { platform: "darwin" });
    updater.emitError(new Error("Could not get code signature for running application"));
    expect(controller.state).toEqual({ status: "unsupported" });

    // A scheduled check must not walk the app back out of a state it can never satisfy, which
    // would re-download the update every interval and settle on an error the user cannot act on.
    await controller.checkNow();

    expect(controller.state).toEqual({ status: "unsupported" });
    expect(updater.checks).toBe(0);
  });

  it("recovers from a download that stops reporting progress", async () => {
    vi.useFakeTimers();
    try {
      const updater = new FakeUpdateSource();
      const controller = createController(updater);
      updater.emitAvailable("1.2.3");
      updater.emitProgress(43);
      expect(controller.state).toEqual({ status: "downloading", percentage: 43 });

      // No further progress, downloaded, cancelled, or error event ever arrives — the case a
      // suspended machine or dropped connection produces.
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS + 1);

      expect(controller.state).toEqual({
        status: "error",
        message: UPDATE_DOWNLOAD_ERROR_MESSAGE,
      });
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("curates a synchronous install failure", () => {
    const updater = new FakeUpdateSource();
    updater.installError = new Error("Installer path: /private/tmp/secret");
    const controller = createController(updater);
    updater.emitDownloaded("1.2.3");

    expect(() => controller.quitAndInstall()).not.toThrow();
    expect(controller.state).toEqual({
      status: "error",
      message: UPDATE_INSTALL_ERROR_MESSAGE,
    });
  });
});
