import { describe, expect, it, vi } from "vitest";

import { handleLastWindowClosed } from "./window-lifecycle";

describe("handleLastWindowClosed", () => {
  it("stops realtime but keeps the macOS process available for window recreation", () => {
    const stopRealtime = vi.fn();
    const quit = vi.fn();

    handleLastWindowClosed({ platform: "darwin", stopRealtime, quit });

    expect(stopRealtime).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("stops realtime before quitting on %s", (platform) => {
    const calls: string[] = [];

    handleLastWindowClosed({
      platform,
      stopRealtime: () => calls.push("stop"),
      quit: () => calls.push("quit"),
    });

    expect(calls).toEqual(["stop", "quit"]);
  });
});
