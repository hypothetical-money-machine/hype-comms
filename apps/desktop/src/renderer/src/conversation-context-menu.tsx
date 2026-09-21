import type { ConversationSummary } from "@hype-comms/contracts";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useOpenChangeNotifier } from "./use-open-change-notifier";

export interface ConversationContextMenuProps {
  readonly conversation: ConversationSummary;
  readonly position: { readonly x: number; readonly y: number };
  readonly triggerRef?: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onMarkAsRead: (conversationId: string) => void;
  readonly onOpenChange?: (open: boolean) => void;
}

const PADDING = 8;

export function ConversationContextMenu({
  conversation,
  position,
  triggerRef,
  onClose,
  onMarkAsRead,
  onOpenChange,
}: ConversationContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  useOpenChangeNotifier(true, onOpenChange);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const x = Math.max(PADDING, Math.min(position.x, window.innerWidth - width - PADDING));
    const y = Math.max(PADDING, Math.min(position.y, window.innerHeight - height - PADDING));
    setAdjustedPosition({ x, y });
  }, [position]);

  useEffect(() => {
    buttonRef.current?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    const onScrollOrResize = (): void => {
      onClose();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("scroll", onScrollOrResize, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("scroll", onScrollOrResize, true);
      triggerRef?.current?.focus();
    };
  }, [onClose, triggerRef]);

  const hasUnreads = conversation.unreadCount > 0 || conversation.mentionCount > 0;

  const style: CSSProperties = {
    left: `${adjustedPosition.x}px`,
    top: `${adjustedPosition.y}px`,
  };

  return createPortal(
    <div
      className="conversation-context-menu"
      data-testid="conversation-context-menu"
      ref={menuRef}
      role="menu"
      aria-label="Conversation actions"
      style={style}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        className="conversation-context-menu-item"
        data-testid="conversation-context-menu-mark-as-read"
        aria-disabled={!hasUnreads}
        onClick={() => {
          if (!hasUnreads) return;
          onMarkAsRead(conversation.conversation.id);
          onClose();
        }}
      >
        Mark as read
      </button>
    </div>,
    document.body,
  );
}
