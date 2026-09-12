import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { useOverlayOwnership } from "./overlay-ownership";

type FocusIntent =
  | { readonly kind: "conversation"; readonly key: string; readonly recordedAt: number }
  | { readonly kind: "thread"; readonly key: string; readonly recordedAt: number };

interface FocusState {
  intent: FocusIntent | null;
  placement: "app" | "user";
  placing: number;
  conversationKey: string | null;
  threadKey: string | null;
  deepLink: string | null;
}

interface ComposerFocusContext {
  readonly active: boolean;
  readonly conversationId: string | null;
  readonly conversationReady: boolean;
  readonly threadRootId: string | null;
  readonly threadReady: boolean;
  readonly deepLinkedReplyId: string | null;
}

const INTENT_TTL_MS = 15_000;

function isTextEntry(element: Element): boolean {
  return element.matches('input, textarea, [contenteditable]:not([contenteditable="false"])');
}

/** Navigation may defer focus; a user focus choice, a newer target or expiry cancels the intent. */
export function useComposerFocus(context: ComposerFocusContext) {
  const overlays = useOverlayOwnership();
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const threadComposer = useRef<HTMLTextAreaElement>(null);
  const key = context.active ? context.conversationId : null;
  const state = useRef<FocusState>({
    intent: null,
    placement: "user",
    placing: 0,
    conversationKey: key,
    threadKey: null,
    deepLink: null,
  });

  const placeAppFocus = useCallback((element: HTMLElement | null): boolean => {
    if (element === null) return false;
    state.current.placing += 1;
    try {
      element.focus();
    } finally {
      state.current.placing -= 1;
    }
    const landed = document.activeElement === element;
    if (landed) {
      state.current.placement = "app";
      state.current.intent = null;
    }
    return landed;
  }, []);

  useLayoutEffect(() => {
    const onFocusIn = (): void => {
      if (state.current.placing > 0) return;
      state.current.placement = "user";
      state.current.intent = null;
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget === null) state.current.placement = "user";
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      state.current.intent = null;
    };
  }, []);

  const {
    active,
    conversationId,
    conversationReady,
    threadRootId,
    threadReady,
    deepLinkedReplyId,
  } = context;
  const attempt = useCallback((): void => {
    const intent = state.current.intent;
    if (intent === null) return;
    const expected = intent.kind === "conversation" ? key : threadRootId;
    if (intent.key !== expected || Date.now() - intent.recordedAt > INTENT_TTL_MS) {
      state.current.intent = null;
      return;
    }
    if (!active || overlays.hasOpen()) return;
    if (intent.kind === "conversation" ? !conversationReady || threadRootId !== null : !threadReady)
      return;
    const input = intent.kind === "conversation" ? composerInput.current : threadComposer.current;
    const focused = document.activeElement;
    if (state.current.placement === "user" && focused !== null && focused !== document.body) {
      const channelToThread = intent.kind === "thread" && focused === composerInput.current;
      if (isTextEntry(focused) && !channelToThread && focused.closest("[hidden]") === null) return;
    }
    placeAppFocus(input);
  }, [active, conversationReady, key, overlays, placeAppFocus, threadReady, threadRootId]);

  const attachComposerInput = useCallback(
    (element: HTMLTextAreaElement | null): void => {
      composerInput.current = element;
      if (element !== null) attempt();
    },
    [attempt],
  );
  const attachThreadComposerInput = useCallback(
    (element: HTMLTextAreaElement | null): void => {
      threadComposer.current = element;
      if (element !== null) attempt();
    },
    [attempt],
  );

  useEffect(() => {
    const current = state.current;
    if (key !== current.conversationKey) {
      current.conversationKey = key;
      if (key !== null) {
        if (threadRootId === null) {
          current.intent = { kind: "conversation", key, recordedAt: Date.now() };
        } else if (current.intent?.kind !== "thread" || current.intent.key !== threadRootId) {
          current.intent = { kind: "thread", key: threadRootId, recordedAt: Date.now() };
        }
      }
    }
    if (threadRootId === null) {
      if (current.intent?.kind === "thread") current.intent = null;
      current.threadKey = null;
      current.deepLink = null;
    } else if (
      threadRootId !== current.threadKey ||
      (deepLinkedReplyId !== null && deepLinkedReplyId !== current.deepLink)
    ) {
      current.threadKey = threadRootId;
      current.deepLink = deepLinkedReplyId;
      current.intent = { kind: "thread", key: threadRootId, recordedAt: Date.now() };
    }
    attempt();
  }, [attempt, deepLinkedReplyId, key, threadRootId]);

  // Overlay callbacks read the committed context, without resubscribing on every navigation.
  const retryAfterOverlay = useRef<(restoreRequested: boolean) => void>(() => undefined);
  useLayoutEffect(() => {
    retryAfterOverlay.current = (restoreRequested) => {
      if (restoreRequested) {
        state.current.intent = null;
        return;
      }
      if (overlays.hasOpen() || !active || document.activeElement !== document.body) return;
      const target = threadRootId ?? conversationId;
      if (target === null) return;
      state.current.intent ??= {
        kind: threadRootId === null ? "conversation" : "thread",
        key: target,
        recordedAt: Date.now(),
      };
      attempt();
    };
  }, [active, attempt, conversationId, overlays, threadRootId]);
  useLayoutEffect(
    () => overlays.onClosed((restored) => retryAfterOverlay.current(restored)),
    [overlays],
  );

  return {
    composerInput,
    threadComposer,
    attachComposerInput,
    attachThreadComposerInput,
    placeAppFocus,
  };
}
