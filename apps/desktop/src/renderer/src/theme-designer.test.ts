// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThemeDesign, ThemePreference, ThemeState } from "@hype-comms/contracts";

import type { ThemeTransport } from "../../shared/desktop-api";
import { getThemeDefinition, themeCssVariable } from "../../shared/theme";
import { ThemeDesigner } from "./theme-designer";
import { ThemeRuntime } from "./theme-runtime";

class DesignerThemeTransport implements ThemeTransport {
  state: ThemeState;
  readonly initialThemeState: ThemeState;
  systemState: ThemeState;
  getSystemState: () => Promise<ThemeState>;
  readonly designs: ThemeDesign[] = [];
  readonly listeners = new Set<(state: ThemeState) => void>();
  error: Error | null = null;

  constructor(
    accentColor: string | null = null,
    preference: "system" | "light" | "dark" = "system",
    systemThemeId: "light" | "dark" = "dark",
  ) {
    const activeThemeId = preference === "system" ? systemThemeId : preference;
    this.state = {
      preference,
      resolvedThemeId: activeThemeId,
      resolvedColorScheme: activeThemeId,
      accentColor,
    };
    this.initialThemeState = this.state;
    this.systemState = {
      preference: "system",
      resolvedThemeId: systemThemeId,
      resolvedColorScheme: systemThemeId,
      accentColor,
    };
    this.getSystemState = () => Promise.resolve(this.systemState);
  }

  async getThemeState(): Promise<ThemeState> {
    return this.state;
  }

  getSystemThemeState(): Promise<ThemeState> {
    return this.getSystemState();
  }

  async setThemePreference(preference: ThemePreference): Promise<ThemeState> {
    const definition =
      preference === "system"
        ? getThemeDefinition(this.systemState.resolvedThemeId)
        : getThemeDefinition(preference);
    this.state = {
      preference,
      resolvedThemeId: definition.id,
      resolvedColorScheme: definition.colorScheme,
      accentColor: this.state.accentColor ?? null,
    };
    this.emit();
    return this.state;
  }

  async setThemeDesign(design: ThemeDesign): Promise<ThemeState> {
    this.designs.push(design);
    if (this.error !== null) throw this.error;
    const definition =
      design.preference === "system"
        ? getThemeDefinition(this.systemState.resolvedThemeId)
        : getThemeDefinition(design.preference);
    this.state = {
      preference: design.preference,
      resolvedThemeId: definition.id,
      resolvedColorScheme: definition.colorScheme,
      accentColor: design.accentColor,
    };
    if (design.preference === "system") this.systemState = this.state;
    this.emit();
    return this.state;
  }

