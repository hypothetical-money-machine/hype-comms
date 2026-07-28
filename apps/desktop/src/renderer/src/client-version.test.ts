// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientVersion } from "./client-version";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClientVersion", () => {
  it("shows the exact version reported by the running desktop client", async () => {
    const getAppVersion = vi.fn().mockResolvedValue("2.4.1");
    render(createElement(ClientVersion, { client: { getAppVersion } }));

    expect(screen.getByText("HMM Chat · checking version…")).toBeTruthy();
    expect(await screen.findByText("HMM Chat · v2.4.1")).toBeTruthy();
    expect(getAppVersion).toHaveBeenCalledOnce();
  });

  it("does not update after unmounting while the version request is pending", async () => {
    let resolveVersion: ((value: string) => void) | undefined;
    const getAppVersion = () =>
      new Promise<string>((resolve) => {
        resolveVersion = resolve;
      });
    const rendered = render(createElement(ClientVersion, { client: { getAppVersion } }));
    rendered.unmount();

    await act(async () => resolveVersion?.("9.9.9"));
    expect(screen.queryByText("HMM Chat · v9.9.9")).toBeNull();
  });

  it("keeps a useful fallback visible if the version cannot be read", async () => {
    const getAppVersion = vi.fn().mockRejectedValue(new Error("IPC unavailable"));
    render(createElement(ClientVersion, { client: { getAppVersion } }));

    expect(await screen.findByText("HMM Chat · version unavailable")).toBeTruthy();
  });
});
