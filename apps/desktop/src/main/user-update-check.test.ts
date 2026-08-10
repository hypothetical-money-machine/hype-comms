import { UPDATE_CHECK_ERROR_MESSAGE, type UpdateState } from "@hmm-chat/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  dialogForUpdateCheckState,
  dialogForWindowRestoreFailure,
  isCheckForUpdatesEnabled,
  runUserInitiatedUpdateCheck,
  shouldParentUpdateCheckDialog,
} from "./user-update-check";

const neverSettles = (): (() => void) => () => {};

describe("runUserInitiatedUpdateCheck", () => {
  it("reports an up-to-date info dialog when the check ends idle", async () => {
    const dialog = await runUserInitiatedUpdateCheck({
      checkNow: () => Promise.resolve(),
      readState: () => ({ status: "idle" }),
      subscribe: neverSettles,
      appVersion: "1.2.3",
    });

    expect(dialog).toEqual({
      type: "info",
      message: "You're up to date",
      detail: "Hype Comms 1.2.3 is the latest version.",
    });
  });

  it("reports an error dialog carrying the curated message when the check fails", async () => {
    const dialog = await runUserInitiatedUpdateCheck({
      checkNow: () => Promise.resolve(),
      readState: () => ({ status: "error", message: UPDATE_CHECK_ERROR_MESSAGE }),
      subscribe: neverSettles,
      appVersion: "1.2.3",
    });

    expect(dialog).toEqual({
      type: "error",
      message: "Update check failed",
      detail: UPDATE_CHECK_ERROR_MESSAGE,
    });
  });

  it("reports an unavailable dialog when the check leaves updates unsupported", async () => {
    const dialog = await runUserInitiatedUpdateCheck({
      checkNow: () => Promise.resolve(),
      readState: () => ({ status: "unsupported" }),
      subscribe: neverSettles,
      appVersion: "1.2.3",
    });

    expect(dialog).toEqual({
      type: "info",
      message: "Updates aren't available",
      detail: "Automatic updates aren't supported for this installation.",
    });
  });

  it.each<UpdateState>([
    { status: "available" },
    { status: "downloading", percentage: 40 },
    { status: "ready", version: "2.0.0" },
  ])("reports no dialog for states the renderer already handles ($status)", async (state) => {
    const dialog = await runUserInitiatedUpdateCheck({
      checkNow: () => Promise.resolve(),
      readState: () => state,
      subscribe: neverSettles,
      appVersion: "1.2.3",
    });

    expect(dialog).toBeNull();
  });

  it("waits out an in-flight check before deciding the dialog", async () => {
    let listener: ((state: UpdateState) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((subscriber: (state: UpdateState) => void) => {
      listener = subscriber;
      return unsubscribe;
    });

    const pendingDialog = runUserInitiatedUpdateCheck({
      checkNow: () => Promise.resolve(),
      readState: () => ({ status: "checking" }),
      subscribe,
      appVersion: "1.2.3",
    });

    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledOnce();
    });
    listener?.({ status: "checking" });
    listener?.({ status: "idle" });

    await expect(pendingDialog).resolves.toMatchObject({ type: "info" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("shows nothing when the in-flight check settles in a renderer-handled state", async () => {
    let listener: ((state: UpdateState) => void) | undefined;
    const subscribe = vi.fn((subscriber: (state: UpdateState) => void) => {
      listener = subscriber;
      return () => {};
    });

    const pendingDialog = runUserInitiatedUpdateCheck({
      checkNow: () => Promise.resolve(),
      readState: () => ({ status: "checking" }),
      subscribe,
      appVersion: "1.2.3",
    });

    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledOnce();
    });
    listener?.({ status: "available" });

    await expect(pendingDialog).resolves.toBeNull();
  });

  it("reads the terminal state only after the check settles", async () => {
    let state: UpdateState = { status: "checking" };
    let checkSettled = false;
    const readState = vi.fn(() => {
      expect(checkSettled).toBe(true);
      return state;
    });
    const checkNow = vi.fn(async () => {
      await Promise.resolve();
      state = { status: "idle" };
      checkSettled = true;
    });

    const dialog = await runUserInitiatedUpdateCheck({
      checkNow,
      readState,
      subscribe: neverSettles,
      appVersion: "1.2.3",
    });

    expect(readState).toHaveBeenCalledTimes(1);
    expect(dialog).toMatchObject({ type: "info" });
  });

  it("propagates a rejected check instead of inventing a dialog", async () => {
    const readState = vi.fn(() => ({ status: "idle" }) as UpdateState);

    await expect(
      runUserInitiatedUpdateCheck({
        checkNow: () => Promise.reject(new Error("boom")),
        readState,
        subscribe: neverSettles,
        appVersion: "1.2.3",
      }),
    ).rejects.toThrow("boom");
    expect(readState).not.toHaveBeenCalled();
  });
});

describe("dialogForUpdateCheckState", () => {
  it("includes the running app version in the up-to-date detail", () => {
    expect(dialogForUpdateCheckState({ status: "idle" }, "9.8.7")?.detail).toContain("9.8.7");
  });
});

describe("dialogForWindowRestoreFailure", () => {
  it("returns a stable error dialog so a failed window restore never goes silent", () => {
    expect(dialogForWindowRestoreFailure()).toEqual({
      type: "error",
      message: "Couldn't check for updates",
      detail: "The app window couldn't be opened. Open the app window and try again.",
    });
  });
});

describe("shouldParentUpdateCheckDialog", () => {
  it("forces an unparented dialog when restore failed", () => {
    expect(
      shouldParentUpdateCheckDialog({ isDestroyed: () => false }, { parentToMainWindow: false }),
    ).toBe(false);
  });

  it("parents to a live main window for normal update-check dialogs", () => {
    expect(shouldParentUpdateCheckDialog({ isDestroyed: () => false })).toBe(true);
  });

  it("stays unparented when the main window is missing or destroyed", () => {
    expect(shouldParentUpdateCheckDialog(null)).toBe(false);
    expect(shouldParentUpdateCheckDialog({ isDestroyed: () => true })).toBe(false);
  });
});

describe("isCheckForUpdatesEnabled", () => {
  it("disables the command once updates become unsupported", () => {
    expect(isCheckForUpdatesEnabled({ status: "unsupported" })).toBe(false);
  });

  it.each<UpdateState>([
    { status: "idle" },
    { status: "checking" },
    { status: "available" },
    { status: "downloading", percentage: 5 },
    { status: "ready", version: "2.0.0" },
    { status: "error", message: UPDATE_CHECK_ERROR_MESSAGE },
  ])("keeps the command enabled while updates can still progress ($status)", (state) => {
    expect(isCheckForUpdatesEnabled(state)).toBe(true);
  });
});
