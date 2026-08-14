import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MacosNotificationAuthorization,
  createMacosNotificationAuthorization,
  requestAuthorizationForPersistedEnabledPreference,
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

  it("uses a short status timeout without shortening the interactive request timeout", async () => {
    vi.useFakeTimers();
    try {
      const authorization = new MacosNotificationAuthorization({
        addonPath: "/tmp/addon.node",
        load: () => ({ authorize: vi.fn() }),
      });
      const status = authorization.read();
      const request = authorization.request();
      let requestSettled = false;
      void request.then(
        () => {
          requestSettled = true;
        },
        () => {
          requestSettled = true;
        },
      );
      const statusAssertion = expect(status).rejects.toThrow("authorization status timed out");
      const requestAssertion = expect(request).rejects.toThrow("authorization request timed out");

      await vi.advanceTimersByTimeAsync(10_000);
      await statusAssertion;
      expect(requestSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(4 * 60_000 + 50_000);
      await requestAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("exists only for packaged macOS and resolves inside the real app bundle", async () => {
    expect(
      createMacosNotificationAuthorization({
        compiledIn: true,
        isPackaged: false,
        platform: "darwin",
        resourcesPath: "/Applications/Hype Comms.app/Contents/Resources",
      }),
    ).toBeNull();
    expect(
      createMacosNotificationAuthorization({
        compiledIn: true,
        isPackaged: true,
        platform: "linux",
        resourcesPath: "/tmp/resources",
      }),
    ).toBeNull();
    expect(
      createMacosNotificationAuthorization({
        compiledIn: false,
        isPackaged: true,
        platform: "darwin",
        resourcesPath: "/Applications/Hype Comms.app/Contents/Resources",
      }),
    ).toBeNull();

    const authorize = vi.fn((_command: string, callback: AuthorizationCallback) =>
      callback(null, "denied"),
    );
    const load = vi.fn(() => ({ authorize }));
    const authorization = createMacosNotificationAuthorization({
      compiledIn: true,
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

  it("degrades to unavailable when the packaged addon cannot load or has an invalid interface", () => {
    const options = {
      compiledIn: true,
      isPackaged: true,
      platform: "darwin" as const,
      resourcesPath: "/Applications/Hype Comms.app/Contents/Resources",
    };

    expect(
      createMacosNotificationAuthorization({
        ...options,
        load: () => {
          throw new Error("dlopen failed");
        },
      }),
    ).toBeNull();
    expect(
      createMacosNotificationAuthorization({
        ...options,
        load: () => ({ authorize: vi.fn(), unexpected: true }),
      }),
    ).toBeNull();
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

  it("persists an independent preview change without persisting enable after denial", async () => {
    const deniedState = { ...DISABLED_STATE, osPermission: "denied" } as const;
    const previewState = { ...deniedState, contentPreviewPreference: "enabled" } as const;
    const authorization = new MacosNotificationAuthorization({
      addonPath: "/tmp/addon.node",
      load: () => binding("denied"),
    });
    const setPreference = vi.fn(async () => previewState);

    await expect(
      setNotificationPreferenceWithAuthorization({
        authorization,
        current: DISABLED_STATE,
        preference: {
          version: 1,
          devicePreference: "enabled",
          contentPreviewPreference: "enabled",
        },
        refreshCapability: async () => deniedState,
        setPreference,
      }),
    ).resolves.toEqual(previewState);
    expect(setPreference).toHaveBeenCalledWith({
      version: 1,
      devicePreference: "disabled",
      contentPreviewPreference: "enabled",
    });
  });

  it("persists an independent preview change before reporting an authorization error", async () => {
    const authorization = new MacosNotificationAuthorization({
      addonPath: "/tmp/addon.node",
      load: () => ({
        authorize: (_command: string, callback: AuthorizationCallback) =>
          callback("native failure", null),
      }),
    });
    const setPreference = vi.fn(async () => ({
      ...DISABLED_STATE,
      contentPreviewPreference: "enabled" as const,
    }));

    await expect(
      setNotificationPreferenceWithAuthorization({
        authorization,
        current: DISABLED_STATE,
        preference: {
          version: 1,
          devicePreference: "enabled",
          contentPreviewPreference: "enabled",
        },
        refreshCapability: vi.fn(),
        setPreference,
      }),
    ).rejects.toThrow("native failure");
    expect(setPreference).toHaveBeenCalledWith({
      version: 1,
      devicePreference: "disabled",
      contentPreviewPreference: "enabled",
    });
  });

  it("requests unknown permission for a persisted enabled pilot preference", async () => {
    const current = { ...DISABLED_STATE, devicePreference: "enabled" } as const;
    const authorize = vi.fn((_command: string, callback: AuthorizationCallback) =>
      callback(null, "granted"),
    );
    const authorization = new MacosNotificationAuthorization({
      addonPath: "/tmp/addon.node",
      load: () => ({ authorize }),
    });
    const grantedState = { ...current, osPermission: "granted" } as const;
    const refreshCapability = vi.fn(async () => grantedState);

    await expect(
      requestAuthorizationForPersistedEnabledPreference({
        authorization,
        current,
        refreshCapability,
      }),
    ).resolves.toEqual(grantedState);
    expect(authorize).toHaveBeenCalledWith("request", expect.any(Function));
    expect(refreshCapability).toHaveBeenCalledOnce();
  });
});
