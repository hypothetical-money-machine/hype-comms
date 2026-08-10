import type {
  ConversationSummary,
  ListConversationsResponse,
  ListMembersResponse,
  User,
} from "@hmm-chat/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationProjectionRepairCoordinator,
  type NotificationProjectionRepairScope,
  type NotificationProjectionRepairTarget,
  type NotificationProjectionRepairTransport,
} from "./notification-projection-repair";

const NOW = "2026-08-10T12:00:00.000Z";

function id(value: number): string {
  return `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const USER_ID = id(1);
const WORKSPACE_ID = id(2);

function member(value: number): User {
  return {
    id: id(value),
    kind: "human",
    username: `member-${String(value)}`,
    displayName: `Member ${String(value)}`,
    avatarUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function conversation(value: number): ConversationSummary {
  return {
    conversation: {
      id: id(10_000 + value),
      workspaceId: WORKSPACE_ID,
      kind: "channel",
      name: `Channel ${String(value)}`,
      slug: `channel-${String(value)}`,
      topic: null,
      access: "workspace",
      isArchived: false,
      createdBy: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    participantIds: [],
    membershipRole: "member",
    lastMessage: null,
    unreadCount: 0,
    mentionCount: 0,
    readCursor: null,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function createHarness(options?: {
  readonly members?: () => Promise<ListMembersResponse>;
  readonly conversations?: (
    input: Parameters<NotificationProjectionRepairTransport["conversations"]>[0],
  ) => Promise<ListConversationsResponse>;
}) {
  let scope: NotificationProjectionRepairScope | null = {
    sessionGeneration: 1,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
  };
  const transport: NotificationProjectionRepairTransport = {
    members: vi.fn(options?.members ?? (async () => ({ members: [member(3)] }))),
    conversations: vi.fn(
      options?.conversations ??
        (async () => ({ conversations: [], nextCursor: null, hasMore: false })),
    ),
  };
  const target: NotificationProjectionRepairTarget = {
    replaceMembers: vi.fn(() => true),
    replaceConversations: vi.fn(() => true),
    disableConversationProjection: vi.fn(),
  };
  const onFailure = vi.fn();
  const coordinator = new NotificationProjectionRepairCoordinator({
    transport,
    target,
    getScope: () => scope,
    onFailure,
  });
  return {
    coordinator,
    transport,
    target,
    onFailure,
    setScope(next: NotificationProjectionRepairScope | null) {
      scope = next;
    },
  };
}

describe("NotificationProjectionRepairCoordinator", () => {
  it("follows an in-flight member repair with a fresh read for a later invalidation", async () => {
    const stale = deferred<ListMembersResponse>();
    const fresh = deferred<ListMembersResponse>();
    let call = 0;
    const harness = createHarness({
      members: () => (call++ === 0 ? stale.promise : fresh.promise),
    });

    const first = harness.coordinator.request("members");
    await Promise.resolve();
    const second = harness.coordinator.request("members");
    expect(second).toBe(first);
    expect(harness.transport.members).toHaveBeenCalledTimes(1);

    stale.resolve({ members: [member(3)] });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.transport.members).toHaveBeenCalledTimes(2);
    expect(harness.target.replaceMembers).not.toHaveBeenCalled();

    const members = [member(3), member(4)];
    fresh.resolve({ members });
    await expect(first).resolves.toBe("applied");
    expect(harness.target.replaceMembers).toHaveBeenCalledWith(members);
    expect(harness.target.replaceMembers).toHaveBeenCalledOnce();
    expect(harness.onFailure).not.toHaveBeenCalled();
  });

  it("retries a rejected stale member read when a later invalidation is already known", async () => {
    const stale = deferred<ListMembersResponse>();
    const fresh = deferred<ListMembersResponse>();
    let call = 0;
    const harness = createHarness({
      members: () => (call++ === 0 ? stale.promise : fresh.promise),
    });

    const repair = harness.coordinator.request("members");
    await Promise.resolve();
    expect(harness.coordinator.request("members")).toBe(repair);
    stale.reject(new Error("stale request failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.transport.members).toHaveBeenCalledTimes(2);
    expect(harness.onFailure).not.toHaveBeenCalled();
    fresh.resolve({ members: [member(4)] });
    await expect(repair).resolves.toBe("applied");
    expect(harness.target.replaceMembers).toHaveBeenCalledWith([member(4)]);
  });

  it("settles after one invalid authoritative member result without retrying itself", async () => {
    const harness = createHarness();
    harness.target.replaceMembers = vi.fn(() => {
      void harness.coordinator.request("members");
      return false;
    });

    await expect(harness.coordinator.request("members")).resolves.toBe("failed");
    expect(harness.transport.members).toHaveBeenCalledOnce();
    expect(harness.target.replaceMembers).toHaveBeenCalledOnce();
    expect(harness.onFailure).toHaveBeenCalledOnce();
    expect(harness.onFailure).toHaveBeenCalledWith("members");
  });

  it("drops a member response when its captured generation is no longer current", async () => {
    const pending = deferred<ListMembersResponse>();
    const harness = createHarness({ members: () => pending.promise });
    const repair = harness.coordinator.request("members");
    await Promise.resolve();

    harness.setScope({
      sessionGeneration: 2,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    pending.resolve({ members: [member(3)] });

    await expect(repair).resolves.toBe("stale");
    expect(harness.target.replaceMembers).not.toHaveBeenCalled();
    expect(harness.onFailure).not.toHaveBeenCalled();
  });

  it("does not coalesce a new generation behind a stale generation repair", async () => {
    const first = deferred<ListMembersResponse>();
    const second = deferred<ListMembersResponse>();
    let call = 0;
    const harness = createHarness({
      members: () => (call++ === 0 ? first.promise : second.promise),
    });
    const oldRepair = harness.coordinator.request("members");
    await Promise.resolve();
    harness.setScope({
      sessionGeneration: 2,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    const newRepair = harness.coordinator.request("members");
    await Promise.resolve();

    expect(newRepair).not.toBe(oldRepair);
    expect(harness.transport.members).toHaveBeenCalledTimes(2);
    first.resolve({ members: [member(3)] });
    second.resolve({ members: [member(4)] });
    await expect(oldRepair).resolves.toBe("stale");
    await expect(newRepair).resolves.toBe("applied");
    expect(harness.target.replaceMembers).toHaveBeenCalledOnce();
    expect(harness.target.replaceMembers).toHaveBeenCalledWith([member(4)]);
  });

  it("fetches every conversation page at 100 per page and replaces atomically", async () => {
    const pages = new Map<string | undefined, ListConversationsResponse>([
      [
        undefined,
        { conversations: [conversation(1), conversation(2)], nextCursor: "page-2", hasMore: true },
      ],
      ["page-2", { conversations: [conversation(3)], nextCursor: "page-3", hasMore: true }],
      ["page-3", { conversations: [conversation(4)], nextCursor: null, hasMore: false }],
    ]);
    const harness = createHarness({
      conversations: async (input) => {
        const page = pages.get(input.after);
        if (page === undefined) throw new Error("Unexpected page");
        return page;
      },
    });

    await expect(harness.coordinator.request("conversations")).resolves.toBe("applied");
    expect(harness.transport.conversations).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(harness.transport.conversations).toHaveBeenNthCalledWith(2, {
      after: "page-2",
      limit: 100,
    });
    expect(harness.transport.conversations).toHaveBeenNthCalledWith(3, {
      after: "page-3",
      limit: 100,
    });
    expect(harness.target.replaceConversations).toHaveBeenCalledOnce();
    expect(harness.target.replaceConversations).toHaveBeenCalledWith([
      conversation(1),
      conversation(2),
      conversation(3),
      conversation(4),
    ]);
  });

  it("uses a bootstrap page as an atomic catalog seed without committing it early", async () => {
    const nextPage = deferred<ListConversationsResponse>();
    const harness = createHarness({ conversations: () => nextPage.promise });

    const repair = harness.coordinator.seedConversationCatalog({
      conversations: [conversation(1)],
      nextCursor: "page-2",
      hasMore: true,
    });
    await Promise.resolve();
    expect(harness.target.disableConversationProjection).toHaveBeenCalledOnce();
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
    expect(harness.transport.conversations).toHaveBeenCalledWith({
      after: "page-2",
      limit: 100,
    });

    nextPage.resolve({
      conversations: [conversation(2)],
      nextCursor: null,
      hasMore: false,
    });
    await expect(repair).resolves.toBe("applied");
    expect(harness.target.replaceConversations).toHaveBeenCalledWith([
      conversation(1),
      conversation(2),
    ]);
  });

  it("does not let a pre-removal catalog response re-enable a removed conversation", async () => {
    const stale = deferred<ListConversationsResponse>();
    const fresh = deferred<ListConversationsResponse>();
    let call = 0;
    const harness = createHarness({
      conversations: () => (call++ === 0 ? stale.promise : fresh.promise),
    });

    const repair = harness.coordinator.request("conversations");
    await Promise.resolve();
    expect(harness.coordinator.request("conversations")).toBe(repair);
    stale.resolve({
      conversations: [conversation(1)],
      nextCursor: null,
      hasMore: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.transport.conversations).toHaveBeenCalledTimes(2);
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
    fresh.resolve({ conversations: [], nextCursor: null, hasMore: false });
    await expect(repair).resolves.toBe("applied");
    expect(harness.target.replaceConversations).toHaveBeenCalledOnce();
    expect(harness.target.replaceConversations).toHaveBeenCalledWith([]);
  });

  it("does not commit a completed catalog after its captured scope becomes stale", async () => {
    const nextPage = deferred<ListConversationsResponse>();
    const harness = createHarness({ conversations: () => nextPage.promise });
    const repair = harness.coordinator.seedConversationCatalog({
      conversations: [conversation(1)],
      nextCursor: "page-2",
      hasMore: true,
    });
    await Promise.resolve();
    harness.setScope({
      sessionGeneration: 2,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    nextPage.resolve({
      conversations: [conversation(2)],
      nextCursor: null,
      hasMore: false,
    });

    await expect(repair).resolves.toBe("stale");
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
    expect(harness.onFailure).not.toHaveBeenCalled();
  });

  it("stops an over-cap catalog without applying a partial projection", async () => {
    const page = Array.from({ length: 100 }, (_, index) => conversation(index));
    let request = 0;
    const harness = createHarness({
      conversations: async () => {
        request += 1;
        return {
          conversations: page,
          nextCursor: `page-${String(request + 1)}`,
          hasMore: true,
        };
      },
    });

    await expect(harness.coordinator.request("conversations")).resolves.toBe("overflow");
    expect(harness.transport.conversations).toHaveBeenCalledTimes(50);
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
    expect(harness.target.disableConversationProjection).toHaveBeenCalledOnce();
    expect(harness.onFailure).toHaveBeenCalledOnce();
    expect(harness.onFailure).toHaveBeenCalledWith("conversation_limit");
  });

  it("fails closed on a broken pagination cursor without looping", async () => {
    const harness = createHarness({
      conversations: async () => ({
        conversations: [conversation(1)],
        nextCursor: null,
        hasMore: true,
      }),
    });

    await expect(harness.coordinator.request("conversations")).resolves.toBe("failed");
    expect(harness.transport.conversations).toHaveBeenCalledOnce();
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
    expect(harness.onFailure).toHaveBeenCalledWith("conversations");
  });

  it("rejects a terminal page that still advertises a next cursor", async () => {
    const harness = createHarness({
      conversations: async () => ({
        conversations: [conversation(1)],
        nextCursor: "unexpected-page",
        hasMore: false,
      }),
    });

    await expect(harness.coordinator.request("conversations")).resolves.toBe("failed");
    expect(harness.transport.conversations).toHaveBeenCalledOnce();
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
    expect(harness.onFailure).toHaveBeenCalledWith("conversations");
  });

  it("reports only a generic failure category when an authorized refresh rejects", async () => {
    const harness = createHarness({
      members: async () => {
        throw new Error("private response detail");
      },
    });

    await expect(harness.coordinator.request("members")).resolves.toBe("failed");
    expect(harness.onFailure).toHaveBeenCalledWith("members");
    expect(harness.onFailure).not.toHaveBeenCalledWith(expect.stringContaining("private"));
  });

  it("does not start a request without an active notification scope", async () => {
    const harness = createHarness();
    harness.setScope(null);

    await expect(harness.coordinator.request("conversations")).resolves.toBe("stale");
    expect(harness.transport.conversations).not.toHaveBeenCalled();
    expect(harness.target.replaceConversations).not.toHaveBeenCalled();
  });
});
