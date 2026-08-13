import { randomUUID } from "node:crypto";

import type {
  Notification as ElectronNotification,
  NotificationConstructorOptions,
} from "electron";
import { notificationCaptureIdSchema } from "@hype-comms/contracts";

import type { NotificationEligibilityReason } from "./notification-policy";

export interface NotificationPresentation {
  readonly title: string;
  readonly body: string;
  readonly reason: NotificationEligibilityReason;
}

export interface NotificationPresentationCallbacks {
  readonly onClick: () => void;
  readonly onClose: () => void;
  readonly onFailure: () => void;
}

export interface PresentedNotificationHandle {
  close(): void;
}

export interface NotificationPresenter {
  readonly kind: "native" | "capture";
  present(
    presentation: NotificationPresentation,
    callbacks: NotificationPresentationCallbacks,
  ): PresentedNotificationHandle;
}

export interface ElectronNotificationConstructor {
  new (options?: NotificationConstructorOptions): ElectronNotification;
  isSupported(): boolean;
}

/** Thin production adapter. It exposes no generic renderer bridge and passes no target IDs. */
export class ElectronNotificationPresenter implements NotificationPresenter {
  readonly kind = "native" as const;
  readonly #Notification: ElectronNotificationConstructor;

  constructor(Notification: ElectronNotificationConstructor) {
    this.#Notification = Notification;
  }

  present(
    presentation: NotificationPresentation,
    callbacks: NotificationPresentationCallbacks,
  ): PresentedNotificationHandle {
    const notification = new this.#Notification({
      title: presentation.title,
      body: presentation.body,
    });
    let finished = false;
    const finish = (callback: () => void): void => {
      if (finished) return;
      finished = true;
      callback();
    };
    notification.once("click", () => finish(callbacks.onClick));
    notification.once("close", () => finish(callbacks.onClose));
    notification.once("failed", () => finish(callbacks.onFailure));

    try {
      notification.show();
    } catch (error) {
      try {
        notification.close();
      } catch {
        // The construction/show failure remains the useful error for the controller to consume.
      }
      throw error;
    }

    return {
      close: () => notification.close(),
    };
  }
}

/** Capability source for NotificationSettingsController; Electron has no portable permission API. */
export class ElectronNotificationCapabilitySource {
  readonly #Notification: ElectronNotificationConstructor;

  constructor(Notification: ElectronNotificationConstructor) {
    this.#Notification = Notification;
  }

  read(): {
    readonly nativeSupport: "supported" | "unsupported";
    readonly osPermission: "unknown";
  } {
    return {
      nativeSupport: this.#Notification.isSupported() ? "supported" : "unsupported",
      osPermission: "unknown",
    };
  }
}

/** A body-free artifact record. The opaque ID activates only an in-memory callback. */
export interface CapturedNotificationRecord {
  readonly version: 1;
  readonly captureId: string;
  readonly reason: NotificationEligibilityReason;
}

const DEFAULT_CAPTURE_RECORD_LIMIT = 1_024;

export class CaptureNotificationPresenter implements NotificationPresenter {
  readonly kind = "capture" as const;
  readonly #createId: () => string;
  readonly #onRecord: ((record: CapturedNotificationRecord) => void) | undefined;
  readonly #recordLimit: number;
  readonly #records: CapturedNotificationRecord[] = [];
  readonly #active = new Map<string, NotificationPresentationCallbacks>();

  constructor(options?: {
    readonly createId?: () => string;
    readonly onRecord?: (record: CapturedNotificationRecord) => void;
    readonly recordLimit?: number;
  }) {
    this.#createId = options?.createId ?? randomUUID;
    this.#onRecord = options?.onRecord;
    this.#recordLimit = options?.recordLimit ?? DEFAULT_CAPTURE_RECORD_LIMIT;
    if (!Number.isSafeInteger(this.#recordLimit) || this.#recordLimit < 1) {
      throw new Error("Capture record limit must be a positive safe integer");
    }
  }

  get records(): readonly CapturedNotificationRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  present(
    presentation: NotificationPresentation,
    callbacks: NotificationPresentationCallbacks,
  ): PresentedNotificationHandle {
    const captureId = this.#createId();
    if (!notificationCaptureIdSchema.safeParse(captureId).success || this.#active.has(captureId)) {
      throw new Error("Capture presenter produced an invalid or duplicate opaque ID");
    }

    const record: CapturedNotificationRecord = {
      version: 1,
      captureId,
      reason: presentation.reason,
    };
    this.#active.set(captureId, callbacks);
    this.#records.push(record);
    if (this.#records.length > this.#recordLimit) this.#records.shift();
    try {
      this.#onRecord?.({ ...record });
    } catch (error) {
      this.#active.delete(captureId);
      const index = this.#records.findIndex((candidate) => candidate.captureId === captureId);
      if (index >= 0) this.#records.splice(index, 1);
      throw error;
    }

    return {
      close: () => {
        const current = this.#active.get(captureId);
        if (current === undefined) return;
        this.#active.delete(captureId);
        current.onClose();
      },
    };
  }

  activate(captureId: string): boolean {
    const callbacks = this.#active.get(captureId);
    if (callbacks === undefined) return false;
    this.#active.delete(captureId);
    callbacks.onClick();
    return true;
  }
}

/** Used when a headless lane wants eligibility coverage without writing capture artifacts. */
export class NoopNotificationPresenter implements NotificationPresenter {
  readonly kind = "capture" as const;

  present(
    _presentation: NotificationPresentation,
    callbacks: NotificationPresentationCallbacks,
  ): PresentedNotificationHandle {
    callbacks.onClose();
    return { close: () => undefined };
  }
}
