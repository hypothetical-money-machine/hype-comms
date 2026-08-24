import type { EphemeralActivityFrame } from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RealtimePrincipal } from "../src/modules/realtime/auth.js";
import {
  EphemeralActivityHub,
  TYPING_ACTIVITY_TTL_MS,
} from "../src/modules/realtime/activity-hub.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const conversationId = "10000000-0000-4000-8000-000000000002";
const alexId = "10000000-0000-4000-8000-000000000003";
const danId = "10000000-0000-4000-8000-000000000004";

function human(userId: string, deviceSessionId: string, capable = true): RealtimePrincipal {
  return {
    workspaceId,
    userId,
    deviceSessionId,
    agentTokenId: null,
    ephemeralActivity: capable,
  };
}

function agent(userId: string): RealtimePrincipal {
  return {
    workspaceId,
    userId,
    deviceSessionId: null,
    agentTokenId: "10000000-0000-4000-8000-000000000009",
    ephemeralActivity: true,
  };
}

function connection(id: string, principal: RealtimePrincipal) {
  const frames: EphemeralActivityFrame[] = [];
  return {
    frames,
    value: { id, principal, send: (frame: EphemeralActivityFrame) => (frames.push(frame), true) },
  };
}

function presence(frames: readonly EphemeralActivityFrame[], userId: string) {
  return frames.filter((frame) => frame.type === "activity.presence" && frame.userId === userId);
}

function typing(frames: readonly EphemeralActivityFrame[], userId: string) {
  return frames.filter((frame) => frame.type === "activity.typing" && frame.userId === userId);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EphemeralActivityHub", () => {
  it("aggregates human presence across devices and never presents an agent as online", () => {
    const hub = new EphemeralActivityHub(async () => true);
    const alexLaptop = connection("alex-laptop", human(alexId, "alex-laptop"));
    const alexPhone = connection("alex-phone", human(alexId, "alex-phone"));
    const dan = connection("dan", human(danId, "dan"));
    const bot = connection("bot", agent("10000000-0000-4000-8000-000000000008"));

    hub.register(dan.value);
    hub.register(alexLaptop.value, "away");
    hub.register(alexPhone.value, "online");
    hub.register(bot.value);
    expect(presence(dan.frames, alexId).at(-1)).toMatchObject({ state: "online" });
    expect(bot.frames.some((frame) => frame.userId === bot.value.principal.userId)).toBe(false);

    hub.setPresence("alex-phone", "away");
    expect(presence(dan.frames, alexId).at(-1)).toMatchObject({ state: "away" });
    hub.disconnect("alex-laptop");
    expect(presence(dan.frames, alexId).at(-1)).toMatchObject({ state: "away" });
    hub.disconnect("alex-phone");
    expect(presence(dan.frames, alexId).at(-1)).toMatchObject({ state: "offline" });
    hub.close();
  });

  it("authorizes each typing recipient, aggregates devices, and expires without durable fields", async () => {
    vi.useFakeTimers();
    const visible = new Set([alexId, danId]);
    const hub = new EphemeralActivityHub(
      async (_workspace, userId) => visible.has(userId),
      Date.now,
    );
    const alexLaptop = connection("alex-laptop", human(alexId, "alex-laptop"));
    const alexPhone = connection("alex-phone", human(alexId, "alex-phone"));
    const dan = connection("dan", human(danId, "dan"));
    hub.register(alexLaptop.value);
    hub.register(alexPhone.value);
    hub.register(dan.value);

    await hub.setTyping("alex-laptop", conversationId, true);
    await hub.setTyping("alex-phone", conversationId, true);
    const frame = typing(dan.frames, alexId).at(-1);
    expect(frame).toMatchObject({ conversationId, typing: true });
    expect(frame).not.toHaveProperty("id");
    expect(frame).not.toHaveProperty("occurredAt");
    expect(frame).not.toHaveProperty("workspaceSequence");
    expect(frame).not.toHaveProperty("delivery");

    await hub.setTyping("alex-laptop", conversationId, false);
    expect(typing(dan.frames, alexId).at(-1)).toMatchObject({ typing: true });
    visible.delete(danId);
    await hub.setTyping("alex-phone", conversationId, true);
    const countBeforeExpiry = typing(dan.frames, alexId).length;
    await vi.advanceTimersByTimeAsync(TYPING_ACTIVITY_TTL_MS);
    expect(typing(dan.frames, alexId)).toHaveLength(countBeforeExpiry);
    hub.close();
  });

  it("fails closed for a recipient whose authorization read fails instead of rejecting", async () => {
    const hub = new EphemeralActivityHub(async (_workspace, userId) => {
      if (userId === danId) throw new Error("database unavailable");
      return true;
    });
    const alex = connection("alex", human(alexId, "alex"));
    const dan = connection("dan", human(danId, "dan"));
    hub.register(alex.value);
    hub.register(dan.value);

    await expect(hub.setTyping("alex", conversationId, true)).resolves.toBeUndefined();

    expect(typing(dan.frames, alexId)).toEqual([]);
    expect(typing(alex.frames, alexId).at(-1)).toMatchObject({ conversationId, typing: true });
    hub.close();
  });

  it("does not register or send unknown frames to a client without the capability", async () => {
    const hub = new EphemeralActivityHub(async () => true);
    const legacy = connection("legacy", human(danId, "legacy", false));
    const capable = connection("capable", human(alexId, "capable"));
    hub.register(legacy.value);
    hub.register(capable.value);
    await hub.setTyping("capable", conversationId, true);
    expect(legacy.frames).toEqual([]);
    hub.close();
  });
});
