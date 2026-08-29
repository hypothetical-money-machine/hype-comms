import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  PRIVATE_DOWNLOAD_INVALID_OUTPUT_PATH_MESSAGE,
  PRIVATE_DOWNLOAD_MAX_CONFIG_BYTES,
  PRIVATE_DOWNLOAD_MAX_INPUT_BYTES,
  PRIVATE_DOWNLOAD_OUTPUT_EXISTS_MESSAGE,
  privateDownloadConfigMessageSchema,
  privateDownloadContinuationMessageSchema,
  privateDownloadWorkerMessageSchema,
} from "./private-download-protocol.ts";
import type {
  PrivateDownloadFailureCode,
  PrivateDownloadPhase,
  PrivateDownloadPhaseMessage,
  PrivateDownloadResultMessage,
} from "./private-download-protocol.ts";

const PRIVATE_FILE_MODE = 0o600;

// The parent process starts this worker with cwd set to the validated output directory. Relative
// operations remain anchored to that directory inode even if its absolute path is later replaced.

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface DirectoryRootIdentity extends FileIdentity {
  readonly path: string;
}

interface DirectoryComponentIdentity extends FileIdentity {
  readonly name: string;
}

interface DirectorySnapshot {
  readonly components: readonly DirectoryComponentIdentity[];
  readonly root: DirectoryRootIdentity;
}

interface WorkerConfig {
  readonly byteLength: number;
  readonly directorySnapshot: DirectorySnapshot;
  readonly targetName: string;
  readonly temporaryName: string;
}

class WorkerFailure extends Error {
  readonly code: PrivateDownloadFailureCode;

  constructor(code: PrivateDownloadFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

function parseConfig(message: unknown): WorkerConfig {
  let encoded: string;
  try {
    encoded = JSON.stringify(message);
  } catch {
    throw new WorkerFailure("WORKER_FAILURE", "The download worker configuration is invalid");
  }
  if (Buffer.byteLength(encoded) > PRIVATE_DOWNLOAD_MAX_CONFIG_BYTES) {
    throw new WorkerFailure("WORKER_FAILURE", "The download worker configuration is too large");
  }
  const parsed = privateDownloadConfigMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new WorkerFailure("WORKER_FAILURE", "The download worker configuration is invalid");
  }
  const decoded = parsed.data.config;
  const components = decoded.directorySnapshot.components.map((component) => ({
    name: component.name,
    dev: BigInt(component.dev),
    ino: BigInt(component.ino),
  }));
  return {
    byteLength: decoded.byteLength,
    directorySnapshot: {
      root: {
        path: decoded.directorySnapshot.root.path,
        dev: BigInt(decoded.directorySnapshot.root.dev),
        ino: BigInt(decoded.directorySnapshot.root.ino),
      },
      components,
    },
    targetName: decoded.targetName,
    temporaryName: decoded.temporaryName,
  };
}

function hasIdentity(info: BigIntStats, identity: FileIdentity): boolean {
  return info.dev === identity.dev && info.ino === identity.ino;
}

function invalidPath(): WorkerFailure {
  return new WorkerFailure("INVALID_OUTPUT_PATH", PRIVATE_DOWNLOAD_INVALID_OUTPUT_PATH_MESSAGE);
}

async function assertDirectorySnapshot(
  directoryHandle: FileHandle,
  snapshot: DirectorySnapshot,
): Promise<void> {
  let current = snapshot.root.path;
  const rootInfo = await lstat(current, { bigint: true }).catch(() => {
    throw invalidPath();
  });
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    !hasIdentity(rootInfo, snapshot.root)
  ) {
    throw invalidPath();
  }
  for (const expected of snapshot.components) {
    current = join(current, expected.name);
    const info = await lstat(current, { bigint: true }).catch(() => {
      throw invalidPath();
    });
    if (info.isSymbolicLink() || !info.isDirectory() || !hasIdentity(info, expected)) {
      throw invalidPath();
    }
  }
  const expectedDirectory = snapshot.components.at(-1) ?? snapshot.root;
  const cwdInfo = await directoryHandle.stat({ bigint: true });
  if (!cwdInfo.isDirectory() || !hasIdentity(cwdInfo, expectedDirectory)) throw invalidPath();
}

function hasPrivateMode(info: BigIntStats): boolean {
  return process.platform === "win32" || (info.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE);
}

async function assertPrivateFile(
  handle: FileHandle,
  path: string,
  identity: FileIdentity,
  expectedLinks: bigint,
): Promise<void> {
  const [handleInfo, pathInfo] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (
    !handleInfo.isFile() ||
    !pathInfo.isFile() ||
    !hasIdentity(handleInfo, identity) ||
    !hasIdentity(pathInfo, identity) ||
    handleInfo.nlink !== expectedLinks ||
    pathInfo.nlink !== expectedLinks ||
    !hasPrivateMode(handleInfo) ||
    !hasPrivateMode(pathInfo)
  ) {
    throw invalidPath();
  }
}

