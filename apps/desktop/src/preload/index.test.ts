import { beforeEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_CHANNELS } from "../shared/channels";
import type {
  DesktopApi,
  NotificationCaptureTransport,
  NotificationTransport,
} from "../shared/desktop-api";

/**
 * The bridge is the renderer's only door to the network, so every response it hands back has to be
 * re-validated on this side: a compromised or simply out-of-date main process must not be able to
 * put a shape the wire contract forbids into the renderer's cache.
 */
const invoke = vi.fn();
let headless = true;
const sendSync = vi.fn((...args: readonly unknown[]) => {
  void args;
  return headless;
});
const on = vi.fn();
const removeListener = vi.fn();
let exposed: Record<string, unknown> = {};

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>): void => {
      exposed = api;
    },
  },
  ipcRenderer: {
    invoke: (...args: readonly unknown[]) => invoke(...args) as unknown,
    sendSync: (...args: readonly unknown[]) => sendSync(...args) as unknown,
    on: (...args: readonly unknown[]) => on(...args),
    removeListener: (...args: readonly unknown[]) => removeListener(...args),
  },
}));

await import("./index");

const desktopApi = exposed as unknown as DesktopApi &
  NotificationTransport &
  NotificationCaptureTransport;

const NOW = "2026-07-24T12:00:00.000Z";
const MEMBER = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const USER_ID = MEMBER.id;
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000003";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000004";

const NOTIFICATION_CONTEXT = {
  version: 1,
  status: "active",
  sessionGeneration: 7,
  rendererSessionGeneration: 3,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
} as const;

const NOTIFICATION_READY = {
  version: 1,
  sessionGeneration: NOTIFICATION_CONTEXT.sessionGeneration,
  rendererSessionGeneration: NOTIFICATION_CONTEXT.rendererSessionGeneration,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
} as const;

const NOTIFICATION_ACTION = {
  version: 1,
  type: "open-message",
  sessionGeneration: NOTIFICATION_CONTEXT.sessionGeneration,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  threadRootId: null,
} as const;

const NOTIFICATION_ACTIVITY = {
  ...NOTIFICATION_READY,
  revision: 1,
  view: {
    pane: "chat",
    conversationId: CONVERSATION_ID,
    timelineAtLiveTail: true,
    thread: null,
  },
} as const;

const NOTIFICATION_PREFERENCE = {
  version: 1,
  devicePreference: "enabled",
  contentPreviewPreference: "disabled",
} as const;

const NOTIFICATION_STATE = {
  ...NOTIFICATION_PREFERENCE,
  nativeSupport: "supported",
  osPermission: "unknown",
} as const;

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
});

describe("preload theme boundary", () => {
  it("gets a strictly validated System appearance without applying a preference", async () => {
    const systemState = {
      preference: "system",
      resolvedThemeId: "light",
      resolvedColorScheme: "light",
      accentColor: "#be123c",
    } as const;
    invoke.mockResolvedValueOnce(systemState);

    await expect(desktopApi.getSystemThemeState()).resolves.toEqual(systemState);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.themeSystemState);

    invoke.mockResolvedValueOnce({
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
      accentColor: null,
    });
    await expect(desktopApi.getSystemThemeState()).rejects.toThrow(/non-system appearance/u);

    invoke.mockResolvedValueOnce({ ...systemState, css: "body { display: none }" });
    await expect(desktopApi.getSystemThemeState()).rejects.toThrow();
  });
});

describe("preload listWorkspaceMembers", () => {
  it("invokes the members channel with no request payload", async () => {
    invoke.mockResolvedValueOnce({ members: [MEMBER] });

    await expect(desktopApi.listWorkspaceMembers()).resolves.toEqual({ members: [MEMBER] });
    expect(invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.workspaceMembersList);
  });

  it("rejects a member directory that the wire contract does not allow", async () => {
    // The removal signal deliberately has no status field anywhere in the member shape. A payload
    // that grew one is a contract drift the renderer must never cache.
    invoke.mockResolvedValueOnce({ members: [{ ...MEMBER, status: "revoked" }] });

    await expect(desktopApi.listWorkspaceMembers()).rejects.toThrow();
  });

  it("rejects a directory response that is not an object at all", async () => {
    invoke.mockResolvedValueOnce(null);

    await expect(desktopApi.listWorkspaceMembers()).rejects.toThrow();
  });
});

