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
import {
  applyComposerFormat,
  composerFormatShortcut,
  composerFormatShortcutLabel,
  type ComposerFormatAction,
} from "./composer-formatting";
import { filterMentionMembers, insertMention, mentionQueryAt, segmentMentions } from "./mentions";

const MIN_COMPOSER_HEIGHT = 44;
const MAX_COMPOSER_HEIGHT = 132;
const MAX_MESSAGE_LENGTH = 4_000;

const FORMATTING_CONTROLS: readonly (
  | { readonly kind: "control"; readonly action: ComposerFormatAction; readonly label: string }
  | { readonly kind: "divider" }
)[] = [
  { kind: "control", action: "bold", label: "Bold" },
  { kind: "control", action: "italic", label: "Italic" },
  { kind: "control", action: "strikethrough", label: "Strikethrough" },
  { kind: "control", action: "code", label: "Inline code" },
  { kind: "divider" },
  { kind: "control", action: "link", label: "Link" },
  { kind: "divider" },
  { kind: "control", action: "bulleted-list", label: "Bulleted list" },
  { kind: "control", action: "numbered-list", label: "Numbered list" },
  { kind: "control", action: "quote", label: "Quote" },
];

function formatIcon(action: ComposerFormatAction) {
  switch (action) {
    case "bold":
      return <strong>B</strong>;
    case "italic":
      return <em>I</em>;
    case "strikethrough":
      return <s>S</s>;
    case "code":
      return <code>{"</>"}</code>;
    case "link":
      return (
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6.5 9.5 9.5 6.5" />
          <path d="m7.3 4.7 1.5-1.5a2.4 2.4 0 0 1 3.4 0 2.4 2.4 0 0 1 0 3.4L10.7 8.1" />
          <path d="M8.7 11.3l-1.5 1.5a2.4 2.4 0 0 1-3.4 0 2.4 2.4 0 0 1 0-3.4l1.5-1.5" />
        </svg>
      );
    case "bulleted-list":
      return (
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6.5 4h7 M6.5 8h7 M6.5 12h7" />
          <path d="M3 4h.01 M3 8h.01 M3 12h.01" strokeWidth="2.4" />
        </svg>
      );
    case "numbered-list":
      return <span aria-hidden="true">1.</span>;
    case "quote":
      return (
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 3v10 M6.5 6h7 M6.5 10h5" />
        </svg>
      );
  }
}

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
  platform = "",
  submitLabel = "Send",
  variantClassName,
  typingText = "",
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
  readonly platform?: string;
  readonly submitLabel?: string;
  readonly variantClassName?: string;
  readonly typingText?: string;
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
  const pendingSelection = useRef<{ readonly start: number; readonly end: number } | null>(null);
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
    const nextSelection = pendingSelection.current;
    if (element === null || nextSelection === null) return;
    pendingSelection.current = null;
    element.setSelectionRange(nextSelection.start, nextSelection.end);
    setCursor(nextSelection.end);
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
      pendingSelection.current = { start: next.cursor, end: next.cursor };
      setDismissed(true);
      onDraftChange(next.text);
    },
    [draft, mentionQuery, onDraftChange],
  );

  const applyFormat = (action: ComposerFormatAction): void => {
    const element = input.current;
    if (element === null || disabled) return;
    const start = element.selectionStart ?? draft.length;
    const end = element.selectionEnd ?? start;
    const result = applyComposerFormat(draft, start, end, action);
    if (result.text.length > MAX_MESSAGE_LENGTH) return;
    pendingSelection.current = { start: result.selectionStart, end: result.selectionEnd };
    onDraftChange(result.text);
    if (document.activeElement !== element) element.focus();
  };

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

    const formatAction = composerFormatShortcut(event);
    if (formatAction !== null) {
      event.preventDefault();
      applyFormat(formatAction);
      return;
    }

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
      <p
        className={typingText === "" ? "typing-indicator idle" : "typing-indicator active"}
        aria-live="polite"
        aria-hidden={typingText === "" ? true : undefined}
      >
        {typingText === "" ? "\u00a0" : typingText}
      </p>
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
        <div className="composer-toolbar" role="toolbar" aria-label="Text formatting">
          {FORMATTING_CONTROLS.map((control, index) =>
            control.kind === "divider" ? (
              <span key={index} className="composer-toolbar-divider" aria-hidden="true" />
            ) : (
              <button
                key={control.action}
                type="button"
                aria-label={control.label}
                title={`${control.label} (${composerFormatShortcutLabel(control.action, platform)})`}
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyFormat(control.action)}
              >
                {formatIcon(control.action)}
              </button>
            ),
          )}
        </div>
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
            maxLength={MAX_MESSAGE_LENGTH}
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
