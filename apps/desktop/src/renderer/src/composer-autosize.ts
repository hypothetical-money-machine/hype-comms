import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type RefObject,
} from "react";

export interface ComposerAutosizeOptions {
  readonly minHeight: number;
  readonly maxHeight: number;
}

export interface ComposerAutosize {
  readonly ref: RefObject<HTMLTextAreaElement | null>;
  readonly assign: (element: HTMLTextAreaElement | null) => void;
  readonly style: CSSProperties;
}

export function composerSizeStyle({
  minHeight,
  maxHeight,
}: ComposerAutosizeOptions): CSSProperties {
  return {
    "--composer-min-height": `${String(minHeight)}px`,
    "--composer-max-height": `${String(maxHeight)}px`,
  } as CSSProperties;
}

export function autosizeComposer(
  element: HTMLTextAreaElement,
  { minHeight, maxHeight }: ComposerAutosizeOptions,
): void {
  const previousScrollTop = element.scrollTop;
  const cursorIsAtEnd =
    element.selectionStart === element.value.length &&
    element.selectionEnd === element.value.length;

  element.style.height = "auto";
  const contentHeight = element.scrollHeight;
  // Composers inherit the global border-box sizing, so style.height is a border-box height
  // while scrollHeight excludes the border. Add it back or the field loses a border per resize.
  const borderHeight = Math.max(0, element.offsetHeight - element.clientHeight);
  const borderBoxHeight = contentHeight + borderHeight;
  const height = Math.min(Math.max(borderBoxHeight, minHeight), maxHeight);

  element.style.height = `${String(height)}px`;
  element.style.overflowY = borderBoxHeight > maxHeight ? "auto" : "hidden";
  element.scrollTop = cursorIsAtEnd ? contentHeight : previousScrollTop;
}

/**
 * Owns a composer textarea's height: the CSS limits it renders with, the ref that sizes it on
 * attach, and the resize that follows every edit. Attach and edit are separate entry points
 * because the element can be replaced without the draft changing — the AI composer unmounts its
 * textarea whenever the channel leaves the ready state, and the restored draft must still fit.
 */
export function useComposerAutosize(
  draft: string,
  { minHeight, maxHeight }: ComposerAutosizeOptions,
): ComposerAutosize {
  const ref = useRef<HTMLTextAreaElement>(null);

  const assign = useCallback(
    (element: HTMLTextAreaElement | null): void => {
      ref.current = element;
      if (element !== null) autosizeComposer(element, { minHeight, maxHeight });
    },
    [minHeight, maxHeight],
  );

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    autosizeComposer(element, { minHeight, maxHeight });
  }, [draft, minHeight, maxHeight]);

  const style = useMemo(() => composerSizeStyle({ minHeight, maxHeight }), [minHeight, maxHeight]);

  return { ref, assign, style };
}
