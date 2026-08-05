import { Fragment, type ReactNode } from "react";

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

function linkedBody(body: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of body.matchAll(HTTPS_URL)) {
    const start = match.index;
    const candidate = match[0];
    if (start > cursor) nodes.push(body.slice(cursor, start));
    const { url, trailing } = trimUrlCandidate(candidate);
    const href = normalizeHttpsUrl(url);
    if (href === null) {
      nodes.push(candidate);
    } else {
      nodes.push(
        <a key={`${String(start)}-${url}`} href={href} target="_blank" rel="noreferrer noopener">
          {url}
        </a>,
      );
      if (trailing !== "") nodes.push(trailing);
    }
    cursor = start + candidate.length;
  }
  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes;
}

export function MessageBody({
  body,
  suffix,
}: {
  readonly body: string;
  readonly suffix?: ReactNode;
}) {
  return (
    <p className="message-body">
      {linkedBody(body).map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
      {suffix}
    </p>
  );
}
