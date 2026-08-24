// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { type Message, type User } from "@hype-comms/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageRow } from "./App";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000002";
const NOW = "2026-08-04T12:00:00.000Z";

const baseUser: User = {
  id: USER_ID,
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const baseMessage: Message = {
  id: MESSAGE_ID,
  conversationId: "10000000-0000-4000-8000-000000000003",
  conversationSequence: "1",
  version: 1,
  clientMessageId: "10000000-0000-4000-8000-000000000004",
  authorId: USER_ID,
  threadRootId: null,
  body: "Hello",
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

afterEach(cleanup);

function renderMessage(overrides: {
  readonly members?: readonly User[];
  readonly message?: Message;
}) {
  return render(
    createElement(MessageRow, {
      message: overrides.message ?? baseMessage,
      members: overrides.members ?? [baseUser],
      reactions: [],
      currentUserId: USER_ID,
      reactionsDisabled: false,
      onAddReaction: vi.fn().mockResolvedValue(undefined),
      onRemoveReaction: vi.fn().mockResolvedValue(undefined),
      highlighted: false,
      continuation: false,
    }),
  );
}

describe("MessageRow author title", () => {
  it("shows a titled author's title next to their display name", () => {
    const author: User = { ...baseUser, title: "Engineering Lead" };

    renderMessage({ members: [author] });

    expect(screen.getByText("Morgan")).not.toBeNull();
    expect(screen.getByText("Engineering Lead")).not.toBeNull();
    expect(screen.getByText("Engineering Lead").classList).toContain("message-author-title");
  });

  it("shows only the display name when the author has no title", () => {
    renderMessage({ members: [{ ...baseUser, title: null }] });

    expect(screen.getByText("Morgan")).not.toBeNull();
    expect(screen.queryByText(/Engineering Lead/i)).toBeNull();
    expect(document.querySelector(".message-author-title")).toBeNull();
  });

  it("shows a bot author's title if present", () => {
    const bot: User = {
      ...baseUser,
      kind: "bot",
      displayName: "Release Bot",
      title: "Automation",
    };

    renderMessage({ members: [bot] });

    expect(screen.getByText("Release Bot")).not.toBeNull();
    expect(screen.getByText("Automation")).not.toBeNull();
  });

  it("falls back to Former member when the author is missing from the members list", () => {
    renderMessage({ members: [] });

    expect(screen.getByText("Former member")).not.toBeNull();
    expect(document.querySelector(".message-author-title")).toBeNull();
  });
});
