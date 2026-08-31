// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NotificationActionDrainResponse,
  NotificationContext,
  NotificationPreference,
  NotificationState,
  ThemeDesign,
  ThemePreference,
  ThemeState,
  User,
} from "@hype-comms/contracts";
import { createElement, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CompactModeTransport,
  DesktopPlatform,
  NotificationTransport,
  ThemeTransport,
} from "../../shared/desktop-api";
import { getThemeDefinition } from "../../shared/theme";
import { CompactModeRuntime } from "./compact-mode-runtime";
import { FencedBlockquoteRuntime } from "./fenced-blockquote-runtime";
import { PreferencesPage, type PreferencesPageHandle } from "./preferences-page";
import { SidebarPositionRuntime } from "./sidebar-position-runtime";
import { ThemeRuntime } from "./theme-runtime";

class PreferencesThemeTransport implements ThemeTransport {
  state: ThemeState = {
    preference: "system",
    resolvedThemeId: "dark",
    resolvedColorScheme: "dark",
  };
  readonly initialThemeState: ThemeState = this.state;
  readonly listeners = new Set<(state: ThemeState) => void>();
  designGate: Promise<void> | null = null;

  async getThemeState(): Promise<ThemeState> {
    return this.state;
  }

  async getSystemThemeState(): Promise<ThemeState> {
    return {
      preference: "system",
      resolvedThemeId: this.state.resolvedThemeId,
      resolvedColorScheme: this.state.resolvedColorScheme,
      accentColor: this.state.accentColor ?? null,
    };
  }

  async setThemePreference(preference: ThemePreference): Promise<ThemeState> {
    const definition = preference === "system" ? null : getThemeDefinition(preference);
    this.state = {
      preference,
      resolvedThemeId: definition?.id ?? "dark",
      resolvedColorScheme: definition?.colorScheme ?? "dark",
      accentColor: this.state.accentColor ?? null,
    };
    this.emit(this.state);
    return this.state;
  }

