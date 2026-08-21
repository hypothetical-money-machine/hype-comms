import type { User } from "@hype-comms/contracts";

export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

export type MentionSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "mention";
      readonly text: string;
      readonly userId: string;
      readonly username: string;
    };

const MENTION_BOUNDARY = /[\p{L}\p{N}_]/u;

function normalizedUsername(username: string): string {
  return username.normalize("NFKC").toLocaleLowerCase();
}

/**
 * The incomplete `@query` immediately before the caret. Word-glued addresses such as `hello@`
 * stay inert, matching the verified mention boundary used on send.
 */
export function mentionQueryAt(text: string, cursor: number): MentionQuery | null {
  if (cursor < 1 || cursor > text.length) return null;
  const prefix = text.slice(0, cursor);
  const match = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_-]*)$/u.exec(prefix);
  if (match === null) return null;
  return { start: match.index + match[1].length, query: match[2] ?? "" };
}

export function filterMentionMembers(members: readonly User[], query: string): readonly User[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  if (normalized === "") return members;
  return members.filter((member) => {
    return (
      normalizedUsername(member.username).includes(normalized) ||
      member.displayName.normalize("NFKC").toLocaleLowerCase().includes(normalized)
    );
  });
}

export function insertMention(
  text: string,
  query: MentionQuery,
  username: string,
): { readonly text: string; readonly cursor: number } {
  const mention = `@${username}`;
  const queryEnd = query.start + 1 + query.query.length;
  const after = text.slice(queryEnd);
  const spacer = after === "" || /^\s/u.test(after) ? "" : " ";
  return {
    text: `${text.slice(0, query.start)}${mention}${spacer}${after}`,
    cursor: query.start + mention.length + spacer.length,
  };
}

/**
 * Splits a plaintext run into ordinary text and `@username` chips for members the caller already
 * holds. Longest username wins so `@morgan-smith` does not render as a `morgan` prefix chip.
 */
export function segmentMentions(text: string, members: readonly User[]): readonly MentionSegment[] {
  if (members.length === 0 || !text.includes("@")) return [{ kind: "text", text }];

  const byLongestUsername = [...members].sort(
    (left, right) => right.username.length - left.username.length,
  );
  const segments: MentionSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])@/gu)) {
    const start = match.index;
    if (start < cursor) continue;

    let resolved:
      { readonly end: number; readonly member: User; readonly text: string } | undefined;
    for (const member of byLongestUsername) {
      const end = start + 1 + member.username.length;
      if (end > text.length) continue;
      const token = text.slice(start + 1, end);
      if (normalizedUsername(token) !== normalizedUsername(member.username)) continue;
      const after = text.slice(end, end + 1);
      if (after !== "" && MENTION_BOUNDARY.test(after)) continue;
      resolved = { end, member, text: text.slice(start, end) };
      break;
    }
    if (resolved === undefined) continue;

    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({
      kind: "mention",
      text: resolved.text,
      userId: resolved.member.id,
      username: resolved.member.username,
    });
    cursor = resolved.end;
  }

  if (segments.length === 0) return [{ kind: "text", text }];
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/**
 * IDs for the verified mention list. Same participant-scoped `@username` scan the composer already
 * used on send; the server rejects IDs that are missing from the body or the conversation audience.
 */
export function mentionedMemberIds(
  body: string,
  members: readonly User[],
  participantIds: readonly string[],
): readonly string[] {
  const visibleMemberIds = new Set(participantIds);
  return members
    .filter((member) => {
      if (!visibleMemberIds.has(member.id)) return false;
      const escaped = member.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(body);
    })
    .map((member) => member.id);
}
