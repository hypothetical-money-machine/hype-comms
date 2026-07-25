import { z } from "zod";

const CHANNEL_SLUG_MAX_CODE_POINTS = 100;
const CHANNEL_SLUG_PATTERN =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:-[\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u;

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * A canonical, user-facing channel identifier. Workspace slugs deliberately remain ASCII-only
 * administrative identifiers.
 */
export const channelSlugSchema = z
  .string()
  .min(1)
  .refine((value) => codePointLength(value) <= CHANNEL_SLUG_MAX_CODE_POINTS, {
    message: "Channel slug must contain at most 100 Unicode code points",
  })
  .refine((value) => value === value.normalize("NFKC"), {
    message: "Channel slug must use Unicode NFKC normalization",
  })
  .refine((value) => value === value.toLowerCase(), {
    message: "Channel slug must be lowercase",
  })
  .regex(CHANNEL_SLUG_PATTERN, "Channel slug segments must begin with a Unicode letter or number");

/**
 * Converts a display name into the canonical slug accepted by `channelSlugSchema`.
 *
 * Combining marks are retained only after a letter or number has begun a segment. Everything else
 * becomes one ASCII hyphen, and the result is capped by Unicode code points rather than UTF-16
 * code units.
 */
export function channelSlugFromName(name: string): string {
  const normalized = name.normalize("NFKC").toLowerCase();
  const output: string[] = [];
  let segmentStarted = false;
  let separatorPending = false;

  for (const character of normalized) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      if (separatorPending && output.length > 0) output.push("-");
      output.push(character);
      segmentStarted = true;
      separatorPending = false;
    } else if (segmentStarted && /\p{M}/u.test(character)) {
      output.push(character);
    } else {
      separatorPending = output.length > 0;
      segmentStarted = false;
    }
  }

  return output.slice(0, CHANNEL_SLUG_MAX_CODE_POINTS).join("").replace(/-$/u, "");
}
