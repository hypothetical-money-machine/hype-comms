import { EventEmitter } from "node:events";

import type { NotificationConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CaptureNotificationPresenter,
  ElectronNotificationCapabilitySource,
  ElectronNotificationPresenter,
  NoopNotificationPresenter,
  type ElectronNotificationConstructor,
} from "./notification-presenter";

class FakeElectronNotification extends EventEmitter {
  static instances: FakeElectronNotification[] = [];
  static supported = true;
  static showFailure: Error | null = null;

  static isSupported(): boolean {
    return this.supported;
  }

  readonly show = vi.fn((): void => {
    if (FakeElectronNotification.showFailure !== null) {
      throw FakeElectronNotification.showFailure;
    }
  });
  readonly close = vi.fn((): void => {
    this.emit("close", {});
  });

  constructor(readonly options?: NotificationConstructorOptions) {
    super();
    FakeElectronNotification.instances.push(this);
  }
}

function electronConstructor(): ElectronNotificationConstructor {
  return FakeElectronNotification as unknown as ElectronNotificationConstructor;
}

function callbacks() {
  return {
    onClick: vi.fn(),
    onClose: vi.fn(),
    onFailure: vi.fn(),
  };
}

const PRESENTATION = {
  title: "Morgan",
  body: "engineering",
  reason: "verified_mention",
} as const;

describe("ElectronNotificationPresenter", () => {
  beforeEach(() => {
    FakeElectronNotification.instances = [];
    FakeElectronNotification.supported = true;
    FakeElectronNotification.showFailure = null;
  });

  it("passes only bounded display content to Electron and finishes once on click", () => {
    const presenter = new ElectronNotificationPresenter(electronConstructor());
    const listeners = callbacks();
    const handle = presenter.present(PRESENTATION, listeners);
    const notification = FakeElectronNotification.instances[0];

    expect(notification?.options).toEqual({ title: "Morgan", body: "engineering" });
    expect(Object.keys(notification?.options ?? {})).toEqual(["title", "body"]);
    expect(notification?.show).toHaveBeenCalledOnce();

    notification?.emit("click", {});
    notification?.emit("close", {});
    expect(listeners.onClick).toHaveBeenCalledOnce();
    expect(listeners.onClose).not.toHaveBeenCalled();
    expect(listeners.onFailure).not.toHaveBeenCalled();

    handle.close();
    expect(notification?.close).toHaveBeenCalledOnce();
  });

  it("passes an explicit correlation ID to Electron when supplied", () => {
    const presenter = new ElectronNotificationPresenter(electronConstructor());

    presenter.present({ ...PRESENTATION, id: "evidence-notification-0001" }, callbacks());

    expect(FakeElectronNotification.instances[0]?.options).toEqual({
      id: "evidence-notification-0001",
      title: "Morgan",
      body: "engineering",
    });
  });

  it("reports asynchronous native failure without carrying its error string", () => {
    const presenter = new ElectronNotificationPresenter(electronConstructor());
    const listeners = callbacks();
    presenter.present(PRESENTATION, listeners);
    const notification = FakeElectronNotification.instances[0];

    notification?.emit("failed", {}, "private native failure detail");
    notification?.emit("click", {});

    expect(listeners.onFailure).toHaveBeenCalledOnce();
    expect(listeners.onFailure).toHaveBeenCalledWith();
    expect(listeners.onClick).not.toHaveBeenCalled();
  });

  it("closes and rethrows when native show fails synchronously", () => {
    const presenter = new ElectronNotificationPresenter(electronConstructor());
    const failure = new Error("show failed");
    FakeElectronNotification.showFailure = failure;

    expect(() => presenter.present(PRESENTATION, callbacks())).toThrow(failure);
    expect(FakeElectronNotification.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("reports portable support while leaving OS permission unknown", () => {
    const capability = new ElectronNotificationCapabilitySource(electronConstructor());
    expect(capability.read()).toEqual({ nativeSupport: "supported", osPermission: "unknown" });

    FakeElectronNotification.supported = false;
    expect(capability.read()).toEqual({ nativeSupport: "unsupported", osPermission: "unknown" });
  });
});

describe("headless notification presenters", () => {
  it("captures a body-free opaque record and activates only its in-memory callback", () => {
    const written: unknown[] = [];
    const presenter = new CaptureNotificationPresenter({
      createId: () => "opaque-capture-0001",
      onRecord: (record) => written.push(record),
    });
    const listeners = callbacks();
    const handle = presenter.present(
      {
        title: "private-author-label",
        body: "private-message-canary",
        reason: "direct_message",
      },
      listeners,
    );

    expect(presenter.records).toEqual([
      { version: 1, captureId: "opaque-capture-0001", reason: "direct_message" },
    ]);
    expect(written).toEqual(presenter.records);
    expect(JSON.stringify(presenter.records)).not.toContain("private-author-label");
    expect(JSON.stringify(presenter.records)).not.toContain("private-message-canary");

    expect(presenter.activate("opaque-capture-0001")).toBe(true);
    expect(presenter.activate("opaque-capture-0001")).toBe(false);
    expect(listeners.onClick).toHaveBeenCalledOnce();
    expect(listeners.onClose).not.toHaveBeenCalled();
    handle.close();
    expect(listeners.onClose).not.toHaveBeenCalled();
  });

  it("bounds capture history and closes an active opaque record", () => {
    const identifiers = ["capture-00000001", "capture-00000002", "capture-00000003"];
    const presenter = new CaptureNotificationPresenter({
      createId: () => identifiers.shift() ?? "capture-overflow-0001",
      recordLimit: 2,
    });
    const first = callbacks();
    const second = callbacks();
    const third = callbacks();
    presenter.present(PRESENTATION, first);
    const secondHandle = presenter.present(PRESENTATION, second);
    presenter.present(PRESENTATION, third);

    expect(presenter.records.map((record) => record.captureId)).toEqual([
      "capture-00000002",
      "capture-00000003",
    ]);
    secondHandle.close();
    expect(second.onClose).toHaveBeenCalledOnce();
    expect(presenter.activate("capture-00000002")).toBe(false);
    expect(presenter.activate("capture-00000001")).toBe(true);
  });

  it("rejects unsafe opaque IDs and a failing artifact sink", () => {
    expect(() =>
      new CaptureNotificationPresenter({ createId: () => "../escape" }).present(
        PRESENTATION,
        callbacks(),
      ),
    ).toThrow(/invalid or duplicate/u);

    const presenter = new CaptureNotificationPresenter({
      createId: () => "safe-capture-0001",
      onRecord: () => {
        throw new Error("artifact unavailable");
      },
    });
    expect(() => presenter.present(PRESENTATION, callbacks())).toThrow("artifact unavailable");
    expect(presenter.records).toEqual([]);
    expect(presenter.activate("safe-capture-0001")).toBe(false);
  });

  it("supports an immediate no-op capture seam", () => {
    const listeners = callbacks();
    const handle = new NoopNotificationPresenter().present(PRESENTATION, listeners);

    expect(listeners.onClose).toHaveBeenCalledOnce();
    expect(() => handle.close()).not.toThrow();
  });
});
