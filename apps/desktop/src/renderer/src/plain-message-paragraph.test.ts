import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { expect, it } from "vitest";

import { isPlainMessageParagraph } from "./plain-message-paragraph";

it("matches the full Markdown renderer for accepted prose and punctuation combinations", () => {
  const corpus = [
    "That works for me. Let's meet tomorrow (same time)!",
    "Bonjour, déjà vu!",
    "日本語のメッセージ",
    "مرحبا بالعالم",
    "Cafe\u0301",
    "1.5 hours remaining",
    "1000000000. Ten-digit numbers are not list markers",
    "Release 1.2.3 is ready",
    "(1) Yes; (2) No",
    "Ready... set... go!",
    "Well-known issue",
    "---word",
    "a  b",
    "",
    " ",
    "    code",
    "1. ordered",
    "1)",
    "- item",
    "---",
    "- - -",
    "hello  ",
    "hello\nworld",
    "hello\n",
    "hello\r",
    "a\tb",
    "www.example.com",
    "visit WWW.example.com today",
    "somebody@example.com",
    "https://example.com",
    "**bold**",
    "~strike~",
    "&#42;",
    "<b>literal</b>",
    "#general",
    "@alex",
    "a\0b",
  ];
  const tokens = ["hello", "é", "字", "1", "123456789", ".", ")", "-", " ", "www."];
  for (const a of tokens) {
    for (const b of tokens) {
      for (const c of tokens) corpus.push(a + b + c);
    }
  }
  let accepted = 0;
  for (const body of corpus) {
    if (!isPlainMessageParagraph(body)) continue;
    accepted += 1;
    const full = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: body }),
    );
    const plain = renderToStaticMarkup(createElement("p", null, body));
    expect(plain, JSON.stringify(body)).toBe(full);
  }
  expect(accepted).toBeGreaterThan(400);
});

it.each([
  "",
  " leading space",
  "trailing space ",
  "\tcode",
  "one\ntwo",
  "one\rtwo",
  "one\n",
  "one\r",
  "1. ordered",
  "9) ordered",
  "---",
  "- - -",
  "www.example.com",
  "x.www.example.com",
  "@alex",
  "#general",
  "&#42;",
  "**bold**",
  "[label](https://example.com)",
  "<img src=x>",
  "a\0b",
])("leaves syntax or whitespace requiring parsing to Markdown: %j", (body) => {
  expect(isPlainMessageParagraph(body)).toBe(false);
});
