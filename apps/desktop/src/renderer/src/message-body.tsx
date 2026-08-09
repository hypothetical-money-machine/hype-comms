import { Fragment, type ReactNode } from "react";

import { segmentMessageBody, type ChannelReferenceTarget } from "./channel-references";

const HTTPS_URL = /https:\/\/[^\s<>"']+/giu;
const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":"]);
const BRACKETS = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
] as const;

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function trimUrlCandidate(candidate: string): { readonly url: string; readonly trailing: string } {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    if (last === undefined) break;
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const bracket = BRACKETS.find(([, closing]) => closing === last);
    if (bracket !== undefined) {
      const value = candidate.slice(0, end);
      if (count(value, bracket[1]) > count(value, bracket[0])) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return { url: candidate.slice(0, end), trailing: candidate.slice(end) };
}

function normalizeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Renders a message body with HTTPS URLs as external links and, when the caller can navigate,
 * `#channel` references as navigation buttons. Everything else stays the literal text the author
 * wrote — the surrounding styles rely on `pre-wrap` whitespace, which plain text nodes, inline
 * links, and inline buttons all preserve. URL spans are carved out first so a fragment such as
 * `https://example.com/#general` stays inside the link; channel references resolve only in the
 * text between URLs.
 */
export function MessageBody({
  body,
  suffix,
  channels = [],
  onOpenChannel,
}: {
  readonly body: string;
  readonly suffix?: ReactNode;
  readonly channels?: readonly ChannelReferenceTarget[];
  readonly onOpenChannel?: (conversationId: string) => void;
}) {
  const nodes: ReactNode[] = [];
  const pushText = (text: string): void => {
    if (text === "") return;
    if (onOpenChannel === undefined) {
      nodes.push(text);
      return;
    }
    for (const segment of segmentMessageBody(text, channels)) {
      if (segment.kind === "channel") {
        const { conversationId } = segment;
        nodes.push(
          <button
            type="button"
            className="channel-reference"
            onClick={() => onOpenChannel(conversationId)}
          >
            {segment.text}
          </button>,
        );
      } else {
        nodes.push(segment.text);
      }
    }
  };

  let cursor = 0;
  for (const match of body.matchAll(HTTPS_URL)) {
    const start = match.index;
    const candidate = match[0];
    pushText(body.slice(cursor, start));
    const { url, trailing } = trimUrlCandidate(candidate);
    const href = normalizeHttpsUrl(url);
    if (href === null) {
      nodes.push(candidate);
    } else {
      nodes.push(
        <a href={href} target="_blank" rel="noreferrer noopener">
          {url}
        </a>,
      );
      if (trailing !== "") nodes.push(trailing);
    }
    cursor = start + candidate.length;
  }
  pushText(body.slice(cursor));

  return (
    <p className="message-body">
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
      {suffix}
    </p>
  );
}
