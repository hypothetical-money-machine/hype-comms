import type { CSSProperties } from "react";

export interface ComposerAutosizeOptions {
  readonly minHeight: number;
  readonly maxHeight: number;
}

type ComposerSizeStyle = CSSProperties & {
  readonly "--composer-min-height": string;
  readonly "--composer-max-height": string;
};

export function composerSizeStyle({
  minHeight,
  maxHeight,
}: ComposerAutosizeOptions): ComposerSizeStyle {
  return {
    "--composer-min-height": `${String(minHeight)}px`,
    "--composer-max-height": `${String(maxHeight)}px`,
  };
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
  const borderHeight = Math.max(0, element.offsetHeight - element.clientHeight);
  const borderBoxHeight = contentHeight + borderHeight;
  const height = Math.min(Math.max(borderBoxHeight, minHeight), maxHeight);

  element.style.height = `${String(height)}px`;
  element.style.overflowY = borderBoxHeight > maxHeight ? "auto" : "hidden";
  element.scrollTop = cursorIsAtEnd ? contentHeight : previousScrollTop;
}
