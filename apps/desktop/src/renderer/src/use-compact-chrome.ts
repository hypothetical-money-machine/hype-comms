import { useCallback, useEffect, useMemo, useRef } from "react";

import type { DesktopPlatform } from "../../shared/desktop-api";

const HIDE_DELAY_MS = 300;
const ATTENTION_MS = 1500;

export function isCompactModeShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  platform: string,
): boolean {
  const modifier =
    platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && event.shiftKey && !event.altKey && event.key.toLocaleLowerCase() === "s";
}

/** Kept beside the matcher so the advertised shortcut cannot drift from the handled one. */
export function compactModeShortcutLabel(platform: DesktopPlatform): string {
  return platform === "darwin" ? "Cmd+Shift+S" : "Ctrl+Shift+S";
}

export interface CompactChromeState {
  readonly revealed: boolean;
  readonly attention: boolean;
}

export interface CompactChromeProps {
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onFocusCapture: () => void;
  readonly onBlurCapture: (event: { readonly relatedTarget: EventTarget | null }) => void;
}

export interface CompactHotzoneProps {
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly onClick: () => void;
}

export interface CompactChrome {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => CompactChromeState;
  readonly notifyUnread: () => void;
  readonly onPopoverOpenChange: (open: boolean) => void;
  /**
   * Hides the chrome immediately, overriding the hover/focus keep-open checks, and discards any
   * focus-within record. Call when the user navigates somewhere (quick switcher pick, search
   * result) — a pointer left resting on the overlay would otherwise keep it covering the
   * destination indefinitely, and a focus record stranded by the navigation's unmount would
   * otherwise pin the chrome revealed.
   */
  readonly collapse: () => void;
  readonly chromeProps: CompactChromeProps;
  readonly hotzoneProps: CompactHotzoneProps;
}

const HIDDEN_STATE: CompactChromeState = { revealed: false, attention: false };

/** True when focus rests nowhere — the browser just destroyed it by hiding the focused element. */
function focusIsDestroyed(): boolean {
  return document.activeElement === document.body || document.activeElement === null;
}

