// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  compactModeShortcutLabel,
  isCompactModeShortcut,
  useCompactChrome,
} from "./use-compact-chrome";

const baseEvent = { key: "s", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("isCompactModeShortcut", () => {
  it("accepts the platform shortcut", () => {
    expect(isCompactModeShortcut({ ...baseEvent, ctrlKey: true, shiftKey: true }, "linux")).toBe(
      true,
    );
    expect(
      isCompactModeShortcut({ ...baseEvent, key: "S", metaKey: true, shiftKey: true }, "darwin"),
    ).toBe(true);
  });

  it("rejects non-matching combinations", () => {
    expect(isCompactModeShortcut({ ...baseEvent, key: "k", metaKey: true }, "darwin")).toBe(false);
    expect(isCompactModeShortcut(baseEvent, "linux")).toBe(false);
    expect(isCompactModeShortcut({ ...baseEvent, ctrlKey: true }, "linux")).toBe(false);
    expect(
      isCompactModeShortcut({ ...baseEvent, ctrlKey: true, shiftKey: true, altKey: true }, "linux"),
    ).toBe(false);
    expect(isCompactModeShortcut({ ...baseEvent, metaKey: true, shiftKey: true }, "linux")).toBe(
      false,
    );
  });

  it("labels the same binding the matcher accepts", () => {
    expect(compactModeShortcutLabel("darwin")).toBe("Cmd+Shift+S");
    expect(compactModeShortcutLabel("linux")).toBe("Ctrl+Shift+S");
  });
});

describe("useCompactChrome", () => {
  // Keeps document.activeElement off <body> so the stale-focus self-heal in the hide timer
  // only fires in the tests that exercise it.
  let focusHolder: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    focusHolder = document.createElement("button");
    document.body.append(focusHolder);
    focusHolder.focus();
  });

  afterEach(() => {
    cleanup();
    focusHolder.remove();
    delete document.documentElement.dataset.compact;
    vi.useRealTimers();
  });

  it("starts hidden on an initial mount with compact mode already on", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    expect(result.current.getState().revealed).toBe(false);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
  });

  it("reveals when the pointer enters the hotzone and mirrors the state onto <html>", () => {
    const { result } = renderHook(() => useCompactChrome(true));

    act(() => result.current.hotzoneProps.onMouseEnter());
    expect(result.current.getState().revealed).toBe(true);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(true);
  });

  it("notifies subscribers on state changes and stops after unsubscribe", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    const listener = vi.fn();
    const unsubscribe = result.current.subscribe(listener);

    act(() => result.current.hotzoneProps.onMouseEnter());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    act(() => result.current.hotzoneProps.onClick());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hides 300ms after the pointer leaves the chrome", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());

    act(() => vi.advanceTimersByTime(299));
    expect(result.current.getState().revealed).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.getState().revealed).toBe(false);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
  });

  it("cancels the pending hide when the pointer re-enters within 300ms", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());

    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.getState().revealed).toBe(true);
  });

  it("keeps the chrome revealed while a popover is open and hides after it closes", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.onPopoverOpenChange(true));
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.getState().revealed).toBe(true);

    act(() => result.current.onPopoverOpenChange(false));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(false);
  });

  it("keeps the chrome revealed while focus stays inside it", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.chromeProps.onFocusCapture());

    // Focus moving between two elements inside the chrome fires blur then focus.
    act(() => result.current.chromeProps.onBlurCapture({ relatedTarget: focusHolder }));
    act(() => result.current.chromeProps.onFocusCapture());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(true);

    act(() => result.current.chromeProps.onBlurCapture({ relatedTarget: focusHolder }));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(false);
  });

  it("heals a stale focus flag when the focused chrome element unmounted without a blur", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    act(() => result.current.chromeProps.onFocusCapture());
    // Closing WorkspaceSearch unmounts its focused input: no focusout fires, focus lands on
    // <body>, and the close routes through onPopoverOpenChange(false) → hide check.
    act(() => result.current.onPopoverOpenChange(true));
    focusHolder.blur();
    act(() => result.current.onPopoverOpenChange(false));

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(false);
  });

  it("raises attention for unread messages and clears it after 1500ms", () => {
    const { result } = renderHook(() => useCompactChrome(true));

    act(() => result.current.notifyUnread());
    expect(result.current.getState().attention).toBe(true);
    act(() => vi.advanceTimersByTime(1499));
    expect(result.current.getState().attention).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.getState().attention).toBe(false);
  });

  it("ignores notifyUnread while revealed and clears attention on reveal", () => {
    const { result } = renderHook(() => useCompactChrome(true));

    act(() => result.current.notifyUnread());
    expect(result.current.getState().attention).toBe(true);
    act(() => result.current.hotzoneProps.onMouseEnter());
    expect(result.current.getState().attention).toBe(false);

    act(() => result.current.notifyUnread());
    expect(result.current.getState().attention).toBe(false);
  });

  it("toggles between reveal and collapse when the hotzone is activated", () => {
    const { result } = renderHook(() => useCompactChrome(true));

    act(() => result.current.hotzoneProps.onClick());
    expect(result.current.getState().revealed).toBe(true);
    act(() => result.current.hotzoneProps.onClick());
    expect(result.current.getState().revealed).toBe(false);
  });

  it("hides after focus leaves the hotzone without entering the chrome", () => {
    const { result } = renderHook(() => useCompactChrome(true));

    act(() => result.current.hotzoneProps.onFocus());
    expect(result.current.getState().revealed).toBe(true);
    act(() => result.current.hotzoneProps.onBlur());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(false);
  });

  it("starts revealed when compact mode activates with focus inside the chrome", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useCompactChrome(active),
      { initialProps: { active: false } },
    );

    // Focus tracking runs even while inactive; the toggle checkbox lives inside the chrome.
    act(() => result.current.chromeProps.onFocusCapture());
    rerender({ active: true });
    expect(result.current.getState().revealed).toBe(true);
  });

  it("starts revealed when compact mode activates with the pointer resting inside the chrome", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useCompactChrome(active),
      { initialProps: { active: false } },
    );

    act(() => result.current.chromeProps.onMouseEnter());
    rerender({ active: true });
    expect(result.current.getState().revealed).toBe(true);
  });

  it("starts revealed when compact mode activates while a popover is open", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useCompactChrome(active),
      { initialProps: { active: false } },
    );

    act(() => result.current.onPopoverOpenChange(true));
    rerender({ active: true });
    expect(result.current.getState().revealed).toBe(true);
  });

  it("starts revealed when activation just destroyed the focused element", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useCompactChrome(active),
      { initialProps: { active: false } },
    );

    // Checking the sidebar checkbox: the runtime puts `data-compact` on <html>, the collapsing
    // chrome blurs the checkbox with focus falling nowhere, then the activation effect runs.
    act(() => result.current.chromeProps.onFocusCapture());
    document.documentElement.dataset.compact = "true";
    focusHolder.blur();
    act(() => result.current.chromeProps.onBlurCapture({ relatedTarget: null }));
    rerender({ active: true });
    expect(result.current.getState().revealed).toBe(true);
  });

  it("stays hidden when activated with focus idling on <body> outside the chrome", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useCompactChrome(active),
      { initialProps: { active: false } },
    );

    // Clicking the conversation background parks focus on <body>; the shortcut then enables
    // compact mode. No chrome focus was destroyed, so the chrome must not appear.
    focusHolder.blur();
    rerender({ active: true });
    expect(result.current.getState().revealed).toBe(false);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
  });

  it("re-reveals when focus lands in the chrome during the hide transition", () => {
    const { result } = renderHook(() => useCompactChrome(true));
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(false);

    act(() => result.current.chromeProps.onFocusCapture());
    expect(result.current.getState().revealed).toBe(true);
  });

  it("never re-renders for chrome interactions", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCompactChrome(true);
    });
    const rendersAfterMount = renders;

    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.notifyUnread());
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());
    act(() => vi.advanceTimersByTime(1000));

    expect(renders).toBe(rendersAfterMount);
    expect(result.current.getState().revealed).toBe(false);
  });

  it("tracks interactions while inactive without committing state", () => {
    const { result } = renderHook(() => useCompactChrome(false));

    act(() => result.current.chromeProps.onFocusCapture());
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());
    act(() => result.current.chromeProps.onBlurCapture({ relatedTarget: null }));
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.getState().revealed).toBe(false);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
  });

  it("resets reveal state when deactivated but keeps tracking an open popover", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useCompactChrome(active),
      { initialProps: { active: true } },
    );
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.onPopoverOpenChange(true));

    rerender({ active: false });
    expect(result.current.getState().revealed).toBe(false);
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
    act(() => result.current.notifyUnread());
    expect(result.current.getState().attention).toBe(false);

    // The popover stayed open across the mode change, so it still pins the chrome.
    rerender({ active: true });
    act(() => result.current.hotzoneProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseEnter());
    act(() => result.current.chromeProps.onMouseLeave());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.getState().revealed).toBe(true);

    act(() => result.current.onPopoverOpenChange(false));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.getState().revealed).toBe(false);
  });

  it("removes the reveal attribute from <html> on unmount", () => {
    const { result, unmount } = renderHook(() => useCompactChrome(true));
    act(() => result.current.hotzoneProps.onMouseEnter());
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(true);

    unmount();
    expect(document.documentElement.hasAttribute("data-chrome-revealed")).toBe(false);
  });
});
