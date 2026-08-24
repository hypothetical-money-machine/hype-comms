import { describe, expect, it, vi } from "vitest";

import { authCapabilitiesForSession, isAuthKitSessionComplete } from "./session-auth-lifecycle";
import {
  BeforeQuitCoordinator,
  FinalQuitCoordinator,
  handleLastWindowClosed,
} from "./window-lifecycle";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("BeforeQuitCoordinator", () => {
  it("blocks quit until teardown settles, then allows the resumed quit event", async () => {
    const pendingTeardown = deferred();
    const cleanup = vi.fn();
    const teardown = vi.fn(() => pendingTeardown.promise);
    const reportCleanupFailure = vi.fn();
    const reportTeardownFailure = vi.fn();
    const resumedPreventDefault = vi.fn();
    const quit = vi.fn();
    const coordinator = new BeforeQuitCoordinator({
      cleanup,
      teardown,
      reportCleanupFailure,
      reportTeardownFailure,
      quit,
    });
    quit.mockImplementation(() => coordinator.handle({ preventDefault: resumedPreventDefault }));
    const firstPreventDefault = vi.fn();

    coordinator.handle({ preventDefault: firstPreventDefault });

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    pendingTeardown.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(resumedPreventDefault).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledOnce();
    expect(reportCleanupFailure).not.toHaveBeenCalled();
    expect(reportTeardownFailure).not.toHaveBeenCalled();
  });

  it("coalesces repeated quit attempts while teardown is pending", () => {
    const pendingTeardown = deferred();
    const teardown = vi.fn(() => pendingTeardown.promise);
    const coordinator = new BeforeQuitCoordinator({
      cleanup: vi.fn(),
      teardown,
      reportCleanupFailure: vi.fn(),
      reportTeardownFailure: vi.fn(),
      quit: vi.fn(),
    });
    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();

    coordinator.handle({ preventDefault: firstPreventDefault });
    coordinator.handle({ preventDefault: secondPreventDefault });

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(secondPreventDefault).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("reports teardown failure and still resumes quitting", async () => {
    const pendingTeardown = deferred();
    const failure = new Error("teardown failed");
    const reportTeardownFailure = vi.fn();
    const quit = vi.fn();
    const coordinator = new BeforeQuitCoordinator({
      cleanup: vi.fn(),
      teardown: () => pendingTeardown.promise,
      reportCleanupFailure: vi.fn(),
      reportTeardownFailure,
      quit,
    });

    coordinator.handle({ preventDefault: vi.fn() });
    pendingTeardown.reject(failure);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(reportTeardownFailure).toHaveBeenCalledWith(failure);
  });

  it("still awaits teardown when unrelated synchronous cleanup fails", async () => {
    const pendingTeardown = deferred();
    const cleanupFailure = new Error("cleanup failed");
    const cleanup = vi.fn(() => {
      throw cleanupFailure;
    });
    const teardown = vi.fn(() => pendingTeardown.promise);
    const reportCleanupFailure = vi.fn();
    const quit = vi.fn();
    const coordinator = new BeforeQuitCoordinator({
      cleanup,
      teardown,
      reportCleanupFailure,
      reportTeardownFailure: vi.fn(),
      quit,
    });

    coordinator.handle({ preventDefault: vi.fn() });

    expect(reportCleanupFailure).toHaveBeenCalledWith(cleanupFailure);
    expect(teardown).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    pendingTeardown.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });
});

describe("FinalQuitCoordinator", () => {
  it("cannot leave AuthKit advertised after a final teardown is subsequently cancelled", () => {
    const chatSession: object | null = {};
    let authKitFlow: object | null = {};
    let authKitPendingStore: object | null = {};
    const scheduledChecks: Array<() => void> = [];
    const reportSessionTeardown = vi.fn();
    const reportQuitCancelledAfterTeardown = vi.fn();
    const event = { defaultPrevented: false };
    const sessionParts = () => ({ chatSession, authKitFlow, authKitPendingStore });
    const capabilitiesHandler = () =>
      authCapabilitiesForSession({ authKit: true, magicLink: true }, sessionParts(), false);
    const startHandler = () => {
      if (!isAuthKitSessionComplete(sessionParts())) {
        throw new Error("AuthKit sign-in is unavailable");
      }
    };
    const coordinator = new FinalQuitCoordinator({
      teardownSession: () => {
        authKitFlow = null;
        authKitPendingStore = null;
      },
      cleanup: vi.fn(),
      reportSessionTeardown,
      reportCleanupFailure: vi.fn(),
      reportQuitCancelledAfterTeardown,
      scheduleQuitCancellationCheck: (check) => scheduledChecks.push(check),
    });

    expect(capabilitiesHandler().authKit).toBe(true);
    expect(startHandler).not.toThrow();

    coordinator.handle(event);
    event.defaultPrevented = true;
    for (const check of scheduledChecks) check();

    expect(reportSessionTeardown).toHaveBeenCalledOnce();
    expect(reportQuitCancelledAfterTeardown).toHaveBeenCalledOnce();
    expect(startHandler).toThrow("AuthKit sign-in is unavailable");
    expect(capabilitiesHandler()).toEqual({ authKit: false, magicLink: true });
    expect(chatSession).not.toBeNull();
  });

  it("runs final teardown once and does not report a quit that remains committed", () => {
    const teardownSession = vi.fn();
    const cleanup = vi.fn();
    const reportQuitCancelledAfterTeardown = vi.fn();
    const scheduledChecks: Array<() => void> = [];
    const coordinator = new FinalQuitCoordinator({
      teardownSession,
      cleanup,
      reportSessionTeardown: vi.fn(),
      reportCleanupFailure: vi.fn(),
      reportQuitCancelledAfterTeardown,
      scheduleQuitCancellationCheck: (check) => scheduledChecks.push(check),
    });
    const event = { defaultPrevented: false };

    coordinator.handle(event);
    coordinator.handle(event);
    for (const check of scheduledChecks) check();

    expect(teardownSession).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reportQuitCancelledAfterTeardown).not.toHaveBeenCalled();
  });
});

describe("handleLastWindowClosed", () => {
  it("keeps the default-off macOS fallback stopped while allowing window recreation", () => {
    const continueRealtimeWithoutRenderer = vi.fn();
    const stopRealtime = vi.fn();
    const quit = vi.fn();

    handleLastWindowClosed({
      platform: "darwin",
      windowlessRealtimeEnabled: false,
      continueRealtimeWithoutRenderer,
      stopRealtime,
      quit,
    });

    expect(stopRealtime).toHaveBeenCalledOnce();
    expect(continueRealtimeWithoutRenderer).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("continues notification observation on macOS when windowless realtime is enabled", () => {
    const continueRealtimeWithoutRenderer = vi.fn();
    const stopRealtime = vi.fn();
    const quit = vi.fn();

    handleLastWindowClosed({
      platform: "darwin",
      windowlessRealtimeEnabled: true,
      continueRealtimeWithoutRenderer,
      stopRealtime,
      quit,
    });

    expect(continueRealtimeWithoutRenderer).toHaveBeenCalledOnce();
    expect(stopRealtime).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("stops realtime before quitting on %s", (platform) => {
    const calls: string[] = [];

    handleLastWindowClosed({
      platform,
      windowlessRealtimeEnabled: true,
      continueRealtimeWithoutRenderer: () => calls.push("continue"),
      stopRealtime: () => calls.push("stop"),
      quit: () => calls.push("quit"),
    });

    expect(calls).toEqual(["stop", "quit"]);
  });
});
