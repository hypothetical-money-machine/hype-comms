import type { DesktopPlatform } from "../../shared/desktop-api";

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
 * Italic uses `*`, not `_`: underscores are word characters in usernames, so `_@name_` would fall
 * out of the mention boundary scan and silently drop the mention's notification and agent wake.
 * Sharing bold's character requires the run-parity checks in toggleInline so neither format eats
 * the other's delimiters. Code spans live in toggleCode, which sizes its own fences.
 */
const INLINE_MARKERS = {
  bold: "**",
  italic: "*",
  strikethrough: "~~",
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

/**
 * Mirrors the renderer's link policy (HTTPS only, no embedded credentials): anything it would
 * refuse to link must become the label, not a permanently dead destination.
 */
function isLinkableUrl(value: string): boolean {
  if (!/^https:\/\/\S+$/iu.test(value)) return false;
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** Length of the run of `char` at `index` — forward from it, or backward ending just before it. */
function runLength(value: string, index: number, step: -1 | 1, char: string): number {
  let count = 0;
  for (
    let i = step === -1 ? index - 1 : index;
    i >= 0 && i < value.length && value[i] === char;
    i += step
  ) {
    count += 1;
  }
  return count;
}

/** An odd asterisk run contains an italic marker; an even one belongs to bold, or is nothing. */
function isItalicRun(run: number): boolean {
  return run % 2 === 1;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Marker runs glued to a word character on their far side belong to a neighboring span — the `*`
 * before `@alex` in `*foo*@alex*` closes `*foo*` — and must never be treated as the selection's
 * own delimiters, or unwrapping corrupts the neighbor. The cost is that intraword italics and code
 * unwrap by re-wrapping instead; mention integrity wins that trade.
 */
function notWordChar(char: string | undefined): boolean {
  return char === undefined || !WORD_CHAR.test(char);
}

/** True when the odd asterisk runs on both sides of the selection can pair as emphasis around it. */
function italicPairSurrounds(text: string, start: number, end: number): boolean {
  const before = runLength(text, start, -1, "*");
  const after = runLength(text, end, 1, "*");
  if (!isItalicRun(before) || !isItalicRun(after)) return false;
  return notWordChar(text[start - before - 1]) && notWordChar(text[end + after]);
}

const MENTION_WORD = /[\p{L}\p{N}_-]/u;
const MENTION_BOUNDARY = /[\p{L}\p{N}_]/u;

/**
 * The maximal `@token` span containing `index`, when the `@` sits at a mention boundary. Null when
 * `index` is outside any such token or at its edge.
 */
function mentionTokenAt(text: string, index: number): { start: number; end: number } | null {
  let at = index;
  while (at > 0 && MENTION_WORD.test(text[at - 1] ?? "")) at -= 1;
  if (at === 0 || text[at - 1] !== "@") return null;
  const atSign = at - 1;
  if (atSign > 0 && MENTION_BOUNDARY.test(text[atSign - 1] ?? "")) return null;
  let end = index;
  while (end < text.length && MENTION_WORD.test(text[end] ?? "")) end += 1;
  return { start: atSign, end };
}

/**
 * Markers dropped inside an `@username` token stop the mention scan from finding the literal
 * contiguous mention, silently losing its notification and agent wake — so wrapping expands to
 * cover the whole token instead of splitting it.
 */
function snapWrapRange(
  text: string,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } {
  // Snap only when the boundary falls strictly inside the token: a selection starting exactly at
  // a mention's end (or ending at its start) does not split it, and expanding there would drag
  // neighboring text — like the `*foo*` after `@alex*foo*` — into the wrap.
  const startToken = mentionTokenAt(text, start);
  const endToken = mentionTokenAt(text, end);
  return {
    start:
      startToken !== null && start > startToken.start && start < startToken.end
        ? startToken.start
        : start,
    end: endToken !== null && end > endToken.start && end < endToken.end ? endToken.end : end,
  };
}

function toggleInline(
  text: string,
  start: number,
  end: number,
  format: InlineFormat,
): ComposerFormatResult {
  const marker = INLINE_MARKERS[format];
  const width = marker.length;
  const selected = text.slice(start, end);

  const selectionCarriesMarkers =
    format === "italic"
      ? selected.length >= 2 &&
        isItalicRun(runLength(selected, 0, 1, "*")) &&
        isItalicRun(runLength(selected, selected.length, -1, "*")) &&
        runLength(selected, 0, 1, "*") + runLength(selected, selected.length, -1, "*") <=
          selected.length &&
        notWordChar(text[start - 1]) &&
        notWordChar(text[end])
      : selected.length >= width * 2 && selected.startsWith(marker) && selected.endsWith(marker);
  if (selectionCarriesMarkers) {
    const inner = selected.slice(width, selected.length - width);
    return {
      text: `${text.slice(0, start)}${inner}${text.slice(end)}`,
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }

  const surroundedByMarkers =
    format === "italic"
      ? italicPairSurrounds(text, start, end)
      : start >= width &&
        text.slice(start - width, start) === marker &&
        text.slice(end, end + width) === marker;
  if (surroundedByMarkers) {
    return {
      text: `${text.slice(0, start - width)}${selected}${text.slice(end + width)}`,
      selectionStart: start - width,
      selectionEnd: end - width,
    };
  }

  const range = snapWrapRange(text, start, end);
  const wrapped = text.slice(range.start, range.end);
  return {
    text: `${text.slice(0, range.start)}${marker}${wrapped}${marker}${text.slice(range.end)}`,
    selectionStart: range.start + width,
    selectionEnd: range.end + width,
  };
}

function longestBacktickRun(value: string): number {
  let max = 0;
  for (const run of value.match(/`+/gu) ?? []) max = Math.max(max, run.length);
  return max;
}

interface CodeSpanBounds {
  readonly openStart: number;
  readonly openEnd: number;
  readonly closeStart: number;
  readonly closeEnd: number;
}

/**
 * CommonMark code spans resolve left to right: a backtick run opens a span that the next run of
 * exactly the same length closes. Scanning the whole text is the only reliable way to tell a
 * span's own fences from a neighbor's — the local context around a selection cannot distinguish
 * `x` in `` `x` `` from x between `` `a` `` and `` `b` ``.
 */
function codeSpanContaining(text: string, start: number, end: number): CodeSpanBounds | null {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    const openStart = i;
    let openEnd = i;
    while (openEnd < text.length && text[openEnd] === "`") openEnd += 1;
    const width = openEnd - openStart;
    let closeStart = -1;
    let j = openEnd;
    while (j < text.length) {
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      const runStart = j;
      while (j < text.length && text[j] === "`") j += 1;
      if (j - runStart === width) {
        closeStart = runStart;
        break;
      }
    }
    if (closeStart === -1) {
      i = openEnd;
      continue;
    }
    if (openEnd <= start && end <= closeStart) {
      return { openStart, openEnd, closeStart, closeEnd: closeStart + width };
    }
    if (openStart > end) return null;
    i = closeStart + width;
  }
  return null;
}

/**
 * Code spans cannot backslash-escape backticks, so a selection containing one needs a fence one
 * backtick longer than its longest run, space-padded when the content itself edges on a backtick.
 */
function toggleCode(text: string, start: number, end: number): ComposerFormatResult {
  const selected = text.slice(start, end);

  const wrapped = /^(`+)( ?)([\s\S]*)\2\1$/u.exec(selected);
  if (wrapped !== null) {
    const [, fence, , inner] = wrapped;
    if (fence !== undefined && inner !== undefined && longestBacktickRun(inner) < fence.length) {
      return {
        text: `${text.slice(0, start)}${inner}${text.slice(end)}`,
        selectionStart: start,
        selectionEnd: start + inner.length,
      };
    }
  }

  // A selection inside a real span's content unwraps that span, pads and all — determined by
  // parsing, so neighboring spans' fences are never mistaken for this selection's wrapper. This
  // runs before the empty-pair check: a caret splitting a backtick run inside span content must
  // unwrap the span, not delete content backticks.
  const span = codeSpanContaining(text, start, end);
  if (span !== null) {
    const inner = text.slice(span.openEnd, span.closeStart);
    const padded = inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "";
    const content = padded ? inner.slice(1, -1) : inner;
    return {
      text: `${text.slice(0, span.openStart)}${content}${text.slice(span.closeEnd)}`,
      selectionStart: span.openStart,
      selectionEnd: span.openStart + content.length,
    };
  }

  // A caret splitting an unmatched backtick run evenly is an empty fence pair left by the wrap
  // branch.
  if (start === end) {
    const beforeRun = runLength(text, start, -1, "`");
    const afterRun = runLength(text, end, 1, "`");
    if (beforeRun > 0 && beforeRun === afterRun) {
      return {
        text: `${text.slice(0, start - beforeRun)}${text.slice(end + afterRun)}`,
        selectionStart: start - beforeRun,
        selectionEnd: start - beforeRun,
      };
    }
  }

  const range = snapWrapRange(text, start, end);
  const content = text.slice(range.start, range.end);
  const fence = "`".repeat(longestBacktickRun(content) + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  const opening = `${fence}${pad}`;
  return {
    text: `${text.slice(0, range.start)}${opening}${content}${pad}${fence}${text.slice(range.end)}`,
    selectionStart: range.start + opening.length,
    selectionEnd: range.end + opening.length,
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

/** A label like `docs]` would otherwise close the link early and emit invalid Markdown. */
function escapeLinkLabel(label: string): string {
  return label.replace(/[\\[\]]/gu, "\\$&");
}

function insertLink(text: string, start: number, end: number): ComposerFormatResult {
  const selected = text.slice(start, end);
  const selectedIsUrl = isLinkableUrl(selected);
  // Select whichever half still holds placeholder text so the user can type straight over it.
  const labelIsPlaceholder = selected === "" || selectedIsUrl;
  const label = labelIsPlaceholder ? LINK_TEXT_PLACEHOLDER : escapeLinkLabel(selected);
  // Unescaped parentheses would close or truncate the Markdown destination early, angle brackets
  // are destination-reserved, and a literal backslash would swallow the character after it.
  const url = selectedIsUrl ? selected.replace(/[\\()<>]/gu, "\\$&") : LINK_URL_PLACEHOLDER;
  const nextText = `${text.slice(0, start)}[${label}](${url})${text.slice(end)}`;
  const labelStart = start + 1;
  const urlStart = labelStart + label.length + 2;
  return {
    text: nextText,
    selectionStart: labelIsPlaceholder ? labelStart : urlStart,
    selectionEnd: labelIsPlaceholder ? labelStart + label.length : urlStart + url.length,
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
      return toggleInline(text, start, end, action);
    case "code":
      return toggleCode(text, start, end);
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
 * link takes Mod+Shift+K and nothing here claims Mod+Shift+S. The digit rows match on `code`
 * because Shift rewrites `key` per keyboard layout.
 *
 * Only the platform's advertised modifier matches — on macOS, Ctrl+B/E must keep their native
 * cursor-movement behavior in text fields, and elsewhere Meta combinations stay untouched.
 *
 * One table drives both the matcher and the advertised label, so what is handled and what is
 * advertised cannot drift apart.
 */
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

const SHORTCUT_ACTIONS = Object.keys(SHORTCUT_KEYS) as readonly ComposerFormatAction[];

export function composerFormatShortcut(
  event: ComposerShortcutKey,
  platform: DesktopPlatform,
): ComposerFormatAction | null {
  const modifier =
    platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey) return null;
  const digit = /^Digit(\d)$/u.exec(event.code)?.[1];
  const pressed = digit ?? event.key.toLocaleLowerCase();
  return (
    SHORTCUT_ACTIONS.find(
      (action) =>
        SHORTCUT_KEYS[action].shift === event.shiftKey &&
        SHORTCUT_KEYS[action].key.toLocaleLowerCase() === pressed,
    ) ?? null
  );
}

export function composerFormatShortcutLabel(
  action: ComposerFormatAction,
  platform: DesktopPlatform,
): string {
  const { shift, key } = SHORTCUT_KEYS[action];
  const modifier = platform === "darwin" ? "Cmd" : "Ctrl";
  return shift ? `${modifier}+Shift+${key}` : `${modifier}+${key}`;
}
