import { createRequire } from "node:module";
import path from "node:path";

import type {
  NotificationOsPermission,
  NotificationPreference,
  NotificationState,
} from "@hype-comms/contracts";

const ADDON_FILENAME = "hmm-notification-authorization.node";
const STATUS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

interface NativeAuthorizationBinding {
  readonly authorize: (
    command: "request" | "status",
    callback: (error: unknown, permission: unknown) => void,
  ) => void;
}

type LoadBinding = (addonPath: string) => unknown;

function isBinding(value: unknown): value is NativeAuthorizationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).join(",") === "authorize" && typeof record.authorize === "function";
}

function parsePermission(value: unknown): NotificationOsPermission {
  if (value === "granted" || value === "denied" || value === "unknown") return value;
  throw new Error("macOS notification authorization addon returned an invalid state");
}

function loadBinding(addonPath: string): unknown {
  const require = createRequire(path.join(path.dirname(addonPath), "package.json"));
  return require(addonPath) as unknown;
}

export class MacosNotificationAuthorization {
  readonly #binding: NativeAuthorizationBinding;

  constructor(options: { readonly addonPath: string; readonly load?: LoadBinding }) {
    const binding = (options.load ?? loadBinding)(options.addonPath);
    if (!isBinding(binding)) {
      throw new Error("macOS notification authorization addon has an invalid interface");
    }
    this.#binding = binding;
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

  #invoke(command: "request" | "status"): Promise<NotificationOsPermission> {
    return new Promise((resolve, reject) => {
      const timeoutMs = command === "status" ? STATUS_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(
        () => reject(new Error(`macOS notification authorization ${command} timed out`)),
        timeoutMs,
      );
      try {
        this.#binding.authorize(command, (error, permission) => {
          clearTimeout(timer);
          if (typeof error === "string" && error !== "") {
            reject(new Error(`macOS notification authorization failed: ${error.slice(0, 512)}`));
            return;
          }
          if (error !== null) {
            reject(new Error("macOS notification authorization returned an invalid error"));
            return;
          }
          try {
            resolve(parsePermission(permission));
          } catch (cause) {
            reject(cause);
          }
        });
      } catch (cause) {
        clearTimeout(timer);
        reject(cause);
      }
    });
  }
}

export function createMacosNotificationAuthorization(options: {
  readonly compiledIn: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly load?: LoadBinding;
}): MacosNotificationAuthorization | null {
  if (!options.compiledIn || !options.isPackaged || options.platform !== "darwin") return null;
  try {
    return new MacosNotificationAuthorization({
      addonPath: path.join(options.resourcesPath, ADDON_FILENAME),
      load: options.load,
    });
  } catch {
    return null;
  }
}

export async function requestAuthorizationForPersistedEnabledPreference(options: {
  readonly authorization: MacosNotificationAuthorization | null;
  readonly current: NotificationState;
  readonly refreshCapability: () => Promise<NotificationState>;
}): Promise<NotificationState> {
  if (
    options.authorization === null ||
    options.current.devicePreference !== "enabled" ||
    options.current.osPermission !== "unknown"
  ) {
    return options.current;
  }
  await options.authorization.request();
  return options.refreshCapability();
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
    const previewChanged =
      options.preference.contentPreviewPreference !== options.current.contentPreviewPreference;
    const persistPreviewPreference = (): Promise<NotificationState> =>
      options.setPreference({
        version: options.preference.version,
        devicePreference: options.current.devicePreference,
        contentPreviewPreference: options.preference.contentPreviewPreference,
      });
    try {
      const permission = await options.authorization.request();
      const refreshed = await options.refreshCapability();
      if (permission !== "granted") {
        return previewChanged ? persistPreviewPreference() : refreshed;
      }
    } catch (cause) {
      if (previewChanged) await persistPreviewPreference();
      throw cause;
    }
  }
  return options.setPreference(options.preference);
}
