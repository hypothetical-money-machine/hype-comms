// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChannelMembersResponse, User } from "@hype-comms/contracts";
import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelMembersDialog } from "./channel-members-dialog";

const CONVERSATION_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000002";
const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const AGENT_ID = "10000000-0000-4000-8000-000000000004";
const BOT_ID = "10000000-0000-4000-8000-000000000005";
const NOW = "2026-07-26T12:00:00.000Z";

function user(
  id: string,
  username: string,
  displayName: string,
  kind: User["kind"] = "human",
): User {
  return {
    id,
    kind,
    username,
    displayName,
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const owner = user(OWNER_ID, "owner", "Owner");
const member = user(MEMBER_ID, "member", "Member");
const agent = user(AGENT_ID, "hermes", "Hermes Agent", "agent");
const bot = user(BOT_ID, "release-bot", "Release Bot", "bot");
const initial: ChannelMembersResponse = {
  conversationId: CONVERSATION_ID,
  access: "members",
  members: [{ user: owner, role: "owner", joinedAt: NOW }],
  canManage: true,
};

const unusedTrigger = { current: null };

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
        source: "channel",
        channelName: "leadership",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner, member],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        load,
        upsert,
        remove: vi.fn(),
      }),
    );

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID, "member"));
    expect(await screen.findByText("Member")).toBeTruthy();
  });

  it("shows a final-owner conflict without discarding the member list", async () => {
    render(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "leadership",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        load: vi.fn().mockResolvedValue(initial),
        upsert: vi.fn(),
        remove: vi.fn().mockRejectedValue(new Error("A channel must retain at least one owner")),
      }),
    );

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A channel must retain at least one owner",
    );
    expect(screen.getByText("Owner (you)")).toBeTruthy();
  });

  it("explains workspace-wide access without management controls", async () => {
    render(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "general",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner, member],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
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

  it("messages humans and agents from a channel directory without treating the row as navigation", async () => {
    const onMessage = vi.fn();
    render(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "general",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner, agent, bot],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage,
        load: vi.fn().mockResolvedValue({
          ...initial,
          access: "workspace",
          members: [
            { user: owner, role: "member", joinedAt: NOW },
            { user: agent, role: "member", joinedAt: NOW },
            { user: bot, role: "member", joinedAt: NOW },
          ],
          canManage: false,
        }),
        upsert: vi.fn(),
        remove: vi.fn(),
      }),
    );

    expect(await screen.findByText("Hermes Agent")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Bot")).toBeTruthy();
    const messageButtons = screen.getAllByRole("button", { name: "Message" });
    expect(messageButtons).toHaveLength(2);
    fireEvent.click(messageButtons[1]!);
    expect(onMessage).toHaveBeenCalledWith(AGENT_ID);
  });

  it("lists the workspace directory without loading channel membership", () => {
    const onMessage = vi.fn();
    render(
      createElement(ChannelMembersDialog, {
        source: "workspace",
        currentUserId: OWNER_ID,
        workspaceMembers: [owner, agent, bot],
        presenceByUser: { [AGENT_ID]: "online" },
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage,
      }),
    );

    expect(screen.getByRole("heading", { name: "People" })).toBeTruthy();
    expect(screen.getByText("Owner (you)")).toBeTruthy();
    expect(screen.getByText("Hermes Agent")).toBeTruthy();
    expect(screen.getByLabelText("Presence: online")).toBeTruthy();
    expect(screen.getByText("Release Bot")).toBeTruthy();
    expect(screen.queryByText("Loading members…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Message" })[0]!);
    expect(onMessage).toHaveBeenCalledWith(OWNER_ID);
    expect(screen.getAllByRole("button", { name: "Message" })).toHaveLength(2);
  });

  it("names the close control after the dialog variant", async () => {
    const { rerender } = render(
      createElement(ChannelMembersDialog, {
        source: "workspace",
        currentUserId: OWNER_ID,
        workspaceMembers: [owner],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
      }),
    );
    expect(screen.getByRole("button", { name: "Close people" })).toBeTruthy();

    rerender(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "leadership",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        load: vi.fn().mockResolvedValue(initial),
        upsert: vi.fn(),
        remove: vi.fn(),
      }),
    );
    expect(await screen.findByRole("button", { name: "Close channel access" })).toBeTruthy();
  });

  it("keeps Tab and Shift+Tab focus inside the workspace directory", () => {
    render(
      createElement(ChannelMembersDialog, {
        source: "workspace",
        currentUserId: OWNER_ID,
        workspaceMembers: [owner],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
      }),
    );

    const close = screen.getByRole("button", { name: "Close people" });
    const done = screen.getByRole("button", { name: "Done" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(done);

    fireEvent.keyDown(done, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("restores focus to the trigger when unmounted", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const dialog = createElement(ChannelMembersDialog, {
      source: "workspace",
      currentUserId: OWNER_ID,
      workspaceMembers: [owner],
      triggerRef,
      onClose: vi.fn(),
      onMessage: vi.fn(),
    });
    const { rerender } = render(
      createElement("div", null, [
        createElement("button", { key: "trigger", ref: triggerRef, type: "button" }, "People"),
        dialog,
      ]),
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close people" }));
    rerender(
      createElement("div", null, [
        createElement("button", { key: "trigger", ref: triggerRef, type: "button" }, "People"),
      ]),
    );
    expect(document.activeElement).toBe(triggerRef.current);
  });

  it("reports compact-chrome open and close around its mount lifetime", () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(
      createElement(ChannelMembersDialog, {
        source: "workspace",
        currentUserId: OWNER_ID,
        workspaceMembers: [owner],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        onOpenChange,
      }),
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    unmount();
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});
