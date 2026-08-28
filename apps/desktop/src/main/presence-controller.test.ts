import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRESENCE_AWAY_IDLE_SECONDS,
  PRESENCE_IDLE_POLL_MS,
  PresenceController,
} from "./presence-controller";

afterEach(() => {
  vi.useRealTimers();
});

describe("PresenceController", () => {
  it("publishes online and away only when idle-derived state changes", () => {
    vi.useFakeTimers();
    let idleSeconds = 0;
    const publish = vi.fn();
    const controller = new PresenceController({ getIdleSeconds: () => idleSeconds, publish });

    controller.start();
    expect(publish).toHaveBeenCalledWith("online");

    idleSeconds = PRESENCE_AWAY_IDLE_SECONDS;
    vi.advanceTimersByTime(PRESENCE_IDLE_POLL_MS);
    expect(publish).toHaveBeenLastCalledWith("away");

    vi.advanceTimersByTime(PRESENCE_IDLE_POLL_MS);
    expect(publish).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("marks suspend away and re-evaluates on resume", () => {
    const publish = vi.fn();
    const controller = new PresenceController({ getIdleSeconds: () => 0, publish });

    controller.start();
    controller.suspend();
    controller.resume();

    expect(publish.mock.calls.map(([state]) => state)).toEqual(["online", "away", "online"]);
    controller.stop();
  });
});
