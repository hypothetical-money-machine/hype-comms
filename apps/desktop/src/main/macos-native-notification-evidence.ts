import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NotificationPresenter, PresentedNotificationHandle } from "./notification-presenter";

export const MACOS_NATIVE_NOTIFICATION_EVIDENCE_ARGUMENT =
  "--hmm-macos-native-notification-evidence";
export const MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY_ENV =
  "HYPE_COMMS_MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY";
export const MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE = "Hype Comms";
export const MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY =
  "Synthetic direct message for native notification evidence";

export interface MacosNativeNotificationEvidenceConfiguration {
  readonly artifactDirectory: string;
  readonly userDataPath: string;
}

export function resolveMacosNativeNotificationEvidenceConfiguration(options: {
  readonly compiledIn: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): MacosNativeNotificationEvidenceConfiguration | null {
  const requested = options.argv.includes(MACOS_NATIVE_NOTIFICATION_EVIDENCE_ARGUMENT);
  const rawDirectory = options.env[MACOS_NATIVE_NOTIFICATION_EVIDENCE_DIRECTORY_ENV]?.trim() ?? "";
  if (!options.compiledIn) {
    if (requested || rawDirectory !== "") {
      throw new Error("macOS native notification evidence is not compiled into this artifact");
    }
    return null;
  }
  if (!requested || rawDirectory === "") return null;
  if (!options.isPackaged || options.platform !== "darwin") {
    throw new Error("macOS native notification evidence requires a packaged macOS application");
  }
  if (!path.isAbsolute(rawDirectory) || rawDirectory === path.parse(rawDirectory).root) {
    throw new Error("macOS native notification evidence requires a non-root absolute directory");
  }
  const artifactDirectory = path.resolve(rawDirectory);
  return {
    artifactDirectory,
    userDataPath: path.join(artifactDirectory, "user-data"),
  };
}

interface NotificationHistoryEntry {
  readonly title: string;
  readonly body: string;
}

interface NativeEvidenceRecord {
  readonly version: 1;
  readonly status: "clicked" | "delivered" | "failed";
}

export interface MacosNativeNotificationEvidenceSession {
  readonly handle: PresentedNotificationHandle;
  readonly delivery: Promise<void>;
}

async function writeRecord(artifactDirectory: string, record: NativeEvidenceRecord): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
  const destination = path.join(artifactDirectory, `${record.status}.json`);
  const pending = `${destination}.pending`;
  await writeFile(pending, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(pending, 0o600);
  await rename(pending, destination);
}

async function waitForDeliveredNotification(options: {
  readonly artifactDirectory: string;
  readonly getHistory: () => Promise<readonly NotificationHistoryEntry[]>;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const history = await options.getHistory();
    if (
      history.some(
        (entry) =>
          entry.title === MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE &&
          entry.body === MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
      )
    ) {
      await writeRecord(options.artifactDirectory, { version: 1, status: "delivered" });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
  throw new Error("Timed out waiting for the synthetic notification in Notification Center");
}

/**
 * Exercise the production Electron presenter in a separately compiled, synthetic-only artifact.
 * No workspace, member, conversation, message identifier, or real message content enters this path.
 */
export async function startMacosNativeNotificationEvidence(options: {
  readonly configuration: MacosNativeNotificationEvidenceConfiguration;
  readonly presenter: NotificationPresenter;
  readonly getHistory: () => Promise<readonly NotificationHistoryEntry[]>;
  readonly onClick: () => void | Promise<void>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}): Promise<MacosNativeNotificationEvidenceSession> {
  if (options.presenter.kind !== "native") {
    throw new Error("macOS native notification evidence requires the native presenter");
  }
  const { artifactDirectory } = options.configuration;
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);

  let handle: PresentedNotificationHandle;
  try {
    handle = options.presenter.present(
      {
        title: MACOS_NATIVE_NOTIFICATION_EVIDENCE_TITLE,
        body: MACOS_NATIVE_NOTIFICATION_EVIDENCE_BODY,
        reason: "direct_message",
      },
      {
        onClick: () => {
          void writeRecord(artifactDirectory, { version: 1, status: "clicked" })
            .then(options.onClick)
            .catch(() => undefined);
        },
        onClose: () => undefined,
        onFailure: () => {
          void writeRecord(artifactDirectory, { version: 1, status: "failed" }).catch(
            () => undefined,
          );
        },
      },
    );
  } catch (error) {
    await writeRecord(artifactDirectory, { version: 1, status: "failed" });
    throw error;
  }

  return {
    handle,
    delivery: waitForDeliveredNotification({
      artifactDirectory,
      getHistory: options.getHistory,
      timeoutMs: options.timeoutMs ?? 120_000,
      pollIntervalMs: options.pollIntervalMs ?? 250,
    }),
  };
}