  onThemeStateChanged(listener: (state: ThemeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
});

async function renderDesigner(client = new DesignerThemeTransport()) {
  const theme = new ThemeRuntime(client, document.documentElement);
  await theme.start();
  const onCancel = vi.fn();
  const onDirtyChange = vi.fn();
  const onSavingChange = vi.fn();
  const onSaved = vi.fn();
  const rendered = render(
    createElement(ThemeDesigner, {
      theme,
      onCancel,
      onDirtyChange,
      onSavingChange,
      onSaved,
    }),
  );
  return { ...rendered, client, onCancel, onDirtyChange, onSavingChange, onSaved, theme };
}

describe("ThemeDesigner", () => {
  it("offers foundations, presets, a custom color, and a scoped live preview", async () => {
    const { container, client, theme } = await renderDesigner();

    expect(screen.getByRole("radio", { name: /System Match this device/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Light Bright and crisp/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Dark Calm and focused/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Accent presets" })).toBeTruthy();
    expect(screen.getByLabelText("Choose a custom accent")).toBeTruthy();
    expect(screen.getByLabelText("Accent hex value")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "System foundation" })).toBeTruthy();

    const rootBefore = document.documentElement.style.getPropertyValue(
      themeCssVariable("actionPrimary"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rose accent" }));
    expect(client.designs).toEqual([]);
    expect(document.documentElement.style.getPropertyValue(themeCssVariable("actionPrimary"))).toBe(
      rootBefore,
    );
    expect(
      (container.querySelector(".theme-preview") as HTMLElement | null)?.style.getPropertyValue(
        themeCssVariable("actionPrimary"),
      ),
    ).not.toBe(rootBefore);
    theme.dispose();
  });

  it("saves and applies a validated foundation and accent", async () => {
    const { client, onSaved, theme } = await renderDesigner();

    fireEvent.click(screen.getByRole("radio", { name: /Light Bright and crisp/ }));
    fireEvent.click(screen.getByRole("button", { name: "Teal accent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));

    await waitFor(() => {
      expect(client.designs).toEqual([{ preference: "light", accentColor: "#0f766e" }]);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue(themeCssVariable("actionPrimary"))).toBe(
      "#0f766e",
    );
    theme.dispose();
  });

  it("previews the OS foundation when System differs from the active explicit theme", async () => {
    const client = new DesignerThemeTransport(null, "dark", "light");
    const { container, onSaved, theme } = await renderDesigner(client);
    const rootAction = document.documentElement.style.getPropertyValue(
      themeCssVariable("actionPrimary"),
    );

    fireEvent.click(screen.getByRole("radio", { name: /System Match this device/ }));

    await waitFor(() => {
      expect(screen.getByRole("complementary", { name: "System foundation" })).toBeTruthy();
      expect((screen.getByLabelText("Accent hex value") as HTMLInputElement).value).toBe(
        getThemeDefinition("light").tokens.borderAccent,
      );
    });
    const preview = container.querySelector(".theme-preview") as HTMLElement;
    expect(preview.style.colorScheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue(themeCssVariable("actionPrimary"))).toBe(
      rootAction,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
    await waitFor(() => {
      expect(client.designs).toEqual([{ preference: "system", accentColor: null }]);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    theme.dispose();
  });

  it("ignores a stale System resolution after another foundation is selected", async () => {
    const client = new DesignerThemeTransport(null, "dark", "light");
    let resolveSystem: ((state: ThemeState) => void) | undefined;
    client.getSystemState = () =>
      new Promise((resolve) => {
        resolveSystem = resolve;
      });
    const { theme } = await renderDesigner(client);

    fireEvent.click(screen.getByRole("radio", { name: /System Match this device/ }));
    expect(screen.getByText("Matching this device…")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Light Bright and crisp/ }));
    resolveSystem?.(client.systemState);

    await waitFor(() => {
      expect(
        (screen.getByRole("radio", { name: /Light Bright and crisp/ }) as HTMLInputElement).checked,
      ).toBe(true);
    });
    expect(screen.queryByText("Matching this device…")).toBeNull();
    expect(screen.getByRole("complementary", { name: "light foundation" })).toBeTruthy();
    theme.dispose();
  });

  it("rejects malformed accent text without replacing the live theme", async () => {
    const { client, container, theme } = await renderDesigner();
    const input = screen.getByLabelText("Accent hex value");
    fireEvent.click(screen.getByRole("button", { name: "Blue accent" }));
    const validPreview = (
      container.querySelector(".theme-preview") as HTMLElement
    ).style.getPropertyValue(themeCssVariable("actionPrimary"));

    fireEvent.change(input, { target: { value: "not-a-color" } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Enter a six-digit color");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByText("Last valid accent")).toBeTruthy();
    expect(
      (container.querySelector(".theme-preview") as HTMLElement).style.getPropertyValue(
        themeCssVariable("actionPrimary"),
      ),
    ).toBe(validPreview);
    expect(screen.getByRole("button", { name: "Save & apply" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(client.designs).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe("dark");
    theme.dispose();
  });

  it("can restore the foundation's default accent", async () => {
    const client = new DesignerThemeTransport("#be123c");
    const { onSaved, theme } = await renderDesigner(client);

    fireEvent.click(screen.getByRole("button", { name: "Use theme default" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));

    await waitFor(() => {
      expect(client.designs).toEqual([{ preference: "system", accentColor: null }]);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    theme.dispose();
  });

  it("reports persistence failure and keeps the designer open", async () => {
    const client = new DesignerThemeTransport();
    client.error = new Error("disk full");
    const { onSaved, theme } = await renderDesigner(client);

    fireEvent.click(screen.getByRole("button", { name: "Blue accent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Could not save your theme");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save & apply" })).toBeTruthy();
    theme.dispose();
  });
});
