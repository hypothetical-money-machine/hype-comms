import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

const FOCUSABLE = 'button, input:not([type="hidden"]), select, textarea, a[href], [tabindex]';

function available(element: HTMLElement | null): element is HTMLElement {
  if (element === null || !element.isConnected || element.closest("[hidden], [inert]") !== null)
    return false;
  if (element.matches(":disabled")) return false;
  for (let parent: HTMLElement | null = element; parent !== null; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function controls(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && available(element),
  );
  return candidates.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || element.name === "")
      return true;
    const group = candidates.filter(
      (candidate) =>
        candidate instanceof HTMLInputElement &&
        candidate.type === "radio" &&
        candidate.name === element.name &&
        candidate.form === element.form,
    );
    return (
      element ===
      (group.find((candidate) => candidate instanceof HTMLInputElement && candidate.checked) ??
        group[0])
    );
  });
}

interface OverlayEntry {
  readonly container: HTMLElement;
  readonly revision: number;
  readonly modal: boolean;
  returnTarget: HTMLElement | null;
}

export interface OverlayLease {
  readonly isTop: () => boolean;
  readonly release: (restoreFocus: boolean) => void;
}

/** One instance per App, including its portals. Removing a covered overlay never takes focus. */
export class OverlayOwnership {
  readonly #entries: OverlayEntry[] = [];
  readonly #closed = new Set<(restored: boolean) => void>();
  readonly #containerRevisions = new WeakMap<HTMLElement, number>();

  hasOpen = (): boolean => this.#entries.length > 0;

  hasModalOpen = (): boolean => this.#entries.some((entry) => entry.modal);

  /** Listeners receive whether focus actually landed on the opener, not whether it was asked for. */
  onClosed = (listener: (restored: boolean) => void): (() => void) => {
    this.#closed.add(listener);
    return () => this.#closed.delete(listener);
  };

  acquire(container: HTMLElement, returnTarget: HTMLElement | null, modal = true): OverlayLease {
    const revision = (this.#containerRevisions.get(container) ?? 0) + 1;
    this.#containerRevisions.set(container, revision);
    const entry = { container, returnTarget, revision, modal };
    this.#entries.push(entry);
    return {
      isTop: () => this.#entries.at(-1) === entry,
      release: (restoreFocus) => {
        const index = this.#entries.indexOf(entry);
        if (index < 0) return;
        const wasTop = this.#entries.at(-1) === entry;
        this.#entries.splice(index, 1);
        // A child must not restore focus into a parent that was removed while covered.
        for (const remaining of this.#entries) {
          if (entry.container.contains(remaining.returnTarget)) {
            remaining.returnTarget = entry.returnTarget;
          }
        }
        if (!wasTop) return;
        // Cleanup can run before React removes the focused portal. Restore after that commit.
        queueMicrotask(() => {
          if (this.#containerRevisions.get(entry.container) !== entry.revision) return;
          const top = this.#entries.at(-1);
          const focused = document.activeElement;
          const stillOwned = focused === document.body || entry.container.contains(focused);
          const target = entry.returnTarget;
          const restored =
            restoreFocus &&
            stillOwned &&
            available(target) &&
            (top === undefined || top.container.contains(target));
          if (restored) target.focus();
          for (const listener of this.#closed) listener(restored);
        });
      },
    };
  }
}

const OverlayContext = createContext<OverlayOwnership | null>(null);

export function OverlayProvider({ children }: { readonly children: ReactNode }) {
  const [ownership] = useState(() => new OverlayOwnership());
  return <OverlayContext.Provider value={ownership}>{children}</OverlayContext.Provider>;
}

export function useOverlayOwnership(): OverlayOwnership {
  const shared = useContext(OverlayContext);
  // A standalone component (for example in a component test) still owns and disposes its lease.
  const [local] = useState(() => new OverlayOwnership());
  return shared ?? local;
}

interface OverlayOptions {
  readonly container: RefObject<HTMLElement | null>;
  readonly initialFocus?: () => HTMLElement | null;
  /** Reapply initial focus on a domain transition without replacing the lease or its opener. */
  readonly focusKey?: string | boolean | number;
  readonly returnFocus?: () => HTMLElement | null;
  readonly onEscape: () => void;
  readonly trapFocus?: boolean;
}

/** Selection closes opt out of restoration; cancellation restores the captured opener. */
export function useOwnedOverlay(open: boolean, options: OverlayOptions) {
  const ownership = useOverlayOwnership();
  const latest = useRef(options);
  const restore = useRef(true);
  const activeLease = useRef<OverlayLease | null>(null);
  useLayoutEffect(() => {
    latest.current = options;
  });
  useLayoutEffect(() => {
    const current = latest.current;
    const container = current.container.current;
    if (!open || container === null) return;
    restore.current = true;
    const previous =
      current.returnFocus?.() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const lease = ownership.acquire(container, previous, current.trapFocus !== false);
    activeLease.current = lease;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!lease.isTop() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.current.onEscape();
      } else if (event.key === "Tab" && latest.current.trapFocus !== false) {
        const focusable = controls(container);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          event.preventDefault();
          container.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || !container.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !container.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      activeLease.current = null;
      lease.release(restore.current);
    };
  }, [open, ownership]);
  useLayoutEffect(() => {
    const current = latest.current;
    const container = current.container.current;
    if (!open || container === null || activeLease.current?.isTop() !== true) return;
    (current.initialFocus?.() ?? controls(container)[0] ?? container).focus();
  }, [open, options.focusKey, ownership]);
  const leaveForNavigation = useCallback(() => {
    restore.current = false;
  }, []);
  return leaveForNavigation;
}
