import type { FencedBlockquoteMode } from "./fenced-blockquote-runtime";

interface CodeFence {
  readonly length: number;
  readonly marker: "`" | "~";
}

function openingCodeFence(line: string): CodeFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  const fence = match?.[1];
  if (fence === undefined) return null;
  const marker = fence[0];
  if (marker !== "`" && marker !== "~") return null;
  if (marker === "`" && match?.[2]?.includes("`")) return null;
  return { marker, length: fence.length };
}

function closesCodeFence(line: string, fence: CodeFence): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/u.exec(line);
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
