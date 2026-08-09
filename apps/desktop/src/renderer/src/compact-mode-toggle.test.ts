// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { CompactModeTransport, DesktopPlatform } from "../../shared/desktop-api";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { CompactModeToggle } from "./compact-mode-toggle";

class ToggleCompactModeTransport implements CompactModeTransport {
  enabled = false;
  readonly initialCompactMode: boolean = this.enabled;
  error: Error | null = null;
  readonly calls: boolean[] = [];
  readonly listeners = new Set<(enabled: boolean) => void>();

  async getCompactMode(): Promise<boolean> {
    return this.enabled;
  }

  async setCompactMode(enabled: boolean): Promise<boolean> {
    this.calls.push(enabled);
    if (this.error !== null) throw this.error;
    this.enabled = enabled;
    for (const listener of this.listeners) listener(this.enabled);
    return this.enabled;
  }

  onCompactModeChanged(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(enabled: boolean): void {
    this.enabled = enabled;
    for (const listener of this.listeners) listener(enabled);
  }
}

afterEach(() => {
  cleanup();
});

async function renderToggle(
  client: ToggleCompactModeTransport,
  platform: DesktopPlatform = "linux",
) {
  const compactMode = new CompactModeRuntime(client, document.documentElement);
  await compactMode.start();
  const rendered = render(createElement(CompactModeToggle, { compactMode, platform }));
  return { ...rendered, compactMode };
}

describe("CompactModeToggle", () => {
  it("renders the current state and platform shortcut", async () => {
    const client = new ToggleCompactModeTransport();
    const { compactMode } = await renderToggle(client);

    const checkbox = screen.getByRole("checkbox", { name: "Compact mode" });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Ctrl+Shift+S").tagName).toBe("KBD");
    compactMode.dispose();
  });

  it("shows the darwin shortcut label", async () => {
    const client = new ToggleCompactModeTransport();
    const { compactMode } = await renderToggle(client, "darwin");

    expect(screen.getByText("Cmd+Shift+S")).toBeTruthy();
    compactMode.dispose();
  });

  it("persists a toggle via the runtime", async () => {
    const client = new ToggleCompactModeTransport();
    const { compactMode } = await renderToggle(client);

    fireEvent.click(screen.getByRole("checkbox", { name: "Compact mode" }));

    await waitFor(() => {
      expect(client.calls).toEqual([true]);
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    });
    expect(document.documentElement.dataset.compact).toBe("true");
    compactMode.dispose();
  });

  it("reports a save error and stays focusable while the save is pending", async () => {
    const client = new ToggleCompactModeTransport();
    client.error = new Error("disk full");
    const { compactMode } = await renderToggle(client);

    const checkbox = screen.getByRole("checkbox", { name: "Compact mode" }) as HTMLInputElement;
    fireEvent.click(checkbox);

    // The checkbox is never disabled (that would blur it and lose the user's tab position);
    // re-entrancy is guarded in the change handler, so a second click is ignored mid-save.
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(checkbox);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save the compact mode preference.",
    );
    expect(client.calls).toEqual([true]);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.getAttribute("aria-busy")).toBe("false");
    compactMode.dispose();
  });

  it("clears a stale save error once the preference changes externally", async () => {
    const client = new ToggleCompactModeTransport();
    client.error = new Error("disk full");
    const { compactMode } = await renderToggle(client);

    fireEvent.click(screen.getByRole("checkbox", { name: "Compact mode" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save the compact mode preference.",
    );

    // The keyboard shortcut saves through the same runtime; a later success must not leave the
    // failure alert next to a checkbox that just flipped.
    client.error = null;
    client.emit(true);

    await waitFor(() => {
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByRole("alert")).toBeNull();
    });
    compactMode.dispose();
  });
});
