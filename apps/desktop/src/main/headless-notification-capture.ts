import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { notificationCaptureIdSchema } from "@hmm-chat/contracts";

import type { NotificationEligibilityReason } from "./notification-policy";

export const HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV =
  "HMM_DESKTOP_HEADLESS_NOTIFICATION_ARTIFACT_DIRECTORY";
export const HEADLESS_NOTIFICATION_CAPTURE_RECORD_LIMIT = 1_024;

const CAPTURE_RECORD_MAX_BYTES = 256;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const RECORD_KEYS = ["captureId", "reason", "version"] as const;

export interface HeadlessNotificationCaptureRecord {
  readonly version: 1;
  readonly captureId: string;
  readonly reason: NotificationEligibilityReason;
}

interface OpenHeadlessNotificationCaptureOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly profile: string;
  readonly recordLimit?: number;
}

function validateRecordLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > HEADLESS_NOTIFICATION_CAPTURE_RECORD_LIMIT
  ) {
    throw new Error("Headless notification capture capacity is invalid");
  }
  return value;
}

function isEligibilityReason(value: unknown): value is NotificationEligibilityReason {
  return (
    value === "verified_mention" ||
    value === "direct_message" ||
    value === "participated_thread_reply"
  );
}

function validateCaptureRecord(value: unknown): HeadlessNotificationCaptureRecord {
  if (value === null || typeof value !== "object") {
    throw new Error("Headless notification capture record is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Headless notification capture record is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== RECORD_KEYS.length ||
    !RECORD_KEYS.every((key) => keys.includes(key)) ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw new Error("Headless notification capture record is invalid");
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.captureId !== "string" ||
    !notificationCaptureIdSchema.safeParse(candidate.captureId).success ||
    !isEligibilityReason(candidate.reason)
  ) {
    throw new Error("Headless notification capture record is invalid");
  }
  return {
    version: 1,
    captureId: candidate.captureId,
    reason: candidate.reason,
  };
}

function serializeCaptureRecord(value: unknown): string {
  const record = validateCaptureRecord(value);
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > CAPTURE_RECORD_MAX_BYTES) {
    throw new Error("Headless notification capture record is oversized");
  }
  return serialized;
}

function validateExistingRecords(fileDescriptor: number, recordLimit: number): number {
  const details = fstatSync(fileDescriptor);
  if (!details.isFile()) throw new Error("Headless notification capture target is invalid");
  if (details.size > recordLimit * CAPTURE_RECORD_MAX_BYTES) {
    throw new Error("Headless notification capture artifact exceeds its capacity");
  }

  const contents = readFileSync(fileDescriptor, "utf8");
  if (contents === "") return 0;
  if (!contents.endsWith("\n")) {
    throw new Error("Headless notification capture artifact is incomplete");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length > recordLimit) {
    throw new Error("Headless notification capture artifact exceeds its capacity");
  }
  for (const line of lines) {
    if (Buffer.byteLength(`${line}\n`, "utf8") > CAPTURE_RECORD_MAX_BYTES) {
      throw new Error("Headless notification capture artifact contains an oversized record");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Headless notification capture artifact is invalid");
    }
    validateCaptureRecord(parsed);
  }
  return lines.length;
}

function resolvePrivateArtifactDirectory(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("Headless notification capture directory must be absolute");
  }
  const directory = path.resolve(value);
  if (directory === path.parse(directory).root || path.normalize(value) !== directory) {
    throw new Error("Headless notification capture directory is outside its allowed scope");
  }
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Headless notification capture directory is invalid");
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error("Headless notification capture directory must be private");
  }
  return directory;
}

function captureFilePath(directory: string, profile: string): string {
  if (!PROFILE_PATTERN.test(profile) || profile === "." || profile === "..") {
    throw new Error("Headless notification capture profile is invalid");
  }
  const file = path.join(directory, `notifications-${profile}.jsonl`);
  if (path.dirname(file) !== directory) {
    throw new Error("Headless notification capture file is outside its allowed scope");
  }
  return file;
}

/**
 * A synchronous append sink for the capture presenter's synchronous callback. Each bounded JSONL
 * record uses one O_APPEND write, so existing records are never rewritten and file offsets cannot
 * race between appenders.
 */
export interface HeadlessNotificationCaptureArtifact {
  readonly filePath: string;
  append(record: HeadlessNotificationCaptureRecord): boolean;
  close(): void;
}

class FileHeadlessNotificationCaptureArtifact implements HeadlessNotificationCaptureArtifact {
  readonly filePath: string;
  readonly #recordLimit: number;
  #fileDescriptor: number | null;
  #recordCount: number;

  constructor(filePath: string, recordLimit = HEADLESS_NOTIFICATION_CAPTURE_RECORD_LIMIT) {
    this.filePath = filePath;
    this.#recordLimit = validateRecordLimit(recordLimit);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const fileDescriptor = openSync(
      filePath,
      constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | noFollow,
      0o600,
    );
    try {
      fchmodSync(fileDescriptor, 0o600);
      this.#recordCount = validateExistingRecords(fileDescriptor, this.#recordLimit);
    } catch (error) {
      closeSync(fileDescriptor);
      throw error;
    }
    this.#fileDescriptor = fileDescriptor;
  }

  append(record: HeadlessNotificationCaptureRecord): boolean {
    const fileDescriptor = this.#fileDescriptor;
    if (fileDescriptor === null) {
      throw new Error("Headless notification capture artifact is closed");
    }
    const serialized = serializeCaptureRecord(record);
    if (this.#recordCount >= this.#recordLimit) return false;
    const bytes = Buffer.from(serialized, "utf8");
    const written = writeSync(fileDescriptor, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      throw new Error("Headless notification capture append was incomplete");
    }
    this.#recordCount += 1;
    return true;
  }

  close(): void {
    if (this.#fileDescriptor === null) return;
    closeSync(this.#fileDescriptor);
    this.#fileDescriptor = null;
  }
}

/** Resolve capture only for an unpackaged headless profile with an explicitly pinned directory. */
export function openHeadlessNotificationCaptureArtifact({
  env,
  isPackaged,
  profile,
  recordLimit = HEADLESS_NOTIFICATION_CAPTURE_RECORD_LIMIT,
}: OpenHeadlessNotificationCaptureOptions): HeadlessNotificationCaptureArtifact | null {
  const headless = env.HMM_DESKTOP_HEADLESS?.trim() ?? "";
  const configuredDirectory = env[HEADLESS_NOTIFICATION_CAPTURE_DIRECTORY_ENV]?.trim() ?? "";
  if (headless === "") {
    if (configuredDirectory !== "") {
      throw new Error("Headless notification capture requires headless desktop scope");
    }
    return null;
  }
  if (headless !== "1" || isPackaged || profile === "") {
    throw new Error("Headless notification capture requires an unpackaged isolated profile");
  }
  if (configuredDirectory === "") {
    throw new Error("Headless notification capture directory is required");
  }

  const directory = resolvePrivateArtifactDirectory(configuredDirectory);
  return new FileHeadlessNotificationCaptureArtifact(
    captureFilePath(directory, profile),
    validateRecordLimit(recordLimit),
  );
}
