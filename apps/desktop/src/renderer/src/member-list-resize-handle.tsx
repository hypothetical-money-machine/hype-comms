import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  applyMemberListHeight,
  clampMemberListHeight,
  DEFAULT_MEMBER_LIST_HEIGHT,
  maxMemberListHeight,
  MEMBER_LIST_HEIGHT_KEYBOARD_STEP,
  memberListHeightFromPointer,
  MIN_MEMBER_LIST_HEIGHT,
  persistMemberListHeight,
  readMemberListHeight,
  type MemberListHeightStorage,
} from "./member-list-height";

interface MemberListResizeHandleProps {
  readonly storage?: MemberListHeightStorage | null;
  readonly root?: HTMLElement;
}

function splitBounds(handle: HTMLElement | null): { bottom: number; height: number } | null {
  const split = handle?.parentElement;
  if (split === null || split === undefined) return null;
  const rect = split.getBoundingClientRect();
  return { bottom: rect.bottom, height: rect.height };
}

export function MemberListResizeHandle({ storage, root }: MemberListResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(DEFAULT_MEMBER_LIST_HEIGHT);
  const grabOffsetRef = useRef(0);
  const [height, setHeight] = useState(() => {
    const initial = readMemberListHeight(storage);
    heightRef.current = initial;
    return initial;
  });
  const [dragging, setDragging] = useState(false);
  const [valueMax, setValueMax] = useState(() => maxMemberListHeight(0));
  const targetRoot =
    root ?? (typeof document === "undefined" ? undefined : document.documentElement);

  const commit = useCallback(
    (next: number, persist: boolean) => {
      const bounds = splitBounds(handleRef.current);
      const clamped = clampMemberListHeight(next, bounds?.height ?? 0);
      heightRef.current = clamped;
      setHeight(clamped);
      setValueMax(maxMemberListHeight(bounds?.height ?? 0));
      if (targetRoot !== undefined) applyMemberListHeight(targetRoot, clamped);
      if (persist) persistMemberListHeight(clamped, storage);
    },
    [storage, targetRoot],
  );

  const finishDrag = useCallback(() => {
    setDragging((active) => {
      if (active) persistMemberListHeight(heightRef.current, storage);
      return false;
    });
  }, [storage]);

  useLayoutEffect(() => {
    if (targetRoot === undefined) return;
    applyMemberListHeight(targetRoot, heightRef.current);
    const bounds = splitBounds(handleRef.current);
    if (bounds !== null) setValueMax(maxMemberListHeight(bounds.height));
  }, [targetRoot]);

  useEffect(() => {
    const split = handleRef.current?.parentElement;
    if (split === null || split === undefined || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const bounds = splitBounds(handleRef.current);
      if (bounds === null || bounds.height <= 0) return;
      commit(heightRef.current, false);
    });
    observer.observe(split);
    return () => observer.disconnect();
  }, [commit]);

  useEffect(() => {
    if (targetRoot === undefined) return;
    if (!dragging) {
      delete targetRoot.dataset.memberListResizing;
      return;
    }
    targetRoot.dataset.memberListResizing = "true";
    return () => {
      delete targetRoot.dataset.memberListResizing;
    };
  }, [dragging, targetRoot]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: globalThis.PointerEvent) => {
      const bounds = splitBounds(handleRef.current);
      if (bounds === null) return;
      event.preventDefault();
      commit(
        memberListHeightFromPointer(
          event.clientY,
          bounds.bottom,
          bounds.height,
          grabOffsetRef.current,
        ),
        false,
      );
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [commit, dragging, finishDrag]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still end an in-window drag if capture is unavailable.
    }
    const bounds = splitBounds(event.currentTarget);
    grabOffsetRef.current =
      bounds === null ? 0 : event.clientY - (bounds.bottom - heightRef.current);
    setDragging(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = height + MEMBER_LIST_HEIGHT_KEYBOARD_STEP;
        break;
      case "ArrowDown":
        next = height - MEMBER_LIST_HEIGHT_KEYBOARD_STEP;
        break;
      case "PageUp":
        next = height + MEMBER_LIST_HEIGHT_KEYBOARD_STEP * 4;
        break;
      case "PageDown":
        next = height - MEMBER_LIST_HEIGHT_KEYBOARD_STEP * 4;
        break;
      case "Home":
        next = MIN_MEMBER_LIST_HEIGHT;
        break;
      case "End":
        next = maxMemberListHeight(splitBounds(event.currentTarget)?.height ?? 0);
        break;
      default:
        break;
    }
    if (next === null) return;
    event.preventDefault();
    commit(next, true);
  };

  return (
    <div
      ref={handleRef}
      className="member-list-resize-handle"
      role="separator"
      aria-controls="workspace-members"
      aria-label="Resize members list"
      aria-orientation="horizontal"
      aria-valuemin={MIN_MEMBER_LIST_HEIGHT}
      aria-valuemax={valueMax}
      aria-valuenow={height}
      aria-valuetext={`${String(height)} pixels`}
      tabIndex={0}
      title="Drag to resize members and conversations"
      onPointerDown={onPointerDown}
      onLostPointerCapture={finishDrag}
      onDoubleClick={() => commit(DEFAULT_MEMBER_LIST_HEIGHT, true)}
      onKeyDown={onKeyDown}
    />
  );
}
