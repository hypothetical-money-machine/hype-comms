// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AuthCapabilities,
  ProtocolHandlerState,
  ThemeState,
  UpdateState,
} from "@hype-comms/contracts";

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

function createClient(overrides: Record<string, unknown> = {}): DesktopApi {
  return {
    getAuthCapabilities: async (): Promise<AuthCapabilities> => ({
      authKit: true,
      magicLink: true,
    }),
    startAuthKitSignIn: async () => undefined,
    requestMagicLink: async () => ({ status: "email-sent" }) as const,
    getUpdateState: async (): Promise<UpdateState> => ({ status: "idle" }),
    checkForUpdates: async () => undefined,
    restartToInstallUpdate: async () => undefined,
    onUpdateStateChanged: () => () => undefined,
    getAppVersion: async () => "0.1.30-test",
    ...overrides,
  } as unknown as DesktopApi;
}

const PROTOCOL_WARNING_TEXT = /link handler\s+is not registered on this system/;

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

  it("warns when the auth URL scheme is confirmed unbound", async () => {
    const client = createClient({
      getProtocolHandlerState: async (): Promise<ProtocolHandlerState> => ({
        scheme: "hype-comms",
        binding: "unbound",
      }),
    });

    render(createElement(SignIn, { client, theme: createTheme() }));

    await waitFor(() => {
      const warning = screen.getByRole("status");
      expect(warning.textContent).toMatch(PROTOCOL_WARNING_TEXT);
      expect(warning.textContent).toContain("hype-comms://");
    });
  });

  it.each(["bound", "unknown"] as const)("stays quiet when the binding is %s", async (binding) => {
    const client = createClient({
      getProtocolHandlerState: async (): Promise<ProtocolHandlerState> => ({
        scheme: "hype-comms",
        binding,
      }),
    });

    render(createElement(SignIn, { client, theme: createTheme() }));

    await screen.findByRole("button", { name: "Sign in with WorkOS" });
    expect(screen.queryByText(PROTOCOL_WARNING_TEXT)).toBeNull();
  });

  it("stays quiet when the bridge does not expose the protocol-handler probe", async () => {
    render(createElement(SignIn, { client: createClient(), theme: createTheme() }));

    await screen.findByRole("button", { name: "Sign in with WorkOS" });
    expect(screen.queryByText(PROTOCOL_WARNING_TEXT)).toBeNull();
  });

  it("announces a failed WorkOS start with its network diagnostic", async () => {
    const client = createClient({
      startAuthKitSignIn: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'chat:session-start-authkit': Error: Could not reach the authentication service (net::ERR_SSL_KEY_USAGE_INCOMPATIBLE)",
          ),
        ),
    });

    render(createElement(SignIn, { client, theme: createTheme() }));

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with WorkOS" }));

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("net::ERR_SSL_KEY_USAGE_INCOMPATIBLE");
    });
  });
});
