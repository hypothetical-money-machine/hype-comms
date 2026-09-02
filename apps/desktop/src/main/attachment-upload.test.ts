import type { Attachment } from "@hype-comms/contracts";
import { describe, expect, it, vi } from "vitest";

import { ATTACHMENT_UPLOAD_SCOPE_CHANGED_MESSAGE } from "../shared/attachment-upload";
import {
  attachmentUploadDialogOptions,
  uploadSelectedConversationFiles,
} from "./attachment-upload";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-08-31T12:00:00.000Z";

function attachment(id: string, fileName: string): Attachment {
  return {
    id,
    messageId: null,
    uploadedBy: "10000000-0000-4000-8000-000000000002",
    fileName,
    contentType: "image/png",
    sizeBytes: 2048,
    status: "ready",
    downloadUrl: null,
    createdAt: NOW,
  };
}

describe("attachment file picker", () => {
  it("allows a multi-file native selection", () => {
    expect(attachmentUploadDialogOptions).toMatchObject({
      title: "Attach files",
      buttonLabel: "Attach files",
      properties: ["openFile", "multiSelections"],
    });
  });

  it("does not upload cancelled selections", async () => {
    const upload = vi.fn();

    await expect(
      uploadSelectedConversationFiles(
        { canceled: true, filePaths: ["/images/one.png"] },
        { conversationId: CONVERSATION_ID, maxFiles: 2 },
        upload,
      ),
    ).resolves.toEqual({ status: "cancelled" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a selection above the remaining capacity before uploading", async () => {
    const upload = vi.fn();

    await expect(
      uploadSelectedConversationFiles(
        { canceled: false, filePaths: ["/images/one.png", "/images/two.png"] },
        { conversationId: CONVERSATION_ID, maxFiles: 1 },
        upload,
      ),
    ).resolves.toEqual({ status: "failed", reason: "selection_limit" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads the selected files in picker order", async () => {
    const first = attachment("10000000-0000-4000-8000-000000000010", "one.png");
    const second = attachment("10000000-0000-4000-8000-000000000011", "two.png");
    let releaseFirst: (() => void) | undefined;
    const firstUpload = new Promise<Attachment>((resolve) => {
      releaseFirst = () => resolve(first);
    });
    const upload = vi.fn((conversationId: string, filePath: string): Promise<Attachment> => {
      if (filePath === "/images/one.png") {
        expect(conversationId).toBe(CONVERSATION_ID);
        return firstUpload;
      }
      return Promise.resolve(second);
    });

    const result = uploadSelectedConversationFiles(
      { canceled: false, filePaths: ["/images/one.png", "/images/two.png"] },
      { conversationId: CONVERSATION_ID, maxFiles: 2 },
      upload,
    );
    expect(upload).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledWith(CONVERSATION_ID, "/images/one.png");

    releaseFirst?.();

    await expect(result).resolves.toEqual({ status: "completed", attachments: [first, second] });
    expect(upload).toHaveBeenNthCalledWith(2, CONVERSATION_ID, "/images/two.png");
  });

  it("keeps earlier uploads when a later file fails", async () => {
    const first = attachment("10000000-0000-4000-8000-000000000010", "one.png");
    const upload = vi
      .fn<(conversationId: string, filePath: string) => Promise<Attachment>>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("File is not available"));

    await expect(
      uploadSelectedConversationFiles(
        { canceled: false, filePaths: ["/images/one.png", "/images/two.png"] },
        { conversationId: CONVERSATION_ID, maxFiles: 2 },
        upload,
      ),
    ).resolves.toEqual({
      status: "partial",
      reason: "upload_failed",
      attachments: [first],
      message: "File is not available",
    });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("stops before the next file when its signed-in scope changes", async () => {
    const first = attachment("10000000-0000-4000-8000-000000000010", "one.png");
    const upload = vi
      .fn<(conversationId: string, filePath: string) => Promise<Attachment>>()
      .mockResolvedValueOnce(first);
    let scopeChecks = 0;

    await expect(
      uploadSelectedConversationFiles(
        { canceled: false, filePaths: ["/images/one.png", "/images/two.png"] },
        { conversationId: CONVERSATION_ID, maxFiles: 2 },
        upload,
        () => {
          scopeChecks += 1;
          // The first two checks fence the first upload. The next check happens before file two.
          return scopeChecks < 3;
        },
      ),
    ).resolves.toEqual({
      status: "partial",
      reason: "upload_failed",
      attachments: [first],
      message: ATTACHMENT_UPLOAD_SCOPE_CHANGED_MESSAGE,
    });
    expect(upload).toHaveBeenCalledOnce();
  });

  it("returns the first upload error to the composer", async () => {
    const upload = vi
      .fn<(conversationId: string, filePath: string) => Promise<Attachment>>()
      .mockRejectedValueOnce(new Error("one.png exceeds the 25 MiB limit"));

    await expect(
      uploadSelectedConversationFiles(
        { canceled: false, filePaths: ["/images/one.png"] },
        { conversationId: CONVERSATION_ID, maxFiles: 1 },
        upload,
      ),
    ).resolves.toEqual({
      status: "failed",
      reason: "upload_failed",
      message: "one.png exceeds the 25 MiB limit",
    });
  });
});
