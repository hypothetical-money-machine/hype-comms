// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MessageSearchResult, User } from "@hmm-chat/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceSearch } from "./workspace-search";

const NOW = "2026-07-26T12:00:00.000Z";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "10000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000003";

const member: User = {
  id: USER_ID,
  kind: "human",
  username: "claire",
  displayName: "Claire",
  avatarUrl: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const result: MessageSearchResult = {
  message: {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    conversationSequence: "7",
    version: 1,
    clientMessageId: MESSAGE_ID,
    authorId: USER_ID,
    threadRootId: null,
    body: "Quarterly avalanche review",
    bodyFormat: "hmm_markdown_v1",
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
};

function renderSearch(
  search = vi.fn().mockResolvedValue({ results: [result], nextCursor: null }),
  openResult = vi.fn().mockResolvedValue(undefined),
) {
  render(
    createElement(WorkspaceSearch, {
      members: [member],
      conversationName: () => "# General",
      search,
      openResult,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Search messages" }));
  return { search, openResult };
}

function submitQuery(query: string): void {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), {
    target: { value: query },
  });
  const form = screen.getByRole("dialog").querySelector("form");
  if (form === null) throw new Error("Search form was not rendered");
  fireEvent.submit(form);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceSearch", () => {
  it("searches, renders message context, and opens a selected result", async () => {
    const { search, openResult } = renderSearch();
    submitQuery("quarterly avalanche");

    expect(await screen.findByText("Quarterly avalanche review")).toBeTruthy();
    expect(screen.getByText("# General")).toBeTruthy();
    expect(screen.getByText(/Claire/)).toBeTruthy();
    expect(search).toHaveBeenCalledWith("quarterly avalanche", undefined);
    fireEvent.click(screen.getByRole("button", { name: /Quarterly avalanche review/ }));
    await waitFor(() => expect(openResult).toHaveBeenCalledWith(result));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("appends a cursor page without discarding earlier results", async () => {
    const secondResult: MessageSearchResult = {
      message: { ...result.message, id: USER_ID, body: "Quarterly avalanche follow-up" },
    };
    const search = vi
      .fn()
      .mockResolvedValueOnce({ results: [result], nextCursor: "next-page" })
      .mockResolvedValueOnce({ results: [secondResult], nextCursor: null });
    renderSearch(search);
    submitQuery("quarterly avalanche");
    await screen.findByText(result.message.body);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(secondResult.message.body)).toBeTruthy();
    expect(screen.getByText(result.message.body)).toBeTruthy();
    expect(search).toHaveBeenLastCalledWith("quarterly avalanche", "next-page");
  });

  it("keeps a failed search in the dialog with a useful error", async () => {
    renderSearch(vi.fn().mockRejectedValue(new Error("Search is temporarily unavailable")));
    submitQuery("quarterly avalanche");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Search is temporarily unavailable",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
