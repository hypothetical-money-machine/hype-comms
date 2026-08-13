import { spawn } from "node:child_process";
import path from "node:path";

import type {
  NotificationOsPermission,
  NotificationPreference,
  NotificationState,
} from "@hmm-chat/contracts";

const HELPER_EXECUTABLE = "hmm-notification-authorization";
const OUTPUT_LIMIT_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

interface HelperResult {
  readonly stdout: string;
}

type RunHelper = (
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
) => Promise<HelperResult>;

async function runHelper(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<HelperResult> {
  const child = spawn(executable, [...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > OUTPUT_LIMIT_BYTES) {
      child.kill("SIGKILL");
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const status = await new Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (outputBytes > OUTPUT_LIMIT_BYTES) {
    throw new Error("macOS notification authorization helper exceeded its output limit");
  }
  if (status.code !== 0) {
    const detail = stderr.trim();
    throw new Error(
      `macOS notification authorization helper failed with ${
        status.signal ?? `code ${String(status.code)}`
      }${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return { stdout };
}

function parsePermission(stdout: string): NotificationOsPermission {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("macOS notification authorization helper returned invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("macOS notification authorization helper returned an invalid state");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "permission,version" ||
    record.version !== 1 ||
    (record.permission !== "granted" &&
      record.permission !== "denied" &&
      record.permission !== "unknown")
  ) {
    throw new Error("macOS notification authorization helper returned an invalid state");
  }
  return record.permission;
}

export class MacosNotificationAuthorization {
  readonly #executable: string;
  readonly #run: RunHelper;

  constructor(options: { readonly executable: string; readonly run?: RunHelper }) {
    this.#executable = options.executable;
    this.#run = options.run ?? runHelper;
  }

  async read(): Promise<{
    readonly nativeSupport: "supported";
    readonly osPermission: NotificationOsPermission;
  }> {
    return {
      nativeSupport: "supported",
      osPermission: await this.#invoke("status"),
    };
  }

  request(): Promise<NotificationOsPermission> {
    return this.#invoke("request");
  }

  async #invoke(command: "request" | "status"): Promise<NotificationOsPermission> {
    const result = await this.#run(this.#executable, [command], REQUEST_TIMEOUT_MS);
    return parsePermission(result.stdout);
  }
}

export function createMacosNotificationAuthorization(options: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly run?: RunHelper;
}): MacosNotificationAuthorization | null {
  if (!options.isPackaged || options.platform !== "darwin") return null;
  return new MacosNotificationAuthorization({
    executable: path.resolve(options.resourcesPath, "..", "MacOS", HELPER_EXECUTABLE),
    run: options.run,
  });
}

export async function setNotificationPreferenceWithAuthorization(options: {
  readonly authorization: MacosNotificationAuthorization | null;
  readonly current: NotificationState;
  readonly preference: NotificationPreference;
  readonly refreshCapability: () => Promise<NotificationState>;
  readonly setPreference: (preference: NotificationPreference) => Promise<NotificationState>;
}): Promise<NotificationState> {
  if (
    options.authorization !== null &&
    options.current.devicePreference === "disabled" &&
    options.preference.devicePreference === "enabled"
  ) {
    const permission = await options.authorization.request();
    const refreshed = await options.refreshCapability();
    if (permission !== "granted") return refreshed;
  }
  return options.setPreference(options.preference);
}
