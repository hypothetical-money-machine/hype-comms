// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  devicePreferencesSchema,
  type DevicePreferences,
  type DevicePreferencesPatch,
} from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceAccessibilityPreferences,
  DeviceComposerPreferences,
  DeviceLayoutPreferences,
  DeviceMessagePreferences,
  type DevicePreferencesControlRuntime,
} from "./device-preferences-controls";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences";

class PreferencesRuntime implements DevicePreferencesControlRuntime {
  state: DevicePreferences = DEFAULT_DEVICE_PREFERENCES;
  readonly listeners = new Set<() => void>();
  readonly updates: DevicePreferencesPatch[] = [];
  updateError: Error | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: DevicePreferencesPatch): Promise<DevicePreferences> {
    this.updates.push(patch);
    if (this.updateError !== null) throw this.updateError;
    this.state = devicePreferencesSchema.parse({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
    return this.state;
  }
}

function renderControls(
  runtime = new PreferencesRuntime(),
  platform: "darwin" | "linux" = "linux",
) {
  return {
    runtime,
    ...render(
      <>
        <DeviceLayoutPreferences runtime={runtime} />
        <DeviceMessagePreferences runtime={runtime} />
        <DeviceComposerPreferences runtime={runtime} platform={platform} />
        <DeviceAccessibilityPreferences runtime={runtime} />
      </>,
    ),
  };
}

afterEach(cleanup);

describe("device preference controls", () => {
  it("renders every preference with an accessible label and current value", () => {
    renderControls(new PreferencesRuntime(), "darwin");

    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Sidebar width" }).value).toBe(
      "default",
    );
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Message text size" }).value,
    ).toBe("default");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Time format" }).value).toBe(
      "system",
    );
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Group consecutive messages" })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Always show grouped message times",
      }).checked,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Show profile titles" }).checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Send messages with" }).value,
    ).toBe("enter");
    expect(screen.getByRole("option", { name: "Command + Enter" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Check spelling" }).checked).toBe(
      true,
    );
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Motion" }).value).toBe(
      "system",
    );
  });

  it("saves select and toggle changes as narrow patches", async () => {
    const { runtime } = renderControls();
    const width = screen.getByRole<HTMLSelectElement>("combobox", { name: "Sidebar width" });
    const grouping = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Group consecutive messages",
    });

    fireEvent.change(width, { target: { value: "wide" } });
    await waitFor(() => expect(width.value).toBe("wide"));
    fireEvent.click(grouping);
    await waitFor(() => expect(grouping.checked).toBe(false));

    expect(runtime.updates).toEqual([
      { sidebarWidth: "wide" },
      { groupConsecutiveMessages: false },
    ]);
  });

  it("keeps the confirmed value and reports a failed save without disabling the control", async () => {
    const runtime = new PreferencesRuntime();
    runtime.updateError = new Error("disk unavailable");
    renderControls(runtime);
    const spellCheck = screen.getByRole<HTMLInputElement>("checkbox", { name: "Check spelling" });

    spellCheck.focus();
    fireEvent.click(spellCheck);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save the spell check preference.",
    );
    expect(spellCheck.checked).toBe(true);
    expect(spellCheck.disabled).toBe(false);
    expect(spellCheck.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(spellCheck);
  });

  it("disables only the active control while its save is pending", async () => {
    const runtime = new PreferencesRuntime();
    let finishSave: (() => void) | undefined;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const update = vi.spyOn(runtime, "update").mockImplementation(async (patch) => {
      runtime.updates.push(patch);
      await pendingSave;
      runtime.state = devicePreferencesSchema.parse({ ...runtime.state, ...patch });
      for (const listener of runtime.listeners) listener();
      return runtime.state;
    });
    renderControls(runtime);
    const textSize = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Message text size",
    });
    const width = screen.getByRole<HTMLSelectElement>("combobox", { name: "Sidebar width" });

    fireEvent.change(textSize, { target: { value: "large" } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(textSize.value).toBe("large");
    expect(textSize.closest(".device-preference-row")?.getAttribute("aria-busy")).toBe("true");
    expect(textSize.disabled).toBe(true);
    expect(width.disabled).toBe(false);

    finishSave?.();
    await waitFor(() => {
      expect(textSize.value).toBe("large");
      expect(textSize.disabled).toBe(false);
    });
  });
});
