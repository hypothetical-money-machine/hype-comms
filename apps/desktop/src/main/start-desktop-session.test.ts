import { describe, expect, it, vi } from "vitest";
import { deferred } from "./test-support/deferred";
import { startDesktopSession } from "./start-desktop-session";

describe("desktop startup", () => {
  it("shows the window before permission and restores login while permission is pending", async () => {
    const window = deferred<void>();
    const permission = deferred<void>();
    const events: string[] = [];
    const startup = startDesktopSession({
      showWindow: async () => {
        await window.promise;
        events.push("shown");
      },
      authorizeNotifications: () => {
        events.push("authorize");
        return permission.promise;
      },
      reportAuthorizationFailure: vi.fn(),
      beforeRestore: async () => undefined,
      restore: async () => {
        events.push("restore");
        return { status: "signed-out" };
      },
    });
    expect(events).toEqual([]);
    window.resolve();
    await expect(startup).resolves.toEqual({ status: "signed-out" });
    expect(events).toEqual(["shown", "authorize", "restore"]);
    permission.resolve();
  });

  it("isolates a failed notification request and awaits platform evidence setup", async () => {
    const evidence = deferred<void>();
    const reportAuthorizationFailure = vi.fn();
    const restore = vi.fn(async () => ({ status: "signed-out" as const }));
    const startup = startDesktopSession({
      showWindow: async () => undefined,
      authorizeNotifications: () => {
        throw new Error("OS prompt failed");
      },
      reportAuthorizationFailure,
      beforeRestore: () => evidence.promise,
      restore,
    });
    await vi.waitFor(() => expect(reportAuthorizationFailure).toHaveBeenCalledOnce());
    expect(restore).not.toHaveBeenCalled();
    evidence.resolve();
    await startup;
    expect(restore).toHaveBeenCalledOnce();
  });
});
