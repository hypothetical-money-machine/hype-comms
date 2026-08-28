import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type SyncDirectory = (directory: string) => Promise<void>;

export interface PrivateReadableFileHandle {
  stat(): Promise<{
    readonly uid: number;
    readonly mode: number;
    readonly size: number;
    isFile(): boolean;
  }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export type PrivateFileOpen = (
  filePath: string,
  flags: number,
) => Promise<PrivateReadableFileHandle>;

export type PrivateFileReadResult =
  | { readonly status: "ok"; readonly value: string }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

export interface PrivateFileReadOptions {
  readonly platform?: NodeJS.Platform;
  readonly currentUid?: number | undefined;
  readonly openFile?: PrivateFileOpen;
}

const defaultPrivateFileOpen: PrivateFileOpen = (filePath, flags) => open(filePath, flags);

function noFollowRejected(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

/**
 * Opens and validates a private file through one descriptor, then performs a capped read from that
 * same descriptor. On POSIX, `O_NOFOLLOW`, owner matching, and private mode checks prevent a
 * checked pathname from being replaced with a different file before it is read.
 */
export async function readPrivateBoundedUtf8File(
  filePath: string,
  maxBytes: number,
  options: PrivateFileReadOptions = {},
): Promise<PrivateFileReadResult> {
  const platform = options.platform ?? process.platform;
  const flags =
    platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  let file: PrivateReadableFileHandle;
  try {
    file = await (options.openFile ?? defaultPrivateFileOpen)(filePath, flags);
  } catch (error) {
    return { status: noFollowRejected(error) ? "invalid" : "unavailable" };
  }

  let result: PrivateFileReadResult;
  try {
    const metadata = await file.stat();
    const currentUid =
      options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > maxBytes ||
      (platform !== "win32" &&
        ((metadata.mode & 0o077) !== 0 || currentUid === undefined || metadata.uid !== currentUid))
    ) {
      result = { status: "invalid" };
    } else {
      const bytes = Buffer.alloc(maxBytes + 1);
      let totalBytesRead = 0;
      while (totalBytesRead < bytes.length) {
        const next = await file.read(bytes, totalBytesRead, bytes.length - totalBytesRead, null);
        if (next.bytesRead === 0) break;
        totalBytesRead += next.bytesRead;
      }
      if (totalBytesRead === 0 || totalBytesRead > maxBytes) {
        result = { status: "invalid" };
      } else {
        try {
          result = {
            status: "ok",
            value: new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(0, totalBytesRead),
            ),
          };
        } catch {
          result = { status: "invalid" };
        }
      }
    }
  } catch {
    result = { status: "unavailable" };
  }

  try {
    await file.close();
  } catch {
    return { status: "unavailable" };
  }
  return result;
}

export async function syncDirectoryStrict(directory: string): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function syncDirectoryBestEffort(directory: string): Promise<void> {
  await syncDirectoryStrict(directory).catch(() => {
    // The preference is already committed by rename; directory durability is best effort.
  });
}

/**
 * Reads a small preference file with a hard size cap, returning null for anything unreadable,
 * empty, or oversized. The cap is enforced on the bytes actually read, not just the stat size,
 * so a file growing between stat and read cannot slip past it.
 */
export async function readBoundedUtf8File(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) {
      return null;
    }

    const bytes = Buffer.alloc(maxBytes + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < bytes.length) {
      const result = await file.read(bytes, totalBytesRead, bytes.length - totalBytesRead, null);
      if (result.bytesRead === 0) {
        break;
      }
      totalBytesRead += result.bytesRead;
    }
    if (totalBytesRead === 0 || totalBytesRead > maxBytes) {
      return null;
    }

    return bytes.toString("utf8", 0, totalBytesRead);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function atomicWrite(
  filePath: string,
  value: string,
  syncDirectory: SyncDirectory,
  options: { readonly requireDirectorySync?: boolean } = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, "wx", 0o600);
  let isOpen = true;
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
    await file.close();
    isOpen = false;
    await rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      if (options.requireDirectorySync === true) {
        await syncDirectory(directory);
      } else {
        await syncDirectory(directory).catch(() => undefined);
      }
    }
  } catch (error) {
    if (isOpen) {
      await file.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
