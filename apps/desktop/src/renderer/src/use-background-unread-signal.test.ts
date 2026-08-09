// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationSummary } from "@hmm-chat/contracts";

import { useBackgroundUnreadSignal } from "./use-background-unread-signal";

function summary(id: string, unreadCount: number, mentionCount = 0): ConversationSummary {
  return { conversation: { id }, unreadCount, mentionCount } as ConversationSummary;
}

interface HookProps {
  readonly conversations: readonly ConversationSummary[] | null;
  readonly selectedConversationId: string | null;
  readonly onNewActivity: () => void;
}

function renderSignal(initial: HookProps) {
  return renderHook(
    ({ conversations, selectedConversationId, onNewActivity }: HookProps) =>
      useBackgroundUnreadSignal(conversations, selectedConversationId, onNewActivity),
    { initialProps: initial },
  );
}

describe("useBackgroundUnreadSignal", () => {
  it("signals when unread counts grow in a non-selected conversation", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: [summary("a", 0), summary("b", 0)],
      selectedConversationId: "a",
      onNewActivity,
    });

    rerender({
      conversations: [summary("a", 0), summary("b", 1)],
      selectedConversationId: "a",
      onNewActivity,
    });
    expect(onNewActivity).toHaveBeenCalledTimes(1);
  });

  it("does not signal for the bootstrap baseline", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: null,
      selectedConversationId: null,
      onNewActivity,
    });

    rerender({
      conversations: [summary("a", 0), summary("b", 7)],
      selectedConversationId: "a",
      onNewActivity,
    });
    expect(onNewActivity).not.toHaveBeenCalled();
  });

  it("ignores unread growth in the selected conversation", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: [summary("a", 0), summary("b", 0)],
      selectedConversationId: "a",
      onNewActivity,
    });

    rerender({
      conversations: [summary("a", 3), summary("b", 0)],
      selectedConversationId: "a",
      onNewActivity,
    });
    expect(onNewActivity).not.toHaveBeenCalled();
  });

  it("treats a conversation switch as a baseline change, not activity", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: [summary("a", 3), summary("b", 0)],
      selectedConversationId: "a",
      onNewActivity,
    });

    // Switching to B moves A's count into the watched total; that must not pulse.
    rerender({
      conversations: [summary("a", 3), summary("b", 0)],
      selectedConversationId: "b",
      onNewActivity,
    });
    expect(onNewActivity).not.toHaveBeenCalled();

    // Growth after the switch is real activity again.
    rerender({
      conversations: [summary("a", 4), summary("b", 0)],
      selectedConversationId: "b",
      onNewActivity,
    });
    expect(onNewActivity).toHaveBeenCalledTimes(1);
  });

  it("signals growth in one conversation even when another shrinks by more", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: [summary("a", 5), summary("b", 0), summary("c", 0)],
      selectedConversationId: "c",
      onNewActivity,
    });

    // A's unreads were read on another device in the same update that a message lands in B;
    // the summed total drops but B still deserves the pulse.
    rerender({
      conversations: [summary("a", 0), summary("b", 1), summary("c", 0)],
      selectedConversationId: "c",
      onNewActivity,
    });
    expect(onNewActivity).toHaveBeenCalledTimes(1);
  });

  it("treats a brand-new conversation's unreads as activity", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: [summary("a", 0)],
      selectedConversationId: "a",
      onNewActivity,
    });

    rerender({
      conversations: [summary("a", 0), summary("b", 1)],
      selectedConversationId: "a",
      onNewActivity,
    });
    expect(onNewActivity).toHaveBeenCalledTimes(1);
  });

  it("counts mentions as activity", () => {
    const onNewActivity = vi.fn();
    const { rerender } = renderSignal({
      conversations: [summary("a", 0), summary("b", 0)],
      selectedConversationId: "a",
      onNewActivity,
    });

    rerender({
      conversations: [summary("a", 0), summary("b", 0, 1)],
      selectedConversationId: "a",
      onNewActivity,
    });
    expect(onNewActivity).toHaveBeenCalledTimes(1);
  });
});
