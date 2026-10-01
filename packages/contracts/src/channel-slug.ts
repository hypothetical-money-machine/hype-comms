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

/** Reserved prefix for server-owned built-in channels. */
export const SYSTEM_CHANNEL_SLUG_PREFIX = "hype/";

/**
 * The slug of a server-owned built-in channel: the reserved prefix plus a valid channel slug.
 *
 * `/` cannot appear in `channelSlugSchema`, so the built-in namespace can never collide with a
 * slug a member is able to create.
 */
export const systemChannelSlugSchema = z
  .string()
  .refine((value) => value.startsWith(SYSTEM_CHANNEL_SLUG_PREFIX), {
    message: "System channel slug must begin with the reserved prefix",
  })
  .refine(
    (value) => channelSlugSchema.safeParse(value.slice(SYSTEM_CHANNEL_SLUG_PREFIX.length)).success,
    { message: "System channel slug must end with a valid channel slug" },
  )
  // The database limits the whole stored slug, prefix included, to 100 code points.
  .refine((value) => codePointLength(value) <= CHANNEL_SLUG_MAX_CODE_POINTS, {
    message: "System channel slug must contain at most 100 Unicode code points",
  });

/** Whether a stored slug names a server-owned built-in channel. */
export function isSystemChannelSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.startsWith(SYSTEM_CHANNEL_SLUG_PREFIX);
}

/**
 * The fixed id of the user that authors every server-published bulletin, installed by the
 * system-channels migration. The publisher never appears in a workspace's member directory, so
 * clients match this id to attribute its messages; any other unresolvable author is an ordinary
 * departed member.
 */
export const SYSTEM_USER_ID = "a0000000-0000-4000-8000-00000000c001";
