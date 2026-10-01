import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "@hype-comms/contracts";
import {
  isReadTrackingEligible,
  isTimelineAtBottom,
  lastReadEligibleMessageId,
} from "./message-read-tracking";
import {
  captureTimelineScrollAnchor,
  isTimelineScrollAnchorPreserved,
  restoreTimelineScrollAnchor,
  type TimelineScrollAnchor,
} from "./timeline-scroll-anchor";

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
  focusedMessageRequest = 0,
  historyLoading = false,
  historyActive = active,
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
  /** A new request can jump to the same conversation message again. */
  readonly focusedMessageRequest?: number;
  /** Retain a conversation's prepend anchor until its history request finishes. */
  readonly historyLoading?: boolean;
  /** Conversation history and focus are available only while the chat view is open. */
  readonly historyActive?: boolean;
  readonly markRead: (conversationId: string, messageId: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atLiveTail, setAtLiveTail] = useState(false);
  const frame = useRef<number | null>(null);
  const markVisibleReadRef = useRef<() => void>(() => undefined);
  const visibility = useRef({ observedStarts: new Set<string>(), observedEnds: new Set<string>() });
  const trackingKey = useRef<string | null>(null);
  const historyAnchor = useRef<{
    conversationId: string;
    focusRequest: number;
    anchor: TimelineScrollAnchor;
    scrollTop: number;
  } | null>(null);
  const handledMessageFocus = useRef<{ id: string; request: number } | null>(null);
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

  const cancelHistoryAnchor = useCallback(() => {
    historyAnchor.current = null;
  }, []);

  const beginHistoryLoad = useCallback(
    (load: () => void): void => {
      const container = list.current;
      const anchor =
        kind === "conversation" &&
        active &&
        historyActive &&
        conversationId !== null &&
        container !== null
          ? captureTimelineScrollAnchor(container)
          : null;
      if (anchor === null || conversationId === null || container === null) {
        historyAnchor.current = null;
      } else {
        historyAnchor.current = {
          conversationId,
          focusRequest: focusedMessageRequest,
          anchor,
          scrollTop: container.scrollTop,
        };
        stickToBottom.current = false;
      }
      load();
    },
    [active, conversationId, focusedMessageRequest, historyActive, kind],
  );

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
  markVisibleReadRef.current = markVisibleRead;

  const scheduleRead = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      markVisibleReadRef.current();
    });
  }, []);

  useEffect(() => {
    window.addEventListener("focus", scheduleRead);
    document.addEventListener("visibilitychange", scheduleRead);
    return () => {
      window.removeEventListener("focus", scheduleRead);
      document.removeEventListener("visibilitychange", scheduleRead);
    };
  }, [scheduleRead]);

  useEffect(
    () => () => {
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    },
    [],
  );

  const handleScroll = useCallback(() => {
    const container = list.current;
    if (container !== null) {
      const pending = historyAnchor.current;
      if (pending !== null) {
        if (
          container.scrollTop !== pending.scrollTop &&
          !isTimelineScrollAnchorPreserved(container, pending.anchor)
        ) {
          historyAnchor.current = null;
        } else {
          pending.scrollTop = container.scrollTop;
        }
      }
      stickToBottom.current = isTimelineAtBottom(container);
      setAtLiveTail(stickToBottom.current);
    }
    scheduleRead();
  }, [scheduleRead]);

  useLayoutEffect(() => {
    const pending = historyAnchor.current;
    const container = list.current;
    if (pending === null) return;
    if (
      container === null ||
      kind !== "conversation" ||
      !active ||
      !historyActive ||
      pending.conversationId !== conversationId ||
      pending.focusRequest !== focusedMessageRequest
    ) {
      historyAnchor.current = null;
      return;
    }
    // A scrollbar can move before its scroll event is dispatched. Browser anchoring instead
    // changes scrollTop while keeping the captured row at the same visual offset.
    if (
      container.scrollTop !== pending.scrollTop &&
      !isTimelineScrollAnchorPreserved(container, pending.anchor)
    ) {
      historyAnchor.current = null;
      return;
    }
    restoreTimelineScrollAnchor(container, pending.anchor);
    pending.scrollTop = container.scrollTop;
    if (!historyLoading) historyAnchor.current = null;
  }, [
    active,
    conversationId,
    focusedMessageRequest,
    historyActive,
    historyLoading,
    kind,
    messages,
  ]);

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
    if (kind !== "conversation") return;
    if (focusedMessageId === null) {
      handledMessageFocus.current = null;
      return;
    }
    if (!active || !historyActive) return;
    const handled = handledMessageFocus.current;
    if (handled?.id === focusedMessageId && handled.request === focusedMessageRequest) return;
    const row = document.getElementById(`message-${focusedMessageId}`);
    if (row === null) return;
    row.scrollIntoView({ block: "center" });
    // History can arrive after the request. Once the target exists, further message loads
    // must preserve the reader's position instead of replaying the old search/task jump.
    handledMessageFocus.current = { id: focusedMessageId, request: focusedMessageRequest };
  }, [active, focusedMessageId, focusedMessageRequest, historyActive, key, kind, messages]);

  useEffect(() => {
    if (kind !== "thread" || !active || focusedMessageId === null) return;
    document
      .getElementById(`thread-message-${focusedMessageId}`)
      ?.scrollIntoView({ block: "center" });
    scheduleRead();
  }, [active, focusedMessageId, key, kind, messages.length, scheduleRead]);

  return { list, atLiveTail, handleScroll, beginHistoryLoad, cancelHistoryAnchor };
}
