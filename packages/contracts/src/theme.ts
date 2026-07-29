import { z } from "zod";

const THEME_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

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

/** The concrete color scheme currently rendered by the desktop client. */
export const resolvedColorSchemeSchema = z.enum(["light", "dark"]);

/**
 * Canonical theme state crossing the desktop IPC boundary. Presentation tokens never cross IPC;
 * the renderer selects a bundled, validated theme by its resolved identifier. An explicit
 * preference always resolves to itself, while `system` can resolve to the designated built-in for
 * either operating-system color scheme.
 */
export const themeStateSchema = z
  .object({
    preference: themePreferenceSchema,
    resolvedThemeId: themeIdSchema,
    resolvedColorScheme: resolvedColorSchemeSchema,
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
export type ResolvedColorScheme = z.infer<typeof resolvedColorSchemeSchema>;
export type ThemeState = z.infer<typeof themeStateSchema>;
