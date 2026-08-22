import { describe, expect, it, vi } from "vitest";

import {
  DeepLinkSignInQueue,
  routeOpenUrlMagicLink,
  routeSecondInstanceMagicLink,
} from "./deep-link-sign-in";
import { AUTH_PROTOCOL_SCHEMES } from "./security";

const TOKEN = "A".repeat(43);
const OTHER_TOKEN = "B".repeat(43);
const SCHEME = AUTH_PROTOCOL_SCHEMES.production;

async function flushQueue(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("deep-link sign-in consent", () => {
  it("does not exchange a bogus open-url callback or disturb the active session", async () => {
    const confirm = vi.fn(async () => true);
    const exchange = vi.fn(async () => "succeeded" as const);
    const onInvalidLink = vi.fn(async () => undefined);
    const queue = new DeepLinkSignInQueue({ confirm, exchange, onInvalidLink });
    await queue.markReady();

    expect(routeOpenUrlMagicLink("hype-comms://auth/callback?token=bogus", SCHEME, queue)).toBe(
      false,
    );
    await flushQueue();

    expect(confirm).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it("queues an open-url callback until the desktop session is ready", async () => {
    const events: string[] = [];
    const queue = new DeepLinkSignInQueue({
      confirm: async () => {
        events.push("confirm");
        return true;
      },
      exchange: async () => {
        events.push("exchange");
        return "succeeded";
      },
      onInvalidLink: async () => undefined,
    });

    expect(routeOpenUrlMagicLink(`hype-comms://auth/callback?token=${TOKEN}`, SCHEME, queue)).toBe(
      true,
    );
    await flushQueue();
    expect(events).toEqual([]);

    await queue.markReady();
    await flushQueue();
    expect(events).toEqual(["confirm", "exchange"]);
  });

  it("requires consent for a second-instance callback before it can replace a session", async () => {
    const activeSession = {
      credential: "victim",
      realtime: "active",
      cache: "victim",
      notifications: "victim",
    };
    const confirm = vi.fn(async () => false);
    const exchange = vi.fn(async () => {
      activeSession.credential = "attacker";
      activeSession.realtime = "replaced";
      activeSession.cache = "attacker";
      activeSession.notifications = "attacker";
      return "succeeded" as const;
    });
    const onInvalidLink = vi.fn(async () => undefined);
    const queue = new DeepLinkSignInQueue({ confirm, exchange, onInvalidLink });
    await queue.markReady();

    expect(
      routeSecondInstanceMagicLink(
        ["--flag", `hype-comms://auth/callback?token=${OTHER_TOKEN}`],
        SCHEME,
        queue,
      ),
    ).toBe(true);
    await flushQueue();

    expect(confirm).toHaveBeenCalledOnce();
    expect(exchange).not.toHaveBeenCalled();
    expect(activeSession).toEqual({
      credential: "victim",
      realtime: "active",
      cache: "victim",
      notifications: "victim",
    });
  });

  it("exchanges a confirmed second-instance callback without exposing its token to the prompt", async () => {
    const confirm = vi.fn(async (...arguments_: readonly unknown[]) => {
      expect(arguments_).toEqual([]);
      return true;
    });
    const exchange = vi.fn(async () => "succeeded" as const);
    const onInvalidLink = vi.fn(async () => undefined);
    const queue = new DeepLinkSignInQueue({ confirm, exchange, onInvalidLink });
    await queue.markReady();

    routeSecondInstanceMagicLink(
      [`hype-comms://auth/callback?token=${OTHER_TOKEN}`],
      SCHEME,
      queue,
    );
    await flushQueue();

    expect(confirm).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledWith(OTHER_TOKEN);
  });

  it("reports a rejected link without changing the active session through the queue", async () => {
    const activeSession = { credential: "victim", realtime: "active", cache: "victim" };
    const onInvalidLink = vi.fn(async () => undefined);
    const queue = new DeepLinkSignInQueue({
      confirm: async () => true,
      exchange: async () => "invalid" as const,
      onInvalidLink,
    });
    await queue.markReady();

    routeOpenUrlMagicLink(`hype-comms://auth/callback?token=${TOKEN}`, SCHEME, queue);
    await flushQueue();

    expect(onInvalidLink).toHaveBeenCalledOnce();
    expect(activeSession).toEqual({ credential: "victim", realtime: "active", cache: "victim" });
  });
});
