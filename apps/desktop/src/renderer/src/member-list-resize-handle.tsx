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

  useLayoutEffect(() => {
    if (targetRoot === undefined) return;
    applyMemberListHeight(targetRoot, heightRef.current);
    const bounds = splitBounds(handleRef.current);
    if (bounds !== null) setValueMax(maxMemberListHeight(bounds.height));
  }, [targetRoot]);

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
      commit(memberListHeightFromPointer(event.clientY, bounds.bottom, bounds.height), false);
    };
    const onUp = () => {
      setDragging(false);
      persistMemberListHeight(heightRef.current, storage);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [commit, dragging, storage]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setDragging(true);
    const bounds = splitBounds(event.currentTarget);
    if (bounds === null) return;
    commit(memberListHeightFromPointer(event.clientY, bounds.bottom, bounds.height), false);
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
      onDoubleClick={() => commit(DEFAULT_MEMBER_LIST_HEIGHT, true)}
      onKeyDown={onKeyDown}
    />
  );
}
