import { useCallback, useState } from "react";

export interface ConversationDraftState {
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly clearDraft: (expectedValue?: string) => void;
  readonly resetDrafts: () => void;
}

export function useConversationDrafts(conversationId: string | null): ConversationDraftState {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  const setDraft = useCallback(
    (value: string): void => {
      if (conversationId === null) return;
      setDrafts((current) => {
        if (current[conversationId] === value) return current;
        if (value === "") {
          if (current[conversationId] === undefined) return current;
          const next: Record<string, string> = { ...current };
          delete next[conversationId];
          return next;
        }
        return { ...current, [conversationId]: value };
      });
    },
    [conversationId],
  );

  const clearDraft = useCallback(
    (expectedValue?: string): void => {
      if (conversationId === null) return;
      setDrafts((current) => {
        if (
          current[conversationId] === undefined ||
          (expectedValue !== undefined && current[conversationId] !== expectedValue)
        ) {
          return current;
        }
        const next: Record<string, string> = { ...current };
        delete next[conversationId];
        return next;
      });
    },
    [conversationId],
  );

  const resetDrafts = useCallback((): void => setDrafts({}), []);

  return {
    draft: conversationId === null ? "" : (drafts[conversationId] ?? ""),
    setDraft,
    clearDraft,
    resetDrafts,
  };
}
