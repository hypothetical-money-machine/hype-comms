import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ATTACHMENT_MAX_BYTES } from "@hype-comms/contracts";

import { ApiError } from "../../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REJECTED_EXTENSIONS = new Set([
  "apk",
  "app",
  "bat",
  "bin",
  "cmd",
  "com",
  "cpl",
  "deb",
  "dll",
  "dmg",
  "exe",
  "jar",
  "msi",
  "msp",
  "pif",
  "pkg",
  "ps1",
  "rpm",
  "scr",
  "sh",
  "sys",
  "vbe",
  "vbs",
  "ws",
  "wsf",
]);

const REJECTED_CONTENT_TYPES = new Set([
  "application/x-apple-diskimage",
  "application/x-debian-package",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-rpm",
  "application/x-sh",
  "application/vnd.microsoft.portable-executable",
]);

export const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1_000;

export function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  const cleaned = base.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\0/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new ApiError(400, "BAD_REQUEST", "File name is invalid");
  }
  return cleaned.slice(0, 255);
}

export function attachmentExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

export function isRejectedAttachment(fileName: string, contentType: string): boolean {
  const type = contentType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return REJECTED_EXTENSIONS.has(attachmentExtension(fileName)) || REJECTED_CONTENT_TYPES.has(type);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Buffer(hex: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid content hash");
  }
  return Buffer.from(hex, "hex");
}

export interface AttachmentStore {
  write(workspaceId: string, attachmentId: string, bytes: Uint8Array): Promise<void>;
  read(workspaceId: string, attachmentId: string): Promise<Buffer>;
  remove(workspaceId: string, attachmentId: string): Promise<void>;
}

export class LocalAttachmentStore implements AttachmentStore {
  constructor(private readonly root: string) {}

  /** Fail startup before migrations or readiness if the configured root is unusable. */
  async prepare(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const metadata = await stat(this.root);
      if (!metadata.isDirectory()) throw new Error("Configured attachment root is not a directory");
      const probePath = path.join(this.root, `.hype-comms-storage-probe-${randomUUID()}`);
      const stagingPath = `${probePath}.part`;
      const probeBytes = Buffer.from("hype-comms-storage-probe", "utf8");
      try {
        await writeFile(stagingPath, probeBytes, { flag: "wx", mode: 0o600 });
        await rename(stagingPath, probePath);
        const stored = await readFile(probePath);
        if (!stored.equals(probeBytes)) throw new Error("Attachment storage probe changed bytes");
      } finally {
        await Promise.all([rm(stagingPath, { force: true }), rm(probePath, { force: true })]);
      }
    } catch (error) {
      throw new Error(`Attachment storage is unavailable at ${this.root}`, { cause: error });
    }
  }

  #objectPath(workspaceId: string, attachmentId: string): string {
    if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(attachmentId)) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid attachment location");
    }
    return path.join(this.root, workspaceId, attachmentId);
  }

  async write(workspaceId: string, attachmentId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new ApiError(400, "BAD_REQUEST", "File exceeds the 25 MiB limit");
    }
    const objectPath = this.#objectPath(workspaceId, attachmentId);
    await mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    const stagingPath = `${objectPath}.part`;
    await writeFile(stagingPath, bytes, { mode: 0o600 });
    await rm(objectPath, { force: true });
    await rename(stagingPath, objectPath);
  }

  async read(workspaceId: string, attachmentId: string): Promise<Buffer> {
    try {
      return await readFile(this.#objectPath(workspaceId, attachmentId));
    } catch {
      throw new ApiError(404, "NOT_FOUND", "File is not available");
    }
  }

  async remove(workspaceId: string, attachmentId: string): Promise<void> {
    await rm(this.#objectPath(workspaceId, attachmentId), { force: true });
    await rm(`${this.#objectPath(workspaceId, attachmentId)}.part`, { force: true });
  }
}
