import { describe, expect, it, vi } from "vitest";

import { configureApplicationIdentity, shouldMigrateLegacyProfile } from "./application-identity";

const developmentIdentity = {
  appId: "com.hypemm.hypecomms.dev",
  desktopName: "hype-comms-dev",
  isProductionBuild: false,
  productName: "Hype Comms DEV",
} as const;

const productionIdentity = {
  appId: "com.hypemm.hypecomms",
  desktopName: "com.hypemm.hypecomms.desktop",
  isProductionBuild: true,
  productName: "Hype Comms",
} as const;

describe("configureApplicationIdentity", () => {
  it("sets the selected product name and Windows application ID", () => {
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();
    const setDesktopName = vi.fn();

    configureApplicationIdentity(
      { setAppUserModelId, setDesktopName, setName },
      "win32",
      developmentIdentity,
    );

    expect(setName).toHaveBeenCalledOnce();
    expect(setName).toHaveBeenCalledWith("Hype Comms DEV");
    expect(setAppUserModelId).toHaveBeenCalledOnce();
    expect(setAppUserModelId).toHaveBeenCalledWith("com.hypemm.hypecomms.dev");
    expect(setDesktopName).not.toHaveBeenCalled();
  });

  it("sets the DEV product and desktop names on Linux", () => {
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();
    const setDesktopName = vi.fn();

    configureApplicationIdentity(
      { setAppUserModelId, setDesktopName, setName },
      "linux",
      developmentIdentity,
    );

    expect(setName).toHaveBeenCalledWith("Hype Comms DEV");
    expect(setDesktopName).toHaveBeenCalledWith("hype-comms-dev");
    expect(setAppUserModelId).not.toHaveBeenCalled();
  });

  it("sets only the DEV product name on macOS", () => {
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();
    const setDesktopName = vi.fn();

    configureApplicationIdentity(
      { setAppUserModelId, setDesktopName, setName },
      "darwin",
      developmentIdentity,
    );

    expect(setName).toHaveBeenCalledWith("Hype Comms DEV");
    expect(setAppUserModelId).not.toHaveBeenCalled();
    expect(setDesktopName).not.toHaveBeenCalled();
  });

  it("preserves the released production package name and sets its Linux desktop name", () => {
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();
    const setDesktopName = vi.fn();

    configureApplicationIdentity(
      { setAppUserModelId, setDesktopName, setName },
      "linux",
      productionIdentity,
    );

    expect(setName).not.toHaveBeenCalled();
    expect(setAppUserModelId).not.toHaveBeenCalled();
    expect(setDesktopName).toHaveBeenCalledWith("com.hypemm.hypecomms.desktop");
  });

  it("preserves the released production package name and sets its Windows identity", () => {
    const setName = vi.fn();
    const setAppUserModelId = vi.fn();
    const setDesktopName = vi.fn();

    configureApplicationIdentity(
      { setAppUserModelId, setDesktopName, setName },
      "win32",
      productionIdentity,
    );

    expect(setName).not.toHaveBeenCalled();
    expect(setAppUserModelId).toHaveBeenCalledWith("com.hypemm.hypecomms");
    expect(setDesktopName).not.toHaveBeenCalled();
  });
});

describe("shouldMigrateLegacyProfile", () => {
  it("allows only the packaged production application to adopt the stable legacy profile", () => {
    expect(
      shouldMigrateLegacyProfile({
        isPackaged: true,
        isProductionBuild: true,
        isNativeNotificationEvidence: false,
      }),
    ).toBe(true);
  });

  it.each([
    [
      "a DEV build",
      {
        isPackaged: true,
        isProductionBuild: false,
        isNativeNotificationEvidence: false,
      },
    ],
    [
      "an unpackaged app",
      {
        isPackaged: false,
        isProductionBuild: true,
        isNativeNotificationEvidence: false,
      },
    ],
    [
      "native notification evidence",
      {
        isPackaged: true,
        isProductionBuild: true,
        isNativeNotificationEvidence: true,
      },
    ],
  ] as const)("skips migration for %s", (_description, context) => {
    expect(shouldMigrateLegacyProfile(context)).toBe(false);
  });
});