  async setThemeDesign(design: ThemeDesign): Promise<ThemeState> {
    if (this.designGate !== null) await this.designGate;
    const definition =
      design.preference === "system" ? null : getThemeDefinition(design.preference);
    this.state = {
      preference: design.preference,
      resolvedThemeId: definition?.id ?? this.state.resolvedThemeId,
      resolvedColorScheme: definition?.colorScheme ?? this.state.resolvedColorScheme,
      accentColor: design.accentColor,
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

class PreferencesNotificationTransport implements NotificationTransport {
  state: NotificationState = {
    version: 1,
    devicePreference: "disabled",
    contentPreviewPreference: "disabled",
    nativeSupport: "supported",
    osPermission: "granted",
  };
  readonly listeners = new Set<(state: NotificationState) => void>();
  getStateCalls = 0;
  subscribeCalls = 0;

  async getNotificationState(): Promise<NotificationState> {
    this.getStateCalls += 1;
    return this.state;
  }

  async setNotificationPreference(preference: NotificationPreference): Promise<NotificationState> {
    this.state = { ...this.state, ...preference };
    this.emit();
    return this.state;
  }

  async refreshNotificationCapability(): Promise<NotificationState> {
    return this.state;
  }

  onNotificationStateChanged(listener: (state: NotificationState) => void): () => void {
    this.subscribeCalls += 1;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getNotificationContext(): Promise<NotificationContext> {
    throw new Error("Preferences do not read notification session context");
  }

  async reportNotificationActivity(): Promise<void> {
    throw new Error("Preferences do not report notification activity");
  }

  async drainNotificationActions(): Promise<NotificationActionDrainResponse> {
    throw new Error("Preferences do not drain notification actions");
  }

  async acknowledgeNotificationAction(): Promise<void> {
    throw new Error("Preferences do not acknowledge notification actions");
  }

  onNotificationAction(): () => void {
    throw new Error("Preferences do not subscribe to notification actions");
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

interface PreferencesHarnessProps {
  readonly theme: ThemeRuntime;
  readonly compactMode: CompactModeRuntime;
  readonly fencedBlockquotes: FencedBlockquoteRuntime;
  readonly sidebarPosition: SidebarPositionRuntime;
  readonly notifications?: NotificationTransport;
  readonly platform: DesktopPlatform;
  readonly currentUser: User;
  readonly onUpdateProfile: (title: string | null) => Promise<void>;
  readonly onNavigationResult?: (allowed: boolean) => void;
}

function PreferencesHarness({
  theme,
  compactMode,
  fencedBlockquotes,
  sidebarPosition,
  notifications,
  platform,
  currentUser,
  onUpdateProfile,
  onNavigationResult,
}: PreferencesHarnessProps) {
  const [active, setActive] = useState(false);
  const page = useRef<PreferencesPageHandle>(null);

  const requestNavigation = async (leavePage: boolean): Promise<void> => {
    const allowed = (await page.current?.requestNavigationAway()) ?? true;
    onNavigationResult?.(allowed);
    if (allowed && leavePage) setActive(false);
  };

  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        "aria-current": active ? "page" : undefined,
        onClick: () => setActive(true),
      },
      "Preferences",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => void requestNavigation(true),
      },
      "Open conversation",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => void requestNavigation(false),
      },
      "Check navigation",
    ),
    createElement(PreferencesPage, {
      ref: page,
      active,
      theme,
      compactMode,
      fencedBlockquotes,
      sidebarPosition,
      notifications,
      platform,
      currentUser,
      onUpdateProfile,
    }),
  );
}

function makeUser(title: string | null = null): User {
  return {
    id: "user-1",
    kind: "human",
    username: "alice",
    displayName: "Alice",
    avatarUrl: null,
    title,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

interface RenderPreferencesOptions {
  readonly notifications?: NotificationTransport;
  readonly currentUser?: User;
  readonly onUpdateProfile?: (title: string | null) => Promise<void>;
  readonly onNavigationResult?: (allowed: boolean) => void;
}

async function renderPreferences({
  notifications,
  currentUser = makeUser(),
  onUpdateProfile = vi.fn().mockResolvedValue(undefined),
  onNavigationResult,
}: RenderPreferencesOptions = {}) {
  const themeClient = new PreferencesThemeTransport();
  const compactModeClient = new PreferencesCompactModeTransport();
  const theme = new ThemeRuntime(themeClient, document.documentElement);
  const compactMode = new CompactModeRuntime(compactModeClient, document.documentElement);
  const fencedBlockquotes = new FencedBlockquoteRuntime(null);
  const sidebarPosition = new SidebarPositionRuntime(document.documentElement, null);
  await theme.start();
  await compactMode.start();
  const rendered = render(
    createElement(PreferencesHarness, {
      theme,
      compactMode,
      fencedBlockquotes,
      sidebarPosition,
      notifications,
      platform: "linux",
      currentUser,
      onUpdateProfile,
      onNavigationResult,
    }),
  );
  return {
    ...rendered,
    compactMode,
    compactModeClient,
    fencedBlockquotes,
    sidebarPosition,
    theme,
    themeClient,
  };
}

function openPreferences(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
  return screen.getByTestId("preferences-page");
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.compact;
  delete document.documentElement.dataset.sidebarPosition;
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe("PreferencesPage", () => {
  it("does not hydrate notification settings until Preferences is open", async () => {
    const notifications = new PreferencesNotificationTransport();
    await renderPreferences({ notifications });

    expect(notifications.getStateCalls).toBe(0);
    expect(notifications.subscribeCalls).toBe(0);

    openPreferences();
    await waitFor(() => expect(notifications.getStateCalls).toBe(1));
    expect(notifications.subscribeCalls).toBe(1);
  });

  it("renders as a workspace page instead of a dialog", async () => {
    await renderPreferences();
    const trigger = screen.getByRole("button", { name: "Preferences" });
    const page = screen.getByTestId("preferences-page");

    expect(page.hidden).toBe(true);
    expect(trigger.getAttribute("aria-current")).toBeNull();

    openPreferences();
    expect(page.hidden).toBe(false);
    expect(trigger.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Preferences" })).toBeNull();
    expect(page.getAttribute("aria-modal")).toBeNull();
  });

  it("renders every preference section and reflects live runtime changes", async () => {
    const { compactModeClient, fencedBlockquotes, sidebarPosition, themeClient } =
      await renderPreferences();
    openPreferences();

    expect(screen.getByRole("heading", { name: "Profile", level: 3 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appearance", level: 3 })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Layout", level: 3 })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Sidebar position" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Left" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Compact mode" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Messages", level: 3 })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Fenced blockquotes" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Off" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("heading", { name: "Notifications", level: 3 })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Notifications are unavailable in this build.",
    );

    themeClient.emit({
      preference: "light",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
    });
    compactModeClient.emit(true);
    sidebarPosition.setPosition("right");
    fireEvent.click(screen.getByRole("radio", { name: '"""' }));
    expect(fencedBlockquotes.mode).toBe("double-quote");

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Appearance" }) as HTMLSelectElement).value,
      ).toBe("light");
      expect(
        (screen.getByRole("checkbox", { name: "Compact mode" }) as HTMLInputElement).checked,
      ).toBe(true);
      expect((screen.getByRole("radio", { name: "Right" }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole("radio", { name: '"""' }) as HTMLInputElement).checked).toBe(true);
    });
  });

  it("keeps the theme designer in the page and returns with its back control", async () => {
    await renderPreferences();
    const page = openPreferences();

    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));
    expect(screen.getByRole("heading", { name: "Theme designer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to preferences" })).toBeTruthy();
    expect(screen.getByText("Live preview")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Theme designer" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to preferences" }));
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy();
    expect(screen.queryByText("Live preview")).toBeNull();
    expect(page.hidden).toBe(false);
  });

  it("keeps a clean designer open until navigation changes the page", async () => {
    const onNavigationResult = vi.fn();
    await renderPreferences({ onNavigationResult });
    const page = openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));

    fireEvent.click(screen.getByRole("button", { name: "Check navigation" }));
    await waitFor(() => expect(onNavigationResult).toHaveBeenCalledWith(true));
    expect(screen.getByRole("heading", { name: "Theme designer" })).toBeTruthy();
    expect(page.hidden).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    await waitFor(() => expect(page.hidden).toBe(true));
    openPreferences();
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy();
  });

  it("confirms before discarding a draft to leave the page", async () => {
    await renderPreferences();
    const page = openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Rose accent" }));

    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    const warning = screen.getByRole("alertdialog", { name: "Discard your changes?" });
    expect(warning).toBeTruthy();
    expect(page.getAttribute("aria-hidden")).toBe("true");
    expect(page.hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Theme designer" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(page.hidden).toBe(true));
  });

  it("settles a repeated navigation request without replacing its first resolver", async () => {
    const onNavigationResult = vi.fn();
    await renderPreferences({ onNavigationResult });
    openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Rose accent" }));

    const openConversation = screen.getByRole("button", { name: "Open conversation" });
    fireEvent.click(openConversation);
    fireEvent.click(openConversation);
    expect(screen.getByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(onNavigationResult).toHaveBeenCalledTimes(2));
    expect(onNavigationResult.mock.calls.map(([allowed]) => allowed)).toEqual([false, true]);
  });

  it("uses Escape to return a clean designer to Preferences", async () => {
    await renderPreferences();
    openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Design a theme" }));
  });

  it("uses Escape to confirm a dirty designer before returning", async () => {
    await renderPreferences();
    openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Rose accent" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Theme designer" })).toBeTruthy();
  });

  it("does not leave while a theme save is in flight", async () => {
    const { themeClient } = await renderPreferences();
    let releaseSave: (() => void) | undefined;
    themeClient.designGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const setThemeDesign = vi.spyOn(themeClient, "setThemeDesign");
    const page = openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Design a theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Rose accent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving…" }).getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(
        screen.getByRole("button", { name: "Back to preferences" }).hasAttribute("disabled"),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(page.hidden).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(setThemeDesign).toHaveBeenCalledTimes(1);

    releaseSave?.();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy());
  });

  it("shows notification controls when the desktop bridge supports them", async () => {
    await renderPreferences({ notifications: new PreferencesNotificationTransport() });
    openPreferences();

    expect(await screen.findByRole("checkbox", { name: /Enable notifications/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Show message previews/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh capability" })).toBeTruthy();
  });

  it("renders and saves a trimmed profile title", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    await renderPreferences({ currentUser: makeUser("Engineering Lead"), onUpdateProfile });
    openPreferences();

    expect(screen.getByText("Engineering Lead")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "  Design Lead  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdateProfile).toHaveBeenCalledWith("Design Lead"));
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("clears a profile title", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    await renderPreferences({ currentUser: makeUser("Engineering Lead"), onUpdateProfile });
    openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(onUpdateProfile).toHaveBeenCalledWith(null));
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("surfaces validation and server errors when saving a profile title", async () => {
    const onUpdateProfile = vi.fn().mockRejectedValue(new Error("Network error"));
    await renderPreferences({ onUpdateProfile });
    openPreferences();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Title" });

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Title must be 1–160 characters",
    );

    fireEvent.change(input, { target: { value: "a".repeat(161) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Title must be 1–160 characters"),
    );
    expect(onUpdateProfile).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Engineering Lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Network error");
  });
});