export function useCompactChrome(active: boolean): CompactChrome {
  // Reveal/attention live in a store, not React state: hover passes and unread pulses notify
  // only the hotzone leaf (via subscribe) and set `data-chrome-revealed` on <html> directly
  // (like `applyCompactMode`), so they never re-render the app tree.
  const stateRef = useRef<CompactChromeState>(HIDDEN_STATE);
  const listenersRef = useRef(new Set<() => void>());
  const activeRef = useRef(active);
  const previousActiveRef = useRef<boolean | null>(null);
  // Hover, focus, and open-popover tracking stays live even while compact mode is off, so the
  // chrome can start revealed when the mode activates with the pointer or focus already inside
  // it. Only the store commits and timers are gated on `active`.
  const hoveringRef = useRef(false);
  const focusWithinRef = useRef(false);
  // Set when the chrome's own focusout reports focus fell nowhere while `data-compact` was
  // already on <html> — i.e. activation just hid the focused chrome element. Focus merely
  // resting on <body> (a click on the conversation background) never sets it.
  const chromeFocusDestroyedRef = useRef(false);
  const pinsRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback((next: CompactChromeState) => {
    const previous = stateRef.current;
    if (next.revealed === previous.revealed && next.attention === previous.attention) return;
    stateRef.current = next;
    if (next.revealed) {
      document.documentElement.dataset.chromeRevealed = "";
    } else {
      delete document.documentElement.dataset.chromeRevealed;
    }
    for (const listener of listenersRef.current) listener();
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getState = useCallback(() => stateRef.current, []);

  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const cancelAttention = useCallback(() => {
    if (attentionTimer.current !== null) {
      clearTimeout(attentionTimer.current);
      attentionTimer.current = null;
    }
  }, []);

  const scheduleHideCheck = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      // A focused chrome-anchored element can unmount without firing focusout (closing
      // WorkspaceSearch from inside its portal), which would strand the flag true and pin the
      // chrome open forever; a destroyed focus means focus is no longer inside the chrome.
      if (focusWithinRef.current && focusIsDestroyed()) {
        focusWithinRef.current = false;
      }
      if (pinsRef.current > 0) return;
      if (hoveringRef.current) return;
      if (focusWithinRef.current) return;
      commit({ ...stateRef.current, revealed: false });
    }, HIDE_DELAY_MS);
  }, [cancelHide, commit]);

  const reveal = useCallback(() => {
    cancelHide();
    cancelAttention();
    commit({ revealed: true, attention: false });
  }, [cancelAttention, cancelHide, commit]);

  const hide = useCallback(() => {
    cancelHide();
    commit({ ...stateRef.current, revealed: false });
  }, [cancelHide, commit]);

  const collapse = useCallback(() => {
    // Collapse accompanies a navigation: a focused chrome-anchored element (the quick-switcher
    // input, the search box) is about to unmount without firing focusout, and the app may park
    // focus on the destination's composer before the next hide check runs — so the destroyed-focus
    // self-heal never fires and a stale flag would pin the chrome open forever. Focus that
    // genuinely lands back inside the chrome re-sets the flag via onFocusCapture. The hotzone
    // toggle hides via `hide` instead: it is not a navigation, so a live focus-inside-chrome
    // record must survive it.
    focusWithinRef.current = false;
    hide();
  }, [hide]);

  const onPopoverOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        pinsRef.current += 1;
        cancelHide();
      } else {
        pinsRef.current = Math.max(0, pinsRef.current - 1);
        if (activeRef.current) scheduleHideCheck();
      }
    },
    [cancelHide, scheduleHideCheck],
  );

  const notifyUnread = useCallback(() => {
    if (!activeRef.current || stateRef.current.revealed) return;
    cancelAttention();
    commit({ ...stateRef.current, attention: true });
    attentionTimer.current = setTimeout(() => {
      attentionTimer.current = null;
      commit({ ...stateRef.current, attention: false });
    }, ATTENTION_MS);
  }, [cancelAttention, commit]);

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;
    activeRef.current = active;
    const chromeFocusDestroyed = chromeFocusDestroyedRef.current;
    chromeFocusDestroyedRef.current = false;
    if (active) {
      // Turning compact mode on must not yank the chrome out from under a resting pointer,
      // strand focus in a `visibility: hidden` subtree, or hide an open popover's anchor. The
      // destroyed-focus case covers the sidebar checkbox: hiding the chrome blurs it to <body>
      // before this passive effect runs, which the chrome's own focusout recorded. Body focus
      // alone is not enough — the shortcut can fire with focus idling on <body>, and that
      // activation must start hidden. Initial mounts (wasActive === null) also start hidden.
      if (
        hoveringRef.current ||
        focusWithinRef.current ||
        pinsRef.current > 0 ||
        (wasActive === false && chromeFocusDestroyed && focusIsDestroyed())
      ) {
        commit({ revealed: true, attention: false });
      }
    } else {
      cancelHide();
      cancelAttention();
      commit(HIDDEN_STATE);
    }
    return () => {
      cancelHide();
      cancelAttention();
    };
  }, [active, cancelAttention, cancelHide, commit]);

  useEffect(
    () => () => {
      delete document.documentElement.dataset.chromeRevealed;
    },
    [],
  );

  const chromeProps = useMemo<CompactChromeProps>(
    () => ({
      onMouseEnter: () => {
        hoveringRef.current = true;
        if (activeRef.current) cancelHide();
      },
      onMouseLeave: () => {
        hoveringRef.current = false;
        if (activeRef.current) scheduleHideCheck();
      },
      onFocusCapture: () => {
        focusWithinRef.current = true;
        chromeFocusDestroyedRef.current = false;
        // Re-revealing (not just cancelling the timer) keeps focus usable when it lands in the
        // chrome during the slide-out window before `visibility: hidden` applies.
        if (activeRef.current) reveal();
      },
      onBlurCapture: (event) => {
        focusWithinRef.current = false;
        // The runtime applies `data-compact` before React re-renders, so a blur that both fell
        // nowhere and happened under that attribute means activation destroyed the chrome focus.
        chromeFocusDestroyedRef.current =
          event.relatedTarget === null && document.documentElement.dataset.compact !== undefined;
        if (activeRef.current) scheduleHideCheck();
      },
    }),
    [cancelHide, reveal, scheduleHideCheck],
  );

  const hotzoneProps = useMemo<CompactHotzoneProps>(
    () => ({
      onMouseEnter: reveal,
      onMouseLeave: scheduleHideCheck,
      onFocus: reveal,
      onBlur: scheduleHideCheck,
      onClick: () => {
        if (stateRef.current.revealed) {
          hide();
        } else {
          reveal();
        }
      },
    }),
    [hide, reveal, scheduleHideCheck],
  );

  return useMemo(
    () => ({
      subscribe,
      getState,
      notifyUnread,
      onPopoverOpenChange,
      collapse,
      chromeProps,
      hotzoneProps,
    }),
    [chromeProps, collapse, getState, hotzoneProps, notifyUnread, onPopoverOpenChange, subscribe],
  );
}
