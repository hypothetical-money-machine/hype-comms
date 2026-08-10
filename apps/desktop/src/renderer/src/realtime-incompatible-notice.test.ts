// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeIncompatibleNotice } from "./conversation-health";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-compact");
  vi.restoreAllMocks();
});

describe("RealtimeIncompatibleNotice", () => {
  it.each(["normal", "compact"])("stays readable in %s chrome", (mode) => {
    if (mode === "compact") document.documentElement.dataset.compact = "true";
    const checkForUpdates = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(createElement(RealtimeIncompatibleNotice, { onCheckForUpdates: checkForUpdates }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Your saved position is safe");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(checkForUpdates).toHaveBeenCalledOnce();
  });
});
