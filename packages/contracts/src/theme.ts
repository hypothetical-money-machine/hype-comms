import { z } from "zod";

const THEME_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const THEME_ACCENT_COLOR_PATTERN = /^#[\da-f]{6}$/iu;

/**
 * Stable identifier for a bundled theme. `system` is reserved for the operating-system-following
 * preference and therefore cannot identify a concrete theme definition.
 */
export const themeIdSchema = z
  .string()
  .regex(THEME_ID_PATTERN)
  .refine((themeId) => themeId !== "system", {
    message: "system is reserved and cannot be used as a theme identifier",
  });

/**
 * The user-facing appearance choice. `system` follows the operating system while any concrete
 * theme identifier remains fixed even when the operating system appearance changes.
 */
export const themePreferenceSchema = z.union([z.literal("system"), themeIdSchema]);

/**
 * A bounded color seed for the theme designer. Only canonical six-digit hexadecimal color data
 * crosses IPC; renderable CSS values are derived from it by trusted shared code.
 */
export const themeAccentColorSchema = z
  .string()
  .regex(THEME_ACCENT_COLOR_PATTERN)
  .transform((color) => color.toLowerCase());

/** The complete device-local input persisted by the desktop appearance controller. */
export const themeDesignSchema = z
  .object({
    preference: themePreferenceSchema,
    accentColor: themeAccentColorSchema.nullable(),
  })
  .strict();

/** The concrete color scheme currently rendered by the desktop client. */
export const resolvedColorSchemeSchema = z.enum(["light", "dark"]);

/**
 * Canonical theme state crossing the desktop IPC boundary. Presentation tokens never cross IPC;
 * the renderer selects a bundled, validated theme by its resolved identifier and derives any
 * bounded accent. An explicit preference always resolves to itself, while `system` can resolve to
 * the designated built-in for either operating-system color scheme. `accentColor` remains optional
 * on the wire so a mixed-version preload can safely consume the pre-designer state shape; current
 * main processes always publish it explicitly as a color or null.
 */
export const themeStateSchema = z
  .object({
    preference: themePreferenceSchema,
    resolvedThemeId: themeIdSchema,
    resolvedColorScheme: resolvedColorSchemeSchema,
    accentColor: themeAccentColorSchema.nullable().optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.preference !== "system" && state.preference !== state.resolvedThemeId) {
      context.addIssue({
        code: "custom",
        path: ["resolvedThemeId"],
        message: "An explicit theme preference must resolve to the same theme identifier",
      });
    }
  });

export type ThemeId = z.infer<typeof themeIdSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type ThemeAccentColor = z.infer<typeof themeAccentColorSchema>;
export type ThemeDesign = z.infer<typeof themeDesignSchema>;
export type ResolvedColorScheme = z.infer<typeof resolvedColorSchemeSchema>;
export type ThemeState = z.infer<typeof themeStateSchema>;
