import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const MIN_COMPOSER_HEIGHT = 44;
const MAX_COMPOSER_HEIGHT = 132;

export function MessageComposer({
  conversationName,
  draft,
  disabled,
  error,
  onDraftChange,
  onSubmit,
}: {
  readonly conversationName: string | null;
  readonly draft: string;
  readonly disabled: boolean;
  readonly error: string;
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

  return (
    <form className="composer" onSubmit={submit} aria-busy={isSubmitting}>
      <div className="composer-input">
        <label className="sr-only" htmlFor="message">
          Message
        </label>
        <textarea
          ref={input}
          id="message"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            conversationName === null ? "Choose a conversation" : `Message ${conversationName}`
          }
          disabled={disabled}
          maxLength={4_000}
          rows={1}
          enterKeyHint="send"
          aria-describedby="composer-hint"
        />
        <p className="composer-hint" id="composer-hint">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
        </p>
      </div>
      <button type="submit" disabled={sendDisabled}>
        Send
      </button>
      {error !== "" && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
