// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateState } from "@hmm-chat/contracts";

import type { DesktopApi } from "../../shared/desktop-api";
import { UpdateControl } from "./App";

type UpdateClient = Pick<
  DesktopApi,
  "getUpdateState" | "checkForUpdates" | "restartToInstallUpdate" | "onUpdateStateChanged"
>;

interface UpdateClientHarness {
  readonly client: UpdateClient;
  readonly emit: (state: UpdateState) => void;
  readonly checkForUpdates: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly restartToInstallUpdate: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function createClient(getUpdateState: () => Promise<UpdateState>): UpdateClientHarness {
  let listener: ((state: UpdateState) => void) | null = null;
  const checkForUpdates = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const restartToInstallUpdate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const client = {
    getUpdateState,
    checkForUpdates,
    restartToInstallUpdate,
    onUpdateStateChanged(nextListener: (state: UpdateState) => void): () => void {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
  } satisfies UpdateClient;

  return {
    client,
    emit(state) {
      listener?.(state);
    },
    checkForUpdates,
    restartToInstallUpdate,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UpdateControl", () => {
  it("does not overwrite a pushed state with a stale hydration response", async () => {
    let resolveInitialState: ((state: UpdateState) => void) | undefined;
    const harness = createClient(
      () =>
        new Promise<UpdateState>((resolve) => {
          resolveInitialState = resolve;
        }),
    );
    render(createElement(UpdateControl, { client: harness.client }));

    act(() => {
      harness.emit({ status: "ready", version: "1.2.3" });
    });
    expect(screen.getByText("Update 1.2.3 ready")).toBeTruthy();

    await act(async () => {
      resolveInitialState?.({ status: "idle" });
    });

    expect(screen.getByText("Update 1.2.3 ready")).toBeTruthy();
  });

  it("offers the ready and error actions", async () => {
    const harness = createClient(() => Promise.resolve({ status: "idle" }));
    render(createElement(UpdateControl, { client: harness.client }));

    act(() => {
      harness.emit({ status: "ready", version: "2.0.0" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(harness.restartToInstallUpdate).toHaveBeenCalledOnce();

    act(() => {
      harness.emit({ status: "error", message: "Could not check for updates. Try again." });
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();
  });
});
