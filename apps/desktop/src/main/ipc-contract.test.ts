import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The renderer reaches main only through preload, so a channel the bridge invokes with no matching
 * `ipcMain.handle` is a runtime rejection that nothing else catches: the wire contract, the preload
 * validation, and the transport method can all be correct and typecheck while the handler is simply
 * absent. That happened to conversation paging once already. These tests read both sides of the
 * bridge and compare them directly.
 */

const preloadSource = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function channelsMatching(source: string, pattern: RegExp): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const [, name] = match;
    if (name !== undefined) found.add(name);
  }
  return found;
}

const invoked = channelsMatching(preloadSource, /ipcRenderer\.invoke\(\s*DESKTOP_CHANNELS\.(\w+)/g);
const synchronouslyRequested = channelsMatching(
  preloadSource,
  /ipcRenderer\.sendSync\(\s*DESKTOP_CHANNELS\.(\w+)/g,
);
const subscribed = channelsMatching(preloadSource, /subscribe\(\s*DESKTOP_CHANNELS\.(\w+)/g);
const handled = channelsMatching(mainSource, /ipcMain\.handle\(\s*DESKTOP_CHANNELS\.(\w+)/g);
const removed = channelsMatching(mainSource, /ipcMain\.removeHandler\(\s*DESKTOP_CHANNELS\.(\w+)/g);
const synchronouslyHandled = channelsMatching(
  mainSource,
  /ipcMain\.on\(\s*DESKTOP_CHANNELS\.(\w+)/g,
);
const synchronouslyRemoved = channelsMatching(
  mainSource,
  /ipcMain\.removeAllListeners\(\s*DESKTOP_CHANNELS\.(\w+)/g,
);

function missingFrom(
  source: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): readonly string[] {
  return [...source].filter((channel) => !expected.has(channel)).sort();
}

describe("desktop IPC contract", () => {
  // Without this the patterns could silently match nothing and every assertion below would pass.
  it("reads channels from both sides of the bridge", () => {
    expect(invoked.size).toBeGreaterThan(10);
    expect(handled.size).toBeGreaterThan(10);
    expect(synchronouslyRequested.size).toBeGreaterThan(0);
    expect(subscribed.size).toBeGreaterThan(0);
  });

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

  it("handles every channel the renderer can invoke", () => {
    expect(missingFrom(invoked, handled)).toEqual([]);
  });

  it("invokes every channel the main process handles", () => {
    expect(missingFrom(handled, invoked)).toEqual([]);
  });

  it("pairs each handler with a removeHandler so re-registration stays idempotent", () => {
    expect(missingFrom(handled, removed)).toEqual([]);
  });

  it("guards every handler with the trusted-sender check", () => {
    // A handler that forgets the guard is reachable from any frame the window ever loads, and the
    // wire schemas cannot catch that: they validate the payload, never the caller. A raw count of
    // `isTrustedIpcSender(event)` occurrences compared against the handler count cannot catch a new
    // handler that omits the guard as long as some other handler happens to reference it twice --
    // the count is not tied to any particular handler. So this instead slices the source between
    // one `ipcMain.handle(DESKTOP_CHANNELS...` call and the next (handler registrations here are
    // sequential and never nested, so that slice is exactly one handler's body) and checks the
    // guard appears inside each slice individually.
    const registrationPattern = /ipcMain\.handle\(\s*DESKTOP_CHANNELS\.(\w+)\s*,/g;
    const registrations = [...mainSource.matchAll(registrationPattern)];
    expect(registrations.length).toBe(handled.size);

    const unguarded = registrations
      .map((registration, index) => {
        const channel = registration[1];
        const start = registration.index;
        if (channel === undefined || start === undefined) return null;
        const end = registrations[index + 1]?.index ?? mainSource.length;
        const body = mainSource.slice(start, end);
        return /isTrustedIpcSender\(event\)/.test(body) ? null : channel;
      })
      .filter((channel): channel is string => channel !== null)
      .sort();
    expect(unguarded).toEqual([]);
  });

  it("answers every synchronous preload capability query", () => {
    expect(missingFrom(synchronouslyRequested, synchronouslyHandled)).toEqual([]);
    expect(missingFrom(synchronouslyHandled, synchronouslyRequested)).toEqual([]);
    expect(missingFrom(synchronouslyHandled, synchronouslyRemoved)).toEqual([]);
  });

  it("never registers a request handler for a push-only channel", () => {
    expect([...subscribed].filter((channel) => handled.has(channel)).sort()).toEqual([]);
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
