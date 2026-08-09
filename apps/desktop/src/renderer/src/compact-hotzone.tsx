import { useSyncExternalStore } from "react";

import type { CompactChrome } from "./use-compact-chrome";

/**
 * The only subscriber to the compact chrome store: hover reveals and unread pulses re-render
 * this 8px button and its live region instead of the whole app tree.
 */
export function CompactHotzone({ chrome }: { readonly chrome: CompactChrome }) {
  const state = useSyncExternalStore(chrome.subscribe, chrome.getState, chrome.getState);

  return (
    <>
      <button
        type="button"
        className={state.attention ? "compact-hotzone attention" : "compact-hotzone"}
        aria-label={
          state.revealed
            ? "Hide navigation"
            : state.attention
              ? "Show navigation, new unread activity"
              : "Show navigation"
        }
        aria-expanded={state.revealed}
        {...chrome.hotzoneProps}
      />
      <span className="sr-only" role="status">
        {state.attention ? "New unread activity in another conversation" : ""}
      </span>
    </>
  );
}
