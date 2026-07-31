// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { ThemePreference, ThemeState } from "@hmm-chat/contracts";

import type { ThemeTransport } from "../../shared/desktop-api";
import { getThemeDefinition } from "../../shared/theme";
import { ThemeRuntime } from "./theme-runtime";
import { ThemeSelector } from "./theme-selector";

class SelectorThemeTransport implements ThemeTransport {
  state: ThemeState = {
    preference: "system",
    resolvedThemeId: "dark",
    resolvedColorScheme: "dark",
  };
  readonly initialThemeState: ThemeState = this.state;
  error: Error | null = null;
  readonly preferences: ThemePreference[] = [];
  readonly listeners = new Set<(state: ThemeState) => void>();

  async getThemeState(): Promise<ThemeState> {
    return this.state;
  }

  async setThemePreference(preference: ThemePreference): Promise<ThemeState> {
    this.preferences.push(preference);
    if (this.error !== null) throw this.error;
    if (preference === "system") {
      this.state = {
        preference,
        resolvedThemeId: this.state.resolvedThemeId,
        resolvedColorScheme: this.state.resolvedColorScheme,
      };
    } else {
      const definition = getThemeDefinition(preference);
      this.state = {
        preference,
        resolvedThemeId: definition.id,
        resolvedColorScheme: definition.colorScheme,
      };
    }
    for (const listener of this.listeners) listener(this.state);
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

afterEach(() => {
  cleanup();
});

async function renderSelector(client: SelectorThemeTransport) {
  const theme = new ThemeRuntime(client, document.documentElement);
  await theme.start();
  const rendered = render(createElement(ThemeSelector, { theme }));
  return { ...rendered, theme };
}

describe("ThemeSelector", () => {
  it("offers an accessible system, light, and dark choice", async () => {
    const client = new SelectorThemeTransport();
    const { theme } = await renderSelector(client);

    const select = screen.getByRole("combobox", { name: "Appearance" });
    expect((select as HTMLSelectElement).value).toBe("system");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(screen.getByText("Following system · Dark")).toBeTruthy();
    theme.dispose();
  });

  it("persists a selection and reflects the resolved scheme", async () => {
    const client = new SelectorThemeTransport();
    const { theme } = await renderSelector(client);

    fireEvent.change(screen.getByRole("combobox", { name: "Appearance" }), {
      target: { value: "light" },
    });

    await waitFor(() => {
      expect(client.preferences).toEqual(["light"]);
      expect(screen.getByText("Light theme")).toBeTruthy();
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    theme.dispose();
  });

  it("reflects a live system appearance update", async () => {
    const client = new SelectorThemeTransport();
    const { theme } = await renderSelector(client);

    client.emit({
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
    });

    await waitFor(() => {
      expect(screen.getByText("Following system · Light")).toBeTruthy();
    });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("system");
    theme.dispose();
  });

  it("reports persistence failure and leaves the canonical selection intact", async () => {
    const client = new SelectorThemeTransport();
    client.error = new Error("disk full");
    const { theme } = await renderSelector(client);

    fireEvent.change(screen.getByRole("combobox", { name: "Appearance" }), {
      target: { value: "light" },
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save the appearance preference.",
    );
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("system");
    theme.dispose();
  });
});
