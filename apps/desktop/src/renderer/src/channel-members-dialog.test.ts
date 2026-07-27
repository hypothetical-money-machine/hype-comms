// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChannelMembersResponse, User } from "@hmm-chat/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelMembersDialog } from "./channel-members-dialog";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000002";
const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const NOW = "2026-07-26T12:00:00.000Z";

function user(id: string, username: string, displayName: string): User {
  return { id, username, displayName, avatarUrl: null, createdAt: NOW, updatedAt: NOW };
}

const owner = user(OWNER_ID, "owner", "Owner");
const member = user(MEMBER_ID, "member", "Member");
const initial: ChannelMembersResponse = {
  conversationId: CONVERSATION_ID,
  access: "members",
  members: [{ user: owner, role: "owner", joinedAt: NOW }],
  canManage: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChannelMembersDialog", () => {
  it("adds available workspace members and renders the returned membership", async () => {
    const load = vi.fn().mockResolvedValue(initial);
    const upsert = vi.fn().mockResolvedValue({
      channelMembers: {
        ...initial,
        members: [...initial.members, { user: member, role: "member", joinedAt: NOW }],
      },
      syncCursor: "4",
    });
    render(
      createElement(ChannelMembersDialog, {
        channelName: "leadership",
        conversationId: CONVERSATION_ID,
        workspaceMembers: [owner, member],
        onClose: vi.fn(),
        load,
        upsert,
        remove: vi.fn(),
      }),
    );

    await screen.findByText("Owner");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID, "member"));
    expect(await screen.findByText("Member")).toBeTruthy();
  });

  it("shows a final-owner conflict without discarding the member list", async () => {
    render(
      createElement(ChannelMembersDialog, {
        channelName: "leadership",
        conversationId: CONVERSATION_ID,
        workspaceMembers: [owner],
        onClose: vi.fn(),
        load: vi.fn().mockResolvedValue(initial),
        upsert: vi.fn(),
        remove: vi.fn().mockRejectedValue(new Error("A channel must retain at least one owner")),
      }),
    );

    await screen.findByText("Owner");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A channel must retain at least one owner",
    );
    expect(screen.getByText("Owner")).toBeTruthy();
  });

  it("explains workspace-wide access without management controls", async () => {
    render(
      createElement(ChannelMembersDialog, {
        channelName: "general",
        conversationId: CONVERSATION_ID,
        workspaceMembers: [owner, member],
        onClose: vi.fn(),
        load: vi.fn().mockResolvedValue({
          ...initial,
          access: "workspace",
          members: [...initial.members, { user: member, role: "member", joinedAt: NOW }],
          canManage: false,
        }),
        upsert: vi.fn(),
        remove: vi.fn(),
      }),
    );

    expect(await screen.findByText("Open to everyone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
