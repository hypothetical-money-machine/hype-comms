import { describe, expect, it, vi } from "vitest";

import { WorkspaceRealtime } from "./workspace-realtime";

describe("WorkspaceRealtime", () => {
  it("keeps reconnecting when console logging fails with EIO", async () => {
    const writeFailure = Object.assign(new Error("write EIO"), { code: "EIO" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      throw writeFailure;
    });
    let reconnecting: (() => void) | undefined;
    const reachedReconnect = new Promise<void>((resolve) => {
      reconnecting = resolve;
    });
    const realtime = new WorkspaceRealtime({
      apiOrigin: "http://127.0.0.1:3000",
      rendererOrigin: "http://127.0.0.1:5173",
      transport: {
        ticket: vi.fn().mockRejectedValue(new Error("Server unavailable")),
      },
      onEvent: vi.fn(),
      onState: (state) => {
        if (state === "reconnecting") reconnecting?.();
      },
    });

    try {
      realtime.start("0");
      await reachedReconnect;
      expect(consoleError).toHaveBeenCalledWith(
        "Could not obtain a realtime ticket",
        expect.objectContaining({ message: "Server unavailable" }),
      );
    } finally {
      realtime.stop();
      consoleError.mockRestore();
    }
  });
});
