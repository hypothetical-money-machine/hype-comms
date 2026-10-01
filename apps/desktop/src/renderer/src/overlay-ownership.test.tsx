// @vitest-environment happy-dom

import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayOwnership, OverlayProvider, useOwnedOverlay } from "./overlay-ownership";

afterEach(cleanup);

function Dialog({
  name,
  close,
  children,
}: {
  name: string;
  close: () => void;
  children?: React.ReactNode;
}) {
  const container = useRef<HTMLElement>(null);
  useOwnedOverlay(true, { container, onEscape: close });
  return (
    <section ref={container} role="dialog" aria-label={name}>
      <button onClick={close}>Close {name}</button>
      {children}
    </section>
  );
}

function NestedDialogs() {
  const [parent, setParent] = useState(false);
  const [child, setChild] = useState(false);
  return (
    <OverlayProvider>
      <button onClick={() => setParent(true)}>Open parent</button>
      {parent && (
        <Dialog name="parent" close={() => setParent(false)}>
          <button onClick={() => setChild(true)}>Open child</button>
          {child && (
            <Dialog name="child" close={() => setChild(false)}>
              <button disabled>Disabled</button>
              <button hidden>Hidden</button>
              <button style={{ display: "none" }}>Invisible</button>
              <button tabIndex={-1}>Excluded</button>
              <input type="radio" name="choice" aria-label="First choice" />
              <input type="radio" name="choice" aria-label="Second choice" defaultChecked />
              <button>Last child control</button>
            </Dialog>
          )}
        </Dialog>
      )}
    </OverlayProvider>
  );
}

describe("overlay ownership", () => {
  it("gives Escape and Tab to the top dialog and restores through nested openers", async () => {
    render(<NestedDialogs />);
    const opener = screen.getByRole("button", { name: "Open parent" });
    opener.focus();
    fireEvent.click(opener);
    const childOpener = screen.getByRole("button", { name: "Open child" });
    childOpener.focus();
    fireEvent.click(childOpener);
    const first = screen.getByRole("button", { name: "Close child" });
    const last = screen.getByRole("button", { name: "Last child control" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "child" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "parent" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(childOpener));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("restores the search opener outside a remaining nonmodal task detail", async () => {
    const owner = new OverlayOwnership();
    const opener = document.createElement("button");
    const taskDetail = document.createElement("section");
    const search = document.createElement("section");
    const searchInput = document.createElement("input");
    search.append(searchInput);
    document.body.append(opener, taskDetail, search);
    const closed = vi.fn();
    const unsubscribe = owner.onClosed(closed);
    const taskLease = owner.acquire(taskDetail, null, false);
    try {
      opener.focus();
      const searchLease = owner.acquire(search, opener);
      searchInput.focus();
      searchLease.release(true);
      search.remove();
      await act(async () => undefined);
      expect(document.activeElement).toBe(opener);
      expect(closed).toHaveBeenCalledWith(true);
      expect(owner.hasOpen()).toBe(true);
      expect(owner.hasModalOpen()).toBe(false);
    } finally {
      unsubscribe();
      taskLease.release(false);
      opener.remove();
      taskDetail.remove();
      search.remove();
    }
  });

  it.each(["inside", "outside"] as const)(
    "fences restoration %s a remaining modal beneath a nonmodal overlay",
    async (location) => {
      const owner = new OverlayOwnership();
      const modal = document.createElement("section");
      const modalOpener = document.createElement("button");
      modal.append(modalOpener);
      const nonmodal = document.createElement("section");
      const nonmodalOpener = document.createElement("button");
      nonmodal.append(nonmodalOpener);
      const search = document.createElement("section");
      const searchInput = document.createElement("input");
      search.append(searchInput);
      document.body.append(modal, nonmodal, search);
      const closed = vi.fn();
      const unsubscribe = owner.onClosed(closed);
      const modalLease = owner.acquire(modal, null);
      const nonmodalLease = owner.acquire(nonmodal, null, false);
      const target = location === "inside" ? modalOpener : nonmodalOpener;
      try {
        const searchLease = owner.acquire(search, target);
        searchInput.focus();
        searchLease.release(true);
        search.remove();
        await act(async () => undefined);
        expect(document.activeElement).toBe(location === "inside" ? target : document.body);
        expect(closed).toHaveBeenCalledWith(location === "inside");
        expect(owner.hasModalOpen()).toBe(true);
      } finally {
        unsubscribe();
        nonmodalLease.release(false);
        modalLease.release(false);
        modal.remove();
        nonmodal.remove();
        search.remove();
      }
    },
  );

  it("does not restore into a removed parent or release the same lease twice", async () => {
    const owner = new OverlayOwnership();
    const opener = document.createElement("button");
    const parent = document.createElement("section");
    const childOpener = document.createElement("button");
    parent.append(childOpener);
    const child = document.createElement("section");
    document.body.append(opener, parent, child);
    const closed = vi.fn();
    owner.onClosed(closed);
    try {
      const parentLease = owner.acquire(parent, opener);
      const childLease = owner.acquire(child, childOpener);
      parentLease.release(true);
      parent.remove();
      await act(async () => undefined);
      expect(closed).not.toHaveBeenCalled();
      childLease.release(true);
      childLease.release(true);
      child.remove();
      await act(async () => undefined);
      expect(document.activeElement).toBe(opener);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(owner.hasOpen()).toBe(false);
    } finally {
      opener.remove();
      parent.remove();
      child.remove();
    }
  });

  it("reports that focus was not restored when the opener left while the overlay was open", async () => {
    const owner = new OverlayOwnership();
    const opener = document.createElement("button");
    const container = document.createElement("section");
    document.body.append(opener, container);
    const closed = vi.fn();
    owner.onClosed(closed);
    try {
      opener.focus();
      const lease = owner.acquire(container, opener);
      opener.remove();
      lease.release(true);
      await act(async () => undefined);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledWith(false);
      expect(document.activeElement).toBe(document.body);
    } finally {
      opener.remove();
      container.remove();
    }
  });

  it("cancels deferred restoration when a new overlay opens or the user chooses focus", async () => {
    const owner = new OverlayOwnership();
    const opener = document.createElement("button");
    const other = document.createElement("button");
    const container = document.createElement("section");
    document.body.append(opener, other, container);
    try {
      const first = owner.acquire(container, opener);
      first.release(true);
      const second = owner.acquire(container, other);
      await act(async () => undefined);
      expect(document.activeElement).not.toBe(opener);
      second.release(true);
      opener.focus();
      await act(async () => undefined);
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
      other.remove();
      container.remove();
    }
  });

  it("does not cancel a sibling overlay close notification", async () => {
    const owner = new OverlayOwnership();
    const firstContainer = document.createElement("section");
    const secondContainer = document.createElement("section");
    const firstOpener = document.createElement("button");
    const secondOpener = document.createElement("button");
    document.body.append(firstContainer, secondContainer, firstOpener, secondOpener);
    const closed = vi.fn();
    owner.onClosed(closed);
    try {
      const first = owner.acquire(firstContainer, firstOpener);
      first.release(true);
      const second = owner.acquire(secondContainer, secondOpener);
      second.release(true);
      await act(async () => undefined);
      expect(closed).toHaveBeenCalledTimes(2);
    } finally {
      firstContainer.remove();
      secondContainer.remove();
      firstOpener.remove();
      secondOpener.remove();
    }
  });
});
