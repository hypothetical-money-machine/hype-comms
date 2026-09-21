// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MessageDateSeparator,
  messageDateLabel,
  messageDayKey,
  shouldShowDateSeparator,
} from "./message-date-separator";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("message date separators", () => {
  it("uses local calendar fields across midnight and year boundaries without constructing formatters", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const before = new Date(2025, 11, 31, 23, 59, 59).toISOString();
      const after = new Date(2026, 0, 1, 0, 0, 1).toISOString();
      expect(messageDayKey(before)).toBe("2025-12-31");
      expect(messageDayKey(after)).toBe("2026-01-01");
      expect(shouldShowDateSeparator(after, before)).toBe(true);
      expect(shouldShowDateSeparator(after, after)).toBe(false);
      expect(messageDateLabel(before, new Date(after))).toBe("Yesterday");
      expect(formatter).not.toHaveBeenCalled();
    } finally {
      formatter.mockRestore();
    }
  });

  it("rejects invalid timestamps in both local and explicit timezone paths", () => {
    expect(() => messageDayKey("invalid")).toThrow();
    expect(() => messageDayKey("invalid", "UTC")).toThrow();
  });

  it("uses the viewer's calendar day instead of the UTC date", () => {
    expect(messageDayKey("2026-07-26T06:30:00.000Z", "America/Los_Angeles")).toBe("2026-07-25");
    expect(
      shouldShowDateSeparator(
        "2026-07-26T07:30:00.000Z",
        "2026-07-26T06:30:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe(true);
  });

  it("labels today and yesterday across a daylight-saving transition", () => {
    const now = new Date("2026-03-09T07:30:00.000Z");
    expect(messageDateLabel("2026-03-09T07:15:00.000Z", now, "en-US", "America/Los_Angeles")).toBe(
      "Today",
    );
    expect(messageDateLabel("2026-03-08T08:30:00.000Z", now, "en-US", "America/Los_Angeles")).toBe(
      "Yesterday",
    );
  });

  it("includes the year only when it differs from the current year", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    expect(messageDateLabel("2026-07-20T12:00:00.000Z", now, "en-US", "UTC")).toBe(
      "Monday, July 20",
    );
    expect(messageDateLabel("2025-07-20T12:00:00.000Z", now, "en-US", "UTC")).toBe(
      "Sunday, July 20, 2025",
    );
  });

  it("renders an accessible timeline separator", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 6, 26, 12);
    vi.setSystemTime(now);
    render(createElement(MessageDateSeparator, { value: now.toISOString() }));
    expect(screen.getByRole("separator", { name: "Today" }).textContent).toBe("Today");
  });

  it("refreshes relative labels at the next local midnight", () => {
    vi.useFakeTimers();
    const beforeMidnight = new Date(2026, 6, 26, 23, 59, 59, 900);
    vi.setSystemTime(beforeMidnight);
    render(createElement(MessageDateSeparator, { value: beforeMidnight.toISOString() }));
    expect(screen.getByRole("separator", { name: "Today" }).textContent).toBe("Today");

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.getByRole("separator", { name: "Yesterday" }).textContent).toBe("Yesterday");
  });
});
