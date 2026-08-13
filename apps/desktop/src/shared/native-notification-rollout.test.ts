import { describe, expect, it } from "vitest";

import { resolveNativeNotificationRollout } from "./native-notification-rollout";

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
