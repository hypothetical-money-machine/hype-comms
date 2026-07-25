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
const subscribed = channelsMatching(preloadSource, /subscribe\(\s*DESKTOP_CHANNELS\.(\w+)/g);
const handled = channelsMatching(mainSource, /ipcMain\.handle\(\s*DESKTOP_CHANNELS\.(\w+)/g);
const removed = channelsMatching(mainSource, /ipcMain\.removeHandler\(\s*DESKTOP_CHANNELS\.(\w+)/g);

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
    expect(subscribed.size).toBeGreaterThan(0);
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

  it("never registers a request handler for a push-only channel", () => {
    expect([...subscribed].filter((channel) => handled.has(channel)).sort()).toEqual([]);
  });
});
