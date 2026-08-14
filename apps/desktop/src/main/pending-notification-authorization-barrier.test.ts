import type { NotificationState } from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import type { NotificationSettingsPort } from "./notification-controller";
import {
  PendingNotificationAuthorizationBarrier,
  settlePendingNotificationAuthorization,
} from "./pending-notification-authorization-barrier";

const UNKNOWN_STATE: NotificationState = {
  version: 1,
  devicePreference: "enabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "unknown",
};

describe("PendingNotificationAuthorizationBarrier", () => {
  it("ignores late authorization and source settlement after disposal", async () => {
    let sourceDisposed = false;
    let sourceListener: ((state: NotificationState) => void) | undefined;
    const stopSourceSubscription = vi.fn();
    const source: NotificationSettingsPort = {
      get state() {
        if (sourceDisposed) throw new Error("source is disposed");
        return UNKNOWN_STATE;
      },
      markPresenterFailure: () => UNKNOWN_STATE,
      subscribe: (listener) => {
        sourceListener = listener;
        return stopSourceSubscription;
      },
    };
    const barrier = new PendingNotificationAuthorizationBarrier({
      source,
      authorizationPending: true,
    });
    let resolveAuthorization: (() => void) | undefined;
    const authorizationSettlement = settlePendingNotificationAuthorization({
      request: () =>
        new Promise<void>((resolve) => {
          resolveAuthorization = resolve;
        }),
      barrier,
      onFailure: vi.fn(),
    });

    barrier.dispose();
    sourceDisposed = true;
    expect(stopSourceSubscription).toHaveBeenCalledOnce();
    expect(() => sourceListener?.(UNKNOWN_STATE)).not.toThrow();

    resolveAuthorization?.();
    await expect(authorizationSettlement).resolves.toBeUndefined();
    barrier.dispose();
    expect(stopSourceSubscription).toHaveBeenCalledOnce();
  });
});
