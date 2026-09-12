import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "@hype-comms/contracts";
import {
  isReadTrackingEligible,
  isTimelineAtBottom,
  lastReadEligibleMessageId,
} from "./message-read-tracking";

type PanePosition =
  | { readonly kind: "conversation"; readonly unreadDividerMessageId: string | null }
  | { readonly kind: "thread"; readonly rootId: string | null };

/** Read visibility and scroll ownership for one mounted conversation or thread list. */
export function useMessagePane({
  position,
  conversationId,
  active,
  isHeadless,
  messages,
  pendingCount,
  lastReadSequence,
  focusedMessageId,
  markRead,
}: {
  readonly position: PanePosition;
  readonly conversationId: string | null;
  readonly active: boolean;
  readonly isHeadless: boolean;
  readonly messages: readonly Pick<Message, "id">[];
  readonly pendingCount: number;
  readonly lastReadSequence: string | null;
  readonly focusedMessageId: string | null;
  readonly markRead: (conversationId: string, messageId: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atLiveTail, setAtLiveTail] = useState(false);
  const frame = useRef<number | null>(null);
  const visibility = useRef({ observedStarts: new Set<string>(), observedEnds: new Set<string>() });
  const trackingKey = useRef<string | null>(null);
  const kind = position.kind;
  const key =
    conversationId === null
      ? null
      : position.kind === "conversation"
        ? conversationId
        : position.rootId === null
          ? null
          : `${conversationId}:${position.rootId}`;
  const unreadDivider = position.kind === "conversation" ? position.unreadDividerMessageId : null;
  const newestMessageId = messages.at(-1)?.id ?? null;
  const previousScroll = useRef({ key: null as string | null, newestMessageId, pendingCount: 0 });

  const markVisibleRead = useCallback(() => {
    const container = list.current;
    if (
      !active ||
      key === null ||
      conversationId === null ||
      container === null ||
      !isReadTrackingEligible(isHeadless, document.visibilityState, document.hasFocus())
    )
      return;
    if (trackingKey.current !== key) {
      trackingKey.current = key;
      visibility.current.observedStarts.clear();
      visibility.current.observedEnds.clear();
    }
    const messageId = lastReadEligibleMessageId(container, visibility.current, lastReadSequence);
    if (messageId !== null) markRead(conversationId, messageId);
  }, [active, conversationId, isHeadless, key, lastReadSequence, markRead]);

  const scheduleRead = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      markVisibleRead();
    });
  }, [markVisibleRead]);

  useEffect(() => {
    window.addEventListener("focus", scheduleRead);
    document.addEventListener("visibilitychange", scheduleRead);
    return () => {
      window.removeEventListener("focus", scheduleRead);
      document.removeEventListener("visibilitychange", scheduleRead);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scheduleRead]);

  const handleScroll = useCallback(() => {
    if (list.current !== null) {
      stickToBottom.current = isTimelineAtBottom(list.current);
      setAtLiveTail(stickToBottom.current);
    }
    scheduleRead();
  }, [scheduleRead]);

  useEffect(() => {
    if (key !== null) return;
    trackingKey.current = null;
    visibility.current.observedStarts.clear();
    visibility.current.observedEnds.clear();
  }, [key]);

  useEffect(() => {
    if (!active || key === null) {
      previousScroll.current = { key: null, newestMessageId: null, pendingCount: 0 };
      stickToBottom.current = false;
      setAtLiveTail(false);
      return;
    }
    const container = list.current;
    if (container === null) return;
    const previous = previousScroll.current;
    const changed = previous.key !== key;
    if (kind === "conversation") {
      if (changed) {
        const divider = document.getElementById(`unread-${conversationId}`);
        container.scrollTop =
          divider === null
            ? container.scrollHeight
            : Math.max(0, divider.offsetTop - container.clientHeight / 2);
      } else if (stickToBottom.current) container.scrollTop = container.scrollHeight;
    } else if (
      changed ||
      previous.pendingCount < pendingCount ||
      (previous.newestMessageId !== newestMessageId && stickToBottom.current)
    )
      container.scrollTop = container.scrollHeight;
    previousScroll.current = { key, newestMessageId, pendingCount };
    stickToBottom.current = isTimelineAtBottom(container);
    setAtLiveTail(stickToBottom.current);
    scheduleRead();
  }, [
    active,
    conversationId,
    key,
    kind,
    messages.length,
    newestMessageId,
    pendingCount,
    scheduleRead,
    unreadDivider,
  ]);

  useEffect(() => {
    if (!active || focusedMessageId === null) return;
    document
      .getElementById(`${kind === "thread" ? "thread-message" : "message"}-${focusedMessageId}`)
      ?.scrollIntoView({ block: "center" });
    scheduleRead();
  }, [active, focusedMessageId, key, kind, messages.length, scheduleRead]);

  return { list, atLiveTail, handleScroll };
}
