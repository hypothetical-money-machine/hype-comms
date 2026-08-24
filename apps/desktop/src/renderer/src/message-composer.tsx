import type { User } from "@hype-comms/contracts";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import type { Attachment } from "@hype-comms/contracts";
import { filterMentionMembers, insertMention, mentionQueryAt, segmentMentions } from "./mentions";

const MIN_COMPOSER_HEIGHT = 44;
const MAX_COMPOSER_HEIGHT = 132;

function ComposerMentionHighlight({
  draft,
  members,
  highlightRef,
}: {
  readonly draft: string;
  readonly members: readonly User[];
  readonly highlightRef: Ref<HTMLDivElement>;
}) {
  if (draft === "") return null;
  return (
    <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
      {segmentMentions(draft, members).map((segment, index) =>
        segment.kind === "mention" ? (
          <span key={index} className="mention-chip" data-mention-user-id={segment.userId}>
            {segment.text}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </div>
  );
}

export function MessageComposer({
  contextKey,
  conversationName,
  draft,
  pendingAttachments = [],
  disabled,
  attachDisabled = false,
  error,
  inputId = "message",
  inputLabel = "Message",
  inputRef,
  members = [],
  currentUserId,
  placeholder,
  submitLabel = "Send",
  variantClassName,
  onDraftChange,
  onAttach,
  onRemoveAttachment,
  onSubmit,
}: {
  readonly contextKey?: string;
  readonly conversationName: string | null;
  readonly draft: string;
  readonly pendingAttachments?: readonly Attachment[];
  readonly disabled: boolean;
  readonly attachDisabled?: boolean;
  readonly error: string;
  readonly inputId?: string;
  readonly inputLabel?: string;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  readonly members?: readonly User[];
  readonly currentUserId?: string;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly variantClassName?: string;
  readonly onDraftChange: (value: string) => void;
  readonly onAttach?: () => Promise<void>;
  readonly onRemoveAttachment?: (attachmentId: string) => void;
  readonly onSubmit: () => Promise<void>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const selectedOption = useRef<HTMLButtonElement | null>(null);
  const submitting = useRef(false);
  const attaching = useRef(false);
  const pendingCursor = useRef<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAttaching, setIsAttaching] = useState(false);
  const [cursor, setCursor] = useState(draft.length);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const sendDisabled =
    disabled || isSubmitting || (draft.trim() === "" && pendingAttachments.length === 0);

  const mentionQuery = mentionQueryAt(draft, cursor);
  const matches = useMemo(
    () => (mentionQuery === null ? [] : filterMentionMembers(members, mentionQuery.query)),
    [members, mentionQuery],
  );
  const pickerOpen = mentionQuery !== null && !dismissed && members.length > 0;
  const listboxId = `${inputId}-mention-picker`;

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.style.height = "auto";
    const height = Math.min(
      Math.max(element.scrollHeight, MIN_COMPOSER_HEIGHT),
      MAX_COMPOSER_HEIGHT,
    );
    element.style.height = `${String(height)}px`;
    element.style.overflowY = element.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [draft]);

  useLayoutEffect(() => {
    const element = input.current;
    const nextCursor = pendingCursor.current;
    if (element === null || nextCursor === null) return;
    pendingCursor.current = null;
    element.setSelectionRange(nextCursor, nextCursor);
    setCursor(nextCursor);
  }, [draft]);

  useEffect(() => {
    if (mentionQuery === null) setDismissed(false);
  }, [mentionQuery]);

  useEffect(() => {
    if (contextKey !== undefined) setDismissed(false);
  }, [contextKey]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mentionQuery?.query, mentionQuery?.start]);

  useEffect(() => {
    if (!pickerOpen) return;
    selectedOption.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (field.current?.contains(event.target as Node) === true) return;
      setDismissed(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  const syncCursor = (element: HTMLTextAreaElement): void => {
    setCursor(element.selectionStart ?? element.value.length);
  };

  const chooseMember = useCallback(
    (member: User): void => {
      if (mentionQuery === null) return;
      const next = insertMention(draft, mentionQuery, member.username);
      pendingCursor.current = next.cursor;
      setDismissed(true);
      onDraftChange(next.text);
    },
    [draft, mentionQuery, onDraftChange],
  );

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (sendDisabled || submitting.current) return;
    submitting.current = true;
    setIsSubmitting(true);
    void (async () => {
      try {
        await onSubmit();
      } finally {
        submitting.current = false;
        setIsSubmitting(false);
      }
    })();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;

    if (pickerOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) =>
          matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
        );
        return;
      }
      if (event.key === "Tab") {
        const selected = matches[activeIndex];
        if (selected !== undefined) {
          event.preventDefault();
          chooseMember(selected);
        }
        return;
      }
      if (event.key === "Enter") {
        const selected = matches[activeIndex];
        if (selected !== undefined) {
          event.preventDefault();
          chooseMember(selected);
          return;
        }
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!sendDisabled) event.currentTarget.form?.requestSubmit();
  };

  const assignInputRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      input.current = element;
      if (typeof inputRef === "function") inputRef(element);
      else if (inputRef !== undefined && inputRef !== null) inputRef.current = element;
    },
    [inputRef],
  );

  const hintId = `${inputId}-hint`;
  const effectivePlaceholder =
    placeholder ??
    (conversationName === null ? "Choose a conversation" : `Message ${conversationName}`);

  return (
    <form
      className={variantClassName === undefined ? "composer" : `composer ${variantClassName}`}
      onSubmit={submit}
      aria-busy={isSubmitting || isAttaching}
    >
      {pendingAttachments.length > 0 && (
        <ul className="composer-attachments" aria-label="Attached files">
          {pendingAttachments.map((attachment) => (
            <li key={attachment.id} className="composer-attachment">
              <span>{attachment.fileName}</span>
              {onRemoveAttachment !== undefined && (
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label={`Remove ${attachment.fileName}`}
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-input">
        <label className="sr-only" htmlFor={inputId}>
          {inputLabel}
        </label>
        <div className={draft === "" ? "composer-field" : "composer-field has-draft"} ref={field}>
          <ComposerMentionHighlight draft={draft} members={members} highlightRef={highlight} />
          <textarea
            ref={assignInputRef}
            id={inputId}
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
              syncCursor(event.target);
            }}
            onClick={(event) => syncCursor(event.currentTarget)}
            onKeyUp={(event) => syncCursor(event.currentTarget)}
            onSelect={(event) => syncCursor(event.currentTarget)}
            onScroll={(event) => {
              if (highlight.current !== null) {
                highlight.current.scrollTop = event.currentTarget.scrollTop;
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={effectivePlaceholder}
            disabled={disabled}
            maxLength={4_000}
            rows={1}
            enterKeyHint="send"
            aria-describedby={hintId}
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              pickerOpen && matches[activeIndex] !== undefined
                ? `${listboxId}-option-${matches[activeIndex].id}`
                : undefined
            }
          />
          {pickerOpen && (
            <ul
              className="mention-picker"
              id={listboxId}
              role="listbox"
              aria-label="Mention a member"
            >
              {matches.length === 0 ? (
                <li className="mention-picker-empty">No matching members</li>
              ) : (
                matches.map((member, index) => {
                  const selected = index === activeIndex;
                  const you = member.id === currentUserId ? " (you)" : "";
                  return (
                    <li key={member.id} role="presentation">
                      <button
                        ref={(element) => {
                          if (selected) selectedOption.current = element;
                        }}
                        type="button"
                        id={`${listboxId}-option-${member.id}`}
                        role="option"
                        aria-selected={selected}
                        className={selected ? "selected" : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => chooseMember(member)}
                      >
                        <span className="mention-picker-avatar" aria-hidden="true">
                          {member.displayName.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="mention-picker-name">
                          {member.displayName}
                          {you}
                        </span>
                        <small>@{member.username}</small>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          )}
        </div>
        <p className="composer-hint" id={hintId}>
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
        </p>
      </div>
      {onAttach !== undefined && (
        <button
          type="button"
          className="composer-attach"
          disabled={disabled || attachDisabled || isAttaching}
          onClick={() => {
            if (attaching.current) return;
            attaching.current = true;
            setIsAttaching(true);
            void (async () => {
              try {
                await onAttach();
              } finally {
                attaching.current = false;
                setIsAttaching(false);
              }
            })();
          }}
        >
          Attach
        </button>
      )}
      <button type="submit" disabled={sendDisabled}>
        {submitLabel}
      </button>
      {error !== "" && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
