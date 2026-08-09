import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type SyncDirectory = (directory: string) => Promise<void>;

export async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(directory, "r");
    await directoryHandle.sync();
  } catch {
    // The preference is already committed by rename; directory durability is best effort.
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
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
      await syncDirectory(directory).catch(() => undefined);
    }
  } catch (error) {
    if (isOpen) {
      await file.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
