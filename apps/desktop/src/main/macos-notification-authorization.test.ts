import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MacosNotificationAuthorization,
  createMacosNotificationAuthorization,
  setNotificationPreferenceWithAuthorization,
} from "./macos-notification-authorization";

const DISABLED_STATE = {
  version: 1,
  devicePreference: "disabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "unknown",
} as const;

type AuthorizationCallback = (error: unknown, permission: unknown) => void;

function binding(permission: unknown): {
  readonly authorize: (command: "request" | "status", callback: AuthorizationCallback) => void;
} {
  return { authorize: (_command, callback) => callback(null, permission) };
}

describe("MacosNotificationAuthorization", () => {
  it("reads and requests permission through the in-process native binding", async () => {
    const authorize = vi
      .fn()
      .mockImplementationOnce((_command: string, callback: AuthorizationCallback) =>
        callback(null, "unknown"),
      )
      .mockImplementationOnce((_command: string, callback: AuthorizationCallback) =>
        callback(null, "granted"),
      );
    const authorization = new MacosNotificationAuthorization({
      addonPath:
        "/Applications/Hype Comms.app/Contents/Resources/hmm-notification-authorization.node",
      load: () => ({ authorize }),
    });

    await expect(authorization.read()).resolves.toEqual({
      nativeSupport: "supported",
      osPermission: "unknown",
    });
    await expect(authorization.request()).resolves.toBe("granted");
    expect(authorize).toHaveBeenNthCalledWith(1, "status", expect.any(Function));
    expect(authorize).toHaveBeenNthCalledWith(2, "request", expect.any(Function));
  });

  it("rejects malformed binding results and interfaces", async () => {
    expect(
      () =>
        new MacosNotificationAuthorization({
          addonPath: "/tmp/addon.node",
          load: () => ({ authorize: vi.fn(), unexpected: true }),
        }),
    ).toThrow("invalid interface");
    const authorization = new MacosNotificationAuthorization({
      addonPath: "/tmp/addon.node",
      load: () => binding("expanded"),
    });

    await expect(authorization.request()).rejects.toThrow("invalid state");
  });

  it("exists only for packaged macOS and resolves inside the real app bundle", async () => {
    expect(
      createMacosNotificationAuthorization({
        isPackaged: false,
        platform: "darwin",
        resourcesPath: "/Applications/Hype Comms.app/Contents/Resources",
      }),
    ).toBeNull();
    expect(
      createMacosNotificationAuthorization({
        isPackaged: true,
        platform: "linux",
        resourcesPath: "/tmp/resources",
      }),
    ).toBeNull();

    const authorize = vi.fn((_command: string, callback: AuthorizationCallback) =>
      callback(null, "denied"),
    );
    const load = vi.fn(() => ({ authorize }));
    const authorization = createMacosNotificationAuthorization({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Hype Comms.app/Contents/Resources",
      load,
    });
    await expect(authorization?.request()).resolves.toBe("denied");
    expect(load).toHaveBeenCalledWith(
      path.join(
        "/Applications/Hype Comms.app/Contents/Resources",
        "hmm-notification-authorization.node",
      ),
    );
  });

  it("requests before persisting enable and leaves intent disabled after denial", async () => {
    const deniedState = { ...DISABLED_STATE, osPermission: "denied" } as const;
    const authorization = new MacosNotificationAuthorization({
      addonPath: "/tmp/addon.node",
      load: () => binding("denied"),
    });
    const refreshCapability = vi.fn(async () => deniedState);
    const setPreference = vi.fn(async () => ({
      ...deniedState,
      devicePreference: "enabled" as const,
    }));

    await expect(
      setNotificationPreferenceWithAuthorization({
        authorization,
        current: DISABLED_STATE,
        preference: {
          version: 1,
          devicePreference: "enabled",
          contentPreviewPreference: "disabled",
        },
        refreshCapability,
        setPreference,
      }),
    ).resolves.toEqual(deniedState);
    expect(refreshCapability).toHaveBeenCalledOnce();
    expect(setPreference).not.toHaveBeenCalled();
  });

  it("persists enable only after authorization is granted", async () => {
    const authorization = new MacosNotificationAuthorization({
      addonPath: "/tmp/addon.node",
      load: () => binding("granted"),
    });
    const grantedState = { ...DISABLED_STATE, osPermission: "granted" } as const;
    const enabledState = { ...grantedState, devicePreference: "enabled" } as const;
    const setPreference = vi.fn(async () => enabledState);

    await expect(
      setNotificationPreferenceWithAuthorization({
        authorization,
        current: DISABLED_STATE,
        preference: {
          version: 1,
          devicePreference: "enabled",
          contentPreviewPreference: "disabled",
        },
        refreshCapability: async () => grantedState,
        setPreference,
      }),
    ).resolves.toEqual(enabledState);
    expect(setPreference).toHaveBeenCalledOnce();
  });
});
