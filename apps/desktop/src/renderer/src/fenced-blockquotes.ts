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
  const content = stripCodeContinuation(line, fence.continuationPrefix);
  if (content === null) return false;
  const match = /^ {0,3}(`+|~+)[\t ]*$/u.exec(content);
  const candidate = match?.[1];
  return (
    candidate !== undefined && candidate[0] === fence.marker && candidate.length >= fence.length
  );
}

function stripCodeContinuation(line: string, prefix: string): string | null {
  if (prefix === "") return line;
  const blockquoteDepth = Array.from(prefix).filter((character) => character === ">").length;
  if (blockquoteDepth === 0) return line.startsWith(prefix) ? line.slice(prefix.length) : null;

  let cursor = /^ {0,3}/u.exec(line)?.[0].length ?? 0;
  for (let depth = 0; depth < blockquoteDepth; depth += 1) {
    if (line[cursor] !== ">") return null;
    cursor += 1;
    if (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    cursor += /^ {0,3}/u.exec(line.slice(cursor))?.[0].length ?? 0;
  }
  return line.slice(cursor);
}

function codeFenceContainerEnded(line: string, fence: CodeFence): boolean {
  return (
    fence.continuationPrefix !== "" &&
    stripCodeContinuation(line, fence.continuationPrefix) === null
  );
}

function quoteFenceIndent(line: string, marker: string): string | null {
  const match = /^( {0,3})(\S+)[\t ]*$/u.exec(line);
  return match?.[2] === marker ? (match[1] ?? "") : null;
}

function findClosingQuoteFence(
  lines: readonly string[],
  start: number,
  marker: string,
  quoteIndent: string,
): number {
  let codeFence: CodeFence | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const content =
      quoteIndent !== "" && line.startsWith(quoteIndent) ? line.slice(quoteIndent.length) : line;
    if (codeFence !== null) {
      if (closesCodeFence(content, codeFence)) {
        codeFence = null;
        continue;
      }
      if (!codeFenceContainerEnded(content, codeFence)) continue;
      codeFence = null;
    }
    const openedCodeFence = openingCodeFence(content);
    if (openedCodeFence !== null) {
      codeFence = openedCodeFence;
      continue;
    }
    if (quoteFenceIndent(line, marker) !== null) return index;
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
      if (closesCodeFence(line, codeFence)) {
        output.push(line);
        codeFence = null;
        continue;
      }
      if (!codeFenceContainerEnded(line, codeFence)) {
        output.push(line);
        continue;
      }
      codeFence = null;
    }

    const openedCodeFence = openingCodeFence(line);
    if (openedCodeFence !== null) {
      codeFence = openedCodeFence;
      output.push(line);
      continue;
    }

    const quoteIndent = quoteFenceIndent(line, marker);
    if (quoteIndent === null) {
      output.push(line);
      continue;
    }

    const closingIndex = findClosingQuoteFence(lines, index + 1, marker, quoteIndent);
    if (closingIndex === -1 || closingIndex === index + 1) {
      output.push(line);
      continue;
    }

    changed = true;
    for (let quoteIndex = index + 1; quoteIndex < closingIndex; quoteIndex += 1) {
      const quotedLine = lines[quoteIndex] ?? "";
      const content =
        quoteIndent !== "" && quotedLine.startsWith(quoteIndent)
          ? quotedLine.slice(quoteIndent.length)
          : quotedLine;
      output.push(content === "" ? `${quoteIndent}>` : `${quoteIndent}> ${content}`);
    }
    const nextLine = lines[closingIndex + 1];
    if (nextLine !== undefined && !/^[\t ]*$/u.test(nextLine)) output.push("");
    index = closingIndex;
  }

  return changed ? output.join(lineEnding) : source;
}
