export interface ChannelReferenceTarget {
  readonly conversationId: string;
  readonly slug: string;
}

export type MessageBodySegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "channel"; readonly text: string; readonly conversationId: string };

/**
 * Candidate references mirror the character classes of `channelSlugSchema`: segments of Unicode
 * letters, numbers, and combining marks joined by hyphens. The hyphen variants `－` (U+FF0D) and
 * `﹣` (U+FE63) NFKC-normalize to `-`, so they belong to the candidate — `#general－ops` means the
 * `general-ops` slug, never a `general` prefix. The lookbehind keeps `#` glued to a preceding
 * word (`issue#42`) or doubled (`##general`) from reading as a channel reference, and the
 * lookahead keeps a glued tail (`#general_team`) from linking a prefix; both use `\p{Pc}` and the
 * NFKC hash variants `＃`/`﹟` so compatibility forms of `_` and `#` behave like the ASCII ones.
 * The lookahead repeats the candidate classes so backtracking cannot shorten a rejected match
 * into an accepted one.
 */
const CHANNEL_REFERENCE_PATTERN =
  /(?<![\p{L}\p{N}\p{M}\p{Pc}#＃﹟])#([\p{L}\p{N}][\p{L}\p{N}\p{M}\-－﹣]*)(?![\p{L}\p{N}\p{M}\p{Pc}#＃﹟\-－﹣])/gu;

/**
 * The pattern's boundary classes can only reject what a Unicode property can name. Compatibility
 * symbols such as `ⓐ` (U+24D0) or `㎏` (U+338F) sit in symbol categories yet NFKC-normalize into
 * slug text, so a glued `#generalⓐ` would otherwise link a wrong-channel `#general` prefix. Any
 * boundary code point whose normalization contains slug or reference characters rejects the match.
 */
function normalizesIntoSlugText(character: string): boolean {
  return character !== "" && /[\p{L}\p{N}\p{M}\p{Pc}#]/u.test(character.normalize("NFKC"));
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.slice(index - 1, index);
}

function codePointAfter(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

/**
 * Splits a message body into plain-text runs and `#slug` references to channels the current
 * member can already see. Matching is display-tolerant — `#General` resolves the `general`
 * slug — but only whole candidates resolve: `#general-ops` never links a mere `general` channel,
 * because linking a prefix would silently rewrite what the author typed.
 */
export function segmentMessageBody(
  body: string,
  channels: readonly ChannelReferenceTarget[],
): readonly MessageBodySegment[] {
  if (channels.length === 0 || !body.includes("#")) return [{ kind: "text", text: body }];

  const conversationIdBySlug = new Map<string, string>();
  for (const channel of channels) {
    // Contract-validated slugs are already NFKC lowercase; normalizing here keeps the match
    // correct even for callers that hold slugs in another form.
    const slug = channel.slug.normalize("NFKC").toLowerCase();
    if (!conversationIdBySlug.has(slug)) {
      conversationIdBySlug.set(slug, channel.conversationId);
    }
  }

  const segments: MessageBodySegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(CHANNEL_REFERENCE_PATTERN)) {
    if (
      normalizesIntoSlugText(codePointBefore(body, match.index)) ||
      normalizesIntoSlugText(codePointAfter(body, match.index + match[0].length))
    ) {
      continue;
    }

    // Slugs never end with a hyphen, so trailing hyphens (of any NFKC variant) are punctuation
    // after the reference. Strip raw characters, not the normalized form, because the segment
    // boundary below is measured in raw string units.
    const candidate = (match[1] ?? "").replace(/[-－﹣]+$/u, "");

    const conversationId = conversationIdBySlug.get(candidate.normalize("NFKC").toLowerCase());
    if (conversationId === undefined) continue;

    const start = match.index;
    const end = start + 1 + candidate.length;
    if (start > cursor) segments.push({ kind: "text", text: body.slice(cursor, start) });
    segments.push({ kind: "channel", text: body.slice(start, end), conversationId });
    cursor = end;
  }

  if (segments.length === 0) return [{ kind: "text", text: body }];
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments;
}
