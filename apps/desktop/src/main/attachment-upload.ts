import type { Attachment } from "@hype-comms/contracts";
import type { OpenDialogOptions } from "electron";

import {
  AttachmentUploadScopeChangedError,
  type AttachmentUploadRequest,
  type AttachmentUploadResult,
} from "../shared/attachment-upload";

export const attachmentUploadDialogOptions = {
  title: "Attach files",
  buttonLabel: "Attach files",
  properties: ["openFile", "multiSelections"],
} satisfies OpenDialogOptions;

interface FileSelection {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

function uploadFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim().slice(0, 500);
  }
  return "Could not attach the selected file";
}

function assertCurrentUploadScope(isCurrentScope: () => boolean): void {
  if (!isCurrentScope()) throw new AttachmentUploadScopeChangedError();
}

/**
 * Upload one native-picker selection in order. Returning prior successes on a later failure keeps
 * completed files available to the message composer; the server does not provide an abort route.
 */
export async function uploadSelectedConversationFiles(
  selection: FileSelection,
  request: AttachmentUploadRequest,
  upload: (conversationId: string, filePath: string) => Promise<Attachment>,
  isCurrentScope: () => boolean = () => true,
): Promise<AttachmentUploadResult> {
  if (selection.canceled || selection.filePaths.length === 0) return { status: "cancelled" };
  if (selection.filePaths.length > request.maxFiles) {
    return { status: "failed", reason: "selection_limit" };
  }

  const attachments: Attachment[] = [];
  for (const filePath of selection.filePaths) {
    try {
      assertCurrentUploadScope(isCurrentScope);
      const attachment = await upload(request.conversationId, filePath);
      assertCurrentUploadScope(isCurrentScope);
      attachments.push(attachment);
    } catch (error) {
      const message = uploadFailureMessage(error);
      return attachments.length === 0
        ? { status: "failed", reason: "upload_failed", message }
        : { status: "partial", reason: "upload_failed", attachments, message };
    }
  }
  return { status: "completed", attachments };
}
