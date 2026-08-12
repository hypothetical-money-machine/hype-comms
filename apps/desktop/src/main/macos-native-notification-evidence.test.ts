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
      userDataPath: "/private/tmp/evidence/user-data",
    });
    expect(resolveMacosNativeNotificationEvidenceConfiguration({ ...input, argv: [] })).toBeNull();
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
    const session = await startMacosNativeNotificationEvidence({
      configuration: { artifactDirectory, userDataPath: path.join(artifactDirectory, "user-data") },
      presenter,
      getHistory: async () => [
        {
          title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
          body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
        },
      ],
      onClick,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(presenter.presentation).toEqual({
      title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
      body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
      reason: "direct_message",
    });
    await session.delivery;
    expect(
      JSON.parse(await readFile(path.join(artifactDirectory, "delivered.json"), "utf8")),
    ).toEqual({ version: 1, status: "delivered" });

    presenter.callbacks?.onClick();
    await vi.waitFor(async () => {
      expect(onClick).toHaveBeenCalledOnce();
      expect(
        JSON.parse(await readFile(path.join(artifactDirectory, "clicked.json"), "utf8")),
      ).toEqual({
        version: 1,
        status: "clicked",
      });
    });
  });

  it("records click success only after the installed interaction state is ready", async () => {
    const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "hmm-native-evidence-"));
    const presenter = new EvidencePresenter();
    const session = await startMacosNativeNotificationEvidence({
      configuration: { artifactDirectory, userDataPath: path.join(artifactDirectory, "user-data") },
      presenter,
      getHistory: async () => [],
      onClick: async () => {
        throw new Error("window restore failed");
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    void session.delivery.catch(() => undefined);

    presenter.callbacks?.onClick();
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(path.join(artifactDirectory, "failed.json"), "utf8")),
      ).toEqual({ version: 1, status: "failed" }),
    );
    await expect(
      readFile(path.join(artifactDirectory, "clicked.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
