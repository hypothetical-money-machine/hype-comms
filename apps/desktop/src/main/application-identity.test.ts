import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  configureWindowsApplicationIdentity,
  DESKTOP_APPLICATION_ID,
} from "./application-identity";

describe("configureWindowsApplicationIdentity", () => {
  it("sets the packaged application ID on Windows", () => {
    const setAppUserModelId = vi.fn();

    configureWindowsApplicationIdentity({ setAppUserModelId }, "win32");

    expect(setAppUserModelId).toHaveBeenCalledOnce();
    expect(setAppUserModelId).toHaveBeenCalledWith(DESKTOP_APPLICATION_ID);
  });

  it.each(["darwin", "linux"] as const)("does not set Windows identity on %s", (platform) => {
    const setAppUserModelId = vi.fn();

    configureWindowsApplicationIdentity({ setAppUserModelId }, platform);

    expect(setAppUserModelId).not.toHaveBeenCalled();
  });

  it("matches electron-builder's installed application identity", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly build?: { readonly appId?: unknown } };

    expect(packageJson.build?.appId).toBe(DESKTOP_APPLICATION_ID);
  });
});
