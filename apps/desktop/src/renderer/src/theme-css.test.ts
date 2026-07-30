/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { themeCssVariable, THEME_TOKEN_NAMES } from "../../shared/theme";

const rendererSourceRoot = fileURLToPath(new URL(".", import.meta.url));
const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const rawPaintPattern =
  /#[\da-f]{3,8}(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|(?<![\w-])(?:black|white)(?![\w-])/giu;
const declarationPattern = /(?:^|[;{])\s*([-\w]+)\s*:\s*([^;{}]+)/gmu;
const themeVariableReferencePattern = /var\(\s*(--theme-[a-z\d-]+)/gu;
const neutralPaintPattern =
  /^(?:0|none|inherit|initial|unset|revert(?:-layer)?|transparent|currentcolor|(?:\d*\.?\d+(?:px|rem|em|vh|vw)?)\s+(?:solid|dashed|dotted|double)\s+(?:transparent|currentcolor))(?:\s*!important)?$/iu;

interface SourceViolation {
  readonly file: string;
  readonly line: number;
  readonly value: string;
}

function withoutCssComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function rawPaintViolations(file: string, source: string): readonly SourceViolation[] {
  return [...source.matchAll(rawPaintPattern)].map((match) => ({
    file,
    line: lineNumber(source, match.index),
    value: match[0],
  }));
}

function isPaintedProperty(property: string): boolean {
  if (
    [
      "accent-color",
      "background",
      "background-color",
      "box-shadow",
      "caret-color",
      "color",
      "fill",
      "outline",
      "outline-color",
      "scrollbar-color",
      "stroke",
      "text-decoration-color",
      "text-shadow",
    ].includes(property)
  ) {
    return true;
  }

  return (
    property === "border" ||
    /^border-(?:color|top|right|bottom|left|block(?:-(?:start|end))?|inline(?:-(?:start|end))?)(?:-color)?$/u.test(
      property,
    )
  );
}

function unthemedPaintDeclarations(source: string): readonly SourceViolation[] {
  const violations: SourceViolation[] = [];
  for (const match of source.matchAll(declarationPattern)) {
    const [, property, value] = match;
    if (property === undefined || value === undefined || !isPaintedProperty(property)) continue;

    const normalizedValue = value.trim();
    if (normalizedValue.includes("var(--theme-") || neutralPaintPattern.test(normalizedValue)) {
      continue;
    }

    violations.push({
      file: "styles.css",
      line: lineNumber(source, match.index),
      value: `${property}: ${normalizedValue}`,
    });
  }
  return violations;
}

function rendererTypeScriptFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...rendererTypeScriptFiles(entryPath));
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/u.test(entry.name)
    ) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

describe("renderer theme CSS", () => {
  it("uses semantic theme variables or neutral paint for every painted declaration", () => {
    const styles = withoutCssComments(readFileSync(stylesPath, "utf8"));

    expect({
      rawPaint: rawPaintViolations("styles.css", styles),
      unthemedPaint: unthemedPaintDeclarations(styles),
    }).toEqual({
      rawPaint: [],
      unthemedPaint: [],
    });
  });

  it("references only CSS variables declared by the semantic token contract", () => {
    const styles = withoutCssComments(readFileSync(stylesPath, "utf8"));
    const contractVariables = new Set(THEME_TOKEN_NAMES.map(themeCssVariable));
    const referencedVariables = new Set(
      [...styles.matchAll(themeVariableReferencePattern)]
        .map((match) => match[1])
        .filter((variable): variable is string => variable !== undefined),
    );
    const unknownVariables = [...referencedVariables]
      .filter((variable) => !contractVariables.has(variable as `--theme-${string}`))
      .sort();

    expect(referencedVariables.size).toBeGreaterThan(0);
    expect(unknownVariables).toEqual([]);
  });

  it("keeps raw paint values out of renderer TypeScript and TSX", () => {
    const violations = rendererTypeScriptFiles(rendererSourceRoot).flatMap((file) =>
      rawPaintViolations(path.relative(rendererSourceRoot, file), readFileSync(file, "utf8")),
    );

    expect(violations).toEqual([]);
  });

  it("preserves pending-state and reaction-reveal cues across themes", () => {
    const styles = withoutCssComments(readFileSync(stylesPath, "utf8"));
    const reactionAddRule = /^\.reaction-add\s*\{(?<body>[^}]*)\}/mu.exec(styles);
    const reactionRevealRule =
      /\.message:hover \.reaction-add,\s*\.reaction-add:focus-visible,\s*\.reaction-add\[aria-expanded="true"\]\s*\{(?<body>[^}]*)\}/u.exec(
        styles,
      );
    const pendingMessageRule = /\.pending-message\s*\{(?<body>[^}]*)\}/u.exec(styles);
    const memberRoleRule = /\.channel-member-list \.channel-role\s*\{(?<body>[^}]*)\}/u.exec(
      styles,
    );

    expect(pendingMessageRule?.groups?.body).toContain("opacity: 0.72");
    expect(reactionAddRule?.groups?.body).toBeDefined();
    expect(reactionAddRule?.groups?.body).toContain("opacity: 0.62");
    expect(reactionAddRule?.groups?.body).toContain("color: var(--theme-text-muted)");
    expect(reactionRevealRule?.groups?.body).toContain("opacity: 1");
    expect(memberRoleRule?.groups?.body).toContain("color: var(--theme-text-secondary)");
  });

  it("keeps the minimum-height sign-in surface vertically reachable", () => {
    const styles = withoutCssComments(readFileSync(stylesPath, "utf8"));
    const signInShellRule = /\.signin-shell\s*\{(?<body>[^}]*)\}/u.exec(styles);

    expect(signInShellRule?.groups?.body).toContain("height: 100vh");
    expect(signInShellRule?.groups?.body).toContain("align-items: safe center");
    expect(signInShellRule?.groups?.body).toContain("overflow-y: auto");
  });
});
