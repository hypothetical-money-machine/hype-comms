// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthCapabilities, ThemeState, UpdateState } from "@hype-comms/contracts";

import { AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE, type DesktopApi } from "../../shared/desktop-api";
import { SignIn } from "./App";
import type { ThemeRuntime } from "./theme-runtime";

const themeState: ThemeState = {
  preference: "system",
  resolvedThemeId: "light",
  resolvedColorScheme: "light",
  accentColor: null,
};

function createTheme(): ThemeRuntime {
  return {
    state: themeState,
    subscribe: () => () => undefined,
    setPreference: async () => themeState,
  } as unknown as ThemeRuntime;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SignIn", () => {
  it("refreshes capabilities and removes AuthKit after an unavailable start failure", async () => {
    const getAuthCapabilities = vi
      .fn<() => Promise<AuthCapabilities>>()
      .mockResolvedValueOnce({ authKit: true, magicLink: true })
      .mockResolvedValueOnce({ authKit: false, magicLink: true });
    const startAuthKitSignIn = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        new Error(
          `Error invoking remote method 'chat:session-start-authkit': Error: ${AUTHKIT_SIGN_IN_UNAVAILABLE_MESSAGE}`,
        ),
      );
    const client = {
      getAuthCapabilities,
      startAuthKitSignIn,
      requestMagicLink: async () => ({ status: "email-sent" }) as const,
      getUpdateState: async (): Promise<UpdateState> => ({ status: "idle" }),
      checkForUpdates: async () => undefined,
      restartToInstallUpdate: async () => undefined,
      onUpdateStateChanged: () => () => undefined,
      getAppVersion: async () => "0.1.30-test",
    } as unknown as DesktopApi;

    render(createElement(SignIn, { client, theme: createTheme() }));

    const authKitButton = await screen.findByRole("button", { name: "Sign in with WorkOS" });
    fireEvent.click(authKitButton);

    await waitFor(() => {
      expect(getAuthCapabilities).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("button", { name: "Sign in with WorkOS" })).toBeNull();
    });
    expect(startAuthKitSignIn).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
  });
});
