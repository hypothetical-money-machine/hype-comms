import { describe, expect, it } from "vitest";

import {
  BUILT_IN_THEME_OPTIONS,
  BUILT_IN_THEMES,
  createInitialThemeStateArgument,
  defineTheme,
  getThemeDefinition,
  isBuiltInThemeId,
  isBuiltInThemeState,
  parseBuiltInThemeState,
  parseInitialThemeStateArgument,
  resolveInitialThemeStateArgument,
  FALLBACK_INITIAL_THEME_STATE,
  SYSTEM_THEME_IDS,
  themeCssVariable,
  THEME_TOKEN_NAMES,
  type ThemeDefinition,
  type ThemeTokenName,
  type ThemeTokens,
} from "./theme";

const EXPECTED_CSS_VARIABLES = {
  surfaceCanvas: "--theme-surface-canvas",
  surfaceShell: "--theme-surface-shell",
  surfaceRail: "--theme-surface-rail",
  surfaceSidebar: "--theme-surface-sidebar",
  surfaceContent: "--theme-surface-content",
  surfaceCard: "--theme-surface-card",
  surfaceElevated: "--theme-surface-elevated",
  surfaceInput: "--theme-surface-input",
  surfaceSubtle: "--theme-surface-subtle",
  surfaceHover: "--theme-surface-hover",
  surfaceSelected: "--theme-surface-selected",
  surfaceHighlight: "--theme-surface-highlight",
  surfaceBackdrop: "--theme-surface-backdrop",
  surfaceReaction: "--theme-surface-reaction",
  surfaceReactionHover: "--theme-surface-reaction-hover",
  textPrimary: "--theme-text-primary",
  textStrong: "--theme-text-strong",
  textSecondary: "--theme-text-secondary",
  textMuted: "--theme-text-muted",
  textSubtle: "--theme-text-subtle",
  textInverse: "--theme-text-inverse",
  textAccent: "--theme-text-accent",
  textAccentMuted: "--theme-text-accent-muted",
  textDanger: "--theme-text-danger",
  textSuccess: "--theme-text-success",
  textWarning: "--theme-text-warning",
  textOnSuccess: "--theme-text-on-success",
  borderSubtle: "--theme-border-subtle",
  borderDefault: "--theme-border-default",
  borderStrong: "--theme-border-strong",
  borderHover: "--theme-border-hover",
  borderAccent: "--theme-border-accent",
  borderDanger: "--theme-border-danger",
  actionPrimary: "--theme-action-primary",
  actionPrimaryHover: "--theme-action-primary-hover",
  actionPrimaryText: "--theme-action-primary-text",
  focusRing: "--theme-focus-ring",
  dangerRing: "--theme-danger-ring",
  accentSurface: "--theme-accent-surface",
  accentSurfaceStrong: "--theme-accent-surface-strong",
  successAction: "--theme-success-action",
  avatarSurface: "--theme-avatar-surface",
  avatarText: "--theme-avatar-text",
  gradientBrand: "--theme-gradient-brand",
  gradientSignIn: "--theme-gradient-sign-in",
  shadowCard: "--theme-shadow-card",
  shadowPopover: "--theme-shadow-popover",
  shadowDialog: "--theme-shadow-dialog",
  shadowPicker: "--theme-shadow-picker",
  scrollbarThumb: "--theme-scrollbar-thumb",
  scrollbarThumbHover: "--theme-scrollbar-thumb-hover",
} as const satisfies Readonly<Record<ThemeTokenName, `--theme-${string}`>>;

interface ContrastPair {
  readonly foreground: ThemeTokenName;
  readonly background: ThemeTokenName;
  readonly minimum: number;
}

const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: "textPrimary", background: "surfaceContent", minimum: 4.5 },
  { foreground: "textStrong", background: "surfaceInput", minimum: 4.5 },
  { foreground: "textSecondary", background: "surfaceSidebar", minimum: 4.5 },
  { foreground: "textMuted", background: "surfaceContent", minimum: 4.5 },
  { foreground: "textSubtle", background: "surfaceContent", minimum: 4.5 },
  { foreground: "textAccent", background: "surfaceContent", minimum: 4.5 },
  { foreground: "textDanger", background: "surfaceContent", minimum: 4.5 },
  { foreground: "textSuccess", background: "surfaceContent", minimum: 4.5 },
  { foreground: "textWarning", background: "surfaceContent", minimum: 4.5 },
  { foreground: "actionPrimaryText", background: "actionPrimary", minimum: 4.5 },
  { foreground: "actionPrimaryText", background: "actionPrimaryHover", minimum: 4.5 },
  { foreground: "textOnSuccess", background: "successAction", minimum: 4.5 },
  { foreground: "avatarText", background: "avatarSurface", minimum: 4.5 },
  { foreground: "textSecondary", background: "surfaceSelected", minimum: 4.5 },
  { foreground: "textMuted", background: "surfaceReaction", minimum: 3 },
  { foreground: "borderDefault", background: "surfaceInput", minimum: 3 },
  { foreground: "borderDefault", background: "surfaceElevated", minimum: 3 },
  { foreground: "borderStrong", background: "surfaceContent", minimum: 3 },
  { foreground: "borderStrong", background: "surfaceElevated", minimum: 3 },
  { foreground: "borderHover", background: "surfaceInput", minimum: 3 },
  { foreground: "borderAccent", background: "surfaceContent", minimum: 3 },
  { foreground: "borderAccent", background: "surfaceSidebar", minimum: 3 },
  { foreground: "borderDanger", background: "surfaceContent", minimum: 3 },
  { foreground: "scrollbarThumb", background: "surfaceContent", minimum: 3 },
  { foreground: "scrollbarThumb", background: "surfaceSidebar", minimum: 3 },
  { foreground: "scrollbarThumbHover", background: "surfaceContent", minimum: 3 },
  { foreground: "scrollbarThumbHover", background: "surfaceSidebar", minimum: 3 },
];

