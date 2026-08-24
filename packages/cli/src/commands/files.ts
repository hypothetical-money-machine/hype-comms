import { randomUUID } from "node:crypto";
import { constants, link, lstat, open, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

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

function entityId(value: string, label: string, code: string): string {
  const parsed = entityIdSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${label} must be a UUID`, code);
  return parsed.data;
}

async function assertDestinationAvailable(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new UsageError("The output path already exists", "OUTPUT_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertRealDirectoryPath(directory: string): Promise<void> {
  const root = parse(directory).root;
  const components = directory.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UsageError("The output directory does not exist", "INVALID_OUTPUT_PATH");
      }
      throw error;
    });
    if (info.isSymbolicLink()) {
      throw new UsageError(
        "The output path must not traverse a symbolic link",
        "INVALID_OUTPUT_PATH",
      );
    }
    if (!info.isDirectory()) {
      throw new UsageError(
        "Every output parent component must be a directory",
        "INVALID_OUTPUT_PATH",
      );
    }
  }
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
  await assertRealDirectoryPath(directory);
  await assertDestinationAvailable(target);

  const temporary = join(directory, `.hype-comms-download.${randomUUID()}.part`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  let temporaryExists = true;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    try {
      // A same-directory hard link is an atomic, no-replace publication primitive. Unlike rename,
      // it fails if another process creates the destination after our initial safety check.
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UsageError("The output path already exists", "OUTPUT_EXISTS");
      }
      throw error;
    }
    await unlink(temporary);
    temporaryExists = false;
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    if (temporaryExists) {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
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
