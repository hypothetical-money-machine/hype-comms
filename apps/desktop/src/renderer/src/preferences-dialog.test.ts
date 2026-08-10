// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ThemePreference, ThemeState } from "@hmm-chat/contracts";
import { createElement, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompactModeTransport,
  DesktopPlatform,
  ThemeTransport,
} from "../../shared/desktop-api";
import { getThemeDefinition } from "../../shared/theme";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { PreferencesDialog } from "./preferences-dialog";
import { ThemeRuntime } from "./theme-runtime";

class PreferencesThemeTransport implements ThemeTransport {
  state: ThemeState = {
    preference: "system",
    resolvedThemeId: "dark",
    resolvedColorScheme: "dark",
  };
  readonly initialThemeState: ThemeState = this.state;
  readonly listeners = new Set<(state: ThemeState) => void>();

  async getThemeState(): Promise<ThemeState> {
    return this.state;
  }

  async setThemePreference(preference: ThemePreference): Promise<ThemeState> {
    const definition = preference === "system" ? null : getThemeDefinition(preference);
    this.state = {
      preference,
      resolvedThemeId: definition?.id ?? "dark",
      resolvedColorScheme: definition?.colorScheme ?? "dark",
    };
    this.emit(this.state);
    return this.state;
  }

  onThemeStateChanged(listener: (state: ThemeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: ThemeState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class PreferencesCompactModeTransport implements CompactModeTransport {
  enabled = false;
  readonly initialCompactMode = this.enabled;
  readonly listeners = new Set<(enabled: boolean) => void>();

  async getCompactMode(): Promise<boolean> {
    return this.enabled;
  }

  async setCompactMode(enabled: boolean): Promise<boolean> {
    this.enabled = enabled;
    for (const listener of this.listeners) listener(enabled);
    return enabled;
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

interface PreferencesHarnessProps {
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly platform: DesktopPlatform;
  readonly onOpenChange: (open: boolean) => void;
}

function PreferencesHarness({
  theme,
  compactMode,
  platform,
  onOpenChange,
}: PreferencesHarnessProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        ref: triggerRef,
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => setOpen(true),
      },
      "Preferences",
    ),
    createElement(PreferencesDialog, {
      open,
      theme,
      compactMode,
      platform,
      triggerRef,
      onClose: () => setOpen(false),
      onOpenChange,
    }),
  );
}

async function renderPreferences() {
  const themeClient = new PreferencesThemeTransport();
  const compactModeClient = new PreferencesCompactModeTransport();
  const theme = new ThemeRuntime(themeClient, document.documentElement);
  const compactMode = new CompactModeRuntime(compactModeClient, document.documentElement);
  await theme.start();
  await compactMode.start();
  const onOpenChange = vi.fn();
  const rendered = render(
    createElement(PreferencesHarness, {
      theme,
      compactMode,
      platform: "linux",
      onOpenChange,
    }),
  );
  return { ...rendered, compactMode, compactModeClient, onOpenChange, theme, themeClient };
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.compact;
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe("PreferencesDialog", () => {
  it("opens from the trigger and closes from its close button", async () => {
    await renderPreferences();
    const trigger = screen.getByRole("button", { name: "Preferences" });

    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Close preferences" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    await renderPreferences();
    const trigger = screen.getByRole("button", { name: "Preferences" });

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close preferences" }));

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps focus from the last control to the first and back again", async () => {
    await renderPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    const first = screen.getByRole("button", { name: "Close preferences" });
    const last = screen.getByRole("checkbox", { name: "Compact mode" });

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on backdrop clicks but not clicks inside the dialog", async () => {
    await renderPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    const backdrop = dialog.parentElement;
    if (backdrop === null) throw new Error("Dialog backdrop was not rendered");

    fireEvent.mouseDown(dialog);
    expect(screen.getByRole("dialog", { name: "Preferences" })).toBeTruthy();
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pins compact chrome while open and releases the pin on close", async () => {
    const { onOpenChange } = await renderPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "Close preferences" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
  });

  it("releases compact chrome pin when unmounted while open", async () => {
    const rendered = await renderPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
    await waitFor(() => expect(rendered.onOpenChange).toHaveBeenCalledWith(true));

    rendered.unmount();
    expect(rendered.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("renders both preference controls and reflects live runtime changes", async () => {
    const { compactModeClient, themeClient } = await renderPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    expect(screen.getByRole("heading", { name: "Appearance", level: 3 })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Layout", level: 3 })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Compact mode" })).toBeTruthy();

    themeClient.emit({
      preference: "light",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
    });
    compactModeClient.emit(true);

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Appearance" }) as HTMLSelectElement).value,
      ).toBe("light");
      expect(
        (screen.getByRole("checkbox", { name: "Compact mode" }) as HTMLInputElement).checked,
      ).toBe(true);
    });
  });
});
