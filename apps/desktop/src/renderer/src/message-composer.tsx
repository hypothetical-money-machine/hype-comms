import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

const MIN_COMPOSER_HEIGHT = 44;
const MAX_COMPOSER_HEIGHT = 132;

export function MessageComposer({
  conversationName,
  draft,
  disabled,
  error,
  focusKey,
  inputId = "message",
  inputLabel = "Message",
  inputRef,
  placeholder,
  submitLabel = "Send",
  variantClassName,
  onDraftChange,
  onSubmit,
}: {
  readonly conversationName: string | null;
  readonly draft: string;
  readonly disabled: boolean;
  readonly error: string;
  readonly focusKey?: string | null;
  readonly inputId?: string;
  readonly inputLabel?: string;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly variantClassName?: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => Promise<void>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const sendDisabled = disabled || isSubmitting || draft.trim() === "";

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

  useEffect(() => {
    if (focusKey === undefined || focusKey === null || disabled) return;
    input.current?.focus();
  }, [disabled, focusKey]);

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
      aria-busy={isSubmitting}
    >
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
