// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Reaction, User } from "@hmm-chat/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { groupReactions, MessageReactions } from "./message-reactions";

const CURRENT_USER_ID = "10000000-0000-4000-8000-000000000001";
const PEER_ID = "10000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000003";
const NOW = "2026-07-27T12:00:00.000Z";

const members: User[] = [
  {
    id: CURRENT_USER_ID,
    username: "morgan",
    displayName: "Morgan",
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: PEER_ID,
    username: "dan",
    displayName: "Dan",
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function reaction(id: string, userId: string, emoji: string): Reaction {
  return { id, messageId: MESSAGE_ID, userId, emoji, createdAt: NOW };
}

const reactions = [
  reaction("10000000-0000-4000-8000-000000000004", CURRENT_USER_ID, "🎉"),
  reaction("10000000-0000-4000-8000-000000000005", PEER_ID, "🎉"),
  reaction("10000000-0000-4000-8000-000000000006", PEER_ID, "👀"),
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageReactions", () => {
  it("groups counts and marks the current member's reaction", () => {
    const groups = groupReactions(reactions, CURRENT_USER_ID);
    expect(groups.map((group) => [group.emoji, group.reactions.length])).toEqual([
      ["🎉", 2],
      ["👀", 1],
    ]);
    expect(groups[0]?.currentUserReaction?.userId).toBe(CURRENT_USER_ID);
    expect(groups[1]?.currentUserReaction).toBeNull();
  });

  it("toggles existing groups and quick-picker choices", async () => {
    const onAdd = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onRemove = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      createElement(MessageReactions, {
        reactions,
        members,
        currentUserId: CURRENT_USER_ID,
        disabled: false,
        onAdd,
        onRemove,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /🎉 2 reactions; remove/i }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("🎉"));

    const trigger = screen.getByRole("button", { name: "Add reaction" });
    fireEvent.click(trigger);
    const firstChoice = screen.getByRole("menuitemcheckbox", { name: "Add 👍 reaction" });
    await waitFor(() => expect(document.activeElement).toBe(firstChoice));
    fireEvent.keyDown(firstChoice, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemcheckbox", { name: "Add ❤️ reaction" }),
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Add 🚀 reaction" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("🚀"));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps the picker open and reports a mutation failure", async () => {
    render(
      createElement(MessageReactions, {
        reactions: [],
        members,
        currentUserId: CURRENT_USER_ID,
        disabled: false,
        onAdd: vi.fn().mockRejectedValue(new Error("Reaction limit reached")),
        onRemove: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Add 👍 reaction" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Reaction limit reached");
    expect(screen.getByRole("menu", { name: "Choose a reaction" })).toBeTruthy();
  });

  it("disables mutation controls for archived conversations", () => {
    render(
      createElement(MessageReactions, {
        reactions,
        members,
        currentUserId: CURRENT_USER_ID,
        disabled: true,
        onAdd: vi.fn(),
        onRemove: vi.fn(),
      }),
    );

    expect(
      screen
        .getByRole("button", { name: "Reactions are unavailable in archived channels" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: /🎉 2 reactions/ }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
