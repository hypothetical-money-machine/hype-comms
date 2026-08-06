// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useConversationDrafts } from "./use-conversation-drafts";

describe("useConversationDrafts", () => {
  it("keeps an independent in-memory draft for each conversation", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { readonly conversationId: string | null }) =>
        useConversationDrafts(conversationId),
      { initialProps: { conversationId: "general" } },
    );

    act(() => result.current.setDraft("General draft"));
    rerender({ conversationId: "launch" });
    expect(result.current.draft).toBe("");
    act(() => result.current.setDraft("Launch draft"));

    rerender({ conversationId: "general" });
    expect(result.current.draft).toBe("General draft");
    rerender({ conversationId: "launch" });
    expect(result.current.draft).toBe("Launch draft");
  });

  it("does not clear newer text when an earlier submission finishes", () => {
    const { result } = renderHook(() => useConversationDrafts("general"));
    act(() => result.current.setDraft("Submitted text"));
    act(() => result.current.setDraft("Newer text"));
    act(() => result.current.clearDraft("Submitted text"));
    expect(result.current.draft).toBe("Newer text");

    act(() => result.current.clearDraft("Newer text"));
    expect(result.current.draft).toBe("");
  });

  it("can clear every draft when a session ends", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { readonly conversationId: string }) =>
        useConversationDrafts(conversationId),
      { initialProps: { conversationId: "general" } },
    );
    act(() => result.current.setDraft("Private text"));
    rerender({ conversationId: "launch" });
    act(() => result.current.setDraft("Another draft"));
    act(() => result.current.resetDrafts());

    expect(result.current.draft).toBe("");
    rerender({ conversationId: "general" });
    expect(result.current.draft).toBe("");
  });
});
