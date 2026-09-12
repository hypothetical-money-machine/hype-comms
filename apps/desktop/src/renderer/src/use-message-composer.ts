import { useCallback, useEffect, useState } from "react";
import type { OutboxItem } from "./workspace-cache";
import { useConversationDrafts } from "./use-conversation-drafts";

/** Each pane owns drafts and failed-send editing independently, including compare-before-clear. */
export function useMessageComposer({
  conversationId,
  threadRootId,
  kind,
  outbox,
  setTyping,
}: {
  readonly conversationId: string | null;
  readonly threadRootId: string | null;
  readonly kind: "conversation" | "thread";
  readonly outbox: readonly OutboxItem[];
  readonly setTyping: (conversationId: string, typing: boolean) => void;
}) {
  const key = kind === "thread" ? threadRootId : conversationId;
  const drafts = useConversationDrafts(key);
  const { setDraft } = drafts;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const editing = outbox.find((item) => item.operation.message.clientMessageId === editingId);

  useEffect(() => {
    if (editingId === null) return;
    if (
      editing === undefined ||
      editing.status !== "permanent_failure" ||
      editing.operation.conversationId !== conversationId ||
      editing.operation.message.threadRootId !== threadRootId
    )
      setEditingId(null);
  }, [conversationId, editing, editingId, threadRootId]);

  useEffect(() => {
    if (kind === "thread") setError("");
  }, [key, kind]);

  const updateDraft = useCallback(
    (value: string) => {
      if (key === null) return;
      setDraft(value);
      if (conversationId !== null) setTyping(conversationId, value.trim() !== "");
    },
    [conversationId, key, setDraft, setTyping],
  );

  return { ...drafts, editingId, setEditingId, error, setError, updateDraft };
}
