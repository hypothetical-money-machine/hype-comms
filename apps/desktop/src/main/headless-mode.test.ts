import { describe, expect, it } from "vitest";

import {
  HEADLESS_DESKTOP_CONTENT_HEIGHT,
  HEADLESS_DESKTOP_CONTENT_WIDTH,
  HEADLESS_DESKTOP_CDP_ADDRESS,
  HEADLESS_DESKTOP_SCALE_FACTOR,
  assertHeadlessDesktopCommandLine,
  resolveHeadlessDesktopConfiguration,
  shouldAdvanceReadCursor,
  shouldFocusDesktopWindow,
  shouldShowDesktopWindow,
} from "./headless-mode";

describe("resolveHeadlessDesktopConfiguration", () => {
  it("is disabled unless explicitly requested", () => {
    expect(resolveHeadlessDesktopConfiguration({}, false, "claire")).toBeNull();
  });

  it("returns deterministic automation settings for an isolated development profile", () => {
    expect(
      resolveHeadlessDesktopConfiguration({ HYPE_COMMS_DESKTOP_HEADLESS: "1" }, false, "claire"),
    ).toEqual({
      contentWidth: HEADLESS_DESKTOP_CONTENT_WIDTH,
      contentHeight: HEADLESS_DESKTOP_CONTENT_HEIGHT,
      deviceScaleFactor: HEADLESS_DESKTOP_SCALE_FACTOR,
      disableBackgroundThrottling: true,
      focusOnNavigation: false,
      focusable: false,
    });
  });

  it("rejects unsupported values instead of silently changing the client presentation", () => {
    expect(() =>
      resolveHeadlessDesktopConfiguration({ HYPE_COMMS_DESKTOP_HEADLESS: "true" }, false, "claire"),
    ).toThrow("HYPE_COMMS_DESKTOP_HEADLESS must be set to 1");
  });

  it("allows headless automation only for an unpackaged isolated profile", () => {
    const environment = { HYPE_COMMS_DESKTOP_HEADLESS: "1" };
    expect(() => resolveHeadlessDesktopConfiguration(environment, true, "claire")).toThrow(
      /unpackaged, isolated development profile/,
    );
    expect(() => resolveHeadlessDesktopConfiguration(environment, false, "")).toThrow(
      /unpackaged, isolated development profile/,
    );
  });
});

describe("headless window presentation", () => {
  it("keeps ordinary clients visible and focusable", () => {
    expect(shouldShowDesktopWindow(null)).toBe(true);
    expect(shouldFocusDesktopWindow(null)).toBe(true);
  });

  it("suppresses native visibility and focus for automation clients", () => {
    const configuration = resolveHeadlessDesktopConfiguration(
      { HYPE_COMMS_DESKTOP_HEADLESS: "1" },
      false,
      "woots",
    );
    expect(shouldShowDesktopWindow(configuration)).toBe(false);
    expect(shouldFocusDesktopWindow(configuration)).toBe(false);
    expect(shouldAdvanceReadCursor(configuration)).toBe(false);
  });

  it("leaves privileged read cursors available for ordinary clients", () => {
    expect(shouldAdvanceReadCursor(null)).toBe(true);
  });
});

describe("headless CDP command line", () => {
  it("allows the loopback address in either Chromium switch form", () => {
    expect(() =>
      assertHeadlessDesktopCommandLine([
        `--remote-debugging-address=${HEADLESS_DESKTOP_CDP_ADDRESS}`,
      ]),
    ).not.toThrow();
    expect(() =>
      assertHeadlessDesktopCommandLine([
        "--remote-debugging-address",
        HEADLESS_DESKTOP_CDP_ADDRESS,
      ]),
    ).not.toThrow();
  });

  it("rejects an unsafe remote-debugging address", () => {
    expect(() => assertHeadlessDesktopCommandLine(["--remote-debugging-address=0.0.0.0"])).toThrow(
      `--remote-debugging-address=${HEADLESS_DESKTOP_CDP_ADDRESS}`,
    );
    expect(() => assertHeadlessDesktopCommandLine(["--remote-debugging-address"])).toThrow(
      `--remote-debugging-address=${HEADLESS_DESKTOP_CDP_ADDRESS}`,
    );
  });
});
