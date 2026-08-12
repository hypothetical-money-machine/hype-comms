// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NotificationAction,
  NotificationActionAcknowledgement,
  NotificationActionDrainRequest,
  NotificationActionDrainResponse,
  NotificationActivityUpdate,
  NotificationContext,
  NotificationPreference,
  NotificationState,
} from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NotificationTransport } from "../../shared/desktop-api";
import { NotificationSettings } from "./notification-settings";

const DEFAULT_STATE: NotificationState = {
  version: 1,
  devicePreference: "disabled",
  contentPreviewPreference: "disabled",
  nativeSupport: "supported",
  osPermission: "unknown",
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeNotificationTransport implements NotificationTransport {
  state: NotificationState = DEFAULT_STATE;
  getResult: NotificationState | Promise<NotificationState> = this.state;
  readonly setResults: (NotificationState | Promise<NotificationState>)[] = [];
  readonly refreshResults: (NotificationState | Promise<NotificationState>)[] = [];
  readonly preferences: NotificationPreference[] = [];
  readonly listeners = new Set<(state: NotificationState) => void>();
  getCalls = 0;
  refreshCalls = 0;

  async getNotificationState(): Promise<NotificationState> {
    this.getCalls += 1;
    return await this.getResult;
  }

  async setNotificationPreference(preference: NotificationPreference): Promise<NotificationState> {
    this.preferences.push(preference);
    const result = this.setResults.shift();
    if (result === undefined) throw new Error("No notification preference result was queued");
    return await result;
  }

  async refreshNotificationCapability(): Promise<NotificationState> {
    this.refreshCalls += 1;
    const result = this.refreshResults.shift();
    if (result === undefined) throw new Error("No notification capability result was queued");
    return await result;
  }

  onNotificationStateChanged(listener: (state: NotificationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: NotificationState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  async getNotificationContext(): Promise<NotificationContext> {
    throw new Error("Notification settings do not read session context");
  }

  async reportNotificationActivity(activity: NotificationActivityUpdate): Promise<void> {
    void activity;
    throw new Error("Notification settings do not report renderer activity");
  }

  async drainNotificationActions(
    ready: NotificationActionDrainRequest,
  ): Promise<NotificationActionDrainResponse> {
    void ready;
    throw new Error("Notification settings do not drain actions");
  }

  async acknowledgeNotificationAction(
    acknowledgement: NotificationActionAcknowledgement,
  ): Promise<void> {
    void acknowledgement;
    throw new Error("Notification settings do not acknowledge actions");
  }

  onNotificationAction(listener: (action: NotificationAction) => void): () => void {
    void listener;
    throw new Error("Notification settings do not subscribe to actions");
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NotificationSettings", () => {
  it("shows a stable unavailable state when the bridge is absent", () => {
    render(createElement(NotificationSettings, { transport: undefined }));

    expect(screen.getByRole("status").textContent).toBe(
      "Notifications are unavailable in this build.",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh capability" })).toBeNull();
  });

  it("subscribes before loading and does not overwrite a push with stale hydration", async () => {
    const transport = new FakeNotificationTransport();
    const hydration = deferred<NotificationState>();
    transport.getResult = hydration.promise;
    render(createElement(NotificationSettings, { transport }));
    await waitFor(() => expect(transport.listeners.size).toBe(1));

    transport.emit({
      ...DEFAULT_STATE,
      devicePreference: "enabled",
      nativeSupport: "supported",
      osPermission: "granted",
    });
    hydration.resolve(DEFAULT_STATE);

    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox", { name: /Enable notifications/ }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(screen.getByText("Granted")).toBeTruthy();
    });
  });

  it("serializes preference writes without blurring the active control", async () => {
    const transport = new FakeNotificationTransport();
    const enabled = { ...DEFAULT_STATE, devicePreference: "enabled" } as const;
    const previews = { ...enabled, contentPreviewPreference: "enabled" } as const;
    const firstSave = deferred<NotificationState>();
    transport.setResults.push(firstSave.promise, previews);
    render(createElement(NotificationSettings, { transport }));
    const enableCheckbox = await screen.findByRole("checkbox", { name: /Enable notifications/ });
    const previewCheckbox = screen.getByRole("checkbox", { name: /Show message previews/ });

    enableCheckbox.focus();
    fireEvent.click(enableCheckbox);
    fireEvent.click(previewCheckbox);
    expect(transport.preferences).toEqual([
      {
        version: 1,
        devicePreference: "enabled",
        contentPreviewPreference: "disabled",
      },
    ]);
    expect(document.activeElement).toBe(enableCheckbox);

    firstSave.resolve(enabled);
    await waitFor(() => expect((enableCheckbox as HTMLInputElement).checked).toBe(true));
    fireEvent.click(previewCheckbox);
    await waitFor(() => expect((previewCheckbox as HTMLInputElement).checked).toBe(true));
    expect(transport.preferences.at(-1)).toEqual({
      version: 1,
      devicePreference: "enabled",
      contentPreviewPreference: "enabled",
    });
  });

  it("shows support and permission separately and refreshes only on an explicit click", async () => {
    const transport = new FakeNotificationTransport();
    transport.state = { ...DEFAULT_STATE, osPermission: "denied" };
    transport.getResult = transport.state;
    const refresh = deferred<NotificationState>();
    transport.refreshResults.push(refresh.promise);
    render(createElement(NotificationSettings, { transport }));

    expect(await screen.findByText("Supported")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.getByText(/Permission and Do Not Disturb are managed/)).toBeTruthy();
    expect(transport.refreshCalls).toBe(0);

    const button = screen.getByRole("button", { name: "Refresh capability" });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(transport.refreshCalls).toBe(1);

    refresh.resolve({ ...transport.state, osPermission: "granted" });
    await waitFor(() => expect(screen.getByText("Granted")).toBeTruthy());
    expect(document.activeElement).toBe(button);
    expect(screen.getByText(/Sound and Do Not Disturb are managed/)).toBeTruthy();
  });

  it("does not retry a failed load and recovers only from explicit capability refresh", async () => {
    const transport = new FakeNotificationTransport();
    const failedLoad = deferred<NotificationState>();
    transport.getResult = failedLoad.promise;
    transport.refreshResults.push(DEFAULT_STATE);
    render(createElement(NotificationSettings, { transport }));
    failedLoad.reject(new Error("OS integration unavailable"));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load notification settings.",
    );
    await Promise.resolve();
    expect(transport.getCalls).toBe(1);
    expect(transport.refreshCalls).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Refresh capability" }));
    await screen.findByRole("checkbox", { name: /Enable notifications/ });
    expect(transport.getCalls).toBe(1);
    expect(transport.refreshCalls).toBe(1);
  });

  it("removes its state listener when unmounted", async () => {
    const transport = new FakeNotificationTransport();
    const rendered = render(createElement(NotificationSettings, { transport }));
    await waitFor(() => expect(transport.listeners.size).toBe(1));

    rendered.unmount();
    expect(transport.listeners.size).toBe(0);
  });
});
