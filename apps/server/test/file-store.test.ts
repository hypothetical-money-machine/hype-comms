import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isRejectedAttachment,
  LocalAttachmentStore,
  sanitizeFileName,
  sha256Hex,
} from "../src/modules/workspace/file-store.js";

describe("attachment file rules", () => {
  it("keeps a display name and rejects path components", () => {
    expect(sanitizeFileName("notes.pdf")).toBe("notes.pdf");
    expect(sanitizeFileName("nested/notes.pdf")).toBe("notes.pdf");
    expect(() => sanitizeFileName("..")).toThrow("File name is invalid");
    expect(() => sanitizeFileName("")).toThrow("File name is invalid");
  });

  it("rejects executables while allowing documents, images, and recordings", () => {
    expect(isRejectedAttachment("setup.exe", "application/x-msdownload")).toBe(true);
    expect(isRejectedAttachment("install.sh", "text/plain")).toBe(true);
    expect(isRejectedAttachment("brief.pdf", "application/pdf")).toBe(false);
    expect(isRejectedAttachment("clip.webm", "video/webm")).toBe(false);
    expect(isRejectedAttachment("memo.m4a", "audio/mp4")).toBe(false);
  });
});

describe("LocalAttachmentStore", () => {
  it("prepares a private writable root and rejects a non-directory root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "hype-comms-attachment-root-"));
    const root = path.join(parent, "nested", "attachments");
    try {
      await new LocalAttachmentStore(root).prepare();
      const metadata = await stat(root);
      expect(metadata.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o700);
      await expect(readdir(root)).resolves.toEqual([]);

      const fileRoot = path.join(parent, "not-a-directory");
      await writeFile(fileRoot, "blocked");
      await expect(new LocalAttachmentStore(fileRoot).prepare()).rejects.toThrow(
        "Attachment storage is unavailable",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("writes, reads, and removes one object", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hype-comms-attachments-"));
    const store = new LocalAttachmentStore(root);
    const workspaceId = "10000000-0000-4000-8000-000000000001";
    const attachmentId = "10000000-0000-4000-8000-000000000002";
    const bytes = Buffer.from("hello dogfood");
    try {
      await store.write(workspaceId, attachmentId, bytes);
      await expect(store.read(workspaceId, attachmentId)).resolves.toEqual(bytes);
      expect(sha256Hex(bytes)).toHaveLength(64);
      await store.remove(workspaceId, attachmentId);
      await expect(store.read(workspaceId, attachmentId)).rejects.toThrow("File is not available");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
