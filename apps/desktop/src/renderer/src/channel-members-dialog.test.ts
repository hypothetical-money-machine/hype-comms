// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ChannelMembershipMutationResponse,
  ChannelMembersResponse,
  User,
} from "@hype-comms/contracts";
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function membersWith(...extra: readonly User[]): ChannelMembersResponse {
  return {
    ...initial,
    members: [
      ...initial.members,
      ...extra.map((user) => ({ user, role: "member" as const, joinedAt: NOW })),
    ],
  };
}

function renderChannelDialog(overrides: {
  readonly workspaceMembers?: readonly User[];
  readonly load?: (conversationId: string) => Promise<ChannelMembersResponse>;
  readonly upsert?: (
    conversationId: string,
    userId: string,
    role: "owner" | "member",
  ) => Promise<ChannelMembershipMutationResponse>;
  readonly remove?: (
    conversationId: string,
    userId: string,
  ) => Promise<ChannelMembershipMutationResponse>;
  readonly onClose?: () => void;
}) {
  return render(
    createElement(ChannelMembersDialog, {
      source: "channel",
      channelName: "leadership",
      conversationId: CONVERSATION_ID,
      currentUserId: OWNER_ID,
      workspaceMembers: overrides.workspaceMembers ?? [owner, member],
      triggerRef: unusedTrigger,
      onClose: overrides.onClose ?? vi.fn(),
      onMessage: vi.fn(),
      load: overrides.load ?? vi.fn().mockResolvedValue(initial),
      upsert: overrides.upsert ?? vi.fn(),
      remove: overrides.remove ?? vi.fn(),
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChannelMembersDialog", () => {
  it("adds checked workspace members and renders the returned membership", async () => {
    const upsert = vi.fn().mockResolvedValue({
      channelMembers: membersWith(member),
      syncCursor: "4",
    });
    renderChannelDialog({ upsert, load: vi.fn().mockResolvedValue(initial) });

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID, "member"));
    expect(await screen.findByText("Member")).toBeTruthy();
  });

  it("filters candidates by display name, username, and title, case-insensitively", async () => {
    const titledAgent: User = { ...agent, title: "Automation" };
    renderChannelDialog({ workspaceMembers: [owner, member, titledAgent] });

    await screen.findByText("Owner (you)");
    const search = screen.getByRole("searchbox", { name: "Add workspace members" });
    expect(screen.getByRole("checkbox", { name: "Member" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Hermes Agent · Automation" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "HERM" } });
    expect(screen.getByRole("checkbox", { name: "Hermes Agent · Automation" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Member" })).toBeNull();

    fireEvent.change(search, { target: { value: "automation" } });
    expect(screen.getByRole("checkbox", { name: "Hermes Agent · Automation" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "member" } });
    expect(screen.getByRole("checkbox", { name: "Member" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Hermes Agent · Automation" })).toBeNull();

    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("fires one concurrent upsert per checked member from a single Add", async () => {
    const first = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const second = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const upsert = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert });

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID, "member");
    expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, AGENT_ID, "member");

    first.resolve({ channelMembers: membersWith(member), syncCursor: "4" });
    second.resolve({ channelMembers: membersWith(member, agent), syncCursor: "5" });
    await waitFor(() => expect(screen.queryByText("Adding…")).toBeNull());
    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.getByText("Hermes Agent")).toBeTruthy();
  });

  it("shows pending rows during an add while the rest of the dialog stays interactive", async () => {
    const pendingUpsert = deferred<{
      channelMembers: ChannelMembersResponse;
      syncCursor: string;
    }>();
    const upsert = vi.fn().mockReturnValue(pendingUpsert.promise);
    const onClose = vi.fn();
    renderChannelDialog({ upsert, onClose });

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.getByText("Adding…")).toBeTruthy();
    const pendingRow = screen.getByText("Member").closest("li");
    if (pendingRow === null) throw new Error("Pending row was not rendered");
    expect(pendingRow.className).toContain("pending");
    for (const button of Array.from(pendingRow.querySelectorAll("button"))) {
      expect(button.disabled).toBe(true);
    }

    const done = screen.getByRole("button", { name: "Done" });
    expect(done.hasAttribute("disabled")).toBe(false);
    const search = screen.getByRole("searchbox", {
      name: "Add workspace members",
    }) as HTMLInputElement;
    expect(search.disabled).toBe(false);
    const ownerMessage = screen.getAllByRole("button", { name: "Message" })[0] as HTMLButtonElement;
    expect(ownerMessage.disabled).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(2);

    pendingUpsert.resolve({ channelMembers: membersWith(member), syncCursor: "4" });
    await waitFor(() => expect(screen.queryByText("Adding…")).toBeNull());
  });

  it("rolls a failed add back out of the list and names the member in the error", async () => {
    const upsert = vi.fn().mockImplementation((_, userId: string) => {
      if (userId === AGENT_ID) return Promise.reject(new Error("Agent enrollment required"));
      return Promise.resolve({ channelMembers: membersWith(member), syncCursor: "4" });
    });
    // The post-batch reconciliation load fails, so the rollback filter is the only mechanism
    // that can take the failed member back out of the list.
    const load = vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(new Error("offline"));
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert, load });

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("Hermes Agent")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Hermes Agent");
    expect(alert.textContent).toContain("Agent enrollment required");
    await waitFor(() => expect(screen.queryByText("Adding…")).toBeNull());
    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hermes Agent/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Hermes Agent" })).toBeTruthy();
  });

  it("does not let an earlier snapshot clobber a later one when responses arrive out of order", async () => {
    const first = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const second = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const upsert = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const load = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(membersWith(member, agent));
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert, load });

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    second.resolve({ channelMembers: membersWith(member, agent), syncCursor: "5" });
    await waitFor(() => expect(screen.getByText("Hermes Agent")).toBeTruthy());
    first.resolve({ channelMembers: membersWith(member), syncCursor: "4" });
    await waitFor(() => expect(screen.queryByText("Adding…")).toBeNull());
    expect(screen.getByText("Member")).toBeTruthy();
    expect(screen.getByText("Hermes Agent")).toBeTruthy();
  });

  it("discards a stale mutation response that lands after a newer one", async () => {
    const promote = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const removal = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const upsert = vi.fn().mockReturnValue(promote.promise);
    const remove = vi.fn().mockReturnValue(removal.promise);
    // Reconciliation loads fail, so the rendered list depends on the snapshot seq guard alone.
    const load = vi
      .fn()
      .mockResolvedValueOnce(membersWith(member, agent))
      .mockRejectedValue(new Error("offline"));
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert, remove, load });

    await screen.findByText("Hermes Agent");
    const memberRow = screen.getByText("Member").closest("li");
    const agentRow = screen.getByText("Hermes Agent").closest("li");
    if (memberRow === null || agentRow === null) throw new Error("Rows were not rendered");
    fireEvent.click(within(memberRow).getByRole("button", { name: "Make owner" }));
    expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID, "owner");
    fireEvent.click(within(agentRow).getByRole("button", { name: "Remove" }));
    expect(remove).toHaveBeenCalledWith(CONVERSATION_ID, AGENT_ID);

    // The remove committed after the promote on the server, so its snapshot is the newest truth.
    const promoted = { user: member, role: "owner" as const, joinedAt: NOW };
    removal.resolve({
      channelMembers: { ...initial, members: [...initial.members, promoted] },
      syncCursor: "6",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Hermes Agent/ })).toBeNull());

    // The promote response arrives late and still contains the agent; it must be discarded.
    promote.resolve({
      channelMembers: {
        ...initial,
        members: [...initial.members, promoted, { user: agent, role: "member", joinedAt: NOW }],
      },
      syncCursor: "5",
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("button", { name: /Hermes Agent/ })).toBeNull();
    const promotedRow = screen.getByText("Member").closest("li");
    if (promotedRow === null) throw new Error("Member row was not rendered");
    expect(within(promotedRow).getByText("owner")).toBeTruthy();
  });

  it("reconciles a remove whose response is discarded after a concurrent batch add", async () => {
    const removal = deferred<{ channelMembers: ChannelMembersResponse; syncCursor: string }>();
    const remove = vi.fn().mockReturnValue(removal.promise);
    const upsert = vi.fn().mockResolvedValue({
      channelMembers: membersWith(member, agent),
      syncCursor: "5",
    });
    const withoutMember: ChannelMembersResponse = {
      ...initial,
      members: [...initial.members, { user: agent, role: "member", joinedAt: NOW }],
    };
    const load = vi
      .fn()
      .mockResolvedValueOnce(membersWith(member))
      // The batch reconciliation still reads pre-remove state...
      .mockResolvedValueOnce(membersWith(member, agent))
      // ...and the remove's own trailing reconciliation reads the committed removal.
      .mockResolvedValue(withoutMember);
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert, remove, load });

    await screen.findByRole("button", { name: /Member @member/ });
    const memberRow = screen.getByText("Member").closest("li");
    if (memberRow === null) throw new Error("Member row was not rendered");
    fireEvent.click(within(memberRow).getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hermes Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    // The removal commits last; its response snapshot is stale by seq and gets discarded, so
    // the trailing reconciliation is what makes the removal visible.
    removal.resolve({ channelMembers: withoutMember, syncCursor: "7" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Member @member/ })).toBeNull(),
    );
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("checkbox", { name: "Member" })).toBeTruthy();
    expect(screen.getByText("Hermes Agent")).toBeTruthy();
  });

  it("locks only the mutated row during a role change and renders the returned role", async () => {
    const pendingPromote = deferred<{
      channelMembers: ChannelMembersResponse;
      syncCursor: string;
    }>();
    const upsert = vi.fn().mockReturnValue(pendingPromote.promise);
    const promoted: ChannelMembersResponse = {
      ...initial,
      members: [...initial.members, { user: member, role: "owner", joinedAt: NOW }],
    };
    const load = vi.fn().mockResolvedValueOnce(membersWith(member)).mockResolvedValue(promoted);
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert, load });

    await screen.findByRole("button", { name: /Member @member/ });
    const memberRow = screen.getByText("Member").closest("li");
    const ownerRow = screen.getByText("Owner (you)").closest("li");
    if (memberRow === null || ownerRow === null) throw new Error("Rows were not rendered");
    fireEvent.click(within(memberRow).getByRole("button", { name: "Make owner" }));
    expect(upsert).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID, "owner");
    for (const button of Array.from(memberRow.querySelectorAll("button"))) {
      expect(button.disabled).toBe(true);
    }
    const ownerRemove = within(ownerRow).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement;
    expect(ownerRemove.disabled).toBe(false);
    const candidate = screen.getByRole("checkbox", { name: "Hermes Agent" }) as HTMLInputElement;
    expect(candidate.disabled).toBe(false);

    pendingPromote.resolve({ channelMembers: promoted, syncCursor: "5" });
    await waitFor(() => expect(within(memberRow).getByText("owner")).toBeTruthy());
    expect(within(memberRow).getByRole("button", { name: "Make member" })).toBeTruthy();
  });

  it("clears a non-empty search query on Escape without closing the dialog", async () => {
    const onClose = vi.fn();
    renderChannelDialog({ onClose });

    await screen.findByText("Owner (you)");
    const search = screen.getByRole("searchbox", {
      name: "Add workspace members",
    }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "mem" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes the candidate checkboxes as a labelled group and announces empty results", async () => {
    renderChannelDialog({});

    await screen.findByText("Owner (you)");
    const group = screen.getByRole("group", { name: "Add workspace members" });
    expect(within(group).getByRole("checkbox", { name: "Member" })).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Add workspace members" }), {
      target: { value: "nobody" },
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("No matches");
  });

  it("clears the checked set and keeps the search input focused after a batch add", async () => {
    const upsert = vi.fn().mockResolvedValue({
      channelMembers: membersWith(member),
      syncCursor: "4",
    });
    renderChannelDialog({ workspaceMembers: [owner, member, agent], upsert });

    await screen.findByText("Owner (you)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Member" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Add workspace members" }),
    );
    await waitFor(() => expect(screen.queryByText("Adding…")).toBeNull());
    const remaining = screen.getByRole("checkbox", { name: "Hermes Agent" }) as HTMLInputElement;
    expect(remaining.checked).toBe(false);
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
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

  it("explains humans-only access without membership controls", async () => {
    render(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "people-planning",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner, agent, bot],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        load: vi.fn().mockResolvedValue({
          ...initial,
          access: "humans",
          canManage: false,
        }),
        upsert: vi.fn(),
        remove: vi.fn(),
      }),
    );

    expect(await screen.findByText("Humans only")).toBeTruthy();
    expect(
      screen.getByText(/all people in the workspace can read and send messages/i),
    ).toBeTruthy();
    expect(screen.getByText(/agents and bots cannot access this channel/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("describes announcement participation for humans-only access", async () => {
    render(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "people-updates",
        channelMode: "announcement",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [owner],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        load: vi.fn().mockResolvedValue({
          ...initial,
          access: "humans",
          canManage: false,
        }),
        upsert: vi.fn(),
        remove: vi.fn(),
      }),
    );

    expect(
      await screen.findByText(/read, reply in threads, and react.*owners can post bulletins/i),
    ).toBeTruthy();
    expect(screen.getByText(/agents and bots cannot access this channel/i)).toBeTruthy();
  });

  it("renders member titles in the directory and available-member select", async () => {
    const titledOwner: User = { ...owner, title: "Boss" };
    const titledMember: User = { ...member, title: "Helper" };
    render(
      createElement(ChannelMembersDialog, {
        source: "channel",
        channelName: "leadership",
        conversationId: CONVERSATION_ID,
        currentUserId: OWNER_ID,
        workspaceMembers: [titledOwner, titledMember],
        triggerRef: unusedTrigger,
        onClose: vi.fn(),
        onMessage: vi.fn(),
        load: vi.fn().mockResolvedValue({
          ...initial,
          members: [{ user: titledOwner, role: "owner", joinedAt: NOW }],
        }),
        upsert: vi.fn(),
        remove: vi.fn(),
      }),
    );

    expect(await screen.findByText("Boss")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Member · Helper" })).toBeTruthy();
  });

  it("messages humans and agents from a channel directory, including name and row clicks", async () => {
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
    expect(onMessage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Hermes Agent/ }));
    expect(onMessage).toHaveBeenNthCalledWith(2, AGENT_ID);
    expect(onMessage).toHaveBeenCalledTimes(2);

    const ownerRow = screen.getByText("Owner (you)").closest("li");
    if (ownerRow === null) throw new Error("Owner row was not rendered");
    fireEvent.click(ownerRow);
    expect(onMessage).toHaveBeenNthCalledWith(3, OWNER_ID);
    expect(onMessage).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByText("Release Bot"));
    const botRow = screen.getByText("Release Bot").closest("li");
    if (botRow === null) throw new Error("Bot row was not rendered");
    fireEvent.click(botRow);
    expect(screen.queryByRole("button", { name: /Release Bot/ })).toBeNull();
    expect(onMessage).toHaveBeenCalledTimes(3);
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

    fireEvent.click(screen.getByRole("button", { name: /Hermes Agent/ }));
    expect(onMessage).toHaveBeenNthCalledWith(2, AGENT_ID);

    const agentRow = screen.getByText("Hermes Agent").closest("li");
    if (agentRow === null) throw new Error("Agent row was not rendered");
    fireEvent.click(agentRow);
    expect(onMessage).toHaveBeenNthCalledWith(3, AGENT_ID);
    expect(onMessage).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByText("Release Bot"));
    expect(screen.queryByRole("button", { name: /Release Bot/ })).toBeNull();
    expect(onMessage).toHaveBeenCalledTimes(3);
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
    const openOwner = screen.getByRole("button", { name: /Owner \(you\)/ });
    const done = screen.getByRole("button", { name: "Done" });
    expect(openOwner).toBeTruthy();
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
