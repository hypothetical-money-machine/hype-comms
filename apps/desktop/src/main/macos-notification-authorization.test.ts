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

describe("MacosNotificationAuthorization", () => {
  it("reads and requests strict permission records through the fixed helper command", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"permission":"unknown","version":1}\n' })
      .mockResolvedValueOnce({ stdout: '{"permission":"granted","version":1}\n' });
    const authorization = new MacosNotificationAuthorization({
      executable: "/Applications/Hype Comms.app/Contents/MacOS/hmm-notification-authorization",
      run,
    });

    await expect(authorization.read()).resolves.toEqual({
      nativeSupport: "supported",
      osPermission: "unknown",
    });
    await expect(authorization.request()).resolves.toBe("granted");
    expect(run).toHaveBeenNthCalledWith(1, expect.any(String), ["status"], 300_000);
    expect(run).toHaveBeenNthCalledWith(2, expect.any(String), ["request"], 300_000);
  });

  it("rejects malformed or expanded helper records", async () => {
    const authorization = new MacosNotificationAuthorization({
      executable: "/tmp/helper",
      run: async () => ({
        stdout: '{"permission":"granted","version":1,"content":"unexpected"}\n',
      }),
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

    const run = vi.fn(async () => ({ stdout: '{"permission":"denied","version":1}\n' }));
    const authorization = createMacosNotificationAuthorization({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Hype Comms.app/Contents/Resources",
      run,
    });
    await expect(authorization?.request()).resolves.toBe("denied");
    expect(run).toHaveBeenCalledWith(
      path.resolve("/Applications/Hype Comms.app/Contents/MacOS/hmm-notification-authorization"),
      ["request"],
      300_000,
    );
  });

  it("requests before persisting enable and leaves intent disabled after denial", async () => {
    const deniedState = { ...DISABLED_STATE, osPermission: "denied" } as const;
    const authorization = new MacosNotificationAuthorization({
      executable: "/tmp/helper",
      run: async () => ({ stdout: '{"permission":"denied","version":1}\n' }),
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
      executable: "/tmp/helper",
      run: async () => ({ stdout: '{"permission":"granted","version":1}\n' }),
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
