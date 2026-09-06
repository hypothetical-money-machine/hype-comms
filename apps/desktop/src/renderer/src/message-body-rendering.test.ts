// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type * as ReactMarkdownModule from "react-markdown";
import { afterEach, expect, it, vi } from "vitest";

import { MessageBody } from "./message-body";

const parsing = vi.hoisted(() => ({ calls: 0 }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      parsing.calls += 1;
      return createElement(actual.default, props);
    },
  };
});

afterEach(() => {
  cleanup();
  parsing.calls = 0;
});

it("renders ordinary single-line prose without constructing a Markdown parser", () => {
  const body = "That works for me. Let's meet tomorrow (same time)!";
  const { container, rerender } = render(createElement(MessageBody, { body }));
  expect(container.querySelector("p")?.textContent).toBe(body);
  expect(parsing.calls).toBe(0);
  rerender(createElement(MessageBody, { body: "**Tomorrow** at the same time" }));
  expect(container.querySelector("strong")?.textContent).toBe("Tomorrow");
  expect(parsing.calls).toBe(1);
  rerender(createElement(MessageBody, { body }));
  expect(container.querySelector("strong")).toBeNull();
  expect(container.querySelector("p")?.textContent).toBe(body);
  expect(parsing.calls).toBe(1);
});

it("updates channel references without reparsing an unchanged message", () => {
  const body = "**Meet in #general**";
  const onOpenChannel = vi.fn();
  const { rerender } = render(createElement(MessageBody, { body, onOpenChannel }));
  expect(parsing.calls).toBe(1);
  expect(screen.queryByRole("button")).toBeNull();
  const channels = [{ conversationId: "10000000-0000-4000-8000-000000000001", slug: "general" }];
  rerender(createElement(MessageBody, { body, channels, onOpenChannel }));
  expect(screen.getByRole("button", { name: "#general" })).toBeDefined();
  expect(parsing.calls).toBe(1);
  rerender(createElement(MessageBody, { body, channels: [], onOpenChannel }));
  expect(screen.queryByRole("button")).toBeNull();
  expect(parsing.calls).toBe(1);
  rerender(createElement(MessageBody, { body: "A *new* message" }));
  expect(parsing.calls).toBe(2);
});
