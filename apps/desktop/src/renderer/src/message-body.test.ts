// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageBody } from "./message-body";

afterEach(cleanup);

describe("MessageBody", () => {
  it("renders credential-free HTTPS URLs as external links", () => {
    render(
      createElement(MessageBody, { body: "Read https://example.com/docs?q=chat for details." }),
    );

    const link = screen.getByRole<HTMLAnchorElement>("link", {
      name: "https://example.com/docs?q=chat",
    });
    expect(link.href).toBe("https://example.com/docs?q=chat");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noreferrer");
    expect(link.closest("p")?.textContent).toBe(
      "Read https://example.com/docs?q=chat for details.",
    );
  });

  it("keeps sentence punctuation outside links while retaining balanced URL brackets", () => {
    render(createElement(MessageBody, { body: "See (https://example.com/path_(guide))." }));

    expect(screen.getByRole<HTMLAnchorElement>("link").href).toBe(
      "https://example.com/path_(guide)",
    );
    expect(screen.getByText(/See/).textContent).toBe("See (https://example.com/path_(guide)).");
  });

  it("leaves non-HTTPS and credential-bearing URLs as inert text", () => {
    render(
      createElement(MessageBody, {
        body: "http://example.com https://user:secret@example.com javascript:alert(1)",
      }),
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/http:\/\/example.com/).textContent).toContain(
      "https://user:secret@example.com",
    );
  });

  it("preserves multiline message text", () => {
    render(createElement(MessageBody, { body: "First line\nSecond line" }));

    expect(screen.getByText(/First line/).textContent).toBe("First line\nSecond line");
  });
});
