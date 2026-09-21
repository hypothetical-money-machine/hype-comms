// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState, type ComponentProps } from "react";
import { MESSAGE_RETRACT_WINDOW_MS, type Message, type User } from "@hype-comms/contracts";
import { afterEach, expect, it, vi } from "vitest";
import type * as MessageBodyModule from "./message-body";
import { formatMessageTime, TimelineMessageRow } from "./App";

const rendering = vi.hoisted(() => ({ bodies: 0 }));
vi.mock("./message-body", async (importOriginal) => {
  const actual = await importOriginal<typeof MessageBodyModule>();
  return {
    ...actual,
    MessageBody: (props: ComponentProps<typeof actual.MessageBody>) => {
      rendering.bodies += 1;
      return createElement(actual.MessageBody, props);
    },
  };
});

const NOW = "2026-09-06T12:00:00.000Z";
const user: User = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "human",
  username: "morgan",
  displayName: "Morgan",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const message: Message = {
  id: "10000000-0000-4000-8000-000000000002",
  conversationId: "10000000-0000-4000-8000-000000000003",
  conversationSequence: "1",
  version: 1,
  clientMessageId: "10000000-0000-4000-8000-000000000004",
  authorId: user.id,
  threadRootId: null,
  body: "Hello **world**",
  bodyFormat: "hype_comms_markdown_v1",
  editedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function rowProps(): ComponentProps<typeof TimelineMessageRow> {
  return {
    message,
    members: [user],
    reactions: [],
    attachments: [],
    currentUserId: user.id,
    reactionsDisabled: false,
    highlighted: false,
    continuation: false,
    threadAvailable: true,
    onCreateTask: vi.fn().mockResolvedValue(undefined),
    runtime: {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      retractMessage: vi.fn().mockResolvedValue(undefined),
      openFile: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn().mockResolvedValue(undefined),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  rendering.bodies = 0;
});

it("keeps unchanged rows out of parent draft updates", () => {
  const props = rowProps();
  function ComposerAndRow() {
    const [draft, setDraft] = useState("");
    return createElement(
      "div",
      null,
      createElement("input", {
        value: draft,
        onChange: (event) => setDraft(event.currentTarget.value),
      }),
      createElement("output", null, draft),
      createElement(TimelineMessageRow, props),
    );
  }
  const { container } = render(createElement(ComposerAndRow));
  const article = container.querySelector("article");
  for (const value of ["a", "ab", "abc"]) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value } });
    expect(container.querySelector("output")?.textContent).toBe(value);
  }
  expect(container.querySelector("article")).toBe(article);
  expect(rendering.bodies).toBe(1);
});

it("updates edited bodies, members, timestamp preferences, grouping and highlights", () => {
  const props = rowProps();
  const { container, rerender } = render(createElement(TimelineMessageRow, props));
  rerender(
    createElement(TimelineMessageRow, {
      ...props,
      message: { ...message, body: "Edited **content**", version: 2 },
      members: [{ ...user, displayName: "Renamed member", title: "Designer" }],
      timestampFormat: "24-hour",
      continuation: true,
      highlighted: true,
    }),
  );
  expect(screen.queryByText("world")).toBeNull();
  expect(screen.getByText("content").tagName).toBe("STRONG");
  expect(screen.getByText("Renamed member")).toBeDefined();
  expect(screen.getByText("Designer")).toBeDefined();
  expect(container.querySelector("article")?.classList.contains("message-continuation")).toBe(true);
  expect(container.querySelector("article")?.classList.contains("search-target")).toBe(true);
  expect(container.querySelector("time")?.textContent).toBe(formatMessageTime(NOW, "24-hour"));
});

it("refreshes thread and task capabilities and disables reactions when archived", () => {
  const props = rowProps();
  const { rerender } = render(createElement(TimelineMessageRow, props));
  expect(screen.getByRole("button", { name: "Reply in thread" })).toBeDefined();
  expect(screen.getByRole("button", { name: "+ Task" })).toBeDefined();
  rerender(createElement(TimelineMessageRow, { ...props, replyCount: 2 }));
  expect(screen.getByRole("button", { name: "Open thread with 2 replies" })).toBeDefined();
  rerender(
    createElement(TimelineMessageRow, {
      ...props,
      threadAvailable: false,
      onCreateTask: undefined,
      reactionsDisabled: true,
    }),
  );
  expect(screen.queryByRole("button", { name: /thread/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "+ Task" })).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Reactions are unavailable in archived channels",
    }).disabled,
  ).toBe(true);
});

