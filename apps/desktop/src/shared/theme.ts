import {
  themeAccentColorSchema,
  themeIdSchema,
  themeStateSchema,
  type ResolvedColorScheme,
  type ThemeAccentColor,
  type ThemeId,
  type ThemeState,
} from "@hype-comms/contracts";

/**
 * Semantic presentation roles understood by every bundled theme. Components consume these roles
 * instead of palette values, so a new theme is one complete token set rather than a CSS rewrite.
 */
export const THEME_TOKEN_NAMES = [
  "surfaceCanvas",
  "surfaceShell",
  "surfaceRail",
  "surfaceSidebar",
  "surfaceContent",
  "surfaceCard",
  "surfaceElevated",
  "surfaceInput",
  "surfaceSubtle",
  "surfaceHover",
  "surfaceSelected",
  "surfaceHighlight",
  "surfaceBackdrop",
  "surfaceReaction",
  "surfaceReactionHover",
  "textPrimary",
  "textStrong",
  "textSecondary",
  "textMuted",
  "textSubtle",
  "textInverse",
  "textAccent",
  "textAccentMuted",
  "textDanger",
  "textSuccess",
  "textWarning",
  "textOnSuccess",
  "borderSubtle",
  "borderDefault",
  "borderStrong",
  "borderHover",
  "borderAccent",
  "borderDanger",
  "actionPrimary",
  "actionPrimaryHover",
  "actionPrimaryText",
  "focusRing",
  "dangerRing",
  "accentSurface",
  "accentSurfaceStrong",
  "successAction",
  "avatarSurface",
  "avatarText",
  "participantName1",
  "participantName2",
  "participantName3",
  "participantName4",
  "participantName5",
  "participantName6",
  "participantName7",
  "participantName8",
  "gradientBrand",
  "gradientSignIn",
  "shadowCard",
  "shadowPopover",
  "shadowDialog",
  "shadowPicker",
  "scrollbarThumb",
  "scrollbarThumbHover",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly label: string;
  readonly colorScheme: ResolvedColorScheme;
  readonly windowBackground: string;
  readonly tokens: ThemeTokens;
}

