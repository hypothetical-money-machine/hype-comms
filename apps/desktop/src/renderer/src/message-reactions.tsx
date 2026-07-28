import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { Reaction, ReactionEmoji, User } from "@hmm-chat/contracts";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🚀", "✅", "🤔"] as const;
const PICKER_WIDTH = 316;
const PICKER_HEIGHT = 50;
const PICKER_GAP = 7;

export interface ReactionGroup {
  readonly emoji: ReactionEmoji;
  readonly reactions: readonly Reaction[];
  readonly currentUserReaction: Reaction | null;
}

export function groupReactions(
  reactions: readonly Reaction[],
  currentUserId: string,
): readonly ReactionGroup[] {
  const groups = new Map<ReactionEmoji, Reaction[]>();
  for (const reaction of reactions) {
    const grouped = groups.get(reaction.emoji) ?? [];
    grouped.push(reaction);
    groups.set(reaction.emoji, grouped);
  }
  return [...groups.entries()].map(([emoji, grouped]) => ({
    emoji,
    reactions: grouped,
    currentUserReaction: grouped.find((reaction) => reaction.userId === currentUserId) ?? null,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Could not update the reaction";
}

export function MessageReactions({
  reactions,
  members,
  currentUserId,
  disabled,
  onAdd,
  onRemove,
}: {
  readonly reactions: readonly Reaction[];
  readonly members: readonly User[];
  readonly currentUserId: string;
  readonly disabled: boolean;
  readonly onAdd: (emoji: ReactionEmoji) => Promise<void>;
  readonly onRemove: (emoji: ReactionEmoji) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pendingEmoji, setPendingEmoji] = useState<ReactionEmoji | null>(null);
  const [error, setError] = useState("");
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const restoreFocusOnClose = useRef(false);
  const groups = useMemo(
    () => groupReactions(reactions, currentUserId),
    [currentUserId, reactions],
  );
  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.id, member.displayName])),
    [members],
  );

  useEffect(() => {
    if (!open) {
      if (restoreFocusOnClose.current) {
        restoreFocusOnClose.current = false;
        trigger.current?.focus();
      }
      return;
    }
    const position = (): void => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (bounds === undefined) return;
      const left = Math.max(
        8,
        Math.min(bounds.left, Math.max(8, window.innerWidth - PICKER_WIDTH - 8)),
      );
      const top =
        bounds.top >= PICKER_HEIGHT + PICKER_GAP + 8
          ? bounds.top - PICKER_HEIGHT - PICKER_GAP
          : bounds.bottom + PICKER_GAP;
      setPickerPosition({ top, left });
    };
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !picker.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        restoreFocusOnClose.current = true;
        setOpen(false);
      }
    };
    position();
    picker.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus();
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);

  const toggle = async (emoji: ReactionEmoji, remove: boolean): Promise<void> => {
    if (disabled || pendingEmoji !== null) return;
    setPendingEmoji(emoji);
    setError("");
    try {
      if (remove) await onRemove(emoji);
      else await onAdd(emoji);
      restoreFocusOnClose.current = true;
      setOpen(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPendingEmoji(null);
    }
  };

  return (
    <div className="message-reactions" ref={root}>
      <div className="reaction-chips">
        {groups.map((group) => {
          const hasCurrentUser = group.currentUserReaction !== null;
          const names = group.reactions
            .map((reaction) => memberNames.get(reaction.userId) ?? "Former member")
            .join(", ");
          return (
            <button
              className={hasCurrentUser ? "reaction-chip selected" : "reaction-chip"}
              type="button"
              key={group.emoji}
              disabled={disabled || pendingEmoji !== null}
              aria-label={`${group.emoji} ${String(group.reactions.length)} ${group.reactions.length === 1 ? "reaction" : "reactions"}; ${hasCurrentUser ? "remove your reaction" : "add your reaction"}`}
              title={names}
              onClick={() => void toggle(group.emoji, hasCurrentUser)}
            >
              <span aria-hidden="true">{group.emoji}</span>
              <span>{group.reactions.length}</span>
            </button>
          );
        })}
        <button
          className="reaction-add"
          type="button"
          ref={trigger}
          disabled={disabled || pendingEmoji !== null}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={disabled ? "Reactions are unavailable in archived channels" : "Add reaction"}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">＋</span>
        </button>
      </div>
      {open &&
        createPortal(
          <div
            className="reaction-picker"
            role="menu"
            aria-label="Choose a reaction"
            ref={picker}
            onKeyDown={(event) => {
              const items = [
                ...(picker.current?.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitemcheckbox"]:not(:disabled)',
                ) ?? []),
              ];
              if (items.length === 0) return;
              const currentIndex = Math.max(
                0,
                items.indexOf(document.activeElement as HTMLButtonElement),
              );
              let nextIndex: number | null = null;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                nextIndex = (currentIndex + 1) % items.length;
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                nextIndex = (currentIndex - 1 + items.length) % items.length;
              } else if (event.key === "Home") {
                nextIndex = 0;
              } else if (event.key === "End") {
                nextIndex = items.length - 1;
              }
              if (nextIndex === null) return;
              event.preventDefault();
              items[nextIndex]?.focus();
            }}
            style={{
              top: `${String(pickerPosition.top)}px`,
              left: `${String(pickerPosition.left)}px`,
            }}
          >
            {QUICK_REACTIONS.map((emoji) => {
              const remove = groups.some(
                (group) => group.emoji === emoji && group.currentUserReaction !== null,
              );
              return (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={remove}
                  key={emoji}
                  disabled={pendingEmoji !== null}
                  aria-label={`${remove ? "Remove" : "Add"} ${emoji} reaction`}
                  onClick={() => void toggle(emoji, remove)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      {error !== "" && (
        <p className="reaction-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