function themeWithTokens(tokens: unknown): ThemeDefinition {
  return {
    ...BUILT_IN_THEMES.dark,
    tokens: tokens as ThemeTokens,
  };
}

function relativeLuminance(color: string): number {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(color);
  if (match === null) {
    throw new Error(`Contrast tokens must be six-digit hex colors; received ${color}`);
  }

  const components = match.slice(1).map((component) => Number.parseInt(component, 16) / 255);
  const [red = 0, green = 0, blue = 0] = components.map((component) =>
    component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme token contract", () => {
  it("keeps one exact, unique token set across every built-in theme", () => {
    const expectedTokenNames = Object.keys(EXPECTED_CSS_VARIABLES);

    expect(THEME_TOKEN_NAMES).toEqual(expectedTokenNames);
    expect(new Set(THEME_TOKEN_NAMES).size).toBe(THEME_TOKEN_NAMES.length);
    expect(BUILT_IN_THEME_OPTIONS.slice(0, 2).map((theme) => theme.id)).toEqual(["light", "dark"]);
    expect(BUILT_IN_THEME_OPTIONS).toEqual(Object.values(BUILT_IN_THEMES));
    expect(SYSTEM_THEME_IDS).toEqual({ light: "light", dark: "dark" });
    expect(Object.values(SYSTEM_THEME_IDS).every(isBuiltInThemeId)).toBe(true);

    for (const [id, theme] of Object.entries(BUILT_IN_THEMES)) {
      expect(theme.id).toBe(id);
      expect(Object.keys(theme.tokens)).toEqual(expectedTokenNames);
    }
  });

  it("maps every semantic token to its exact unique CSS variable", () => {
    const actual = Object.fromEntries(
      THEME_TOKEN_NAMES.map((token) => [token, themeCssVariable(token)]),
    );

    expect(actual).toEqual(EXPECTED_CSS_VARIABLES);
    expect(new Set(Object.values(actual)).size).toBe(THEME_TOKEN_NAMES.length);
  });

  it("rejects incomplete, extended, empty, and invalid runtime definitions", () => {
    const missingTokens = {
      ...BUILT_IN_THEMES.dark.tokens,
    } as Partial<Record<ThemeTokenName, string>>;
    delete missingTokens.surfaceCanvas;
    expect(() => defineTheme(themeWithTokens(missingTokens))).toThrow(/missing: surfaceCanvas/u);

    const inheritedTokens = Object.create({
      surfaceCanvas: BUILT_IN_THEMES.dark.tokens.surfaceCanvas,
    }) as Partial<Record<ThemeTokenName, string>>;
    Object.assign(inheritedTokens, missingTokens);
    expect(() => defineTheme(themeWithTokens(inheritedTokens))).toThrow(/missing: surfaceCanvas/u);

    const extraTokens = {
      ...BUILT_IN_THEMES.dark.tokens,
      componentSpecificPurple: "#7654ff",
    };
    expect(() => defineTheme(themeWithTokens(extraTokens))).toThrow(
      /extra: componentSpecificPurple/u,
    );

    expect(() =>
      defineTheme(
        themeWithTokens({
          ...BUILT_IN_THEMES.dark.tokens,
          textPrimary: "  ",
        }),
      ),
    ).toThrow(/empty textPrimary token/u);

    expect(
      defineTheme({
        ...BUILT_IN_THEMES.dark,
        id: "dim",
        label: "Dim",
        colorScheme: "dark",
      }),
    ).toMatchObject({ id: "dim", colorScheme: "dark" });

    for (const id of ["", "Dim Theme", "theme!", "a".repeat(65)]) {
      expect(() =>
        defineTheme({
          ...BUILT_IN_THEMES.dark,
          id,
        }),
      ).toThrow(/invalid identifier/u);
    }

    expect(() =>
      defineTheme({
        ...BUILT_IN_THEMES.dark,
        id: "system",
      }),
    ).toThrow(/invalid identifier/u);

    expect(() =>
      defineTheme({
        ...BUILT_IN_THEMES.dark,
        label: "  ",
      }),
    ).toThrow(/empty label/u);

    for (const windowBackground of ["transparent", "#fff", "#12345678"]) {
      expect(() =>
        defineTheme({
          ...BUILT_IN_THEMES.dark,
          windowBackground,
        }),
      ).toThrow(/invalid native window background/u);
    }
  });

  it("deeply freezes built-in definitions and their registry", () => {
    expect(Object.isFrozen(BUILT_IN_THEMES)).toBe(true);
    expect(Object.isFrozen(BUILT_IN_THEME_OPTIONS)).toBe(true);
    expect(Object.isFrozen(SYSTEM_THEME_IDS)).toBe(true);

    for (const theme of Object.values(BUILT_IN_THEMES)) {
      const originalPrimaryText = theme.tokens.textPrimary;
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.tokens)).toBe(true);
      expect(Reflect.set(theme.tokens, "textPrimary", "#000000")).toBe(false);
      expect(theme.tokens.textPrimary).toBe(originalPrimaryText);
    }

    const originalDarkTheme = BUILT_IN_THEMES.dark;
    expect(Reflect.set(BUILT_IN_THEMES, "dark", BUILT_IN_THEMES.light)).toBe(false);
    expect(BUILT_IN_THEMES.dark).toBe(originalDarkTheme);
  });

  it("resolves registered IDs and rejects unknown theme definitions", () => {
    expect(isBuiltInThemeId("light")).toBe(true);
    expect(isBuiltInThemeId("dim")).toBe(false);
    expect(getThemeDefinition("light")).toBe(BUILT_IN_THEMES.light);
    expect(() => getThemeDefinition("dim")).toThrow(/Unknown built-in theme identifier: dim/u);
  });

  it("validates resolved state against the bundled theme registry", () => {
    for (const resolvedColorScheme of ["light", "dark"] as const) {
      const systemState = {
        preference: "system",
        resolvedThemeId: SYSTEM_THEME_IDS[resolvedColorScheme],
        resolvedColorScheme,
      };

      expect(parseBuiltInThemeState(systemState)).toEqual(systemState);
      expect(isBuiltInThemeState(systemState)).toBe(true);
    }
    expect(
      isBuiltInThemeState({
        preference: "system",
        resolvedThemeId: "light",
        resolvedColorScheme: "dark",
      }),
    ).toBe(false);
    expect(() =>
      parseBuiltInThemeState({
        preference: "dim",
        resolvedThemeId: "dim",
        resolvedColorScheme: "dark",
      }),
    ).toThrow(/Unknown built-in theme identifier: dim/u);
  });

  it("round-trips an exact validated theme state through the renderer startup argument", () => {
    const state = {
      preference: "dark",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    } as const;
    const argument = createInitialThemeStateArgument(state);

    expect(parseInitialThemeStateArgument(["--renderer-process", argument])).toEqual(state);
    expect(() => parseInitialThemeStateArgument([])).toThrow(/missing/u);
    expect(() =>
      parseInitialThemeStateArgument([
        "--hmm-chat-initial-theme-state=%7B%22preference%22%3A%22dim%22%7D",
      ]),
    ).toThrow(/invalid/u);
  });

  it("falls back safely when the renderer startup argument is absent or invalid", () => {
    expect(resolveInitialThemeStateArgument([])).toBe(FALLBACK_INITIAL_THEME_STATE);
    expect(
      resolveInitialThemeStateArgument([
        "--hmm-chat-initial-theme-state=%7B%22preference%22%3A%22dim%22%7D",
      ]),
    ).toBe(FALLBACK_INITIAL_THEME_STATE);
    expect(FALLBACK_INITIAL_THEME_STATE).toEqual({
      preference: "system",
      resolvedThemeId: "dark",
      resolvedColorScheme: "dark",
    });
    expect(Object.isFrozen(FALLBACK_INITIAL_THEME_STATE)).toBe(true);
  });

  it("meets WCAG contrast for key text, action, status, avatar, and focus pairs", () => {
    for (const theme of Object.values(BUILT_IN_THEMES)) {
      for (const { foreground, background, minimum } of CONTRAST_PAIRS) {
        const ratio = contrastRatio(theme.tokens[foreground], theme.tokens[background]);
        expect(
          ratio,
          `${theme.id} ${foreground} on ${background} has ${ratio.toFixed(2)}:1 contrast`,
        ).toBeGreaterThanOrEqual(minimum);
      }

      const brandStops = [...theme.tokens.gradientBrand.matchAll(/#[\da-f]{6}/giu)].map(
        ([color]) => color,
      );
      expect(brandStops.length).toBeGreaterThan(0);
      for (const stop of brandStops) {
        const ratio = contrastRatio(theme.tokens.textInverse, stop);
        expect(
          ratio,
          `${theme.id} textInverse on gradientBrand stop ${stop} has ${ratio.toFixed(2)}:1 contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
