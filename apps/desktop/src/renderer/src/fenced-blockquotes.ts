import type { FencedBlockquoteMode } from "./fenced-blockquote-runtime";

interface CodeFence {
  readonly continuationPrefix: string;
  readonly length: number;
  readonly marker: "`" | "~";
}

function splitCodeContainer(line: string): {
  readonly content: string;
  readonly continuationPrefix: string;
} {
  let cursor = /^ {0,3}/u.exec(line)?.[0].length ?? 0;
  const initialIndent = line.slice(0, cursor);
  let continuationPrefix = "";
  let hasContainer = false;

  while (cursor < line.length) {
    if (line[cursor] === ">") {
      if (!hasContainer) continuationPrefix = initialIndent;
      hasContainer = true;
      continuationPrefix += ">";
      cursor += 1;
      if (line[cursor] === " " || line[cursor] === "\t") {
        continuationPrefix += line[cursor];
        cursor += 1;
      }
      const indent = /^ {0,3}/u.exec(line.slice(cursor))?.[0] ?? "";
      continuationPrefix += indent;
      cursor += indent.length;
      continue;
    }

    const listMarker = /^(?:[*+-]|\d{1,9}[.)])[\t ]{1,4}/u.exec(line.slice(cursor))?.[0];
    if (listMarker === undefined) break;
    if (!hasContainer) continuationPrefix = initialIndent;
    hasContainer = true;
    continuationPrefix += " ".repeat(listMarker.length);
    cursor += listMarker.length;
  }

  return {
    content: line.slice(cursor),
    continuationPrefix: hasContainer ? continuationPrefix : "",
  };
}

function openingCodeFence(line: string): CodeFence | null {
  const { content, continuationPrefix } = splitCodeContainer(line);
  const match = /^(`{3,}|~{3,})(.*)$/u.exec(content);
  const fence = match?.[1];
  if (fence === undefined) return null;
  const marker = fence[0];
  if (marker !== "`" && marker !== "~") return null;
  if (marker === "`" && match?.[2]?.includes("`")) return null;
  return { continuationPrefix, marker, length: fence.length };
}

function closesCodeFence(line: string, fence: CodeFence): boolean {
  const content =
    fence.continuationPrefix !== "" && line.startsWith(fence.continuationPrefix)
      ? line.slice(fence.continuationPrefix.length)
      : line;
  const match = /^ {0,3}(`+|~+)[\t ]*$/u.exec(content);
  const candidate = match?.[1];
  return (
    candidate !== undefined && candidate[0] === fence.marker && candidate.length >= fence.length
  );
}

function isQuoteFence(line: string, marker: string): boolean {
  const match = /^ {0,3}(\S+)[\t ]*$/u.exec(line);
  return match?.[1] === marker;
}

function findClosingQuoteFence(lines: readonly string[], start: number, marker: string): number {
  let codeFence: CodeFence | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (codeFence !== null) {
      if (closesCodeFence(line, codeFence)) codeFence = null;
      continue;
    }
    const openedCodeFence = openingCodeFence(line);
    if (openedCodeFence !== null) {
      codeFence = openedCodeFence;
      continue;
    }
    if (isQuoteFence(line, marker)) return index;
  }
  return -1;
}

function markerForMode(mode: FencedBlockquoteMode): string | null {
  if (mode === "double-quote") return '"""';
  if (mode === "greater-than") return ">>>";
  return null;
}

/**
 * Expands the selected nonstandard quote fence into ordinary CommonMark blockquote markers before
 * parsing. Fences inside code blocks and unclosed fences remain literal text.
 */
export function expandFencedBlockquotes(source: string, mode: FencedBlockquoteMode): string {
  const marker = markerForMode(mode);
  if (marker === null) return source;

  const lineEnding = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
  const lines = source.split(/\r\n|\r|\n/u);
  const output: string[] = [];
  let codeFence: CodeFence | null = null;
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (codeFence !== null) {
      output.push(line);
      if (closesCodeFence(line, codeFence)) codeFence = null;
      continue;
    }

    const openedCodeFence = openingCodeFence(line);
    if (openedCodeFence !== null) {
      codeFence = openedCodeFence;
      output.push(line);
      continue;
    }

    if (!isQuoteFence(line, marker)) {
      output.push(line);
      continue;
    }

    const closingIndex = findClosingQuoteFence(lines, index + 1, marker);
    if (closingIndex === -1) {
      output.push(line);
      continue;
    }

    changed = true;
    for (let quoteIndex = index + 1; quoteIndex < closingIndex; quoteIndex += 1) {
      const quotedLine = lines[quoteIndex] ?? "";
      output.push(quotedLine === "" ? ">" : `> ${quotedLine}`);
    }
    index = closingIndex;
  }

  return changed ? output.join(lineEnding) : source;
}
