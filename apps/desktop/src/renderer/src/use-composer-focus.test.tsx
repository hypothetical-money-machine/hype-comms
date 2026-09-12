// @vitest-environment happy-dom

import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, useOwnedOverlay } from "./overlay-ownership";
import { useComposerFocus } from "./use-composer-focus";

type Context = Parameters<typeof useComposerFocus>[0];
const initial: Context = {
  active: true,
  conversationId: "a",
  conversationReady: true,
  threadRootId: null,
  threadReady: false,
  deepLinkedReplyId: null,
};

function ComposerScene({ context, overlay = false }: { context: Context; overlay?: boolean }) {
  const focus = useComposerFocus(context);
  const dialog = useRef<HTMLElement>(null);
  useOwnedOverlay(overlay, { container: dialog, onEscape: () => undefined });
  return (
    <>
      <input aria-label="Other input" />
      <button>Navigation</button>
      <section hidden={!context.active}>
        {context.conversationReady && (
          <textarea aria-label="Conversation" ref={focus.attachComposerInput} />
        )}
        {context.threadRootId !== null && (
          <textarea
            aria-label="Thread"
            disabled={!context.threadReady}
            ref={focus.attachThreadComposerInput}
          />
        )}
      </section>
      {overlay && (
        <section ref={dialog} role="dialog">
          <button>Overlay action</button>
        </section>
      )}
    </>
  );
}

function scene(context: Context, overlay = false) {
  return (
    <OverlayProvider>
      <ComposerScene context={context} overlay={overlay} />
    </OverlayProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("composer focus intents", () => {
  it("retains a reply intent while hidden and focuses it when the workspace returns", () => {
    const { rerender } = render(scene(initial));
    const hidden = {
      ...initial,
      active: false,
      conversationId: "b",
      threadRootId: "root",
      threadReady: false,
      deepLinkedReplyId: "reply",
    };
    rerender(scene(hidden));
    rerender(scene({ ...hidden, active: true }));
    rerender(scene({ ...hidden, active: true, threadReady: true }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Thread" }));
  });

  it("cancels deferred navigation after the user chooses another control", () => {
    const { rerender } = render(scene(initial));
    const pending = { ...initial, conversationId: "b", conversationReady: false };
    rerender(scene(pending));
    const chosen = screen.getByRole("textbox", { name: "Other input" });
    chosen.focus();
    rerender(scene({ ...pending, conversationReady: true }));
    expect(document.activeElement).toBe(chosen);
    const navigation = screen.getByRole("button", { name: "Navigation" });
    navigation.focus();
    rerender(scene(pending));
    rerender(scene({ ...pending, conversationReady: true }));
    expect(document.activeElement).toBe(navigation);
  });

  it("expires blocked intents and only focuses a later navigation", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const { rerender } = render(scene(initial));
    rerender(scene({ ...initial, conversationId: "b", conversationReady: false }));
    now.mockReturnValue(15_001);
    rerender(scene({ ...initial, conversationId: "b" }));
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "Conversation" }));
    rerender(scene({ ...initial, conversationId: "c" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Conversation" }));
  });

  it("blocks focus behind an owned popover even when focus has fallen to the body", () => {
    const { rerender } = render(scene(initial, true));
    const control = screen.getByRole("button", { name: "Overlay action" });
    control.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(scene({ ...initial, conversationId: "b" }, true));
    expect(document.activeElement).toBe(document.body);
  });

  it("does not publish a deferred focus after the scene is disposed", async () => {
    const { rerender, unmount } = render(scene(initial, true));
    rerender(scene({ ...initial, conversationId: "b" }, true));
    const outside = document.createElement("button");
    document.body.append(outside);
    unmount();
    outside.focus();
    await act(async () => undefined);
    expect(document.activeElement).toBe(outside);
    fireEvent.keyDown(outside, { key: "Escape" });
    outside.remove();
  });
});
