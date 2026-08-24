import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTACHMENTS_CAPABILITY,
  ATTACHMENT_MAX_BYTES,
  conversationFilesResponseSchema,
  entityIdSchema,
  listMessageAttachmentsRequestSchema,
  listMessageAttachmentsResponseSchema,
  paginationCursorSchema,
} from "@hype-comms/contracts";

import { integerOption, parseCommandArguments, requirePositionals, stringOption } from "../argv.js";
import { clientFromContext } from "../context.js";
import { UsageError } from "../errors.js";
import { writeResult } from "../output.js";
import { resolveConversationSelector } from "../selectors.js";
import type { CommandContext } from "../types.js";

const ATTACHMENTS_HEADER = { "x-hype-comms-capabilities": ATTACHMENTS_CAPABILITY } as const;
const MAX_WORKER_CONFIG_BYTES = 1 * 1_024 * 1_024;
const MAX_WORKER_OUTPUT_BYTES = 16 * 1_024;

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

function entityId(value: string, label: string, code: string): string {
  const parsed = entityIdSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${label} must be a UUID`, code);
  return parsed.data;
}

function invalidOutputPath(message: string): UsageError {
  return new UsageError(message, "INVALID_OUTPUT_PATH");
}

async function directoryInfo(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw invalidOutputPath("The output directory does not exist");
    }
    throw error;
  }
}

function assertRealDirectory(info: BigIntStats): void {
  if (info.isSymbolicLink()) {
    throw invalidOutputPath("The output path must not traverse a symbolic link");
  }
  if (!info.isDirectory()) {
    throw invalidOutputPath("Every output parent component must be a directory");
  }
}

async function realDirectorySnapshot(directory: string): Promise<DirectorySnapshot> {
  const root = parse(directory).root;
  const components = directory.slice(root.length).split(sep).filter(Boolean);
  const rootInfo = await directoryInfo(root);
  assertRealDirectory(rootInfo);
  const snapshot: DirectoryComponentIdentity[] = [];
  let current = root;
  for (const component of components) {
    current = join(current, component);
    const info = await directoryInfo(current);
    assertRealDirectory(info);
    snapshot.push({ name: component, dev: info.dev, ino: info.ino });
  }
  return {
    root: { path: root, dev: rootInfo.dev, ino: rootInfo.ino },
    components: snapshot,
  };
}

function privateDownloadWorkerUrl(): URL {
  return basename(fileURLToPath(import.meta.url)) === "bin.js"
    ? new URL("./private-download-worker.js", import.meta.url)
    : new URL("../private-download-worker.ts", import.meta.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function runPrivateDownloadWorker(
  directory: string,
  targetName: string,
  temporaryName: string,
  directorySnapshot: DirectorySnapshot,
  bytes: Uint8Array,
): Promise<void> {
  const configMessage = {
    type: "config",
    config: {
      byteLength: bytes.byteLength,
      directorySnapshot: {
        root: {
          path: directorySnapshot.root.path,
          dev: directorySnapshot.root.dev.toString(),
          ino: directorySnapshot.root.ino.toString(),
        },
        components: directorySnapshot.components.map(({ name, dev, ino }) => ({
          name,
          dev: dev.toString(),
          ino: ino.toString(),
        })),
      },
      targetName,
      temporaryName,
    },
  } as const;
  if (Buffer.byteLength(JSON.stringify(configMessage)) > MAX_WORKER_CONFIG_BYTES) {
    throw invalidOutputPath("The output directory is too deep to validate safely");
  }

  const child = spawn(process.execPath, [fileURLToPath(privateDownloadWorkerUrl())], {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (
    child.stdin === null ||
    child.stdout === null ||
    child.stderr === null ||
    child.send === undefined
  ) {
    child.kill();
    throw new Error("The private download worker pipes are unavailable");
  }
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES) {
      outputOverflow = true;
      child.kill();
      return;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAX_WORKER_OUTPUT_BYTES) {
      outputOverflow = true;
      child.kill();
      return;
    }
  });
  let inputError: Error | undefined;
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") inputError = error;
  });

  let protocolError: Error | undefined;
  let response: unknown;
  let completedPhases = 0;
  const failProtocol = (message: string): void => {
    protocolError ??= new Error(message);
    child.kill();
  };
  const sendControl = (message: Record<string, unknown>): void => {
    child.send?.(message, (error) => {
      if (error !== null) failProtocol("The private download worker control channel failed");
    });
  };
  child.on("message", (message: unknown) => {
    if (!isRecord(message) || typeof message.type !== "string") {
      failProtocol("The private download worker returned an invalid message");
      return;
    }
    if (message.type === "phase") {
      if (
        !hasExactKeys(message, ["phase", "type"]) ||
        typeof message.phase !== "string" ||
        (message.phase !== "temporary-ready" && message.phase !== "target-linked")
      ) {
        failProtocol("The private download worker returned an invalid phase");
        return;
      }
      if (message.phase === "temporary-ready" && completedPhases === 0) {
        completedPhases = 1;
        child.stdin?.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        sendControl({ type: "continue", phase: "temporary-ready" });
        return;
      }
      if (message.phase === "target-linked" && completedPhases === 1) {
        completedPhases = 2;
        sendControl({ type: "continue", phase: "target-linked" });
        return;
      }
      failProtocol("The private download worker phases arrived out of order");
      return;
    }
    if (message.type === "result") {
      if (response !== undefined) {
        failProtocol("The private download worker returned more than one result");
        return;
      }
      response = message;
      return;
    }
    failProtocol("The private download worker returned an unknown message");
  });

  const completion = new Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.send?.(configMessage, (error) => {
        if (error === null) resolvePromise();
        else reject(error);
      });
    });
  } catch (error) {
    child.kill();
    await completion.catch(() => undefined);
    throw error;
  }
  const result = await completion;
  if (inputError !== undefined) throw inputError;
  if (outputOverflow) throw new Error("The private download worker exceeded its output limit");
  if (protocolError !== undefined) throw protocolError;
  if (stdoutBytes !== 0) throw new Error("The private download worker wrote unexpected output");

  if (!isRecord(response) || response.type !== "result" || typeof response.ok !== "boolean") {
    throw new Error("The private download worker returned an invalid response");
  }
  if (response.ok) {
    if (
      result.code !== 0 ||
      result.signal !== null ||
      completedPhases !== 2 ||
      !hasExactKeys(response, ["ok", "type"])
    ) {
      throw new Error("The private download worker did not exit cleanly");
    }
    return;
  }
  if (
    result.code === 0 ||
    typeof response.code !== "string" ||
    typeof response.message !== "string" ||
    !hasExactKeys(response, ["code", "message", "ok", "type"])
  ) {
    throw new Error("The private download worker returned an invalid failure");
  }
  if (response.code === "OUTPUT_EXISTS") {
    throw new UsageError(response.message, "OUTPUT_EXISTS");
  }
  if (response.code === "INVALID_OUTPUT_PATH") {
    throw invalidOutputPath(response.message);
  }
  throw new Error("The private download worker failed");
}

/** Publish a complete private file atomically without ever replacing an existing path. */
export async function savePrivateDownload(
  cwd: string,
  output: string,
  bytes: Uint8Array,
): Promise<string> {
  if (output.trim() === "" || output.includes("\0")) {
    throw new UsageError("--output must be a safe file path", "INVALID_OUTPUT_PATH");
  }
  const target = resolve(cwd, output);
  const directory = dirname(target);
  const directorySnapshot = await realDirectorySnapshot(directory);
  try {
    await runPrivateDownloadWorker(
      directory,
      basename(target),
      `.hype-comms-download.${randomUUID()}.part`,
      directorySnapshot,
      bytes,
    );
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw invalidOutputPath("The output directory changed while the file was being saved");
    }
    throw error;
  }
  return target;
}

export async function filesCommand(
  context: CommandContext,
  subcommand: string | undefined,
  args: readonly string[],
): Promise<void> {
  const client = await clientFromContext(context);
  if (subcommand === "list") {
    const parsed = parseCommandArguments(args, {
      before: { kind: "string" },
      limit: { kind: "string" },
    });
    const [selector] = requirePositionals(parsed, 1);
    const beforeValue = stringOption(parsed, "before");
    const before =
      beforeValue === undefined ? undefined : paginationCursorSchema.safeParse(beforeValue);
    if (before !== undefined && !before.success) {
      throw new UsageError("--before is not a valid pagination cursor", "INVALID_CURSOR");
    }
    const conversationId = await resolveConversationSelector(client, selector!);
    const response = await client.request({
      path: `/v1/conversations/${conversationId}/files`,
      query: {
        before: before?.data,
        limit: integerOption(parsed, "limit", 50, 100),
      },
      responseSchema: conversationFilesResponseSchema,
      headers: ATTACHMENTS_HEADER,
    });
    writeResult(context.runtime.io, response, context.options.json);
    return;
  }

  if (subcommand === "for-message") {
    const parsed = parseCommandArguments(args, {});
    const [value] = requirePositionals(parsed, 1);
    const messageId = entityId(value!, "The message ID", "INVALID_MESSAGE_ID");
    const body = { messageIds: [messageId] };
    const response = await client.request({
      method: "POST",
      path: "/v1/attachments/query",
      body,
      requestSchema: listMessageAttachmentsRequestSchema,
      responseSchema: listMessageAttachmentsResponseSchema,
      headers: ATTACHMENTS_HEADER,
    });
    writeResult(context.runtime.io, { messageId, ...response }, context.options.json);
    return;
  }

  if (subcommand === "get") {
    const parsed = parseCommandArguments(args, { output: { kind: "string" } });
    const [value] = requirePositionals(parsed, 1);
    const attachmentId = entityId(value!, "The attachment ID", "INVALID_ATTACHMENT_ID");
    const output = stringOption(parsed, "output");
    if (output === undefined) throw new UsageError("files get requires --output");
    const download = await client.download({
      path: `/v1/files/${attachmentId}/content`,
      maxBytes: ATTACHMENT_MAX_BYTES,
      headers: ATTACHMENTS_HEADER,
    });
    const path = await savePrivateDownload(context.runtime.cwd, output, download.bytes);
    writeResult(
      context.runtime.io,
      {
        attachmentId,
        path,
        sizeBytes: download.sizeBytes,
        contentSha256: download.contentSha256,
      },
      context.options.json,
    );
    return;
  }

  throw new UsageError("Usage: hype-comms-cli files <list|for-message|get>");
}