it("uses replacement handlers and the current message for row actions", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const old = rowProps();
  const { rerender } = render(createElement(TimelineMessageRow, old));
  const next = rowProps();
  const updated = {
    ...message,
    id: "10000000-0000-4000-8000-000000000006",
    body: "Changed message",
    version: 2,
  };
  rerender(createElement(TimelineMessageRow, { ...next, message: updated }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "+ Task" }));
    fireEvent.click(screen.getByRole("button", { name: "Reply in thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Retract message" }));
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Add 👍 reaction" }));
  });
  expect(next.onCreateTask).toHaveBeenCalledWith(updated);
  expect(next.runtime.openThread).toHaveBeenCalledWith(updated.id);
  expect(next.runtime.retractMessage).toHaveBeenCalledWith(updated.id);
  expect(next.runtime.addReaction).toHaveBeenCalledWith(updated.id, "👍");
  expect(old.onCreateTask).not.toHaveBeenCalled();
  expect(old.runtime.openThread).not.toHaveBeenCalled();
  expect(old.runtime.retractMessage).not.toHaveBeenCalled();
  expect(old.runtime.addReaction).not.toHaveBeenCalled();
  rerender(
    createElement(TimelineMessageRow, {
      ...next,
      message: updated,
      reactions: [
        { id: "reaction", messageId: updated.id, userId: user.id, emoji: "👍", createdAt: NOW },
      ],
    }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "👍 1 reaction; remove your reaction" }));
  });
  expect(next.runtime.removeReaction).toHaveBeenCalledWith(updated.id, "👍");
});

it("expires the retract control even when parent props have not changed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  render(createElement(TimelineMessageRow, rowProps()));
  expect(screen.getByRole("button", { name: "Retract message" })).toBeDefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MESSAGE_RETRACT_WINDOW_MS);
  });
  expect(screen.getByRole("button", { name: "Retract message" })).toBeDefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.queryByRole("button", { name: "Retract message" })).toBeNull();
});

it("updates attachment and channel links without retaining obsolete actions", async () => {
  const props = rowProps();
  const linkedMessage = { ...message, body: "Meet in #general" };
  const oldOpenChannel = vi.fn();
  const { rerender } = render(
    createElement(TimelineMessageRow, {
      ...props,
      message: linkedMessage,
      onOpenChannel: oldOpenChannel,
    }),
  );
  expect(screen.queryByRole("button", { name: "#general" })).toBeNull();
  const nextOpenChannel = vi.fn();
  const next = {
    ...props,
    message: linkedMessage,
    onOpenChannel: nextOpenChannel,
    channelReferences: [{ conversationId: message.conversationId, slug: "general" }],
    attachments: [
      {
        id: "10000000-0000-4000-8000-000000000005",
        messageId: message.id,
        uploadedBy: user.id,
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 42,
        status: "ready" as const,
        downloadUrl: null,
        createdAt: NOW,
      },
    ],
  };
  rerender(createElement(TimelineMessageRow, next));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "#general" }));
    fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
  });
  expect(oldOpenChannel).not.toHaveBeenCalled();
  expect(nextOpenChannel).toHaveBeenCalledWith(message.conversationId);
  expect(props.runtime.openFile).toHaveBeenCalledWith(next.attachments[0]?.id);
  rerender(createElement(TimelineMessageRow, { ...next, attachments: [], channelReferences: [] }));
  expect(screen.queryByRole("button", { name: "notes.txt" })).toBeNull();
  expect(screen.queryByRole("button", { name: "#general" })).toBeNull();
});

it("refreshes ownership controls when the current user changes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const props = rowProps();
  const { rerender } = render(createElement(TimelineMessageRow, props));
  expect(screen.getByRole("button", { name: "Retract message" })).toBeDefined();
  rerender(createElement(TimelineMessageRow, { ...props, currentUserId: "another-user" }));
  expect(screen.queryByRole("button", { name: "Retract message" })).toBeNull();
});
