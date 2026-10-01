import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Native-addon selection still has source coverage; lifecycle ordering is tested behaviorally.
const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
describe("desktop composition", () => {
  it("fails closed when a packaged Mac cannot load its authorization addon", () => {
    const capabilityFactory = mainSource.slice(
      mainSource.indexOf("function createNotificationCapabilitySource()"),
      mainSource.indexOf("function createNotificationPresenter()"),
    );
    const packagedMacGuard = capabilityFactory.indexOf(
      'if (app.isPackaged && process.platform === "darwin")',
    );
    const electronFallback = capabilityFactory.indexOf(
      "return new ElectronNotificationCapabilitySource(Notification);",
    );
    expect(packagedMacGuard).toBeGreaterThan(-1);
    expect(electronFallback).toBeGreaterThan(packagedMacGuard);
    expect(capabilityFactory.slice(packagedMacGuard, electronFallback)).toContain(
      'nativeSupport: "unsupported", osPermission: "unknown"',
    );
  });
});
