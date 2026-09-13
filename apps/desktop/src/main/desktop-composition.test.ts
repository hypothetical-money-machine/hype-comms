import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Existing lifecycle checks stay until the session-ownership refactor adds behavioral coverage.
const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
describe("desktop composition", () => {
  it("shows the window and starts authorization without blocking session restore", () => {
    const createWindow = mainSource.indexOf("await createMainWindow();");
    const requestAuthorization = mainSource.indexOf(
      "void settlePendingNotificationAuthorization({",
    );
    const restoreSession = mainSource.indexOf("await chatSession.restore();");
    expect(createWindow).toBeGreaterThan(-1);
    expect(requestAuthorization).toBeGreaterThan(createWindow);
    expect(restoreSession).toBeGreaterThan(requestAuthorization);
  });
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
  it("retires the local AI worker when a passive session transition signs the user out", () => {
    const deliveryStart = mainSource.indexOf("function deliverSessionState(");
    const deliveryEnd = mainSource.indexOf("function deliverNotificationState(", deliveryStart);
    const delivery = mainSource.slice(deliveryStart, deliveryEnd);

    expect(deliveryStart).toBeGreaterThanOrEqual(0);
    expect(deliveryEnd).toBeGreaterThan(deliveryStart);
    expect(delivery).toContain('if (state.status !== "signed-in")');
    expect(delivery).toContain("suspendAiChannel();");
    expect(mainSource).toContain("chatSession.subscribe(deliverSessionState)");
  });
});
