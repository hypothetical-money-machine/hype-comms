import { describe, expect, it } from "vitest";

import {
  resolveMacosNativeNotificationEvidence,
  resolveNativeNotificationRollout,
} from "./native-notification-rollout";

describe("resolveNativeNotificationRollout", () => {
  it("is default-off and accepts an explicit disabled value", () => {
    expect(resolveNativeNotificationRollout(undefined)).toBe(false);
    expect(resolveNativeNotificationRollout("")).toBe(false);
    expect(resolveNativeNotificationRollout(" 0 ")).toBe(false);
  });

  it("enables only the explicit pilot value", () => {
    expect(resolveNativeNotificationRollout("1")).toBe(true);
    expect(() => resolveNativeNotificationRollout("true")).toThrow(
      "HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED must be 0 or 1",
    );
  });
});

describe("resolveMacosNativeNotificationEvidence", () => {
  it("is compiled out unless explicitly enabled", () => {
    expect(resolveMacosNativeNotificationEvidence(undefined, true)).toBe(false);
    expect(resolveMacosNativeNotificationEvidence("0", true)).toBe(false);
  });

  it("requires the native notification pilot and rejects ambiguous values", () => {
    expect(resolveMacosNativeNotificationEvidence("1", true)).toBe(true);
    expect(() => resolveMacosNativeNotificationEvidence("1", false)).toThrow(
      "requires HYPE_COMMS_NATIVE_NOTIFICATIONS_ENABLED=1",
    );
    expect(() => resolveMacosNativeNotificationEvidence("true", true)).toThrow(
      "HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_ENABLED must be 0 or 1",
    );
  });
});