export interface ThemeAccentPreset {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

/** Curated seeds; every rendered role is still derived and contrast-corrected per base theme. */
export const THEME_ACCENT_PRESETS: readonly Readonly<ThemeAccentPreset>[] = Object.freeze(
  [
    { id: "indigo", label: "Indigo", color: "#6758ef" },
    { id: "blue", label: "Blue", color: "#2563eb" },
    { id: "teal", label: "Teal", color: "#0f766e" },
    { id: "green", label: "Green", color: "#15803d" },
    { id: "amber", label: "Amber", color: "#b45309" },
    { id: "rose", label: "Rose", color: "#be123c" },
  ].map((preset) =>
    Object.freeze({
      ...preset,
      color: themeAccentColorSchema.parse(preset.color),
    }),
  ),
);

const INITIAL_THEME_STATE_ARGUMENT_PREFIX = "--hype-comms-initial-theme-state=";

export function themeCssVariable(token: ThemeTokenName): `--theme-${string}` {
  return `--theme-${token.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * Runtime validation complements TypeScript's exact token map. It also protects future themes
 * loaded from generated modules, where a missing token would otherwise silently fall back.
 */
export function defineTheme(definition: ThemeDefinition): Readonly<ThemeDefinition> {
  const expectedTokens = new Set<string>(THEME_TOKEN_NAMES);
  const actualTokens = Object.keys(definition.tokens);
  const missing = THEME_TOKEN_NAMES.filter((token) => !Object.hasOwn(definition.tokens, token));
  const extra = actualTokens.filter((token) => !expectedTokens.has(token));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Theme ${definition.id} has an invalid token contract (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
  if (!themeIdSchema.safeParse(definition.id).success) {
    throw new Error(`Theme ${definition.id} has an invalid identifier`);
  }
  if (definition.label.trim() === "") {
    throw new Error(`Theme ${definition.id} has an empty label`);
  }
  if (!/^#[\da-f]{6}$/iu.test(definition.windowBackground)) {
    throw new Error(`Theme ${definition.id} has an invalid native window background`);
  }
  for (const token of THEME_TOKEN_NAMES) {
    if (definition.tokens[token].trim() === "") {
      throw new Error(`Theme ${definition.id} has an empty ${token} token`);
    }
  }

  return Object.freeze({
    ...definition,
    tokens: Object.freeze({ ...definition.tokens }),
  });
}

const darkTheme = defineTheme({
  id: "dark",
  label: "Dark",
  colorScheme: "dark",
  windowBackground: "#0e1320",
  tokens: {
    surfaceCanvas: "#090d18",
    surfaceShell: "#0b0f1a",
    surfaceRail: "#080b13",
    surfaceSidebar: "#111625",
    surfaceContent: "#0e1320",
    surfaceCard: "rgba(16, 22, 38, 0.96)",
    surfaceElevated: "#151b2c",
    surfaceInput: "#0c1120",
    surfaceSubtle: "#101626",
    surfaceHover: "#1a2031",
    surfaceSelected: "#252c43",
    surfaceHighlight: "rgba(119, 104, 255, 0.14)",
    surfaceBackdrop: "rgba(4, 7, 13, 0.72)",
    surfaceReaction: "#1b2132",
    surfaceReactionHover: "#272d43",
    textPrimary: "#e7eaf3",
    textStrong: "#f7f8fb",
    textSecondary: "#cbd2e5",
    textMuted: "#aeb7cf",
    textSubtle: "#7f8ba9",
    textInverse: "#ffffff",
    textAccent: "#9287ff",
    textAccentMuted: "#b9afff",
    textDanger: "#ff9a9a",
    textSuccess: "#c8f7e6",
    textWarning: "#f6c177",
    textOnSuccess: "#0b1020",
    borderSubtle: "#252b3d",
    borderDefault: "#65708b",
    borderStrong: "#77839e",
    borderHover: "#6d7894",
    borderAccent: "#7768ff",
    borderDanger: "#d96f78",
    actionPrimary: "#6758ef",
    actionPrimaryHover: "#7162e8",
    actionPrimaryText: "#ffffff",
    focusRing: "rgba(119, 104, 255, 0.22)",
    dangerRing: "rgba(217, 111, 120, 0.16)",
    accentSurface: "rgba(119, 104, 255, 0.16)",
    accentSurfaceStrong: "rgba(119, 104, 255, 0.2)",
    successAction: "#91e8c8",
    avatarSurface: "#293149",
    avatarText: "#dfe3ee",
    participantName1: "#ff9d8d",
    participantName2: "#f4c66a",
    participantName3: "#71d9b1",
    participantName4: "#6fd6e8",
    participantName5: "#8eb8ff",
    participantName6: "#b6a0ff",
    participantName7: "#f39ad6",
    participantName8: "#d6a66f",
    gradientBrand: "linear-gradient(145deg, #7161e5, #4c3dd3)",
    gradientSignIn:
      "radial-gradient(circle at 15% 15%, rgba(105, 87, 255, 0.22), transparent 38%), radial-gradient(circle at 85% 80%, rgba(51, 199, 183, 0.14), transparent 34%), #090d18",
    shadowCard: "0 24px 80px rgba(0, 0, 0, 0.42)",
    shadowPopover: "0 18px 55px rgba(0, 0, 0, 0.48)",
    shadowDialog: "0 28px 90px rgba(0, 0, 0, 0.55)",
    shadowPicker: "0 12px 30px rgba(0, 0, 0, 0.35)",
    scrollbarThumb: "#5d6982",
    scrollbarThumbHover: "#71809c",
  },
});

const lightTheme = defineTheme({
  id: "light",
  label: "Light",
  colorScheme: "light",
  windowBackground: "#ffffff",
  tokens: {
    surfaceCanvas: "#eef1f7",
    surfaceShell: "#f3f5f9",
    surfaceRail: "#e7eaf2",
    surfaceSidebar: "#f0f2f7",
    surfaceContent: "#ffffff",
    surfaceCard: "rgba(255, 255, 255, 0.96)",
    surfaceElevated: "#ffffff",
    surfaceInput: "#f8f9fc",
    surfaceSubtle: "#f1f3f8",
    surfaceHover: "#e6e9f1",
    surfaceSelected: "#dedff2",
    surfaceHighlight: "rgba(87, 70, 217, 0.12)",
    surfaceBackdrop: "rgba(30, 38, 55, 0.34)",
    surfaceReaction: "#f1f3f7",
    surfaceReactionHover: "#e4e7ee",
    textPrimary: "#1b2233",
    textStrong: "#111827",
    textSecondary: "#344158",
    textMuted: "#4e5b70",
    textSubtle: "#5e697c",
    textInverse: "#ffffff",
    textAccent: "#5746d9",
    textAccentMuted: "#4d3ec2",
    textDanger: "#b42332",
    textSuccess: "#176b50",
    textWarning: "#7a4a00",
    textOnSuccess: "#ffffff",
    borderSubtle: "#d9dee8",
    borderDefault: "#78849a",
    borderStrong: "#68758a",
    borderHover: "#707d92",
    borderAccent: "#6756dc",
    borderDanger: "#b42332",
    actionPrimary: "#5544c9",
    actionPrimaryHover: "#4637ad",
    actionPrimaryText: "#ffffff",
    focusRing: "rgba(87, 70, 217, 0.26)",
    dangerRing: "rgba(180, 35, 50, 0.18)",
    accentSurface: "rgba(87, 70, 217, 0.12)",
    accentSurfaceStrong: "rgba(87, 70, 217, 0.18)",
    successAction: "#176b50",
    avatarSurface: "#e0e4ee",
    avatarText: "#273149",
    participantName1: "#a53b2b",
    participantName2: "#7a5500",
    participantName3: "#137158",
    participantName4: "#0c6b78",
    participantName5: "#2e5fa7",
    participantName6: "#6247b5",
    participantName7: "#92366f",
    participantName8: "#805019",
    gradientBrand: "linear-gradient(145deg, #6756e8, #4434bd)",
    gradientSignIn:
      "radial-gradient(circle at 15% 15%, rgba(103, 86, 232, 0.16), transparent 38%), radial-gradient(circle at 85% 80%, rgba(30, 145, 124, 0.12), transparent 34%), #eef1f7",
    shadowCard: "0 24px 70px rgba(28, 38, 58, 0.16)",
    shadowPopover: "0 18px 45px rgba(28, 38, 58, 0.18)",
    shadowDialog: "0 28px 80px rgba(28, 38, 58, 0.22)",
    shadowPicker: "0 12px 28px rgba(28, 38, 58, 0.18)",
    scrollbarThumb: "#7f8ba0",
    scrollbarThumbHover: "#67758c",
  },
});

export const BUILT_IN_THEMES = Object.freeze({
  light: lightTheme,
  dark: darkTheme,
});

/** User-facing built-ins in stable display order. Registry insertion order is intentional. */
export const BUILT_IN_THEME_OPTIONS: readonly Readonly<ThemeDefinition>[] = Object.freeze(
  Object.values(BUILT_IN_THEMES),
);

/** Concrete built-ins selected while the user preference follows the operating system. */
export const SYSTEM_THEME_IDS: Readonly<Record<ResolvedColorScheme, ThemeId>> = Object.freeze({
  light: BUILT_IN_THEMES.light.id,
  dark: BUILT_IN_THEMES.dark.id,
});

export function isBuiltInThemeId(themeId: string): themeId is keyof typeof BUILT_IN_THEMES {
  return Object.hasOwn(BUILT_IN_THEMES, themeId);
}

export function getThemeDefinition(themeId: string): Readonly<ThemeDefinition> {
  if (!isBuiltInThemeId(themeId)) {
    throw new Error(`Unknown built-in theme identifier: ${themeId}`);
  }
  return BUILT_IN_THEMES[themeId];
}

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const BLACK = themeAccentColorSchema.parse("#000000");
const WHITE = themeAccentColorSchema.parse("#ffffff");

function parseHexColor(color: string): RgbColor {
  const canonical = themeAccentColorSchema.parse(color);
  return {
    red: Number.parseInt(canonical.slice(1, 3), 16),
    green: Number.parseInt(canonical.slice(3, 5), 16),
    blue: Number.parseInt(canonical.slice(5, 7), 16),
  };
}

function hexColor({ red, green, blue }: RgbColor): ThemeAccentColor {
  const component = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return themeAccentColorSchema.parse(`#${component(red)}${component(green)}${component(blue)}`);
}

function mixHexColors(source: string, target: string, amount: number): ThemeAccentColor {
  const from = parseHexColor(source);
  const to = parseHexColor(target);
  const boundedAmount = Math.min(1, Math.max(0, amount));
  return hexColor({
    red: from.red + (to.red - from.red) * boundedAmount,
    green: from.green + (to.green - from.green) * boundedAmount,
    blue: from.blue + (to.blue - from.blue) * boundedAmount,
  });
}

function alphaColor(color: string, alpha: number): string {
  const { red, green, blue } = parseHexColor(color);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function compositeColor(foreground: string, background: string, alpha: number): ThemeAccentColor {
  return mixHexColors(background, foreground, alpha);
}

function relativeLuminance(color: string): number {
  const { red, green, blue } = parseHexColor(color);
  const linear = (component: number): number => {
    const normalized = component / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** Contrast for the strict solid colors accepted by the designer and its derived text roles. */
export function themeContrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function meetsContrast(color: string, backgrounds: readonly string[], minimum: number): boolean {
  return backgrounds.every((background) => themeContrastRatio(color, background) >= minimum);
}

/**
 * Preserves the chosen hue for as long as possible, then moves only toward black or white until
 * every known background meets the required contrast. At least one endpoint is guaranteed to pass
 * for the light/dark built-ins and thresholds used below.
 */
function nearestContrastingColor(
  color: string,
  backgrounds: readonly string[],
  minimum: number,
): ThemeAccentColor {
  const canonical = themeAccentColorSchema.parse(color);
  if (meetsContrast(canonical, backgrounds, minimum)) return canonical;

  for (let step = 1; step <= 100; step += 1) {
    const amount = step / 100;
    const darker = mixHexColors(canonical, BLACK, amount);
    const lighter = mixHexColors(canonical, WHITE, amount);
    if (meetsContrast(darker, backgrounds, minimum)) return darker;
    if (meetsContrast(lighter, backgrounds, minimum)) return lighter;
  }
  throw new Error("Could not derive an accessible accent role");
}

function moreContrastingVariation(
  color: string,
  foreground: string,
  amount: number,
): ThemeAccentColor {
  const canonical = themeAccentColorSchema.parse(color);
  const candidates = [
    mixHexColors(canonical, BLACK, amount),
    mixHexColors(canonical, WHITE, amount),
  ]
    .filter((candidate) => candidate !== canonical)
    .filter((candidate) => themeContrastRatio(foreground, candidate) >= 4.5)
    .sort(
      (left, right) => themeContrastRatio(foreground, right) - themeContrastRatio(foreground, left),
    );
  const variation = candidates[0];
  if (variation !== undefined) return variation;

  // A near-threshold seed can require more than the preferred visual offset. Search both fixed
  // poles, while never returning the unchanged endpoint for pure black or white accents.
  for (let step = 1; step <= 100; step += 1) {
    for (const target of [BLACK, WHITE]) {
      const candidate = mixHexColors(canonical, target, step / 100);
      if (candidate !== canonical && themeContrastRatio(foreground, candidate) >= 4.5) {
        return candidate;
      }
    }
  }
  throw new Error("Could not derive an accessible accent variation");
}

function accessibleActionVariation(
  color: string,
  foreground: string,
  surroundings: readonly string[],
  amount: number,
): ThemeAccentColor {
  const canonical = themeAccentColorSchema.parse(color);
  const valid = (candidate: ThemeAccentColor): boolean =>
    candidate !== canonical &&
    themeContrastRatio(foreground, candidate) >= 4.5 &&
    meetsContrast(candidate, surroundings, 3);
  const candidates = [
    mixHexColors(canonical, BLACK, amount),
    mixHexColors(canonical, WHITE, amount),
  ].filter(valid);
  const preferred = candidates[0];
  if (preferred !== undefined) return preferred;

  for (let step = 1; step <= 100; step += 1) {
    for (const target of [BLACK, WHITE]) {
      const candidate = mixHexColors(canonical, target, step / 100);
      if (valid(candidate)) return candidate;
    }
  }
  throw new Error("Could not derive an accessible primary-action variation");
}

function distinctContrastingTextVariation(
  color: string,
  backgrounds: readonly string[],
  preferredTarget: string,
  amount: number,
): ThemeAccentColor {
  const canonical = themeAccentColorSchema.parse(color);
  const oppositeTarget = preferredTarget === BLACK ? WHITE : BLACK;
  for (const target of [preferredTarget, oppositeTarget]) {
    const candidate = mixHexColors(canonical, target, amount);
    if (candidate !== canonical && meetsContrast(candidate, backgrounds, 4.5)) return candidate;
  }
  for (let step = 1; step <= 100; step += 1) {
    for (const target of [preferredTarget, oppositeTarget]) {
      const candidate = mixHexColors(canonical, target, step / 100);
      if (candidate !== canonical && meetsContrast(candidate, backgrounds, 4.5)) return candidate;
    }
  }
  return canonical;
}

/**
 * Derives renderable semantic roles from one bounded color seed. No user-provided CSS survives this
 * function: rgba values, gradients, hover states, and contrast-corrected foregrounds are generated
 * from fixed templates.
 */
export function deriveThemeDefinitionWithAccent(
  base: Readonly<ThemeDefinition>,
  accentColor: string,
): Readonly<ThemeDefinition> {
  const accent = themeAccentColorSchema.parse(accentColor);
  const contentBackgrounds = [
    base.tokens.surfaceContent,
    base.tokens.surfaceElevated,
    base.tokens.surfaceSidebar,
    base.tokens.surfaceInput,
  ];
  const accentSurfaceAlpha = base.colorScheme === "dark" ? 0.16 : 0.12;
  const accentSurfaceStrongAlpha = base.colorScheme === "dark" ? 0.2 : 0.18;
  const accentSurfaceBackgrounds = contentBackgrounds.flatMap((background) => [
    compositeColor(accent, background, accentSurfaceAlpha),
    compositeColor(accent, background, accentSurfaceStrongAlpha),
  ]);
  const textBackgrounds = [...contentBackgrounds, ...accentSurfaceBackgrounds];
  const textAccent = nearestContrastingColor(accent, textBackgrounds, 4.5);
  const textAccentMuted = distinctContrastingTextVariation(
    textAccent,
    textBackgrounds,
    base.colorScheme === "light" ? BLACK : WHITE,
    base.colorScheme === "light" ? 0.12 : 0.2,
  );
  const borderAccent = nearestContrastingColor(
    accent,
    [
      base.tokens.surfaceContent,
      base.tokens.surfaceSidebar,
      base.tokens.surfaceInput,
      base.tokens.surfaceElevated,
    ],
    3,
  );

  const actionSurroundings = [
    base.tokens.surfaceContent,
    base.tokens.surfaceElevated,
    base.tokens.surfaceSidebar,
    base.tokens.surfaceInput,
  ];
  const actionPrimary = nearestContrastingColor(accent, actionSurroundings, 3);
  const blackActionContrast = themeContrastRatio(BLACK, actionPrimary);
  const whiteActionContrast = themeContrastRatio(WHITE, actionPrimary);
  const actionPrimaryText = blackActionContrast >= whiteActionContrast ? BLACK : WHITE;
  const actionPrimaryHover = accessibleActionVariation(
    actionPrimary,
    actionPrimaryText,
    actionSurroundings,
    0.12,
  );
  const brandStart = nearestContrastingColor(accent, [base.tokens.textInverse], 4.5);
  const brandEnd = moreContrastingVariation(brandStart, base.tokens.textInverse, 0.14);
  const highlightAlpha = base.colorScheme === "dark" ? 0.14 : 0.12;
  const focusAlpha = base.colorScheme === "dark" ? 0.22 : 0.26;
  const signInPrimaryAlpha = base.colorScheme === "dark" ? 0.22 : 0.16;
  const signInSecondaryAlpha = base.colorScheme === "dark" ? 0.14 : 0.12;

  return defineTheme({
    ...base,
    tokens: {
      ...base.tokens,
      surfaceHighlight: alphaColor(accent, highlightAlpha),
      textAccent,
      textAccentMuted,
      borderAccent,
      actionPrimary,
      actionPrimaryHover,
      actionPrimaryText,
      focusRing: alphaColor(accent, focusAlpha),
      accentSurface: alphaColor(accent, accentSurfaceAlpha),
      accentSurfaceStrong: alphaColor(accent, accentSurfaceStrongAlpha),
      gradientBrand: `linear-gradient(145deg, ${brandStart}, ${brandEnd})`,
      gradientSignIn:
        `radial-gradient(circle at 15% 15%, ${alphaColor(accent, signInPrimaryAlpha)}, transparent 38%), ` +
        `radial-gradient(circle at 85% 80%, ${alphaColor(accent, signInSecondaryAlpha)}, transparent 34%), ` +
        base.tokens.surfaceCanvas,
    },
  });
}

/** Resolves and validates the built-in foundation, then applies an optional bounded accent. */
export function getThemeDefinitionForState(state: ThemeState): Readonly<ThemeDefinition> {
  const canonical = parseBuiltInThemeState(state);
  const base = getThemeDefinition(canonical.resolvedThemeId);
  return canonical.accentColor === undefined || canonical.accentColor === null
    ? base
    : deriveThemeDefinitionWithAccent(base, canonical.accentColor);
}

/**
 * Completes structural IPC validation with the bundled registry invariant. This keeps a theme ID
 * and its light/dark native color scheme coherent without hard-coding theme IDs in wire schemas.
 */
export function parseBuiltInThemeState(value: unknown): ThemeState {
  const state = themeStateSchema.parse(value);
  const definition = getThemeDefinition(state.resolvedThemeId);
  if (definition.colorScheme !== state.resolvedColorScheme) {
    throw new Error(
      `Theme ${state.resolvedThemeId} cannot resolve as ${state.resolvedColorScheme}`,
    );
  }
  if (
    state.preference === "system" &&
    state.resolvedThemeId !== SYSTEM_THEME_IDS[state.resolvedColorScheme]
  ) {
    throw new Error(
      `System ${state.resolvedColorScheme} must resolve to ${SYSTEM_THEME_IDS[state.resolvedColorScheme]}`,
    );
  }
  return state;
}

export function isBuiltInThemeState(value: unknown): value is ThemeState {
  try {
    parseBuiltInThemeState(value);
    return true;
  } catch {
    return false;
  }
}

export const FALLBACK_INITIAL_THEME_STATE: ThemeState = Object.freeze({
  preference: "system",
  resolvedThemeId: SYSTEM_THEME_IDS.dark,
  resolvedColorScheme: "dark",
  accentColor: null,
});

/**
 * Supplies the already-initialized theme identity to a sandboxed renderer before asynchronous IPC
 * is available. Appearance is non-secret, and the preload validates the encoded state again.
 */
export function createInitialThemeStateArgument(state: ThemeState): string {
  const canonicalState = parseBuiltInThemeState(state);
  return `${INITIAL_THEME_STATE_ARGUMENT_PREFIX}${encodeURIComponent(JSON.stringify(canonicalState))}`;
}

export function parseInitialThemeStateArgument(arguments_: readonly string[]): ThemeState {
  let argument: string | undefined;
  for (let index = arguments_.length - 1; index >= 0; index -= 1) {
    const candidate = arguments_[index];
    if (candidate?.startsWith(INITIAL_THEME_STATE_ARGUMENT_PREFIX) === true) {
      argument = candidate;
      break;
    }
  }
  if (argument === undefined) {
    throw new Error("Initial theme state argument is missing");
  }

  const source = argument.slice(INITIAL_THEME_STATE_ARGUMENT_PREFIX.length);
  try {
    return parseBuiltInThemeState(JSON.parse(decodeURIComponent(source)) as unknown);
  } catch (error) {
    throw new Error("Initial theme state argument is invalid", { cause: error });
  }
}

/**
 * Keeps cosmetic startup data from disabling the entire preload bridge. Main sends authoritative
 * state again after load, so this fallback is used only until theme IPC hydrates the renderer.
 */
export function resolveInitialThemeStateArgument(arguments_: readonly string[]): ThemeState {
  try {
    return parseInitialThemeStateArgument(arguments_);
  } catch {
    return FALLBACK_INITIAL_THEME_STATE;
  }
}
