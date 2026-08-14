import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MACOS_NATIVE_NOTIFICATION_EVIDENCE_ARGUMENT,
  MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
  MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY_ENV,
  MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
  resolveMacosNativeNotificationEvidenceConfiguration,
  startMacosNativeNotificationEvidence,
} from "./macos-native-notification-evidence";
import type {
  NotificationPresentation,
  NotificationPresentationCallbacks,
  NotificationPresenter,
} from "./notification-presenter";

class EvidencePresenter implements NotificationPresenter {
  readonly kind = "native" as const;
  presentation: NotificationPresentation | null = null;
  callbacks: NotificationPresentationCallbacks | null = null;

  present(presentation: NotificationPresentation, callbacks: NotificationPresentationCallbacks) {
    this.presentation = presentation;
    this.callbacks = callbacks;
    return { close: vi.fn() };
  }
}

describe("macOS native notification evidence", () => {
  it("requires an evidence build, packaged macOS, an explicit argument, and an absolute path", () => {
    const input = {
      compiledIn: true,
      isPackaged: true,
      platform: "darwin" as const,
      argv: [MACOS_NATIVE_NOTIFICATION_EVIDENCE_ARGUMENT],
      env: { [MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY_ENV]: "/private/tmp/evidence" },
    };
    expect(resolveMacosNativeNotificationEvidenceConfiguration(input)).toEqual({
      artifactDirectory: "/private/tmp/evidence",
      userDataPath: "/private/tmp/evidence-user-data",
    });
    expect(() =>
      resolveMacosNativeNotificationEvidenceConfiguration({ ...input, argv: [] }),
    ).toThrow("requires both the argument and artifact directory");
    expect(() =>
      resolveMacosNativeNotificationEvidenceConfiguration({
        ...input,
        env: {},
      }),
    ).toThrow("requires both the argument and artifact directory");
    expect(
      resolveMacosNativeNotificationEvidenceConfiguration({ ...input, argv: [], env: {} }),
    ).toBeNull();
    expect(() =>
      resolveMacosNativeNotificationEvidenceConfiguration({ ...input, compiledIn: false }),
    ).toThrow("not compiled into this artifact");
    expect(() =>
      resolveMacosNativeNotificationEvidenceConfiguration({ ...input, isPackaged: false }),
    ).toThrow("requires a packaged macOS application");
    expect(() =>
      resolveMacosNativeNotificationEvidenceConfiguration({
        ...input,
        env: { [MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY_ENV]: "relative" },
      }),
    ).toThrow("requires a non-root absolute directory");
  });

  it("presents fixed synthetic content and records delivery and click without target data", async () => {
    const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-native-evidence-"));
    const presenter = new EvidencePresenter();
    const onClick = vi.fn();
    const priorSyntheticClose = vi.fn();
    const unrelatedClose = vi.fn();
    const currentNotificationId = "evidence-notification-current";
    let historyReadCount = 0;
    const session = await startMacosNativeNotificationEvidence({
      configuration: { artifactDirectory, userDataPath: path.join(artifactDirectory, "user-data") },
      presenter,
      requestAuthorization: async () => "granted",
      getHistory: async () => {
        historyReadCount += 1;
        if (presenter.presentation === null && historyReadCount === 1) {
          return [
            {
              id: "evidence-notification-stale",
              title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
              body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
              close: priorSyntheticClose,
            },
            {
              id: "real-message",
              title: "Real message",
              body: "Do not remove",
              close: unrelatedClose,
            },
          ];
        }
        if (presenter.presentation === null && historyReadCount === 2) {
          return [
            {
              id: "evidence-notification-stale",
              title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
              body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
              close: vi.fn(),
            },
          ];
        }
        if (presenter.presentation === null) return [];
        return [
          {
            id: "evidence-notification-stale",
            title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
            body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
            close: vi.fn(),
          },
          {
            id: currentNotificationId,
            title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
            body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
            close: vi.fn(),
          },
        ];
      },
      onClick,
      createNotificationId: () => currentNotificationId,
      cleanupTimeoutMs: 100,
      cleanupPollIntervalMs: 1,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(presenter.presentation).toEqual({
      id: currentNotificationId,
      title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
      body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
      reason: "direct_message",
    });
    expect(priorSyntheticClose).toHaveBeenCalledOnce();
    expect(unrelatedClose).not.toHaveBeenCalled();
    await session.delivery;
    expect(
      JSON.parse(await readFile(path.join(artifactDirectory, "delivered.json"), "utf8")),
    ).toEqual({ version: 1, status: "delivered", notificationId: currentNotificationId });
    expect(historyReadCount).toBe(4);

    presenter.callbacks?.onClick();
    await vi.waitFor(async () => {
      expect(onClick).toHaveBeenCalledOnce();
      expect(
        JSON.parse(await readFile(path.join(artifactDirectory, "clicked.json"), "utf8")),
      ).toEqual({
        version: 1,
        status: "clicked",
        notificationId: currentNotificationId,
      });
    });
  });

  it("fails before presenting when a prior synthetic notification does not disappear", async () => {
    const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-native-evidence-"));
    const presenter = new EvidencePresenter();
    const staleClose = vi.fn();
    const notificationId = "evidence-notification-cleanup-timeout";

    await expect(
      startMacosNativeNotificationEvidence({
        configuration: {
          artifactDirectory,
          userDataPath: path.join(artifactDirectory, "user-data"),
        },
        presenter,
        requestAuthorization: async () => "granted",
        getHistory: async () => [
          {
            id: "evidence-notification-stale",
            title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
            body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
            close: staleClose,
          },
        ],
        onClick: vi.fn(),
        createNotificationId: () => notificationId,
        cleanupTimeoutMs: 5,
        cleanupPollIntervalMs: 1,
      }),
    ).rejects.toThrow(
      "Timed out waiting for prior synthetic notifications to leave Notification Center",
    );
    expect(staleClose).toHaveBeenCalledOnce();
    expect(presenter.presentation).toBeNull();
    expect(JSON.parse(await readFile(path.join(artifactDirectory, "failed.json"), "utf8"))).toEqual(
      { version: 1, status: "failed", notificationId },
    );
  });

  it("records click success only after the installed interaction state is ready", async () => {
    const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-native-evidence-"));
    const presenter = new EvidencePresenter();
    const notificationId = "evidence-notification-click-failure";
    const session = await startMacosNativeNotificationEvidence({
      configuration: { artifactDirectory, userDataPath: path.join(artifactDirectory, "user-data") },
      presenter,
      requestAuthorization: async () => "granted",
      getHistory: async () => [],
      onClick: async () => {
        throw new Error("window restore failed");
      },
      createNotificationId: () => notificationId,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    void session.delivery.catch(() => undefined);

    presenter.callbacks?.onClick();
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(path.join(artifactDirectory, "failed.json"), "utf8")),
      ).toEqual({ version: 1, status: "failed", notificationId }),
    );
    await expect(
      readFile(path.join(artifactDirectory, "clicked.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before presentation when the real app is not authorized", async () => {
    const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-native-evidence-"));
    const presenter = new EvidencePresenter();
    const notificationId = "evidence-notification-denied";

    await expect(
      startMacosNativeNotificationEvidence({
        configuration: {
          artifactDirectory,
          userDataPath: path.join(artifactDirectory, "user-data"),
        },
        presenter,
        requestAuthorization: async () => "denied",
        getHistory: async () => [],
        onClick: vi.fn(),
        createNotificationId: () => notificationId,
      }),
    ).rejects.toThrow("authorization is denied");
    expect(presenter.presentation).toBeNull();
    expect(JSON.parse(await readFile(path.join(artifactDirectory, "failed.json"), "utf8"))).toEqual(
      { version: 1, status: "failed", notificationId },
    );
  });
});
