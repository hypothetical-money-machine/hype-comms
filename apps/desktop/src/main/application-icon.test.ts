import path from "node:path";

import { describe, expect, it } from "vitest";

import { PACKAGED_APPLICATION_ICON_FILENAME, resolveApplicationIconPath } from "./application-icon";

describe("application icon", () => {
  it("uses the build source while running from the workspace", () => {
    expect(
      resolveApplicationIconPath({
        appPath: path.join("workspace", "apps", "desktop"),
        isPackaged: false,
        resourcesPath: path.join("ignored", "resources"),
      }),
    ).toBe(path.join("workspace", "apps", "desktop", "build", "icon.png"));
  });

  it("uses the copied runtime resource in a packaged application", () => {
    expect(
      resolveApplicationIconPath({
        appPath: path.join("ignored", "app.asar"),
        isPackaged: true,
        resourcesPath: path.join("Hype Comms.app", "Contents", "Resources"),
      }),
    ).toBe(
      path.join("Hype Comms.app", "Contents", "Resources", PACKAGED_APPLICATION_ICON_FILENAME),
    );
  });
});
