export type ComposerFormatAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  | "bulleted-list"
  | "numbered-list"
  | "quote";

export interface ComposerFormatResult {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * Italic uses `_` rather than `*` so its marker never collides with bold's `**` — toggling one
 * format off can then never eat the other's delimiters.
 */
const INLINE_MARKERS = {
  bold: "**",
  italic: "_",
  strikethrough: "~~",
  code: "`",
} as const;

type InlineFormat = keyof typeof INLINE_MARKERS;

const LINE_RULES = {
  "bulleted-list": { pattern: /^[-*] /u, prefix: () => "- " },
  "numbered-list": { pattern: /^\d+\. /u, prefix: (ordinal: number) => `${String(ordinal + 1)}. ` },
  quote: { pattern: /^> /u, prefix: () => "> " },
} as const;

type LineFormat = keyof typeof LINE_RULES;

const LINK_TEXT_PLACEHOLDER = "link text";
const LINK_URL_PLACEHOLDER = "url";
const URL_PATTERN = /^https?:\/\/\S+$/iu;

function toggleInline(
  text: string,
  start: number,
  end: number,
  format: InlineFormat,
): ComposerFormatResult {
  const marker = INLINE_MARKERS[format];
  const width = marker.length;
  const selected = text.slice(start, end);

  if (selected.length >= width * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(width, selected.length - width);
    return {
      text: `${text.slice(0, start)}${inner}${text.slice(end)}`,
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }

  if (
    start >= width &&
    text.slice(start - width, start) === marker &&
    text.slice(end, end + width) === marker
  ) {
    return {
      text: `${text.slice(0, start - width)}${selected}${text.slice(end + width)}`,
      selectionStart: start - width,
      selectionEnd: end - width,
    };
  }

  return {
    text: `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`,
    selectionStart: start + width,
    selectionEnd: end + width,
  };
}

function toggleLines(
  text: string,
  start: number,
  end: number,
  format: LineFormat,
): ComposerFormatResult {
  const rule = LINE_RULES[format];
  const blockStart = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  // A selection made by dragging to the start of the next line ends on a newline; that trailing
  // line is not part of what the user meant to format.
  const effectiveEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const newlineAfter = text.indexOf("\n", effectiveEnd);
  const blockEnd = newlineAfter === -1 ? text.length : newlineAfter;
  const lines = text.slice(blockStart, blockEnd).split("\n");
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const formatted = nonEmpty.length > 0 && nonEmpty.every((line) => rule.pattern.test(line));

  let ordinal = 0;
  const nextLines = lines.map((line) => {
    if (formatted) return line.replace(rule.pattern, "");
    if (lines.length > 1 && line.trim() === "") return line;
    // Re-prefixing from the bare line keeps a mixed selection from double-prefixing and
    // renumbers stale ordinals.
    return `${rule.prefix(ordinal++)}${line.replace(rule.pattern, "")}`;
  });
  const block = nextLines.join("\n");
  const nextText = `${text.slice(0, blockStart)}${block}${text.slice(blockEnd)}`;

  if (start === end) {
    const firstLine = lines[0] ?? "";
    const firstNextLine = nextLines[0] ?? "";
    const caret = Math.max(blockStart, start + (firstNextLine.length - firstLine.length));
    return { text: nextText, selectionStart: caret, selectionEnd: caret };
  }
  return { text: nextText, selectionStart: blockStart, selectionEnd: blockStart + block.length };
}

function insertLink(text: string, start: number, end: number): ComposerFormatResult {
  const selected = text.slice(start, end);
  const selectedIsUrl = URL_PATTERN.test(selected);
  const label = selected === "" || selectedIsUrl ? LINK_TEXT_PLACEHOLDER : selected;
  const url = selectedIsUrl ? selected : LINK_URL_PLACEHOLDER;
  const nextText = `${text.slice(0, start)}[${label}](${url})${text.slice(end)}`;
  // Select whichever half still holds placeholder text so the user can type straight over it.
  const selectLabel = selected === "" || selectedIsUrl;
  const labelStart = start + 1;
  const urlStart = labelStart + label.length + 2;
  return {
    text: nextText,
    selectionStart: selectLabel ? labelStart : urlStart,
    selectionEnd: selectLabel ? labelStart + label.length : urlStart + url.length,
  };
}

export function applyComposerFormat(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  action: ComposerFormatAction,
): ComposerFormatResult {
  const clamp = (value: number): number => Math.min(Math.max(value, 0), text.length);
  const start = clamp(Math.min(selectionStart, selectionEnd));
  const end = clamp(Math.max(selectionStart, selectionEnd));

  switch (action) {
    case "bold":
    case "italic":
    case "strikethrough":
    case "code":
      return toggleInline(text, start, end, action);
    case "link":
      return insertLink(text, start, end);
    case "bulleted-list":
    case "numbered-list":
    case "quote":
      return toggleLines(text, start, end, action);
  }
}

export interface ComposerShortcutKey {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Plain Mod+K stays with the conversation quick switcher and Mod+Shift+S with compact mode, so
 * link takes Mod+Shift+K and nothing here claims Mod+Shift+S. The digit rows use `code` because
 * Shift rewrites `key` per keyboard layout.
 */
export function composerFormatShortcut(event: ComposerShortcutKey): ComposerFormatAction | null {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLocaleLowerCase();
  if (event.shiftKey) {
    if (key === "x") return "strikethrough";
    if (key === "k") return "link";
    if (event.code === "Digit7") return "numbered-list";
    if (event.code === "Digit8") return "bulleted-list";
    if (event.code === "Digit9") return "quote";
    return null;
  }
  if (key === "b") return "bold";
  if (key === "i") return "italic";
  if (key === "e") return "code";
  return null;
}

const SHORTCUT_KEYS: Record<
  ComposerFormatAction,
  { readonly shift: boolean; readonly key: string }
> = {
  bold: { shift: false, key: "B" },
  italic: { shift: false, key: "I" },
  code: { shift: false, key: "E" },
  strikethrough: { shift: true, key: "X" },
  link: { shift: true, key: "K" },
  "numbered-list": { shift: true, key: "7" },
  "bulleted-list": { shift: true, key: "8" },
  quote: { shift: true, key: "9" },
};

/** Kept beside the matcher so the advertised shortcut cannot drift from the handled one. */
export function composerFormatShortcutLabel(
  action: ComposerFormatAction,
  platform: string,
): string {
  const { shift, key } = SHORTCUT_KEYS[action];
  const modifier = platform === "darwin" ? "Cmd" : "Ctrl";
  return shift ? `${modifier}+Shift+${key}` : `${modifier}+${key}`;
}
