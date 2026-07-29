import {
  themeIdSchema,
  themeStateSchema,
  type ResolvedColorScheme,
  type ThemeId,
  type ThemeState,
} from "@hmm-chat/contracts";

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

const INITIAL_THEME_STATE_ARGUMENT_PREFIX = "--hmm-chat-initial-theme-state=";

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
