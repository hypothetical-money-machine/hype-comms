// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Attachment, User } from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesView, formatFileSize } from "./files-view";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-08-04T12:00:00.000Z";

const user: User = {
  id: USER_ID,
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const file: Attachment = {
  id: "10000000-0000-4000-8000-000000000010",
  messageId: "10000000-0000-4000-8000-000000000011",
  uploadedBy: USER_ID,
  fileName: "launch-notes.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  status: "ready",
  downloadUrl: null,
  createdAt: NOW,
};

afterEach(cleanup);

describe("FilesView", () => {
  it("lists shared files and can open or jump to the source message", () => {
    const onOpen = vi.fn().mockResolvedValue(undefined);
    const onOpenSource = vi.fn();
    render(
      createElement(FilesView, {
        conversationName: "# General",
        files: [file],
        members: [user],
        busy: false,
        error: null,
        onOpen,
        onOpenSource,
      }),
    );

    expect(screen.getByText("launch-notes.pdf")).toBeTruthy();
    expect(screen.getByText(/Morgan/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith(file.id);
    fireEvent.click(screen.getByRole("button", { name: "Show in chat" }));
    expect(onOpenSource).toHaveBeenCalledWith(file);
  });

  it("shows an empty state when the conversation has no files", () => {
    render(
      createElement(FilesView, {
        conversationName: "Dan",
        files: [],
        members: [user],
        busy: false,
        error: null,
        onOpen: vi.fn(),
        onOpenSource: vi.fn(),
      }),
    );
    expect(screen.getByText("No files have been shared here yet.")).toBeTruthy();
  });
});

describe("formatFileSize", () => {
  it("formats byte sizes for the files list", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