describe("preload native notification boundary", () => {
  it("exposes a frozen, body-free pull bridge", () => {
    expect(Object.isFrozen(desktopApi)).toBe(true);
    expect(desktopApi).toMatchObject({
      getNotificationContext: expect.any(Function),
      reportNotificationActivity: expect.any(Function),
      drainNotificationActions: expect.any(Function),
      acknowledgeNotificationAction: expect.any(Function),
      onNotificationAction: expect.any(Function),
      getNotificationState: expect.any(Function),
      setNotificationPreference: expect.any(Function),
      refreshNotificationCapability: expect.any(Function),
      onNotificationStateChanged: expect.any(Function),
      activateCapturedNotification: expect.any(Function),
    });
    expect(desktopApi).not.toHaveProperty("showNotification");
    expect(desktopApi).not.toHaveProperty("notify");
  });

  it("gets a strictly validated main-issued renderer context", async () => {
    invoke.mockResolvedValueOnce(NOTIFICATION_CONTEXT);

    await expect(desktopApi.getNotificationContext()).resolves.toEqual(NOTIFICATION_CONTEXT);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.notificationContext);

    invoke.mockResolvedValueOnce({ ...NOTIFICATION_CONTEXT, body: "private canary" });
    await expect(desktopApi.getNotificationContext()).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      ...NOTIFICATION_CONTEXT,
      padding: "x".repeat(2_048),
    });
    await expect(desktopApi.getNotificationContext()).rejects.toThrow(/byte limit/);
  });

  it("validates and bounds activity before invoking main", async () => {
    invoke.mockResolvedValueOnce(undefined);

    await expect(desktopApi.reportNotificationActivity(NOTIFICATION_ACTIVITY)).resolves.toBe(
      undefined,
    );
    expect(invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.notificationActivityUpdate,
      NOTIFICATION_ACTIVITY,
    );

    await expect(
      desktopApi.reportNotificationActivity({
        ...NOTIFICATION_ACTIVITY,
        body: "x".repeat(2_048),
      } as typeof NOTIFICATION_ACTIVITY),
    ).rejects.toThrow(/byte limit/);
    expect(invoke).toHaveBeenCalledOnce();

    invoke.mockResolvedValueOnce({ accepted: true });
    await expect(desktopApi.reportNotificationActivity(NOTIFICATION_ACTIVITY)).rejects.toThrow(
      /unexpected payload/,
    );
  });

  it("uses the ready request to drain only a strict scope-bound action batch", async () => {
    const response = { ...NOTIFICATION_READY, actions: [NOTIFICATION_ACTION] };
    invoke.mockResolvedValueOnce(response);

    await expect(desktopApi.drainNotificationActions(NOTIFICATION_READY)).resolves.toEqual(
      response,
    );
    expect(invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.notificationActionsDrain,
      NOTIFICATION_READY,
    );

    invoke.mockResolvedValueOnce({
      ...NOTIFICATION_READY,
      actions: [{ type: "open-channel", channelId: CONVERSATION_ID }],
    });
    await expect(desktopApi.drainNotificationActions(NOTIFICATION_READY)).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      ...NOTIFICATION_READY,
      actions: [{ ...NOTIFICATION_ACTION, sessionGeneration: 8 }],
    });
    await expect(desktopApi.drainNotificationActions(NOTIFICATION_READY)).rejects.toThrow();
  });

  it("validates action pushes and removes the exact wrapped listener", () => {
    const listener = vi.fn();
    const unsubscribe = desktopApi.onNotificationAction(listener);
    const wrapped = on.mock.calls[0]?.[1] as ((event: unknown, value: unknown) => void) | undefined;

    expect(on).toHaveBeenCalledWith(DESKTOP_CHANNELS.notificationAction, expect.any(Function));
    expect(wrapped).toBeTypeOf("function");
    wrapped?.({}, NOTIFICATION_ACTION);
    wrapped?.({}, { type: "open-channel", channelId: CONVERSATION_ID });
    wrapped?.({}, { ...NOTIFICATION_ACTION, body: "x".repeat(2_048) });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(NOTIFICATION_ACTION);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(DESKTOP_CHANNELS.notificationAction, wrapped);
  });

  it("strictly validates and bounds an exact action acknowledgement", async () => {
    const acknowledgement = { ...NOTIFICATION_READY, action: NOTIFICATION_ACTION };
    invoke.mockResolvedValueOnce(undefined);

    await expect(
      desktopApi.acknowledgeNotificationAction(acknowledgement),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.notificationActionAcknowledge,
      acknowledgement,
    );

    await expect(
      desktopApi.acknowledgeNotificationAction({
        ...acknowledgement,
        action: { ...NOTIFICATION_ACTION, workspaceId: "10000000-0000-4000-8000-000000000099" },
      }),
    ).rejects.toThrow();
    await expect(
      desktopApi.acknowledgeNotificationAction({
        ...acknowledgement,
        body: "x".repeat(4_096),
      } as typeof acknowledgement),
    ).rejects.toThrow(/byte limit/);
    expect(invoke).toHaveBeenCalledOnce();

    invoke.mockResolvedValueOnce({ acknowledged: true });
    await expect(desktopApi.acknowledgeNotificationAction(acknowledgement)).rejects.toThrow(
      /unexpected payload/,
    );
  });

  it("gets, sets, refreshes, and subscribes to strict notification state", async () => {
    invoke
      .mockResolvedValueOnce(NOTIFICATION_STATE)
      .mockResolvedValueOnce({ ...NOTIFICATION_STATE, devicePreference: "disabled" })
      .mockResolvedValueOnce({ ...NOTIFICATION_STATE, osPermission: "granted" });

    await expect(desktopApi.getNotificationState()).resolves.toEqual(NOTIFICATION_STATE);
    await expect(desktopApi.setNotificationPreference(NOTIFICATION_PREFERENCE)).resolves.toEqual({
      ...NOTIFICATION_STATE,
      devicePreference: "disabled",
    });
    await expect(desktopApi.refreshNotificationCapability()).resolves.toEqual({
      ...NOTIFICATION_STATE,
      osPermission: "granted",
    });
    expect(invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.notificationState],
      [DESKTOP_CHANNELS.notificationPreferenceSet, NOTIFICATION_PREFERENCE],
      [DESKTOP_CHANNELS.notificationCapabilityRefresh],
    ]);

    const listener = vi.fn();
    const unsubscribe = desktopApi.onNotificationStateChanged(listener);
    const wrapped = on.mock.calls[0]?.[1] as ((event: unknown, value: unknown) => void) | undefined;
    wrapped?.({}, NOTIFICATION_STATE);
    wrapped?.({}, { ...NOTIFICATION_STATE, body: "private canary" });
    wrapped?.({}, { ...NOTIFICATION_STATE, padding: "x".repeat(2_048) });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(NOTIFICATION_STATE);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(DESKTOP_CHANNELS.notificationStateChanged, wrapped);
  });

  it("rejects oversized preference input before invoking main", async () => {
    await expect(
      desktopApi.setNotificationPreference({
        ...NOTIFICATION_PREFERENCE,
        body: "x".repeat(2_048),
      } as typeof NOTIFICATION_PREFERENCE),
    ).rejects.toThrow(/byte limit/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects oversized or expanded state responses", async () => {
    invoke.mockResolvedValueOnce({ ...NOTIFICATION_STATE, padding: "x".repeat(2_048) });
    await expect(desktopApi.getNotificationState()).rejects.toThrow(/byte limit/);

    invoke.mockResolvedValueOnce({ ...NOTIFICATION_STATE, title: "arbitrary title" });
    await expect(desktopApi.refreshNotificationCapability()).rejects.toThrow();
  });

  it("activates one opaque capture ID and returns only the boolean result", async () => {
    const captureId = "capture_0123456789abcdef";
    invoke.mockResolvedValueOnce({ version: 1, activated: true });

    await expect(desktopApi.activateCapturedNotification(captureId)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_CHANNELS.notificationCaptureActivate, {
      version: 1,
      captureId,
    });

    invoke.mockResolvedValueOnce({ version: 1, activated: false });
    await expect(desktopApi.activateCapturedNotification(captureId)).resolves.toBe(false);
  });

  it("rejects malformed capture IDs and expanded activation results", async () => {
    await expect(
      desktopApi.activateCapturedNotification("message-id-is-not-opaque!"),
    ).rejects.toThrow();
    await expect(desktopApi.activateCapturedNotification("x".repeat(300))).rejects.toThrow(
      /byte limit/,
    );
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({
      version: 1,
      activated: true,
      messageId: MESSAGE_ID,
    });
    await expect(
      desktopApi.activateCapturedNotification("capture_0123456789abcdef"),
    ).rejects.toThrow();

    invoke.mockResolvedValueOnce({
      version: 1,
      activated: true,
      body: "private canary",
    });
    await expect(
      desktopApi.activateCapturedNotification("capture_0123456789abcdef"),
    ).rejects.toThrow();
  });

  it("rejects capture activation outside headless automation", async () => {
    headless = false;
    exposed = {};
    vi.resetModules();
    try {
      await import("./index");
      const normalApi = exposed as unknown as NotificationCaptureTransport;

      await expect(
        normalApi.activateCapturedNotification("capture_0123456789abcdef"),
      ).rejects.toThrow(/only in headless mode/);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      headless = true;
    }
  });
});
