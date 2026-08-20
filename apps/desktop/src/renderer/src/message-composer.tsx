import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import type { Attachment } from "@hype-comms/contracts";

const MIN_COMPOSER_HEIGHT = 44;
const MAX_COMPOSER_HEIGHT = 132;

export function MessageComposer({
  conversationName,
  draft,
  pendingAttachments = [],
  disabled,
  attachDisabled = false,
  error,
  inputId = "message",
  inputLabel = "Message",
  inputRef,
  placeholder,
  submitLabel = "Send",
  variantClassName,
  onDraftChange,
  onAttach,
  onRemoveAttachment,
  onSubmit,
}: {
  readonly conversationName: string | null;
  readonly draft: string;
  readonly pendingAttachments?: readonly Attachment[];
  readonly disabled: boolean;
  readonly attachDisabled?: boolean;
  readonly error: string;
  readonly inputId?: string;
  readonly inputLabel?: string;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly variantClassName?: string;
  readonly onDraftChange: (value: string) => void;
  readonly onAttach?: () => Promise<void>;
  readonly onRemoveAttachment?: (attachmentId: string) => void;
  readonly onSubmit: () => Promise<void>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const attaching = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAttaching, setIsAttaching] = useState(false);
  const sendDisabled =
    disabled || isSubmitting || (draft.trim() === "" && pendingAttachments.length === 0);

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
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
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
        <textarea
          ref={assignInputRef}
          id={inputId}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          maxLength={4_000}
          rows={1}
          enterKeyHint="send"
          aria-describedby={hintId}
        />
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
