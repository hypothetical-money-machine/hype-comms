import { describe, expect, it, vi } from "vitest";

import { handleLastWindowClosed } from "./window-lifecycle";

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
