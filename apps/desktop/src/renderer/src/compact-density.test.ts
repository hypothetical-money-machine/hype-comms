/// <reference types="node" />

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));

function withoutCssComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
}

function firstRuleBody(source: string, selector: string): string {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "u").exec(source);
  if (match?.groups?.body === undefined) {
    throw new Error(`Missing CSS rule for ${selector}`);
  }
  return match.groups.body;
}

function customProperties(body: string): Readonly<Record<string, string>> {
  const properties: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
    const name = match[1];
    const value = match[2]?.trim();
    if (name !== undefined && value !== undefined) {
      properties[name] = value;
    }
  }
  return properties;
}

function pixelNumbers(value: string): readonly number[] {
  return [...value.matchAll(/-?\d+(?:\.\d+)?(?=px\b)/gu)].map((match) => Number(match[0]));
}

const DENSITY_TOKENS = [
  "density-rail-padding",
  "density-workspace-header-padding",
  "density-search-margin",
  "density-search-padding",
  "density-sidebar-nav-padding",
  "density-nav-heading-min-height",
  "density-nav-heading-margin",
  "density-row-padding",
  "density-pane-header-min-height",
  "density-conversation-header-padding",
  "density-thread-header-padding",
  "density-message-list-padding",
  "density-thread-message-list-padding",
  "density-message-padding-block",
  "density-message-gap",
  "density-message-continuation-padding-block",
  "density-composer-padding",
  "density-unreads-header-padding",
  "density-unreads-list-padding",
  "density-unreads-item-padding",
  "density-unreads-item-gap",
  "density-date-separator-margin",
  "density-unread-divider-margin",
] as const;

const TOKEN_CONSUMERS: Readonly<Record<string, string>> = {
  ".workspace-rail": "var(--density-rail-padding)",
  ".workspace-header": "var(--density-workspace-header-padding)",
  ".sidebar nav": "var(--density-sidebar-nav-padding)",
  ".nav-heading": "var(--density-nav-heading-margin)",
  ".conversation-header": "var(--density-conversation-header-padding)",
  ".message-list": "var(--density-message-list-padding)",
  ".message": "var(--density-message-padding-block)",
  ".message-continuation": "var(--density-message-continuation-padding-block)",
  ".composer": "var(--density-composer-padding)",
  ".thread-header": "var(--density-thread-header-padding)",
  ".thread-message-list": "var(--density-thread-message-list-padding)",
  ".unreads-header": "var(--density-unreads-header-padding)",
  ".unreads-list": "var(--density-unreads-list-padding)",
  ".unreads-item": "var(--density-unreads-item-padding)",
};

describe("compact density tokens", () => {
  const styles = withoutCssComments(readFileSync(stylesPath, "utf8"));
  const comfortable = customProperties(firstRuleBody(styles, ":root"));
  const compact = customProperties(firstRuleBody(styles, "html[data-compact]"));

  it("keeps the comfortable defaults on :root and only tightens them under data-compact", () => {
    for (const token of DENSITY_TOKENS) {
      const comfortableValue = comfortable[token];
      const compactValue = compact[token];
      expect(comfortableValue, `--${token} comfortable`).toBeDefined();
      expect(compactValue, `--${token} compact`).toBeDefined();
      expect(compactValue).not.toBe(comfortableValue);

      const comfortableTotal = pixelNumbers(comfortableValue ?? "").reduce(
        (sum, value) => sum + Math.abs(value),
        0,
      );
      const compactTotal = pixelNumbers(compactValue ?? "").reduce(
        (sum, value) => sum + Math.abs(value),
        0,
      );
      expect(compactTotal, `--${token} compact total`).toBeLessThan(comfortableTotal);
    }
  });

  it("applies the shared density tokens to the message list, sidebar, and chrome", () => {
    for (const [selector, token] of Object.entries(TOKEN_CONSUMERS)) {
      expect(firstRuleBody(styles, selector)).toContain(token);
    }

    expect(styles).toMatch(/\.conversation\s*\{[^}]*padding:\s*var\(--density-row-padding\)/u);
    expect(styles).toMatch(
      /\.workspace-search-button,\s*\.quick-switcher-trigger\s*\{[^}]*padding:\s*var\(--density-search-padding\)/u,
    );
  });
});