async function unlinkMatchingPath(path: string, identity: FileIdentity): Promise<void> {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info !== undefined && hasIdentity(info, identity)) await unlink(path);
}

async function receiveControlMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onDisconnect = (): void => {
      process.off("message", onMessage);
      reject(new WorkerFailure("WORKER_FAILURE", "The worker control channel closed"));
    };
    const onMessage = (message: unknown): void => {
      process.off("disconnect", onDisconnect);
      resolve(message);
    };
    process.once("disconnect", onDisconnect);
    process.once("message", onMessage);
  });
}

async function sendControlMessage(
  message: PrivateDownloadPhaseMessage | PrivateDownloadResultMessage,
): Promise<void> {
  if (process.send === undefined || !process.connected) {
    throw new WorkerFailure("WORKER_FAILURE", "The worker control channel is unavailable");
  }
  const parsed = privateDownloadWorkerMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new WorkerFailure("WORKER_FAILURE", "The worker control message is invalid");
  }
  await new Promise<void>((resolve, reject) => {
    process.send?.(parsed.data, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function checkpoint(phase: PrivateDownloadPhase): Promise<void> {
  const continuation = receiveControlMessage();
  try {
    await sendControlMessage({ type: "phase", phase });
  } catch (error) {
    if (process.connected) process.disconnect();
    void continuation.catch(() => undefined);
    throw error;
  }
  const message = privateDownloadContinuationMessageSchema.safeParse(await continuation);
  if (!message.success || message.data.phase !== phase) {
    throw new WorkerFailure("WORKER_FAILURE", "The worker continuation is invalid");
  }
}

async function readInput(expectedBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > expectedBytes || total > PRIVATE_DOWNLOAD_MAX_INPUT_BYTES) {
      throw new WorkerFailure("WORKER_FAILURE", "The download worker received too many bytes");
    }
    chunks.push(bytes);
  }
  if (total !== expectedBytes) {
    throw new WorkerFailure("WORKER_FAILURE", "The download worker received incomplete bytes");
  }
  return Buffer.concat(chunks, total);
}

async function publish(config: WorkerConfig): Promise<void> {
  const directoryHandle = await open(
    ".",
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  let handle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  let temporaryExists = false;
  let targetPublished = false;
  let complete = false;
  try {
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    try {
      await lstat(config.targetName);
      throw new WorkerFailure("OUTPUT_EXISTS", PRIVATE_DOWNLOAD_OUTPUT_EXISTS_MESSAGE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    handle = await open(
      config.temporaryName,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    temporaryExists = true;
    await handle.chmod(PRIVATE_FILE_MODE);
    const openedInfo = await handle.stat({ bigint: true });
    identity = { dev: openedInfo.dev, ino: openedInfo.ino };
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.temporaryName, identity, 1n);
    await checkpoint("temporary-ready");

    const bytes = await readInput(config.byteLength);
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.temporaryName, identity, 1n);
    await handle.writeFile(bytes);
    await handle.sync();
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.temporaryName, identity, 1n);

    try {
      await link(config.temporaryName, config.targetName);
      targetPublished = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkerFailure("OUTPUT_EXISTS", PRIVATE_DOWNLOAD_OUTPUT_EXISTS_MESSAGE);
      }
      throw error;
    }
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.temporaryName, identity, 2n);
    await assertPrivateFile(handle, config.targetName, identity, 2n);
    await checkpoint("target-linked");
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.temporaryName, identity, 2n);
    await assertPrivateFile(handle, config.targetName, identity, 2n);

    await unlink(config.temporaryName);
    temporaryExists = false;
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.targetName, identity, 1n);
    await directoryHandle.sync();
    await assertDirectorySnapshot(directoryHandle, config.directorySnapshot);
    await assertPrivateFile(handle, config.targetName, identity, 1n);
    complete = true;
  } finally {
    if (!complete && handle !== undefined) {
      await handle.truncate(0).catch(() => undefined);
      await handle.sync().catch(() => undefined);
      await handle.chmod(0).catch(() => undefined);
      if (identity !== undefined) {
        if (targetPublished) {
          await unlinkMatchingPath(config.targetName, identity).catch(() => undefined);
        }
        if (temporaryExists) {
          await unlinkMatchingPath(config.temporaryName, identity).catch(() => undefined);
        }
      }
    }
    await handle?.close().catch(() => undefined);
    await directoryHandle.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  try {
    await publish(parseConfig(await receiveControlMessage()));
    await sendControlMessage({ type: "result", ok: true });
  } catch (error) {
    const failure =
      error instanceof WorkerFailure
        ? error
        : new WorkerFailure("WORKER_FAILURE", "The private download worker failed");
    await sendControlMessage({
      type: "result",
      ok: false,
      code: failure.code,
      message: failure.message,
    }).catch(() => undefined);
    process.exitCode = 1;
  }
}

await main();
