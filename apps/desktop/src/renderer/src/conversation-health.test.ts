// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationHealth } from "./conversation-health";

afterEach(cleanup);

function renderHealth(overrides: Partial<Parameters<typeof ConversationHealth>[0]> = {}) {
  const props: Parameters<typeof ConversationHealth>[0] = {
    connection: "live",
    stale: false,
    cacheMode: "persistent",
    notice: null,
    onRetry: vi.fn(),
    onResetCache: vi.fn(),
    onCheckForUpdates: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
  return { props, ...render(createElement(ConversationHealth, props)) };
}

describe("ConversationHealth", () => {
  it("stays out of the header when realtime and persistence are healthy", () => {
    const { container } = renderHealth();

    expect(container.childElementCount).toBe(0);
  });

  it.each([
    ["connecting", "Connecting…"],
    ["reconnecting", "Reconnecting…"],
    ["offline", "Offline"],
  ] as const)("renders a concise %s status chip", (connection, label) => {
    renderHealth({ connection });

    expect(screen.getByRole("status").textContent).toBe(label);
  });

  it("summarizes stale and memory-only cache state without suggesting a destructive repair", () => {
    const { props } = renderHealth({ stale: true, cacheMode: "memory_only" });

    expect(screen.getByText(/Showing cached messages/).textContent).toContain(
      "Local history will not be saved",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Reset local cache" })).toBeNull();
  });

  it("announces an actionable runtime notice as an error", () => {
    const { props } = renderHealth({ notice: "The workspace could not sync." });

    expect(screen.getByRole("alert").textContent).toContain("The workspace could not sync.");
    fireEvent.click(screen.getByRole("button", { name: "Reset local cache" }));
    expect(props.onResetCache).toHaveBeenCalledOnce();
  });
});
